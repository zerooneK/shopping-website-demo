import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { items, orderEvents, orders } from "@/db/schema";
import {
  createDrizzleReserveStore,
  RESERVE_MINUTES,
  reserveItem,
} from "@/lib/reserve";
import type { CreateOrderInput } from "@/lib/validation";

/**
 * Integration test กับ Postgres (Neon) จริง — พิสูจน์สิ่งที่ in-memory store พิสูจน์ไม่ได้
 * (atomic ของ UPDATE ... RETURNING, NOT EXISTS, make_interval, rollback ของ transaction)
 *
 * DB เป็นก้อนเดียวกับ dev: ใช้รหัสสินค้า T901-T999 เท่านั้น และลบเฉพาะแถวของตัวเอง
 * (order_events -> orders -> items) ทั้งก่อนและหลังรัน
 * รัน: npm run test:integration
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);
if (!HAS_DB) {
  console.warn(
    "[integration] ข้ามเทสต์: ไม่พบ DATABASE_URL (รันผ่าน `npm run test:integration` ซึ่งโหลด .env.local)",
  );
}

const TEST_CODES = Array.from({ length: 99 }, (_, i) => `T${901 + i}`);

const input = (
  code: string,
  over: Partial<CreateOrderInput> = {},
): CreateOrderInput => ({
  code,
  customerName: "ทดสอบ",
  phone: "0812345678",
  deliveryMethod: "pickup",
  ...over,
});

describe.skipIf(!HAS_DB)("reserve บน Postgres จริง", () => {
  // getDb() โยน error ถ้าไม่มี DATABASE_URL จึงสร้างแบบ lazy ภายใน describe ที่ไม่ถูก skip
  const db = HAS_DB ? getDb() : (undefined as never);
  const store = HAS_DB ? createDrizzleReserveStore(db) : (undefined as never);

  async function cleanup() {
    const ids = (
      await db
        .select({ id: items.id })
        .from(items)
        .where(inArray(items.code, TEST_CODES))
    ).map((r) => r.id);
    if (ids.length === 0) return;
    const orderIds = (
      await db
        .select({ id: orders.id })
        .from(orders)
        .where(inArray(orders.itemId, ids))
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
  async function ordersOf(code: string) {
    const it = await getItem(code);
    return db.select().from(orders).where(eq(orders.itemId, it.id));
  }
  async function eventsOf(orderId: string) {
    return db.select().from(orderEvents).where(eq(orderEvents.orderId, orderId));
  }

  /** จำลองอัปสลิป: ออเดอร์เป็น awaiting_review + ปรับ reserved_until ตามที่กำหนด */
  async function simulateSlip(
    orderId: string,
    code: string,
    reservedUntil: "past" | "null",
  ) {
    await db.execute(
      sql`UPDATE orders SET status = 'awaiting_review', slip_uploaded_at = now() WHERE id = ${orderId}`,
    );
    if (reservedUntil === "null") {
      await db.execute(
        sql`UPDATE items SET reserved_until = NULL WHERE code = ${code}`,
      );
    } else {
      await db.execute(
        sql`UPDATE items SET reserved_until = now() - interval '1 hour' WHERE code = ${code}`,
      );
    }
  }

  beforeAll(cleanup);
  afterAll(async () => {
    try {
      await cleanup();
    } catch (e) {
      console.error(
        "[integration] cleanup ล้มเหลว",
        e instanceof Error ? e.message : "unknown",
      );
    }
  });

  it("a) จอง 1 ชิ้นพร้อมกัน 20 ราย -> สำเร็จ 1 เท่านั้น", async () => {
    await makeItem("T901");
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        reserveItem(store, input("T901", { customerName: `ลูกค้า ${i}` })),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const failed = results.filter((r) => !r.ok);
    expect(failed).toHaveLength(19);
    for (const r of failed) expect(r).toEqual({ ok: false, reason: "unavailable" });

    const os = await ordersOf("T901");
    expect(os).toHaveLength(1);
    expect(os[0].status).toBe("pending_payment");
    expect((await getItem("T901")).status).toBe("reserved");
  });

  describe.each(["past", "null"] as const)(
    "b) X อัปสลิปแล้ว reserved_until = %s",
    (mode) => {
      it("Y จองไม่ได้ (unavailable) และมีออเดอร์ 1 ใบ", async () => {
        const code = mode === "past" ? "T902" : "T903";
        await makeItem(code);
        const x = await reserveItem(store, input(code, { customerName: "X" }));
        expect(x.ok).toBe(true);
        if (!x.ok) return;
        await simulateSlip(x.order.id, code, mode);

        const y = await reserveItem(store, input(code, { customerName: "Y" }));
        expect(y).toEqual({ ok: false, reason: "unavailable" });

        const os = await ordersOf(code);
        expect(os).toHaveLength(1);
        expect(os[0].id).toBe(x.order.id);
        expect(os[0].status).toBe("awaiting_review");
        expect((await getItem(code)).status).toBe("reserved");
      });
    },
  );

  it("c) pending_payment ที่หมดเวลา -> จองใหม่ได้, ออเดอร์เก่า expired พร้อม event", async () => {
    await makeItem("T904");
    const first = await reserveItem(store, input("T904", { customerName: "เก่า" }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await db.execute(
      sql`UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id = ${first.order.id}`,
    );
    await db.execute(
      sql`UPDATE items SET reserved_until = now() - interval '1 minute' WHERE code = 'T904'`,
    );

    const second = await reserveItem(store, input("T904", { customerName: "ใหม่" }));
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const os = await ordersOf("T904");
    expect(os).toHaveLength(2);
    expect(os.find((o) => o.id === first.order.id)?.status).toBe("expired");
    const evs = await eventsOf(first.order.id);
    expect(evs.some((e) => e.type === "expire" && e.actor === "system")).toBe(true);
    expect(os.find((o) => o.id === second.order.id)?.status).toBe("pending_payment");
    const item = await getItem("T904");
    expect(item.status).toBe("reserved");
    expect(item.reservedUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it.each(["confirmed", "shipped", "completed"] as const)(
    "d) ออเดอร์ %s ไม่ถูกจองทับแม้ reserved_until ผ่านไปแล้ว",
    async (status) => {
      const code = { confirmed: "T905", shipped: "T906", completed: "T907" }[status];
      await makeItem(code);
      const x = await reserveItem(store, input(code));
      expect(x.ok).toBe(true);
      if (!x.ok) return;
      await db.execute(
        sql`UPDATE orders SET status = ${status}::order_status WHERE id = ${x.order.id}`,
      );
      await db.execute(
        sql`UPDATE items SET reserved_until = now() - interval '1 hour' WHERE code = ${code}`,
      );

      const y = await reserveItem(store, input(code, { customerName: "Y" }));
      expect(y).toEqual({ ok: false, reason: "unavailable" });
      const os = await ordersOf(code);
      expect(os).toHaveLength(1);
      expect(os[0].status).toBe(status);
    },
  );

  it("e) expires_at ~ now()+15 นาที และเท่ากับ items.reserved_until", async () => {
    await makeItem("T908");
    const before = Date.now();
    const r = await reserveItem(store, input("T908"));
    const after = Date.now();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const item = await getItem("T908");
    expect(item.reservedUntil).not.toBeNull();
    expect(r.order.expiresAt.getTime()).toBe(item.reservedUntil!.getTime());
    const expected = RESERVE_MINUTES * 60_000;
    // ยอมคลาดเคลื่อนของ clock เครื่องนี้เทียบกับ DB + latency
    expect(r.order.expiresAt.getTime()).toBeGreaterThan(before + expected - 10_000);
    expect(r.order.expiresAt.getTime()).toBeLessThan(after + expected + 10_000);
    // ตรวจฝั่ง DB ล้วน ไม่พึ่ง clock เครื่องนี้: expires_at - created_at ~ 15 นาที
    const res = await db.execute<{ diff: number }>(
      sql`SELECT extract(epoch FROM (expires_at - created_at))::float8 AS diff FROM orders WHERE id = ${r.order.id}`,
    );
    expect(Math.abs(Number(res.rows[0].diff) - RESERVE_MINUTES * 60)).toBeLessThan(5);
  });

  it("f) rollback: สร้างออเดอร์ล้มเหลว (token ซ้ำ) -> การจองและ lazy expiry ถูกย้อนกลับ", async () => {
    await makeItem("T909");
    await makeItem("T910");
    await makeItem("T911");
    const dup = "t-dup-token-integration";
    const a = await reserveItem(store, input("T909"), null, {
      generateToken: () => dup,
    });
    expect(a.ok).toBe(true);

    // T910 มีออเดอร์เก่าที่หมดเวลาค้างอยู่ — lazy expiry ใน tx เดียวกันต้องถูกย้อนด้วย
    const old = await reserveItem(store, input("T910", { customerName: "เก่า" }));
    expect(old.ok).toBe(true);
    if (!old.ok) return;
    await db.execute(
      sql`UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id = ${old.order.id}`,
    );
    await db.execute(
      sql`UPDATE items SET reserved_until = now() - interval '1 minute' WHERE code = 'T910'`,
    );
    const before = await getItem("T910");

    await expect(
      reserveItem(store, input("T910", { customerName: "ใหม่" }), null, {
        generateToken: () => dup,
      }),
    ).rejects.toThrow();

    const after = await getItem("T910");
    expect(after.status).toBe(before.status);
    expect(after.reservedUntil?.getTime()).toBe(before.reservedUntil?.getTime());
    const os = await ordersOf("T910");
    expect(os).toHaveLength(1);
    expect(os[0].status).toBe("pending_payment"); // ไม่ถูก mark expired เพราะ tx ถูก rollback
    expect((await eventsOf(old.order.id)).some((e) => e.type === "expire")).toBe(false);

    // สินค้าที่ไม่เคยถูกจองต้องกลับเป็น available ถ้า insert ล้ม
    await expect(
      reserveItem(store, input("T911"), null, { generateToken: () => dup }),
    ).rejects.toThrow();
    const t911 = await getItem("T911");
    expect(t911.status).toBe("available");
    expect(t911.reservedUntil).toBeNull();
    expect(await ordersOf("T911")).toHaveLength(0);
  });
});
