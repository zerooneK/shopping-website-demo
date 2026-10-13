import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { items, orderEvents, orders } from "@/db/schema";
import { getAdminDashboard, getAdminOrderDetail, getSlipRecord } from "@/lib/admin/queries";
import { STATUS_PRIORITY } from "@/lib/admin/view";
import { reserveSlipTokenSlot, uploadSlip } from "@/lib/orders/commands";
import { getCustomerOrder } from "@/lib/orders/queries";
import { buildTimeline, describeOrder } from "@/lib/orders/view";
import { DEMO_REASON_SUFFIX, adminTransition } from "@/lib/orders/admin-commands";
import type { AdminSession } from "@/lib/auth";
import { createDrizzleReserveStore, reserveItem } from "@/lib/reserve";
import type { CreateOrderInput } from "@/lib/validation";

/**
 * Integration test กับ Postgres (Neon) จริง สำหรับคำสั่งฝั่งแอดมิน (ขั้น 3c-1):
 *  - confirm / reject / ship / complete: สถานะออเดอร์ + สถานะสินค้า + reserved_until + order_events
 *  - reject แล้วสินค้ากลับ available (จองใหม่ได้จริง) รวมออเดอร์ที่ "ค้าง" (reserved_until เป็นอดีต/NULL)
 *  - race: สองคนกดพร้อมกัน (confirm+confirm, confirm+reject) ผู้ชนะได้คนเดียวและสถานะสินค้าสอดคล้อง
 *  - query หลังบ้าน: ลำดับ awaiting_review ก่อน, pending ที่หมดเวลาแสดงเป็น expired, mask ของ demo,
 *    timeline กรอง slip_token_issued
 *
 * ใช้รหัสสินค้า U801-U860 เท่านั้น (ไม่ชนกับเทสต์อื่น) ลบเฉพาะแถวของตัวเองก่อน/หลังรัน — ห้ามแตะ seed
 * รัน: npm run test:integration
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);
if (!HAS_DB) {
  console.warn("[integration] ข้ามเทสต์: ไม่พบ DATABASE_URL (รันผ่าน `npm run test:integration`)");
}

const CODES = Array.from({ length: 60 }, (_, i) => `U${801 + i}`);
let seq = 0;
const nextCode = () => CODES[seq++];

const OWNER_ACTOR: AdminSession = { role: "owner" };
const demoActor = (sid: string): AdminSession => ({ role: "demo", sid });
/**
 * sid ของ "ผู้ลองเดโม" ในเทสต์ (รูปแบบถูกต้อง 32-64 ตัวอักษร)
 * ใช้ sid ใหม่ทุกเทสต์: reserveItem จำกัดต่อ sid (<= 2 ออเดอร์ที่ถือสินค้า, <= 5 ต่อชั่วโมง) จึงใช้ซ้ำข้ามเทสต์ไม่ได้
 */
let sidSeq = 0;
const newSid = () => `it-${Date.now().toString(36)}-${++sidSeq}-`.padEnd(40, "x");
let SID_A = newSid();
/** sid ของ "คนแปลกหน้า" — ไม่เคยสร้างออเดอร์ ใช้เป็นผู้ลงมือเท่านั้น */
const SID_B = "B".repeat(40);

const REAL_NAME = "สมหญิง รักดี";
const REAL_PHONE = "0899998877";
const REAL_ADDRESS = "1/2 ซอยลับ เขตทดสอบ กรุงเทพฯ 10110";

const input = (code: string, over: Partial<CreateOrderInput> = {}): CreateOrderInput => ({
  code,
  customerName: REAL_NAME,
  phone: REAL_PHONE,
  deliveryMethod: "pickup",
  ...over,
});

describe.skipIf(!HAS_DB)("คำสั่งแอดมินบน Postgres จริง", () => {
  const db = HAS_DB ? getDb() : (undefined as never);
  const store = HAS_DB ? createDrizzleReserveStore(db) : (undefined as never);

  async function cleanup() {
    const ids = (await db.select({ id: items.id }).from(items).where(inArray(items.code, CODES))).map((r) => r.id);
    if (ids.length === 0) return;
    const orderIds = (await db.select({ id: orders.id }).from(orders).where(inArray(orders.itemId, ids))).map(
      (r) => r.id,
    );
    if (orderIds.length > 0) {
      await db.delete(orderEvents).where(inArray(orderEvents.orderId, orderIds));
      await db.delete(orders).where(inArray(orders.id, orderIds));
    }
    await db.delete(items).where(inArray(items.id, ids));
  }

  async function makeItem(code: string) {
    await db.insert(items).values({
      code,
      title: `ทดสอบแอดมิน ${code}`,
      description: "integration test",
      flaws: "ไม่มีตำหนิที่สังเกตเห็น",
      condition: "good",
      category: "other",
      price: 100,
    });
  }
  const getItem = async (code: string) => (await db.select().from(items).where(eq(items.code, code)))[0];
  const getOrder = async (id: string) => (await db.select().from(orders).where(eq(orders.id, id)))[0];
  const eventsOf = (id: string) =>
    db.select().from(orderEvents).where(eq(orderEvents.orderId, id)).orderBy(orderEvents.id);

  /** สร้างสินค้า + จอง + ส่งสลิป → ออเดอร์ awaiting_review ที่ถือสินค้าอยู่จริง */
  async function awaitingOrder(over: Partial<CreateOrderInput> = {}, sid: string | null = null) {
    const code = nextCode();
    await makeItem(code);
    const r = await reserveItem(store, input(code, over), sid);
    if (!r.ok) throw new Error("reserve failed in test setup");
    const up = await uploadSlip(db, {
      token: r.order.token,
      slipPath: `slips/${r.order.id}/test.jpg`,
    });
    if (!up.ok) throw new Error("uploadSlip failed in test setup");
    return { code, order: r.order };
  }

  beforeAll(cleanup);
  afterAll(cleanup);
  beforeEach(() => {
    SID_A = newSid();
  });

  it("confirm (นัดรับ): awaiting_review → confirmed, สินค้า sold + reserved_until NULL, มี confirmed_at และ event", async () => {
    const { code, order } = await awaitingOrder({}, SID_A);
    const res = await adminTransition(db, { orderId: order.id, intent: { type: "confirm" }, actor: OWNER_ACTOR });
    expect(res).toEqual({ ok: true, from: "awaiting_review", to: "confirmed" });

    const o = await getOrder(order.id);
    expect(o.status).toBe("confirmed");
    expect(o.confirmedAt).not.toBeNull();
    const item = await getItem(code);
    expect(item.status).toBe("sold");
    expect(item.reservedUntil).toBeNull();

    const evs = (await eventsOf(order.id)).filter((e) => e.type === "confirm");
    expect(evs).toHaveLength(1);
    expect(evs[0].actor).toBe("admin");
    expect(evs[0].meta).toMatchObject({ adminRole: "owner" });

    // นัดรับ: ปิดงานได้เลยจาก confirmed
    const done = await adminTransition(db, { orderId: order.id, intent: { type: "complete" }, actor: demoActor(SID_A) });
    expect(done).toEqual({ ok: true, from: "confirmed", to: "completed" });
    expect((await getOrder(order.id)).completedAt).not.toBeNull();
    expect((await getItem(code)).status).toBe("sold");
    expect((await eventsOf(order.id)).find((e) => e.type === "complete")?.meta).toMatchObject({ adminRole: "demo" });
  });

  it("ส่งไปรษณีย์: confirm → ship (ต้องมีเลขพัสดุ) → complete; ship ข้ามขั้น/นัดรับถูกปฏิเสธ", async () => {
    const { code, order } = await awaitingOrder({ deliveryMethod: "post", address: REAL_ADDRESS });

    // ยังไม่ confirm → ship ไม่ได้
    const early = await adminTransition(db, {
      orderId: order.id,
      intent: { type: "ship", trackingNo: "TH123456789" },
      actor: OWNER_ACTOR,
    });
    expect(early).toMatchObject({ ok: false, error: "invalid_state", status: "awaiting_review" });

    await adminTransition(db, { orderId: order.id, intent: { type: "confirm" }, actor: OWNER_ACTOR });

    // post: ปิดงานจาก confirmed ตรงๆ ไม่ได้ (ต้องผ่าน shipped)
    const skip = await adminTransition(db, { orderId: order.id, intent: { type: "complete" }, actor: OWNER_ACTOR });
    expect(skip).toMatchObject({ ok: false, error: "invalid_state", status: "confirmed" });

    const noTrack = await adminTransition(db, {
      orderId: order.id,
      intent: { type: "ship", trackingNo: "   " },
      actor: OWNER_ACTOR,
    });
    expect(noTrack).toMatchObject({ ok: false, error: "tracking_required" });
    expect((await getOrder(order.id)).status).toBe("confirmed");

    const shipped = await adminTransition(db, {
      orderId: order.id,
      intent: { type: "ship", trackingNo: " TH123456789 " },
      actor: OWNER_ACTOR,
    });
    expect(shipped).toEqual({ ok: true, from: "confirmed", to: "shipped" });
    const o = await getOrder(order.id);
    expect(o.status).toBe("shipped");
    expect(o.trackingNo).toBe("TH123456789");
    expect(o.shippedAt).not.toBeNull();
    expect((await getItem(code)).status).toBe("sold");

    const done = await adminTransition(db, { orderId: order.id, intent: { type: "complete" }, actor: OWNER_ACTOR });
    expect(done).toEqual({ ok: true, from: "shipped", to: "completed" });
    expect((await getItem(code)).status).toBe("sold");
  });

  it("ship ออเดอร์นัดรับ = pickup_cannot_ship และสถานะไม่เปลี่ยน", async () => {
    const { order } = await awaitingOrder();
    await adminTransition(db, { orderId: order.id, intent: { type: "confirm" }, actor: OWNER_ACTOR });
    const r = await adminTransition(db, {
      orderId: order.id,
      intent: { type: "ship", trackingNo: "TH123456789" },
      actor: OWNER_ACTOR,
    });
    expect(r).toMatchObject({ ok: false, error: "pickup_cannot_ship" });
    expect((await getOrder(order.id)).status).toBe("confirmed");
  });

  it("reject: ต้องมีเหตุผล; สำเร็จแล้วสินค้ากลับ available + reserved_until NULL + จองใหม่ได้จริง", async () => {
    const { code, order } = await awaitingOrder({}, SID_A);

    const noReason = await adminTransition(db, { orderId: order.id, intent: { type: "reject", reason: "  " }, actor: OWNER_ACTOR });
    expect(noReason).toMatchObject({ ok: false, error: "reason_required" });
    expect((await getOrder(order.id)).status).toBe("awaiting_review");
    expect((await getItem(code)).status).toBe("reserved");

    const res = await adminTransition(db, {
      orderId: order.id,
      intent: { type: "reject", reason: "  ยอดเงินไม่ตรง " },
      actor: demoActor(SID_A),
    });
    expect(res).toEqual({ ok: true, from: "awaiting_review", to: "rejected" });

    const o = await getOrder(order.id);
    expect(o.status).toBe("rejected");
    // เหตุผลที่ role demo เขียนถูกติดป้าย (ลูกค้าเห็นข้อความนี้)
    expect(o.rejectReason).toBe("ยอดเงินไม่ตรง" + DEMO_REASON_SUFFIX);
    const item = await getItem(code);
    expect(item.status).toBe("available");
    expect(item.reservedUntil).toBeNull();

    const ev = (await eventsOf(order.id)).find((e) => e.type === "reject")!;
    expect(ev.actor).toBe("admin");
    expect(ev.meta).toEqual({ reason: "ยอดเงินไม่ตรง" + DEMO_REASON_SUFFIX, adminRole: "demo" });

    // ของกลับมาขายได้จริง: คนใหม่จองสำเร็จ
    const again = await reserveItem(store, input(code, { customerName: "ลูกค้าใหม่" }));
    expect(again.ok).toBe(true);
    expect((await getItem(code)).status).toBe("reserved");
  });

  it.each([
    ["reserved_until เป็นอดีต", sql`now() - interval '3 hours'`],
    ["reserved_until เป็น NULL", sql`NULL::timestamptz`],
  ])("ออเดอร์ที่ค้างอยู่ (%s + expires_at ผ่านไปนานแล้ว) reject ได้และคืนสินค้าครบ", async (_label, reservedUntil) => {
    const { code, order } = await awaitingOrder();
    await db.execute(sql`UPDATE items SET reserved_until = ${reservedUntil} WHERE code = ${code}`);
    await db.execute(sql`UPDATE orders SET expires_at = now() - interval '5 hours' WHERE id = ${order.id}`);

    const res = await adminTransition(db, {
      orderId: order.id,
      intent: { type: "reject", reason: "ค้างนานเกินไป" },
      actor: OWNER_ACTOR,
    });
    expect(res.ok).toBe(true);
    const item = await getItem(code);
    expect(item.status).toBe("available");
    expect(item.reservedUntil).toBeNull();
    expect((await getOrder(order.id)).status).toBe("rejected");
    expect((await reserveItem(store, input(code))).ok).toBe(true);
  });

  it("confirm ออเดอร์ที่ค้าง (reserved_until เป็นอดีต) ก็ได้ sold และ reserved_until NULL", async () => {
    const { code, order } = await awaitingOrder();
    await db.execute(sql`UPDATE items SET reserved_until = now() - interval '3 hours' WHERE code = ${code}`);
    const res = await adminTransition(db, { orderId: order.id, intent: { type: "confirm" }, actor: OWNER_ACTOR });
    expect(res.ok).toBe(true);
    const item = await getItem(code);
    expect(item.status).toBe("sold");
    expect(item.reservedUntil).toBeNull();
  });

  it("reject ไม่ปล่อยสินค้าถ้ายังมีออเดอร์อื่นถืออยู่ (ป้องกันซ้ำอีกชั้น)", async () => {
    const { code, order } = await awaitingOrder();
    const [item] = await db.select({ id: items.id }).from(items).where(eq(items.code, code));
    // สร้างผู้ถือรายอื่นโดยตรง (ปกติ claimItem ไม่ยอมให้เกิด — ทดสอบแค่ guard ของ reject)
    await db.insert(orders).values({
      token: "guard-" + "x".repeat(37),
      itemId: item.id,
      amount: 100,
      customerName: "อีกคน",
      phone: "0811111111",
      deliveryMethod: "pickup",
      status: "pending_payment",
      expiresAt: sql`now() + interval '10 minutes'`,
    });
    const res = await adminTransition(db, {
      orderId: order.id,
      intent: { type: "reject", reason: "ทดสอบ" },
      actor: OWNER_ACTOR,
    });
    expect(res.ok).toBe(true);
    expect((await getOrder(order.id)).status).toBe("rejected");
    expect((await getItem(code)).status).toBe("reserved");
  });

  it("ออเดอร์ที่ไม่ใช่ awaiting_review (pending_payment / ไม่มีอยู่จริง) ถูกปฏิเสธ", async () => {
    const code = nextCode();
    await makeItem(code);
    const r = await reserveItem(store, input(code));
    if (!r.ok) throw new Error("setup");
    for (const type of ["confirm", "complete"] as const) {
      const res = await adminTransition(db, { orderId: r.order.id, intent: { type }, actor: OWNER_ACTOR });
      expect(res).toMatchObject({ ok: false, error: "invalid_state", status: "pending_payment" });
    }
    const rej = await adminTransition(db, {
      orderId: r.order.id,
      intent: { type: "reject", reason: "x" },
      actor: OWNER_ACTOR,
    });
    expect(rej).toMatchObject({ ok: false, error: "invalid_state" });
    expect((await getItem(code)).status).toBe("reserved");

    const ghost = await adminTransition(db, {
      orderId: "00000000-0000-4000-8000-000000000000",
      intent: { type: "confirm" },
      actor: OWNER_ACTOR,
    });
    expect(ghost).toEqual({ ok: false, error: "not_found" });
  });

  it("race: confirm พร้อมกัน 8 คำขอ → สำเร็จ 1, ที่เหลือ invalid_state, มี event confirm ครั้งเดียว", async () => {
    const { code, order } = await awaitingOrder();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => adminTransition(db, { orderId: order.id, intent: { type: "confirm" }, actor: OWNER_ACTOR })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const r of results.filter((x) => !x.ok)) expect(r).toMatchObject({ ok: false, error: "invalid_state" });
    expect((await eventsOf(order.id)).filter((e) => e.type === "confirm")).toHaveLength(1);
    expect((await getOrder(order.id)).status).toBe("confirmed");
    expect((await getItem(code)).status).toBe("sold");
  });

  it("race: confirm กับ reject พร้อมกัน (ทำซ้ำ 6 รอบ) → ผู้ชนะคนเดียว สถานะออเดอร์/สินค้า/event สอดคล้องกัน", async () => {
    let confirmWins = 0;
    let rejectWins = 0;
    for (let i = 0; i < 6; i++) {
      const sid = newSid();
      const { code, order } = await awaitingOrder({}, sid);
      const [a, b] = await Promise.all([
        adminTransition(db, { orderId: order.id, intent: { type: "confirm" }, actor: OWNER_ACTOR }),
        adminTransition(db, { orderId: order.id, intent: { type: "reject", reason: "ทดสอบแข่งกัน" }, actor: demoActor(sid) }),
      ]);
      expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
      const loser = a.ok ? b : a;
      expect(loser).toMatchObject({ ok: false, error: "invalid_state" });

      const o = await getOrder(order.id);
      const item = await getItem(code);
      const adminEvents = (await eventsOf(order.id)).filter((e) => e.actor === "admin");
      expect(adminEvents).toHaveLength(1);
      if (a.ok) {
        confirmWins++;
        expect(o.status).toBe("confirmed");
        expect(o.rejectReason).toBeNull();
        expect(item.status).toBe("sold");
        expect(adminEvents[0].type).toBe("confirm");
      } else {
        rejectWins++;
        expect(o.status).toBe("rejected");
        expect(o.confirmedAt).toBeNull();
        expect(item.status).toBe("available");
        expect(item.reservedUntil).toBeNull();
        expect(adminEvents[0].type).toBe("reject");
      }
    }
    expect(confirmWins + rejectWins).toBe(6);
  });

  describe("role demo จำกัดเฉพาะออเดอร์ของตัวเอง (demo_session_id = sid)", () => {
    /** ไม่มี event ฝั่งแอดมินเลย = ไม่มีการเปลี่ยนแปลงหลุดเข้า DB */
    const adminEventCount = async (id: string) =>
      (await eventsOf(id)).filter((e) => e.actor === "admin").length;

    it("sid อื่น confirm/reject ไม่ได้ (not_your_order): สถานะออเดอร์ สินค้า reserved_until และ event ไม่เปลี่ยน; จองซ้ำยังไม่ได้", async () => {
      const { code, order } = await awaitingOrder({}, SID_A);
      const before = await getItem(code);
      const stranger = demoActor(SID_B);

      for (const intent of [
        { type: "confirm" } as const,
        { type: "reject", reason: "ลองแกล้งปฏิเสธ" } as const,
      ]) {
        const res = await adminTransition(db, { orderId: order.id, intent, actor: stranger });
        expect(res).toEqual({ ok: false, error: "not_your_order" });
      }

      const o = await getOrder(order.id);
      expect(o.status).toBe("awaiting_review");
      expect(o.rejectReason).toBeNull();
      expect(o.confirmedAt).toBeNull();
      const after = await getItem(code);
      expect(after.status).toBe("reserved");
      expect(after.reservedUntil?.getTime() ?? null).toBe(before.reservedUntil?.getTime() ?? null);
      expect(await adminEventCount(order.id)).toBe(0);
      // ของยังถูกถืออยู่จริง: คนอื่นจองไม่ได้
      const again = await reserveItem(store, input(code, { customerName: "คนอื่น" }));
      expect(again).toMatchObject({ ok: false, reason: "unavailable" });
    });

    it("sid อื่นทำ ship/complete ไม่ได้ในสถานะที่ถูกต้อง (ออเดอร์ที่ owner ยืนยันแล้ว) และออเดอร์ที่ไม่มี demo_session_id ก็ไม่ได้", async () => {
      const post = await awaitingOrder({ deliveryMethod: "post", address: REAL_ADDRESS }, SID_A);
      await adminTransition(db, { orderId: post.order.id, intent: { type: "confirm" }, actor: OWNER_ACTOR });
      const ship = await adminTransition(db, {
        orderId: post.order.id,
        intent: { type: "ship", trackingNo: "TH123456789" },
        actor: demoActor(SID_B),
      });
      expect(ship).toEqual({ ok: false, error: "not_your_order" });
      const pickup = await awaitingOrder({}, SID_A);
      await adminTransition(db, { orderId: pickup.order.id, intent: { type: "confirm" }, actor: OWNER_ACTOR });
      const done = await adminTransition(db, {
        orderId: pickup.order.id,
        intent: { type: "complete" },
        actor: demoActor(SID_B),
      });
      expect(done).toEqual({ ok: false, error: "not_your_order" });
      expect((await getOrder(post.order.id)).status).toBe("confirmed");
      expect((await getOrder(post.order.id)).trackingNo).toBeNull();
      expect((await getOrder(pickup.order.id)).status).toBe("confirmed");
      expect((await getItem(pickup.code)).status).toBe("sold");

      // ออเดอร์ที่ไม่มี demo_session_id (เช่นลูกค้าจริงที่ไม่มีคุกกี้) — demo ใดๆ ก็แตะไม่ได้
      const noSid = await awaitingOrder({}, null);
      const res = await adminTransition(db, {
        orderId: noSid.order.id,
        intent: { type: "confirm" },
        actor: demoActor(SID_A),
      });
      expect(res).toEqual({ ok: false, error: "not_your_order" });
      expect((await getOrder(noSid.order.id)).status).toBe("awaiting_review");
      expect((await getItem(noSid.code)).status).toBe("reserved");
    });

    it("sid ตรงกัน: confirm → ship → complete (post) และ reject ได้ตามปกติ", async () => {
      const mine = demoActor(SID_A);
      const post = await awaitingOrder({ deliveryMethod: "post", address: REAL_ADDRESS }, SID_A);
      expect(await adminTransition(db, { orderId: post.order.id, intent: { type: "confirm" }, actor: mine })).toEqual({
        ok: true,
        from: "awaiting_review",
        to: "confirmed",
      });
      expect(
        await adminTransition(db, {
          orderId: post.order.id,
          intent: { type: "ship", trackingNo: "TH123456789" },
          actor: mine,
        }),
      ).toEqual({ ok: true, from: "confirmed", to: "shipped" });
      expect(await adminTransition(db, { orderId: post.order.id, intent: { type: "complete" }, actor: mine })).toEqual({
        ok: true,
        from: "shipped",
        to: "completed",
      });
      expect((await getItem(post.code)).status).toBe("sold");

      const rej = await awaitingOrder({}, SID_A);
      expect(
        await adminTransition(db, {
          orderId: rej.order.id,
          intent: { type: "reject", reason: "ทดสอบ" },
          actor: mine,
        }),
      ).toEqual({ ok: true, from: "awaiting_review", to: "rejected" });
      expect((await getItem(rej.code)).status).toBe("available");
    });

    it("owner ไม่ถูกจำกัด: ทำกับออเดอร์ของ sid ใดๆ หรือไม่มี sid ได้", async () => {
      const a = await awaitingOrder({}, SID_A);
      const none = await awaitingOrder({}, null);
      for (const o of [a, none]) {
        const res = await adminTransition(db, { orderId: o.order.id, intent: { type: "confirm" }, actor: OWNER_ACTOR });
        expect(res).toEqual({ ok: true, from: "awaiting_review", to: "confirmed" });
      }
    });

    it("race: demo sid อื่น 4 คำขอ + sid ตัวเอง 1 คำขอ confirm พร้อมกัน → สำเร็จเฉพาะของ sid ตรง และมี event confirm เดียว", async () => {
      const { code, order } = await awaitingOrder({}, SID_A);
      const results = await Promise.all([
        ...Array.from({ length: 4 }, () =>
          adminTransition(db, { orderId: order.id, intent: { type: "confirm" }, actor: demoActor(SID_B) }),
        ),
        adminTransition(db, { orderId: order.id, intent: { type: "confirm" }, actor: demoActor(SID_A) }),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok && r.error === "not_your_order")).toHaveLength(4);
      expect((await eventsOf(order.id)).filter((e) => e.type === "confirm")).toHaveLength(1);
      expect((await getOrder(order.id)).status).toBe("confirmed");
      expect((await getItem(code)).status).toBe("sold");
    });

    it("M2: เหตุผลที่ demo เขียนมีป้ายต่อท้ายที่ลูกค้าเห็น (คอลัมน์ + หน้า order + timeline); เหตุผลของ owner ไม่มีป้าย", async () => {
      const viaDemo = await awaitingOrder({}, SID_A);
      await adminTransition(db, {
        orderId: viaDemo.order.id,
        intent: { type: "reject", reason: "ข้อความจากเดโม" },
        actor: demoActor(SID_A),
      });
      const c = (await getCustomerOrder(viaDemo.order.token))!;
      expect(c.status).toBe("rejected");
      expect(c.rejectReason).toBe("ข้อความจากเดโม (ข้อความจากผู้ลองเดโม)");
      const view = describeOrder({
        status: c.status,
        deliveryMethod: c.deliveryMethod,
        expiresAtMs: c.expiresAt.getTime(),
        nowMs: c.dbNow.getTime(),
        rejectReason: c.rejectReason,
      });
      expect(view.body).toBe("เหตุผล: ข้อความจากเดโม (ข้อความจากผู้ลองเดโม)");
      const tl = buildTimeline(c.events.map((e) => ({ type: e.type, meta: e.meta, createdAtMs: e.createdAt.getTime() })));
      expect(tl.find((t) => t.label === "ร้านไม่รับสลิป")?.detail).toBe("ข้อความจากเดโม (ข้อความจากผู้ลองเดโม)");

      const viaOwner = await awaitingOrder({}, SID_A);
      await adminTransition(db, {
        orderId: viaOwner.order.id,
        intent: { type: "reject", reason: "ยอดไม่ตรง" },
        actor: OWNER_ACTOR,
      });
      expect((await getCustomerOrder(viaOwner.order.token))!.rejectReason).toBe("ยอดไม่ตรง");
    });
  });

  describe("query หลังบ้าน", () => {
    const OWNER = OWNER_ACTOR;
    const SID = "I".repeat(40);
    const DEMO = { role: "demo", sid: SID } as const;

    it("dashboard: awaiting_review ขึ้นก่อนสถานะอื่น, pending ที่หมดเวลาแสดงเป็น expired (ไม่ใช่ค่าดิบ)", async () => {
      // ออเดอร์หลายสถานะ
      const confirmed = await awaitingOrder();
      await adminTransition(db, { orderId: confirmed.order.id, intent: { type: "confirm" }, actor: OWNER_ACTOR });
      const waiting = await awaitingOrder();

      const pendingCode = nextCode();
      await makeItem(pendingCode);
      const pending = await reserveItem(store, input(pendingCode));
      if (!pending.ok) throw new Error("setup");
      await db.execute(sql`UPDATE orders SET expires_at = now() - interval '2 minutes' WHERE id = ${pending.order.id}`);

      const rejected = await awaitingOrder();
      await adminTransition(db, { orderId: rejected.order.id, intent: { type: "reject", reason: "x" }, actor: OWNER_ACTOR });

      const mine = new Set([confirmed.order.id, waiting.order.id, pending.order.id, rejected.order.id]);
      const all = await getAdminDashboard(OWNER, "all");
      const rows = all.orders.filter((o) => mine.has(o.id));
      expect(rows).toHaveLength(4);

      // ลำดับต้องไม่ผิดไปจาก STATUS_PRIORITY (awaiting_review ก่อนเสมอ)
      const prios = rows.map((r) => STATUS_PRIORITY[r.status]);
      expect(prios).toEqual([...prios].sort((x, y) => x - y));
      expect(rows[0].id).toBe(waiting.order.id);
      expect(rows[0].status).toBe("awaiting_review");
      // และก่อนแถวอื่นทั้งหมดในหน้าทั้งก้อน (รวมออเดอร์อื่นในฐานข้อมูล)
      const firstNonAwaiting = all.orders.findIndex((o) => o.status !== "awaiting_review");
      const lastAwaiting = all.orders.map((o) => o.status).lastIndexOf("awaiting_review");
      if (firstNonAwaiting !== -1) expect(lastAwaiting).toBeLessThan(firstNonAwaiting);

      const pendingRow = rows.find((r) => r.id === pending.order.id)!;
      expect(pendingRow.status).toBe("expired");
      expect(pendingRow.statusLabel).toBe("หมดเวลา");
      expect((await getOrder(pending.order.id)).status).toBe("pending_payment"); // ค่าดิบยังเป็น pending แต่ UI ไม่แสดงดิบ

      // แท็บ: review มีเฉพาะ awaiting_review; closed มี expired+rejected
      const review = await getAdminDashboard(OWNER, "review");
      expect(review.orders.every((o) => o.status === "awaiting_review")).toBe(true);
      expect(review.orders.some((o) => o.id === waiting.order.id)).toBe(true);
      const closed = await getAdminDashboard(OWNER, "closed");
      const closedIds = new Set(closed.orders.map((o) => o.id));
      expect(closedIds.has(pending.order.id)).toBe(true);
      expect(closedIds.has(rejected.order.id)).toBe(true);
      expect(closedIds.has(waiting.order.id)).toBe(false);
      expect(all.counts.all).toBeGreaterThanOrEqual(4);
      expect(all.counts.review).toBeGreaterThanOrEqual(1);
    });

    it("demo: ข้อมูลลูกค้าถูก mask ที่ชั้น query (ค่าจริงไม่อยู่ใน DTO) และเห็นสลิปเฉพาะของ sid ตัวเอง", async () => {
      const mine = await awaitingOrder({ deliveryMethod: "post", address: REAL_ADDRESS, note: "โน้ตลับ" }, SID);
      const others = await awaitingOrder({ deliveryMethod: "post", address: REAL_ADDRESS }, "J".repeat(40));

      const d = await getAdminOrderDetail(DEMO, mine.order.id);
      expect(d).not.toBeNull();
      expect(d!.order.customerName).toBe("ส***");
      expect(d!.order.phone).toBe("08x-xxx-xx77");
      expect(d!.order.slipVisible).toBe(true);
      const json = JSON.stringify(d);
      for (const s of [REAL_NAME, "สมหญิง", REAL_PHONE, "1/2 ซอยลับ", "โน้ตลับ", `slips/${mine.order.id}`]) {
        expect(json).not.toContain(s);
      }

      const od = await getAdminOrderDetail(DEMO, others.order.id);
      expect(od!.order.slipVisible).toBe(false);
      expect(od!.order.hasSlip).toBe(true);
      expect(JSON.stringify(od)).not.toContain(REAL_NAME);

      // dashboard ของ demo ก็ mask
      const dash = await getAdminDashboard(DEMO, "all");
      const row = dash.orders.find((o) => o.id === mine.order.id)!;
      expect(row.customerName).toBe("ส***");
      // รายการใน dashboard ต้องไม่มีค่าจริงของชื่อ/เบอร์/ที่อยู่/หมายเหตุ และไม่มี path สลิป (ทั้งของตัวเองและของคนอื่น)
      const dashJson = JSON.stringify(dash.orders.filter((o) => [mine.order.id, others.order.id].includes(o.id)));
      for (const s of [REAL_NAME, "สมหญิง", REAL_PHONE, REAL_ADDRESS, "1/2 ซอยลับ", "โน้ตลับ", "slips/"]) {
        expect(dashJson, "dashboard ของ demo ต้องไม่มี: " + s).not.toContain(s);
      }
      expect(row.phone).toBe("08x-xxx-xx77");
      expect(row.address).not.toBe(REAL_ADDRESS);
      // ยืนยันว่า payload ของ owner มีค่าจริงจริง (กันเทสต์ผ่านเพราะข้อมูลไม่มีอยู่)
      const ownerDash = await getAdminDashboard(OWNER, "all");
      const ownerJson = JSON.stringify(ownerDash.orders.filter((o) => o.id === mine.order.id));
      expect(ownerJson).toContain(REAL_PHONE);
      expect(ownerJson).toContain(REAL_ADDRESS);

      // owner เห็นค่าจริง
      const ownerView = await getAdminOrderDetail(OWNER, others.order.id);
      expect(ownerView!.order.customerName).toBe(REAL_NAME);
      expect(ownerView!.order.phone).toBe(REAL_PHONE);
      expect(ownerView!.order.address).toBe(REAL_ADDRESS);
      expect(ownerView!.order.slipVisible).toBe(true);

      // ข้อมูลสำหรับ proxy สลิปมี slipPath/demoSessionId จริง (ใช้ฝั่ง server เท่านั้น)
      const rec = await getSlipRecord(mine.order.id);
      expect(rec).toEqual({ slipPath: `slips/${mine.order.id}/test.jpg`, demoSessionId: SID });
    });

    it("timeline ของหลังบ้านไม่แสดง slip_token_issued และไม่ปนข้อมูลภายใน", async () => {
      const code = nextCode();
      await makeItem(code);
      const r = await reserveItem(store, input(code));
      if (!r.ok) throw new Error("setup");
      expect((await reserveSlipTokenSlot(db, r.order.token)).ok).toBe(true);
      expect((await reserveSlipTokenSlot(db, r.order.token)).ok).toBe(true);
      await uploadSlip(db, { token: r.order.token, slipPath: `slips/${r.order.id}/t.jpg` });

      // ใน DB มี event ภายอยู่จริง 2 รายการ
      const raw = await eventsOf(r.order.id);
      expect(raw.filter((e) => e.type === "slip_token_issued")).toHaveLength(2);

      const d = await getAdminOrderDetail(OWNER, r.order.id);
      expect(d!.timeline.map((t) => t.label)).toEqual(["ลูกค้าจองสินค้า", "ลูกค้าส่งสลิป"]);
      expect(JSON.stringify(d!.timeline)).not.toContain("slip_token");
    });

    it("สถานะสินค้าในรายละเอียดใช้ resolveDisplayStatus: หลัง reject เป็น 'available', ระหว่างรอตรวจเป็น 'reserved'", async () => {
      const { order } = await awaitingOrder();
      expect((await getAdminOrderDetail(OWNER, order.id))!.order.item.display).toBe("reserved");
      await adminTransition(db, { orderId: order.id, intent: { type: "reject", reason: "x" }, actor: OWNER_ACTOR });
      expect((await getAdminOrderDetail(OWNER, order.id))!.order.item.display).toBe("available");
      expect((await getAdminOrderDetail(OWNER, "00000000-0000-4000-8000-000000000000"))).toBeNull();
    });
  });
});
