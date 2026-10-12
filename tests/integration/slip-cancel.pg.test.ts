import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { items, orderEvents, orders } from "@/db/schema";
import { cancelOrder, expireOrderIfStale, uploadSlip } from "@/lib/orders/commands";
import { createDrizzleReserveStore, reserveItem } from "@/lib/reserve";
import type { CreateOrderInput } from "@/lib/validation";

/**
 * Integration test กับ Postgres (Neon) จริง สำหรับคำสั่งฝั่งลูกค้า (ขั้น 3b-2):
 *  - uploadSlip: CAS สำเร็จ + ล้าง reserved_until เป็น NULL + เขียน event, หมดเวลาตอนอัป = ถูกปฏิเสธ,
 *    อัปซ้ำสองครั้งพร้อมกันได้ผู้ชนะคนเดียว
 *  - cancelOrder: คืนสินค้าเป็น available แบบ CAS
 *  - expireOrderIfStale: mark หมดอายุครั้งเดียว
 *  - rate limit ใน reserveItem (นับจาก DB + advisory lock)
 *
 * ใช้รหัสสินค้า T931-T960 เท่านั้น ลบเฉพาะแถวของตัวเอง (order_events -> orders -> items) ก่อน/หลังรัน
 * ห้ามแตะ seed (A001-A012) — รัน: npm run test:integration
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);
if (!HAS_DB) {
  console.warn(
    "[integration] ข้ามเทสต์: ไม่พบ DATABASE_URL (รันผ่าน `npm run test:integration` ซึ่งโหลด .env.local)",
  );
}

const TEST_CODES = Array.from({ length: 30 }, (_, i) => `T${931 + i}`);

const input = (code: string, over: Partial<CreateOrderInput> = {}): CreateOrderInput => ({
  code,
  customerName: "ทดสอบ",
  phone: "0812345678",
  deliveryMethod: "pickup",
  ...over,
});

let sidSeq = 0;
const newSid = () => `integration-sid-${Date.now()}-${++sidSeq}-${"x".repeat(20)}`;

describe.skipIf(!HAS_DB)("คำสั่งออเดอร์ฝั่งลูกค้าบน Postgres จริง", () => {
  const db = HAS_DB ? getDb() : (undefined as never);
  const store = HAS_DB ? createDrizzleReserveStore(db) : (undefined as never);

  async function cleanup() {
    const ids = (
      await db.select({ id: items.id }).from(items).where(inArray(items.code, TEST_CODES))
    ).map((r) => r.id);
    if (ids.length === 0) return;
    const orderIds = (
      await db.select({ id: orders.id }).from(orders).where(inArray(orders.itemId, ids))
    ).map((r) => r.id);
    if (orderIds.length > 0) {
      await db.delete(orderEvents).where(inArray(orderEvents.orderId, orderIds));
      await db.delete(orders).where(inArray(orders.id, orderIds));
    }
    await db.delete(items).where(inArray(items.id, ids));
  }

  async function makeItem(code: string) {
    const [row] = await db
      .insert(items)
      .values({
        code,
        title: `ทดสอบ ${code}`,
        description: "integration test",
        flaws: "ไม่มีตำหนิที่สังเกตเห็น",
        condition: "good",
        category: "other",
        price: 100,
      })
      .returning();
    return row;
  }
  async function getItem(code: string) {
    const [row] = await db.select().from(items).where(eq(items.code, code));
    return row;
  }
  async function getOrder(id: string) {
    const [row] = await db.select().from(orders).where(eq(orders.id, id));
    return row;
  }
  async function eventTypes(orderId: string) {
    const rows = await db.select().from(orderEvents).where(eq(orderEvents.orderId, orderId));
    return rows.map((r) => r.type).sort();
  }
  /** สร้างสินค้า + จองจริงผ่าน reserveItem แล้วคืนออเดอร์ */
  async function reserved(code: string, sid: string | null = null) {
    await makeItem(code);
    const r = await reserveItem(store, input(code), sid);
    if (!r.ok) throw new Error(`reserve failed: ${r.reason}`);
    return r.order;
  }
  /** ทำให้ออเดอร์/สินค้า "หมดเวลาไปแล้ว 1 นาที" ตามเวลาของ DB */
  async function lapse(orderId: string, code: string) {
    await db.execute(sql`UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id = ${orderId}`);
    await db.execute(sql`UPDATE items SET reserved_until = now() - interval '1 minute' WHERE code = ${code}`);
  }

  beforeAll(cleanup);
  afterAll(async () => {
    try {
      await cleanup();
    } catch (e) {
      console.error("[integration] cleanup ล้มเหลว", e instanceof Error ? e.name : "unknown");
    }
  });

  describe("uploadSlip", () => {
    it("สำเร็จ: awaiting_review + เก็บ slipPath + ล้าง reserved_until เป็น NULL + เขียน event", async () => {
      const o = await reserved("T931");
      expect((await getItem("T931")).reservedUntil).not.toBeNull();

      const r = await uploadSlip(db, { token: o.token, slipPath: `slips/${o.id}/slip-abc.jpg` });
      expect(r).toEqual({ ok: true });

      const after = await getOrder(o.id);
      expect(after.status).toBe("awaiting_review");
      expect(after.slipPath).toBe(`slips/${o.id}/slip-abc.jpg`);
      expect(after.slipUploadedAt).not.toBeNull();
      const item = await getItem("T931");
      expect(item.status).toBe("reserved");
      expect(item.reservedUntil).toBeNull(); // สัญญา clearReservedUntil
      expect(await eventTypes(o.id)).toEqual(["created", "upload_slip"]);
    });

    it("หลังอัปสลิป สินค้าถูกแย่งไม่ได้ (reserved_until เป็น NULL ไม่ใช่ 'หมดเวลา')", async () => {
      const o = await reserved("T932");
      await uploadSlip(db, { token: o.token, slipPath: `slips/${o.id}/s.jpg` });
      const second = await reserveItem(store, input("T932"), null);
      expect(second).toEqual({ ok: false, reason: "unavailable" });
      expect((await getOrder(o.id)).status).toBe("awaiting_review");
    });

    it("สลิปตัวอย่าง: meta.sample = true และ transition เหมือนกันทุกประการ", async () => {
      const o = await reserved("T933");
      const r = await uploadSlip(db, { token: o.token, slipPath: "demo/sample-slip.png", sample: true });
      expect(r).toEqual({ ok: true });
      const [ev] = await db
        .select()
        .from(orderEvents)
        .where(eq(orderEvents.orderId, o.id))
        .then((rows) => rows.filter((e) => e.type === "upload_slip"));
      expect(ev.meta).toEqual({ sample: true });
      expect((await getItem("T933")).reservedUntil).toBeNull();
    });

    it("หมดเวลาตอนอัป = ถูกปฏิเสธ (เวลาของ DB) และไม่เปลี่ยนอะไรเลย", async () => {
      const o = await reserved("T934");
      await lapse(o.id, "T934");
      const before = await getItem("T934");

      const r = await uploadSlip(db, { token: o.token, slipPath: `slips/${o.id}/late.jpg` });
      expect(r).toMatchObject({ ok: false, error: "window_closed" });

      const after = await getOrder(o.id);
      expect(after.status).toBe("pending_payment");
      expect(after.slipPath).toBeNull();
      expect((await getItem("T934")).reservedUntil?.getTime()).toBe(before.reservedUntil?.getTime());
      expect(await eventTypes(o.id)).toEqual(["created"]);
    });

    it("ออเดอร์ที่ไม่ใช่ pending_payment อัปสลิปไม่ได้ / token ไม่มีอยู่จริง = not_found", async () => {
      const o = await reserved("T935");
      await cancelOrder(db, o.token);
      expect(await uploadSlip(db, { token: o.token, slipPath: `slips/${o.id}/x.jpg` })).toMatchObject({
        ok: false,
        error: "invalid_state",
        status: "cancelled",
      });
      expect(await uploadSlip(db, { token: "no-such-token", slipPath: "x" })).toEqual({
        ok: false,
        error: "not_found",
      });
    });

    it("อัปสลิปซ้ำสองครั้งพร้อมกัน: ได้ผู้ชนะคนเดียว event เดียว", async () => {
      const o = await reserved("T936");
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          uploadSlip(db, { token: o.token, slipPath: `slips/${o.id}/race-${i}.jpg` }),
        ),
      );
      const winners = results.filter((r) => r.ok);
      expect(winners).toHaveLength(1);
      for (const loser of results.filter((r) => !r.ok)) {
        expect(loser).toMatchObject({ ok: false, error: "invalid_state" });
      }
      const after = await getOrder(o.id);
      expect(after.status).toBe("awaiting_review");
      expect(after.slipPath).toMatch(/^slips\/.+\/race-\d\.jpg$/);
      expect(await eventTypes(o.id)).toEqual(["created", "upload_slip"]);
      expect((await getItem("T936")).reservedUntil).toBeNull();
    });
  });

  describe("cancelOrder", () => {
    it("คืนสินค้าเป็น available (reserved_until NULL) + order cancelled + event", async () => {
      const o = await reserved("T937");
      expect(await cancelOrder(db, o.token)).toEqual({ ok: true });
      expect((await getOrder(o.id)).status).toBe("cancelled");
      const item = await getItem("T937");
      expect(item.status).toBe("available");
      expect(item.reservedUntil).toBeNull();
      expect(await eventTypes(o.id)).toEqual(["cancel", "created"]);
    });

    it("ยกเลิกแล้วคนอื่นจองต่อได้ทันที", async () => {
      const o = await reserved("T938");
      await cancelOrder(db, o.token);
      const next = await reserveItem(store, input("T938"), null);
      expect(next.ok).toBe(true);
      if (next.ok) expect(next.order.id).not.toBe(o.id);
    });

    it("ยกเลิกซ้ำ / ยกเลิกหลังส่งสลิป = invalid_state และสินค้ายังถูกกันไว้", async () => {
      const a = await reserved("T939");
      await cancelOrder(db, a.token);
      expect(await cancelOrder(db, a.token)).toMatchObject({ ok: false, error: "invalid_state" });

      const b = await reserved("T940");
      await uploadSlip(db, { token: b.token, slipPath: `slips/${b.id}/s.jpg` });
      expect(await cancelOrder(db, b.token)).toMatchObject({
        ok: false,
        error: "invalid_state",
        status: "awaiting_review",
      });
      expect((await getItem("T940")).status).toBe("reserved");
      expect((await getOrder(b.id)).status).toBe("awaiting_review");
    });

    it("ยกเลิกกับอัปสลิปพร้อมกัน: ชนะได้อย่างเดียว สถานะออเดอร์กับสินค้าสอดคล้องกัน", async () => {
      for (const code of ["T941", "T942", "T943"]) {
        const o = await reserved(code);
        const [c, u] = await Promise.all([
          cancelOrder(db, o.token),
          uploadSlip(db, { token: o.token, slipPath: `slips/${o.id}/s.jpg` }),
        ]);
        expect([c.ok, u.ok].filter(Boolean)).toHaveLength(1);
        const order = await getOrder(o.id);
        const item = await getItem(code);
        if (c.ok) {
          expect(order.status).toBe("cancelled");
          expect(item.status).toBe("available");
        } else {
          expect(order.status).toBe("awaiting_review");
          expect(item.status).toBe("reserved");
          expect(item.reservedUntil).toBeNull();
        }
      }
    });
  });

  describe("expireOrderIfStale", () => {
    it("mark expired + event ครั้งเดียว แม้เรียกพร้อมกัน; ยังไม่หมดเวลา = ไม่ทำอะไร", async () => {
      const fresh = await reserved("T944");
      expect(await expireOrderIfStale(db, fresh.token)).toBe(false);
      expect((await getOrder(fresh.id)).status).toBe("pending_payment");

      await lapse(fresh.id, "T944");
      const results = await Promise.all([
        expireOrderIfStale(db, fresh.token),
        expireOrderIfStale(db, fresh.token),
        expireOrderIfStale(db, fresh.token),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect((await getOrder(fresh.id)).status).toBe("expired");
      expect(await eventTypes(fresh.id)).toEqual(["created", "expire"]);
    });
  });

  describe("rate limit (SPEC §7) บน DB จริง", () => {
    it("pending_payment ได้ไม่เกิน 2 ต่อ session; จองพร้อมกัน 6 ชิ้นสำเร็จได้ 2 (advisory lock)", async () => {
      const codes = ["T945", "T946", "T947", "T948", "T949", "T950"];
      for (const c of codes) await makeItem(c);
      const sid = newSid();
      const results = await Promise.all(codes.map((c) => reserveItem(store, input(c), sid)));
      expect(results.filter((r) => r.ok)).toHaveLength(2);
      for (const r of results.filter((x) => !x.ok)) {
        expect(r).toEqual({ ok: false, reason: "too_many_pending" });
      }
      // ชิ้นที่ถูกปฏิเสธต้องไม่ถูกแตะ
      const rejected = results.map((r, i) => (r.ok ? null : codes[i])).filter(Boolean) as string[];
      for (const c of rejected) expect((await getItem(c)).status).toBe("available");

      // session อื่นไม่ถูกกระทบ
      const other = await reserveItem(store, input(rejected[0]), newSid());
      expect(other.ok).toBe(true);
    });

    it("ยกเลิกแล้วจองต่อได้ (นับเฉพาะ pending ที่ยังไม่หมดเวลา)", async () => {
      const sid = newSid();
      const a = await reserved("T951", sid);
      await reserved("T952", sid);
      await makeItem("T953");
      expect(await reserveItem(store, input("T953"), sid)).toEqual({
        ok: false,
        reason: "too_many_pending",
      });
      await cancelOrder(db, a.token);
      expect((await reserveItem(store, input("T953"), sid)).ok).toBe(true);
    });

    it("สร้างเกิน 5 ออเดอร์ใน 1 ชั่วโมง (แม้ไม่มี pending) = too_many_per_hour", async () => {
      const sid = newSid();
      await makeItem("T954");
      const first = await reserved("T955", sid);
      // ออเดอร์เก่าที่ปิดไปแล้ว 4 ใบ (created_at = now ตามค่าเริ่มต้น) + ใบแรก = 5
      for (let i = 0; i < 4; i++) {
        await db.insert(orders).values({
          token: `integration-hourly-${i}-${sid}`,
          itemId: first.itemId,
          amount: 100,
          customerName: "ทดสอบ",
          phone: "0812345678",
          deliveryMethod: "pickup",
          status: "expired",
          expiresAt: sql`now() - interval '5 minutes'`,
          demoSessionId: sid,
        });
      }
      await cancelOrder(db, first.token);
      expect(await reserveItem(store, input("T954"), sid)).toEqual({
        ok: false,
        reason: "too_many_per_hour",
      });
      // ออเดอร์ที่สร้างเกิน 1 ชั่วโมงแล้วไม่นับ
      await db.execute(
        sql`UPDATE orders SET created_at = now() - interval '2 hours' WHERE demo_session_id = ${sid}`,
      );
      expect((await reserveItem(store, input("T954"), sid)).ok).toBe(true);
    });
  });
});
