import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { items, orderEvents, orders } from "@/db/schema";
import { getAdminDashboard, getAdminOrderDetail } from "@/lib/admin/queries";
import { changeItemStatus } from "@/lib/admin/item-commands";
import type { AdminTabKey } from "@/lib/admin/view";
import type { AdminSession } from "@/lib/auth";
import {
  DEMO_ORDER_RETURN_MINUTES,
  holdingOrderExistsSql,
  resolveDisplayStatus,
} from "@/lib/availability";
import { hashClientIp } from "@/lib/client-ip";
import { adminTransition } from "@/lib/orders/admin-commands";
import { uploadSlip } from "@/lib/orders/commands";
import { getCustomerOrder, getOrderStatusSnapshot } from "@/lib/orders/queries";
import { buildTimeline, describeOrder } from "@/lib/orders/view";
import { MAX_HOLDING_PER_IP } from "@/lib/rate-limit";
import { createDrizzleReserveStore, reserveItem } from "@/lib/reserve";
import type { CreateOrderInput } from "@/lib/validation";

/**
 * Integration test กับ Postgres (Neon) จริง: ออเดอร์ที่ role demo ยืนยัน "คืนสินค้าเข้าร้านเอง" (ขั้น 5-fix)
 *
 * ปัญหาเดิม: ผู้ลองเดโมกด จอง → ใช้สลิปตัวอย่าง → ลองหลังบ้านแบบเดโม → ยืนยัน ทำให้สินค้าเป็น sold ถาวรและ
 * owner คืนไม่ได้ — ผู้ชมไม่กี่คนก็ทำให้ทั้งร้านหมด
 *
 * ครอบคลุม:
 *  - demo ยืนยัน 9 ใบจาก IP เดียว: ภายใน N นาทีของไม่หมด (ชั้น IP ถือสินค้า <= 3 นับออเดอร์เดโมที่ยืนยันแล้วด้วย)
 *  - ครบ N นาที (ย้อนเวลา confirmed_at/reserved_until ใน DB — ตรรกะตัดสินด้วย now() ของ DB) สินค้ากลับว่างจริงและจองใหม่ได้
 *    พร้อมเทียบขอบเขตเวลา (N-2 วินาที ยังถือ / N+2 วินาที คืนแล้ว)
 *  - owner ยืนยันแล้วไม่คืนเอง (รวมแถวเก่าที่ confirmed_by_role เป็น NULL) และไม่นับเข้าเพดานถือสินค้าต่อ IP
 *  - race: ออเดอร์เดโมหมดเวลากับการจองใหม่พร้อมกัน → จองสำเร็จได้คนเดียว ไม่ขายซ้ำ และ ship/complete ของออเดอร์เดโมที่สิ้นสุด
 *    ไม่ทับสถานะสินค้าของออเดอร์ใหม่
 *  - owner คืนสินค้า (return) ทำได้ / demo ทำไม่ได้ / compare-and-set (กดพร้อมกันสำเร็จครั้งเดียว) / ต้องมีเหตุผล / event
 *  - dashboard + หน้าลูกค้า: ออเดอร์เดโมที่สิ้นสุดแสดงเป็น demo_ended ไม่ค้างเป็น confirmed และแท็บ/ตัวนับถูกต้อง
 *
 * ใช้รหัสสินค้า X601-X660 เท่านั้น ลบเฉพาะแถวของตัวเองก่อน/หลังรัน — ห้ามแตะ seed
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);
if (!HAS_DB) {
  console.warn("[integration] ข้ามเทสต์: ไม่พบ DATABASE_URL (รันผ่าน `npm run test:integration`)");
}

const CODES = Array.from({ length: 60 }, (_, i) => `X${601 + i}`);
let seq = 0;
const nextCode = () => {
  if (seq >= CODES.length) throw new Error("test codes exhausted");
  return CODES[seq++];
};

const OWNER: AdminSession = { role: "owner" };
const demoActor = (sid: string): AdminSession => ({ role: "demo", sid });
let sidSeq = 0;
const newSid = () => `it-ret-${Date.now().toString(36)}-${++sidSeq}-`.padEnd(40, "x");
// IPv4 ที่ถูกต้องและต่างกันเสมอ (198.19.x.y) — ไม่ชนช่วง 198.18 ของ rate-limit-ip.pg.test.ts
const ip = (n: number) => hashClientIp(`198.19.${Math.floor(n / 256)}.${n % 256}`);
let ipSeq = 1000;
const nextIp = () => ip(++ipSeq);

const input = (code: string): CreateOrderInput => ({
  code,
  customerName: "สมหญิง รักดี",
  phone: "0899998877",
  deliveryMethod: "pickup",
});

const N_SECONDS = DEMO_ORDER_RETURN_MINUTES * 60;

describe.skipIf(!HAS_DB)("ออเดอร์เดโมคืนสินค้าเข้าร้านเอง บน Postgres จริง", () => {
  const db = HAS_DB ? getDb() : (undefined as never);
  const store = HAS_DB ? createDrizzleReserveStore(db) : (undefined as never);

  async function cleanup() {
    const ids = (await db.select({ id: items.id }).from(items).where(inArray(items.code, CODES))).map((r) => r.id);
    if (ids.length === 0) return;
    const orderIds = (await db.select({ id: orders.id }).from(orders).where(inArray(orders.itemId, ids))).map((r) => r.id);
    if (orderIds.length > 0) {
      await db.delete(orderEvents).where(inArray(orderEvents.orderId, orderIds));
      await db.delete(orders).where(inArray(orders.id, orderIds));
    }
    await db.delete(items).where(inArray(items.id, ids));
  }

  async function makeItem(code: string) {
    await db.insert(items).values({
      code,
      title: `ทดสอบคืนสินค้า ${code}`,
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
  const ordersOfItem = async (code: string) => {
    const it = await getItem(code);
    return db.select().from(orders).where(eq(orders.itemId, it.id));
  };

  /** สถานะที่ลูกค้าเห็นบนหน้าร้าน — ใช้นิยามกลางเดียวกับ lib/items.ts (holdingOrderExistsSql + resolveDisplayStatus) */
  async function live(code: string) {
    const [r] = await db
      .select({
        status: items.status,
        lapsed: sql<boolean>`coalesce(${items.reservedUntil} < now(), false)`,
        held: sql<boolean>`${holdingOrderExistsSql(sql`${items.id}`)}`,
      })
      .from(items)
      .where(eq(items.code, code));
    return resolveDisplayStatus(r);
  }

  /** สร้างสินค้า + จอง + ส่งสลิปตัวอย่าง → ออเดอร์ awaiting_review */
  async function awaiting(opts: { sid?: string; ipHash?: string; code?: string } = {}) {
    const code = opts.code ?? nextCode();
    if (!opts.code) await makeItem(code);
    const sid = opts.sid ?? newSid();
    const r = await reserveItem(store, input(code), sid, { clientIpHash: opts.ipHash ?? nextIp() });
    if (!r.ok) throw new Error(`reserve failed in setup: ${r.reason}`);
    const up = await uploadSlip(db, { token: r.order.token, slipPath: `slips/${r.order.id}/test.jpg` });
    if (!up.ok) throw new Error("uploadSlip failed in setup");
    return { code, sid, order: r.order };
  }

  async function demoConfirmed(opts: { sid?: string; ipHash?: string; code?: string } = {}) {
    const a = await awaiting(opts);
    const res = await adminTransition(db, { orderId: a.order.id, intent: { type: "confirm" }, actor: demoActor(a.sid) });
    expect(res).toEqual({ ok: true, from: "awaiting_review", to: "confirmed" });
    return a;
  }

  async function ownerConfirmed(opts: { sid?: string; ipHash?: string; code?: string } = {}) {
    const a = await awaiting(opts);
    const res = await adminTransition(db, { orderId: a.order.id, intent: { type: "confirm" }, actor: OWNER });
    expect(res).toEqual({ ok: true, from: "awaiting_review", to: "confirmed" });
    return a;
  }

  /**
   * จำลองเวลาผ่านไป: เลื่อน confirmed_at ย้อนหลัง `secondsAgo` วินาที และ (ถ้าสินค้ายังถูกกันแบบเดโม) เลื่อน reserved_until
   * ให้เป็น confirmed_at + N เหมือนที่ระบบตั้งตอนยืนยัน — ตรรกะจริงตัดสินด้วย now() ของ DB เหมือนเดิมทุกประการ
   */
  async function age(orderId: string, secondsAgo: number) {
    await db.execute(sql`UPDATE orders SET confirmed_at = now() - make_interval(secs => ${secondsAgo}) WHERE id = ${orderId}`);
    await db.execute(sql`
      UPDATE items SET reserved_until = (SELECT confirmed_at FROM orders WHERE id = ${orderId})
                                        + make_interval(mins => ${DEMO_ORDER_RETURN_MINUTES})
      WHERE id = (SELECT item_id FROM orders WHERE id = ${orderId}) AND status = 'reserved'`);
  }

  const freshReserve = (code: string) => reserveItem(store, input(code), newSid(), { clientIpHash: nextIp() });

  beforeAll(cleanup);
  afterAll(cleanup);

  it("demo ยืนยัน: ออเดอร์จำ role ผู้ยืนยัน, สินค้าถูกกัน (reserved ถึง confirmed_at + N) ไม่ใช่ sold, มี event ระบุ role", async () => {
    const { code, order } = await demoConfirmed();
    const o = await getOrder(order.id);
    expect(o.status).toBe("confirmed");
    expect(o.confirmedByRole).toBe("demo");
    expect(o.confirmedAt).not.toBeNull();

    const item = await getItem(code);
    expect(item.status).toBe("reserved");
    // reserved_until = confirmed_at + N นาที เป๊ะ (ทั้งสองมาจาก now() ของ transaction เดียว)
    expect(item.reservedUntil!.getTime() - o.confirmedAt!.getTime()).toBe(N_SECONDS * 1000);

    expect(await live(code)).toBe("reserved");
    expect(await freshReserve(code)).toMatchObject({ ok: false, reason: "unavailable" });
    const ev = (await eventsOf(order.id)).find((e) => e.type === "confirm")!;
    expect(ev.meta).toMatchObject({ adminRole: "demo" });
  });

  it("owner ยืนยัน: confirmed_by_role = owner, สินค้า sold ถาวร (reserved_until NULL) และไม่คืนเองแม้ผ่านไปหลายวัน", async () => {
    const { code, order } = await ownerConfirmed();
    expect((await getOrder(order.id)).confirmedByRole).toBe("owner");
    const item = await getItem(code);
    expect(item.status).toBe("sold");
    expect(item.reservedUntil).toBeNull();

    await age(order.id, 3 * 24 * 3600);
    expect(await live(code)).toBe("sold");
    expect(await freshReserve(code)).toMatchObject({ ok: false, reason: "unavailable" });
    expect((await getItem(code)).status).toBe("sold");

    // แถวเก่าที่ยืนยันก่อนมีคอลัมน์ (confirmed_by_role = NULL) ถือเป็นขายถาวรเช่นกัน
    const legacy = await ownerConfirmed();
    await db.execute(sql`UPDATE orders SET confirmed_by_role = NULL WHERE id = ${legacy.order.id}`);
    await age(legacy.order.id, 3 * 24 * 3600);
    expect(await live(legacy.code)).toBe("sold");
    expect(await freshReserve(legacy.code)).toMatchObject({ ok: false, reason: "unavailable" });
  });

  it("demo ยืนยัน 9 ใบจาก IP เดียว: ภายใน N นาทีถือสินค้าได้ไม่เกิน 3 ชิ้น ของที่เหลือยังจองได้ครบ", async () => {
    const SAME_IP = nextIp();
    const codes = Array.from({ length: 12 }, () => nextCode());
    for (const c of codes) await makeItem(c);

    const outcomes: string[] = [];
    const held: { code: string; orderId: string }[] = [];
    for (let i = 0; i < 9; i++) {
      // ลบ cookie / login ใหม่ทุกรอบ = sid ใหม่ แต่ IP เดิม (วิธีหลบ rate limit ต่อ sid ในรายงานรีวิว)
      const sid = newSid();
      const r = await reserveItem(store, input(codes[i]), sid, { clientIpHash: SAME_IP });
      if (!r.ok) {
        outcomes.push(r.reason);
        continue;
      }
      await uploadSlip(db, { token: r.order.token, slipPath: `slips/${r.order.id}/test.jpg` });
      const c = await adminTransition(db, { orderId: r.order.id, intent: { type: "confirm" }, actor: demoActor(sid) });
      expect(c.ok).toBe(true);
      outcomes.push("ok");
      held.push({ code: codes[i], orderId: r.order.id });
    }
    expect(outcomes).toEqual([
      ...Array(MAX_HOLDING_PER_IP).fill("ok"),
      ...Array(9 - MAX_HOLDING_PER_IP).fill("ip_too_many_holding"),
    ]);
    expect(held).toHaveLength(MAX_HOLDING_PER_IP);

    // ของไม่หมด: อย่างน้อย 12 - 3 = 9 ชิ้นยังว่างจริง และจองได้ (คนละ IP)
    const free = codes.filter((c) => !held.some((h) => h.code === c));
    expect(free).toHaveLength(12 - MAX_HOLDING_PER_IP);
    for (const c of free) expect(await live(c)).toBe("available");
    const results = await Promise.all(free.map((c) => freshReserve(c)));
    expect(results.every((r) => r.ok)).toBe(true);
    // ชิ้นที่ถูกกันโดยออเดอร์เดโมจองไม่ได้ระหว่างช่วง N นาที
    for (const h of held) {
      expect(await live(h.code)).toBe("reserved");
      expect(await freshReserve(h.code)).toMatchObject({ ok: false, reason: "unavailable" });
    }

    // ครบ N นาที: IP เดิมถือสินค้าได้อีก (ออเดอร์เดโมไม่นับแล้ว) และสินค้า 3 ชิ้นกลับว่างจริง
    for (const h of held) await age(h.orderId, N_SECONDS + 2);
    for (const h of held) {
      expect(await live(h.code)).toBe("available");
    }
    const again = await reserveItem(store, input(held[0].code), newSid(), { clientIpHash: SAME_IP });
    expect(again.ok).toBe(true);
  });

  it("ชั้นถือสินค้าต่อ IP นับเฉพาะออเดอร์เดโม ไม่นับออเดอร์ที่ owner ยืนยัน (ลูกค้าจริงซื้อหลายชิ้นได้)", async () => {
    const SAME_IP = nextIp();
    for (let i = 0; i < MAX_HOLDING_PER_IP + 1; i++) await ownerConfirmed({ ipHash: SAME_IP });
    const code = nextCode();
    await makeItem(code);
    const r = await reserveItem(store, input(code), newSid(), { clientIpHash: SAME_IP });
    expect(r.ok).toBe(true);
  });

  it("ขอบเขตเวลา: N-30 วินาทียังถือสินค้า (จองไม่ได้ ถือ item_held) / N+2 วินาทีคืนแล้ว (จองได้ owner เปลี่ยนสถานะได้) — ใช้ now() ของ DB", async () => {
    const inside = await demoConfirmed();
    await age(inside.order.id, N_SECONDS - 30);
    expect(await live(inside.code)).toBe("reserved");
    expect(await freshReserve(inside.code)).toMatchObject({ ok: false, reason: "unavailable" });
    const itemInside = await getItem(inside.code);
    expect(await changeItemStatus(db, { id: itemInside.id, status: "hidden" })).toEqual({ ok: false, error: "item_held" });

    const outside = await demoConfirmed();
    await age(outside.order.id, N_SECONDS + 2);
    expect(await live(outside.code)).toBe("available");
    // ค่าที่เก็บของออเดอร์ไม่ถูกเขียนทับตามเวลา (lazy): ยังเป็น confirmed
    expect((await getOrder(outside.order.id)).status).toBe("confirmed");
    const itemOutside = await getItem(outside.code);
    expect(itemOutside.status).toBe("reserved"); // แถวสินค้ายังไม่ถูกแตะ — คืนด้วยกฎ lazy expiry
    // owner เปลี่ยนสถานะสินค้าได้แล้ว (ไม่ถูกบล็อกด้วย item_held)
    expect(await changeItemStatus(db, { id: itemOutside.id, status: "hidden" })).toEqual({ ok: true, changed: true });
    expect((await getItem(outside.code)).status).toBe("hidden");
  });

  it("หลังครบ N นาที: สินค้ากลับ available จริง จองใหม่สำเร็จ (ออเดอร์ใหม่ + reserved_until ใหม่) และออเดอร์เดโมเดิมไม่ถือสินค้าอีก", async () => {
    const { code, order } = await demoConfirmed();
    await age(order.id, N_SECONDS + 2);
    const r = await freshReserve(code);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const item = await getItem(code);
    expect(item.status).toBe("reserved");
    expect(item.reservedUntil!.getTime()).toBe(r.order.expiresAt.getTime());
    const all = await ordersOfItem(code);
    expect(all).toHaveLength(2);
    expect(all.filter((o) => o.status === "pending_payment")).toHaveLength(1);
    // ออเดอร์ใหม่ยืนยันโดย owner ได้ตามปกติ → sold ถาวร
    await uploadSlip(db, { token: r.order.token, slipPath: `slips/${r.order.id}/n.jpg` });
    expect(await adminTransition(db, { orderId: r.order.id, intent: { type: "confirm" }, actor: OWNER })).toMatchObject({ ok: true });
    expect((await getItem(code)).status).toBe("sold");
  });

  it("race: ออเดอร์เดโมหมดเวลา + จองใหม่พร้อมกัน 10 คำขอ → สำเร็จ 1 ที่เหลือ unavailable, ออเดอร์รวม 2 ใบ, ไม่เป็น sold", async () => {
    const { code, order } = await demoConfirmed();
    await age(order.id, N_SECONDS + 2);
    const results = await Promise.all(Array.from({ length: 10 }, () => freshReserve(code)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === "unavailable")).toHaveLength(9);
    expect(await ordersOfItem(code)).toHaveLength(2);
    expect((await getItem(code)).status).toBe("reserved");
  });

  it("ออเดอร์เดโมที่สิ้นสุดแล้ว ship/complete/return ไม่ได้ (demo_ended) และไม่ทับสินค้าที่คนอื่นจองไปแล้ว — แม้ยิงพร้อมกับการจองใหม่", async () => {
    // pickup: complete ได้ตอนยังอยู่ในช่วงถือ — ต้องไม่แตะสินค้า
    const live1 = await demoConfirmed();
    const done = await adminTransition(db, { orderId: live1.order.id, intent: { type: "complete" }, actor: demoActor(live1.sid) });
    expect(done).toEqual({ ok: true, from: "confirmed", to: "completed" });
    const itemAfterComplete = await getItem(live1.code);
    expect(itemAfterComplete.status).toBe("reserved");
    expect(itemAfterComplete.reservedUntil).not.toBeNull();
    expect(await live(live1.code)).toBe("reserved");

    // สิ้นสุดแล้ว + มีคนจองใหม่ + คำสั่งเก่ายิงเข้ามาพร้อมกัน
    const ended = await demoConfirmed();
    await age(ended.order.id, N_SECONDS + 2);
    const attempts = await Promise.all([
      ...Array.from({ length: 4 }, () => freshReserve(ended.code)),
      adminTransition(db, { orderId: ended.order.id, intent: { type: "complete" }, actor: demoActor(ended.sid) }),
      adminTransition(db, { orderId: ended.order.id, intent: { type: "complete" }, actor: OWNER }),
      adminTransition(db, { orderId: ended.order.id, intent: { type: "return", reason: "ลองคืน" }, actor: OWNER }),
    ]);
    const reserves = attempts.slice(0, 4) as Awaited<ReturnType<typeof freshReserve>>[];
    expect(reserves.filter((r) => r.ok)).toHaveLength(1);
    for (const a of attempts.slice(4) as Awaited<ReturnType<typeof adminTransition>>[]) {
      expect(a).toMatchObject({ ok: false, error: "demo_ended", status: "confirmed" });
    }
    // สินค้าอยู่ในมือผู้จองใหม่ ไม่ถูกเปลี่ยนเป็น sold / available
    const item = await getItem(ended.code);
    expect(item.status).toBe("reserved");
    const winner = reserves.find((r) => r.ok);
    if (!winner || !winner.ok) throw new Error("expected one winner");
    expect(item.reservedUntil!.getTime()).toBe(winner.order.expiresAt.getTime());
    const o = await getOrder(ended.order.id);
    expect(o.status).toBe("confirmed");
    expect((await eventsOf(ended.order.id)).filter((e) => e.type !== "created" && e.type !== "upload_slip" && e.type !== "confirm")).toHaveLength(0);
  });

  describe("owner คืนสินค้าเข้าร้าน (return)", () => {
    it.each([
      ["confirmed (owner ยืนยัน)", async () => ownerConfirmed()],
      [
        "shipped (owner ยืนยัน + จัดส่ง)",
        async () => {
          const code = nextCode();
          await makeItem(code);
          const r = await reserveItem(store, { ...input(code), deliveryMethod: "post", address: "1/2 ซอยทดสอบ กรุงเทพฯ" }, newSid(), {
            clientIpHash: nextIp(),
          });
          if (!r.ok) throw new Error("setup");
          await uploadSlip(db, { token: r.order.token, slipPath: `slips/${r.order.id}/s.jpg` });
          await adminTransition(db, { orderId: r.order.id, intent: { type: "confirm" }, actor: OWNER });
          await adminTransition(db, { orderId: r.order.id, intent: { type: "ship", trackingNo: "TH123456789" }, actor: OWNER });
          return { code, sid: "", order: r.order };
        },
      ],
      [
        "completed (owner ยืนยัน + ปิดงาน)",
        async () => {
          const a = await ownerConfirmed();
          await adminTransition(db, { orderId: a.order.id, intent: { type: "complete" }, actor: OWNER });
          return a;
        },
      ],
      ["confirmed ที่ demo ยืนยัน (ยังอยู่ในช่วงถือ)", async () => demoConfirmed()],
    ])("%s → cancelled + สินค้า available ทันที + เหตุผล/event + จองใหม่ได้", async (_label, setup) => {
      const { code, order } = await setup();
      const res = await adminTransition(db, {
        orderId: order.id,
        intent: { type: "return", reason: "  ลูกค้าขอคืนของ  " },
        actor: OWNER,
      });
      expect(res).toMatchObject({ ok: true, to: "cancelled" });

      const o = await getOrder(order.id);
      expect(o.status).toBe("cancelled");
      expect(o.rejectReason).toBe("ลูกค้าขอคืนของ");
      const item = await getItem(code);
      expect(item.status).toBe("available");
      expect(item.reservedUntil).toBeNull();

      const ev = (await eventsOf(order.id)).filter((e) => e.type === "return");
      expect(ev).toHaveLength(1);
      expect(ev[0].actor).toBe("admin");
      expect(ev[0].meta).toEqual({ reason: "ลูกค้าขอคืนของ", adminRole: "owner" });

      // ลูกค้าเห็นว่าร้านเป็นคนยกเลิก พร้อมเหตุผล
      const c = (await getCustomerOrder(order.token))!;
      const view = describeOrder({
        status: c.status,
        deliveryMethod: c.deliveryMethod,
        expiresAtMs: c.expiresAt.getTime(),
        nowMs: c.dbNow.getTime(),
        rejectReason: c.rejectReason,
        demoEnded: c.demoEnded,
      });
      expect(view.headline).toContain("ร้านยกเลิกออเดอร์");
      expect(view.body).toBe("เหตุผล: ลูกค้าขอคืนของ");
      const tl = buildTimeline(c.events.map((e) => ({ type: e.type, meta: e.meta, createdAtMs: e.createdAt.getTime() })));
      expect(tl.find((t) => t.label.includes("คืนสินค้าเข้าร้าน"))?.detail).toBe("ลูกค้าขอคืนของ");

      expect((await freshReserve(code)).ok).toBe(true);
    });

    it("demo คืนสินค้าไม่ได้ (owner_only) แม้เป็นออเดอร์ตัวเอง/ที่ตัวเองยืนยัน: สถานะ สินค้า และ event ไม่เปลี่ยน", async () => {
      const own = await demoConfirmed();
      const before = await getItem(own.code);
      const eventsBefore = (await eventsOf(own.order.id)).length;
      const res = await adminTransition(db, {
        orderId: own.order.id,
        intent: { type: "return", reason: "ขอคืนเอง" },
        actor: demoActor(own.sid),
      });
      expect(res).toEqual({ ok: false, error: "owner_only" });
      expect((await getOrder(own.order.id)).status).toBe("confirmed");
      const after = await getItem(own.code);
      expect(after.status).toBe(before.status);
      expect(after.reservedUntil!.getTime()).toBe(before.reservedUntil!.getTime());
      expect((await eventsOf(own.order.id)).length).toBe(eventsBefore);

      // ออเดอร์ที่ owner ยืนยัน (sold) — demo ใดๆ คืนไม่ได้
      const sold = await ownerConfirmed();
      for (const actor of [demoActor(sold.sid), demoActor(newSid())]) {
        expect(await adminTransition(db, { orderId: sold.order.id, intent: { type: "return", reason: "แกล้ง" }, actor })).toEqual({
          ok: false,
          error: "owner_only",
        });
      }
      expect((await getOrder(sold.order.id)).status).toBe("confirmed");
      expect((await getItem(sold.code)).status).toBe("sold");
    });

    it("ต้องมีเหตุผล; ก่อนยืนยัน (awaiting_review) คืนไม่ได้; คืนซ้ำไม่ได้; ออเดอร์เดโมที่สิ้นสุดแล้วคืนไม่ได้ (demo_ended)", async () => {
      const a = await ownerConfirmed();
      expect(await adminTransition(db, { orderId: a.order.id, intent: { type: "return", reason: "   " }, actor: OWNER })).toMatchObject({
        ok: false,
        error: "reason_required",
      });
      expect((await getOrder(a.order.id)).status).toBe("confirmed");
      expect((await getItem(a.code)).status).toBe("sold");

      const waiting = await awaiting();
      expect(await adminTransition(db, { orderId: waiting.order.id, intent: { type: "return", reason: "x" }, actor: OWNER })).toMatchObject({
        ok: false,
        error: "invalid_state",
        status: "awaiting_review",
      });
      expect((await getItem(waiting.code)).status).toBe("reserved");

      expect(await adminTransition(db, { orderId: a.order.id, intent: { type: "return", reason: "ครั้งแรก" }, actor: OWNER })).toMatchObject({ ok: true });
      expect(await adminTransition(db, { orderId: a.order.id, intent: { type: "return", reason: "ครั้งที่สอง" }, actor: OWNER })).toMatchObject({
        ok: false,
        error: "invalid_state",
        status: "cancelled",
      });
      expect((await getOrder(a.order.id)).rejectReason).toBe("ครั้งแรก");

      const ended = await demoConfirmed();
      await age(ended.order.id, N_SECONDS + 2);
      expect(await adminTransition(db, { orderId: ended.order.id, intent: { type: "return", reason: "x" }, actor: OWNER })).toMatchObject({
        ok: false,
        error: "demo_ended",
      });
      expect((await getOrder(ended.order.id)).status).toBe("confirmed");
    });

    it("compare-and-set: owner กดคืนพร้อมกัน 6 คำขอ → สำเร็จ 1, event return เดียว, สินค้า available; ไม่ปล่อยทับถ้ามีคนจองต่อ", async () => {
      const { code, order } = await ownerConfirmed();
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          adminTransition(db, { orderId: order.id, intent: { type: "return", reason: `คำขอ ${i}` }, actor: OWNER }),
        ),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok && r.error === "invalid_state")).toHaveLength(5);
      expect((await eventsOf(order.id)).filter((e) => e.type === "return")).toHaveLength(1);
      expect((await getItem(code)).status).toBe("available");

      // คนใหม่จองต่อ แล้ว return เดิมถูกยิงซ้ำ: ต้องไม่ปล่อยสินค้าของผู้จองใหม่
      const r = await freshReserve(code);
      expect(r.ok).toBe(true);
      const late = await adminTransition(db, { orderId: order.id, intent: { type: "return", reason: "ซ้ำ" }, actor: OWNER });
      expect(late).toMatchObject({ ok: false, error: "invalid_state" });
      const item = await getItem(code);
      expect(item.status).toBe("reserved");
      expect(await freshReserve(code)).toMatchObject({ ok: false, reason: "unavailable" });
    });

    it("return กับ complete พร้อมกัน: ผู้ชนะ compare-and-set มีคนเดียว สินค้ากับออเดอร์สอดคล้องเสมอ (ไม่มีสินค้า available ทั้งที่ออเดอร์ยังถือ)", async () => {
      const { code, order } = await ownerConfirmed();
      await Promise.all([
        adminTransition(db, { orderId: order.id, intent: { type: "return", reason: "คืน" }, actor: OWNER }),
        adminTransition(db, { orderId: order.id, intent: { type: "complete" }, actor: OWNER }),
      ]);
      const o = await getOrder(order.id);
      const item = await getItem(code);
      if (o.status === "cancelled") {
        expect(item.status).toBe("available");
      } else {
        // complete ชนะ: return ที่อ่านสถานะ confirmed ไว้แพ้ CAS (invalid_state) จึงต้องไม่ปล่อยสินค้าทั้งที่ออเดอร์ยัง completed
        expect(o.status).toBe("completed");
        expect(item.status).toBe("sold");
      }
    });
  });

  describe("หลังบ้านและหน้าลูกค้า แสดงออเดอร์เดโมที่สิ้นสุดแล้วถูกต้อง", () => {
    const counts = async () => {
      const all = await getAdminDashboard(OWNER, "all");
      return all.counts;
    };

    it("dashboard: ไม่ค้างเป็น confirmed ปลอม — ย้ายไปแท็บ 'ปิดแล้ว' และตัวนับถูกต้อง; owner ที่ยืนยันยังเป็น confirmed", async () => {
      const base = await counts();
      const ownerOrder = await ownerConfirmed();
      const demoLive = await demoConfirmed();
      const demoDone = await demoConfirmed();
      await age(demoDone.order.id, N_SECONDS + 2);
      // ผ่านไปนานแต่ owner ยืนยัน → ยังเป็น confirmed
      await age(ownerOrder.order.id, 5 * 24 * 3600);

      const c = await counts();
      const delta = (k: AdminTabKey) => c[k] - base[k];
      expect(delta("all")).toBe(3);
      expect(delta("confirmed")).toBe(2); // owner ยืนยัน + เดโมที่ยังอยู่ในช่วงถือ (ไม่นับเดโมที่สิ้นสุด)
      expect(delta("closed")).toBe(1); // เดโมสิ้นสุด
      expect(delta("shipped")).toBe(0);
      expect(delta("completed")).toBe(0);
      expect(delta("review")).toBe(0);

      const closed = await getAdminDashboard(OWNER, "closed");
      const row = closed.orders.find((o) => o.id === demoDone.order.id)!;
      expect(row.status).toBe("demo_ended");
      expect(row.statusLabel).toContain("เดโมสิ้นสุดแล้ว");
      expect(row.actions).toEqual([]);
      expect(row.demoReturnAtMs).not.toBeNull();
      expect(row.item.display).toBe("available");

      const confirmedTab = await getAdminDashboard(OWNER, "confirmed");
      const ids = confirmedTab.orders.map((o) => o.id);
      expect(ids).toContain(ownerOrder.order.id);
      expect(ids).toContain(demoLive.order.id);
      expect(ids).not.toContain(demoDone.order.id);

      // เดโมที่ยังอยู่ในช่วงถือ: เห็น action สำหรับ owner รวมคืนสินค้า, สินค้า "มีคนจองอยู่"
      const liveRow = confirmedTab.orders.find((o) => o.id === demoLive.order.id)!;
      expect(liveRow.status).toBe("confirmed");
      expect(liveRow.actions).toEqual(["complete", "return"]);
      expect(liveRow.item.display).toBe("reserved");
      const ownerRow = confirmedTab.orders.find((o) => o.id === ownerOrder.order.id)!;
      expect(ownerRow.demoReturnAtMs).toBeNull();
      expect(ownerRow.item.display).toBe("sold");
      expect(ownerRow.actions).toEqual(["complete", "return"]);

      // demo ของตัวเอง: ไม่มีปุ่มคืน
      const mine = await getAdminOrderDetail(demoActor(demoLive.sid), demoLive.order.id);
      expect(mine!.order.actions).toEqual(["complete"]);
      const detail = await getAdminOrderDetail(OWNER, demoDone.order.id);
      expect(detail!.order.status).toBe("demo_ended");
    });

    it("หน้า/สถานะของลูกค้า: ระหว่างช่วงถือเป็น confirmed + หมายเหตุเดโม; ครบเวลาเป็น demo_ended และหยุด poll", async () => {
      const { order } = await demoConfirmed();
      const view = (c: NonNullable<Awaited<ReturnType<typeof getCustomerOrder>>>) =>
        describeOrder({
          status: c.status,
          deliveryMethod: c.deliveryMethod,
          expiresAtMs: c.expiresAt.getTime(),
          nowMs: c.dbNow.getTime(),
          demoEnded: c.demoEnded,
          demoConfirmed: c.demoReturnAt !== null,
        });

      const c1 = (await getCustomerOrder(order.token))!;
      expect(view(c1).effectiveStatus).toBe("confirmed");
      expect(view(c1).demoNote).toContain(`${DEMO_ORDER_RETURN_MINUTES} นาที`);
      expect((await getOrderStatusSnapshot(order.token))!.status).toBe("confirmed");

      await age(order.id, N_SECONDS + 2);
      const c2 = (await getCustomerOrder(order.token))!;
      expect(c2.status).toBe("confirmed"); // ค่าที่เก็บไม่เปลี่ยน
      const v2 = view(c2);
      expect(v2.effectiveStatus).toBe("demo_ended");
      expect(v2.headline).toBe("เดโมสิ้นสุดแล้ว");
      expect(v2.keepPolling).toBe(false);
      expect((await getOrderStatusSnapshot(order.token))!.status).toBe("demo_ended");
    });

    it("ออเดอร์ที่ owner ยืนยันผ่านไปนาน: หน้าลูกค้ายังเป็น confirmed ไม่มีหมายเหตุเดโม", async () => {
      const { order } = await ownerConfirmed();
      await age(order.id, 5 * 24 * 3600);
      const c = (await getCustomerOrder(order.token))!;
      expect(c.demoEnded).toBe(false);
      expect(c.demoReturnAt).toBeNull();
      expect((await getOrderStatusSnapshot(order.token))!.status).toBe("confirmed");
    });
  });
});
