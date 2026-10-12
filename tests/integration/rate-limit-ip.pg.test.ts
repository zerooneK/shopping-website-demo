import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { items, orderEvents, orders } from "@/db/schema";
import { NextRequest } from "next/server";
import { POST as postOrder } from "@/app/api/orders/route";
import { hashClientIp } from "@/lib/client-ip";
import {
  cancelOrder,
  MAX_SLIP_TOKENS_PER_ORDER,
  reserveSlipTokenSlot,
  SLIP_TOKEN_EVENT,
} from "@/lib/orders/commands";
import { MAX_HOLDING_PER_IP, MAX_ORDERS_PER_IP_PER_HOUR } from "@/lib/rate-limit";
import { createDrizzleReserveStore, reserveItem } from "@/lib/reserve";
import type { CreateOrderInput } from "@/lib/validation";

/**
 * Integration test กับ Postgres (Neon) จริง สำหรับ rate limit ต่อ IP (ขั้น 3b-2-fix),
 * การที่ "ไม่มีเพดานรวมทั้งร้าน" (ขั้น 3b-2-fix2) และเพดาน Blob upload token ต่อออเดอร์:
 *  - sid ต่างกัน (ไม่ส่ง cookie) แต่ IP เดียวกัน → ติด IP limit; IP อื่นไม่ถูกกระทบ
 *  - ออเดอร์ที่ไม่มีวันหมดอายุ (awaiting_review ฯลฯ) จากหลาย IP ไม่ทำให้ IP ใหม่ถูกปฏิเสธเพราะ "ร้านเต็ม"
 *    (ปฏิเสธเฉพาะชิ้นที่ถูกถืออยู่) ทั้งผ่าน reserveItem และผ่าน POST /api/orders ตัวจริง
 *  - ยิงพร้อมกันหลาย IP/sid: ไม่ deadlock และ invariants รายชิ้น/รายIP/รายsid ครบ
 *  - reserveSlipTokenSlot: ไม่เกิน 3 ต่อออเดอร์แม้ยิงพร้อมกัน
 *
 * ใช้รหัสสินค้า T961-T979 เท่านั้น ลบ/แก้เฉพาะแถวของตัวเอง ห้ามแตะ seed (A001-A012)
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);
if (!HAS_DB) {
  console.warn(
    "[integration] ข้ามเทสต์: ไม่พบ DATABASE_URL (รันผ่าน `npm run test:integration` ซึ่งโหลด .env.local)",
  );
}

const CODES = Array.from({ length: 19 }, (_, i) => `T${961 + i}`);
const code = (i: number) => CODES[i];

const input = (c: string): CreateOrderInput => ({
  code: c,
  customerName: "ทดสอบ",
  phone: "0812345678",
  deliveryMethod: "pickup",
});

let sidSeq = 0;
const newSid = () => `integration-ipsid-${Date.now()}-${++sidSeq}-${"x".repeat(20)}`;
// n ถูกแปลงเป็น IPv4 ที่ถูกต้องและต่างกันเสมอ (IP ที่ผิดรูปแบบจะถูกรวมเป็น bucket "unknown")
const ipHash = (n: number) => hashClientIp(`198.18.${Math.floor(n / 256)}.${n % 256}`);

describe.skipIf(!HAS_DB)("rate limit ต่อ IP / ไม่มีเพดานรวม / token สลิป บน Postgres จริง", () => {
  const db = HAS_DB ? getDb() : (undefined as never);
  const store = HAS_DB ? createDrizzleReserveStore(db) : (undefined as never);

  async function cleanup() {
    const ids = (
      await db.select({ id: items.id }).from(items).where(inArray(items.code, CODES))
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

  async function makeItems(n: number) {
    await db.insert(items).values(
      CODES.slice(0, n).map((c) => ({
        code: c,
        title: `ทดสอบ ${c}`,
        description: "integration test",
        flaws: "ไม่มีตำหนิที่สังเกตเห็น",
        condition: "good" as const,
        category: "other" as const,
        price: 100,
      })),
    );
  }
  async function getItem(c: string) {
    const [row] = await db.select().from(items).where(eq(items.code, c));
    return row;
  }
  /**
   * ทำให้ออเดอร์ของเทสต์ "ไม่มีวันหมดอายุ" เหมือนหลังส่งสลิป (uploadSlip ตั้ง awaiting_review/ล้าง reserved_until)
   * แก้เฉพาะแถวที่ระบุ id
   */
  async function makeNonExpiring(placed: { id: string; itemId: number }[], statuses: readonly string[]) {
    for (let i = 0; i < placed.length; i++) {
      await db.execute(sql`UPDATE orders SET status = ${statuses[i]}, updated_at = now() WHERE id = ${placed[i].id}`);
    }
    await db.execute(
      sql`UPDATE items SET reserved_until = NULL WHERE id IN (${sql.join(
        placed.map((o) => sql`${o.itemId}`),
        sql`, `,
      )})`,
    );
  }
  async function ownRows() {
    const ids = (await db.select({ id: items.id }).from(items).where(inArray(items.code, CODES))).map(
      (r) => r.id,
    );
    if (ids.length === 0) return [];
    return db.select().from(orders).where(inArray(orders.itemId, ids));
  }

  beforeAll(cleanup);
  beforeEach(cleanup);
  afterAll(async () => {
    try {
      await cleanup();
    } catch (e) {
      console.error("[integration] cleanup ล้มเหลว", e instanceof Error ? e.name : "unknown");
    }
  });

  describe("ต่อ IP", () => {
    it("sid ต่างกันทุกครั้ง (เท่ากับไม่ส่ง cookie) จาก IP เดียวกัน → 429 ที่ IP limit และเก็บเฉพาะ hash", async () => {
      await makeItems(6);
      const ip = ipHash(1);
      const rs = [];
      for (let i = 0; i < 5; i++) {
        rs.push(await reserveItem(store, input(code(i)), newSid(), { clientIpHash: ip }));
      }
      expect(rs.slice(0, MAX_HOLDING_PER_IP).every((r) => r.ok)).toBe(true);
      expect(rs[MAX_HOLDING_PER_IP]).toEqual({ ok: false, reason: "ip_too_many_holding" });
      expect(rs[MAX_HOLDING_PER_IP + 1]).toEqual({ ok: false, reason: "ip_too_many_holding" });
      // ชิ้นที่ถูกปฏิเสธไม่ถูกแตะ
      expect((await getItem(code(MAX_HOLDING_PER_IP))).status).toBe("available");
      // เก็บ hash ลงออเดอร์ (64 hex) ไม่ใช่ IP ดิบ
      const rows = await ownRows();
      expect(rows).toHaveLength(MAX_HOLDING_PER_IP);
      for (const r of rows) {
        expect(r.clientIpHash).toBe(ip);
        expect(r.clientIpHash).toMatch(/^[0-9a-f]{64}$/);
        expect(JSON.stringify(r)).not.toContain("198.18");
      }
      // IP อื่นยังจองได้
      expect((await reserveItem(store, input(code(5)), newSid(), { clientIpHash: ipHash(2) })).ok).toBe(true);
    });

    it("ไม่มี sid เลย (null) ก็ติด IP limit", async () => {
      await makeItems(5);
      const ip = ipHash(3);
      for (let i = 0; i < MAX_HOLDING_PER_IP; i++) {
        expect((await reserveItem(store, input(code(i)), null, { clientIpHash: ip })).ok).toBe(true);
      }
      expect(await reserveItem(store, input(code(4)), null, { clientIpHash: ip })).toEqual({
        ok: false,
        reason: "ip_too_many_holding",
      });
    });

    it("สร้างเกิน 8 ต่อชั่วโมง = ip_too_many_per_hour (แม้ไม่มีออเดอร์ค้าง); เกิน 1 ชั่วโมงแล้วไม่นับ", async () => {
      await makeItems(3);
      const ip = ipHash(4);
      const first = await reserveItem(store, input(code(0)), newSid(), { clientIpHash: ip });
      if (!first.ok) throw new Error("setup");
      // ใส่ออเดอร์ที่ปิดแล้ว (expired) ของ IP เดียวกัน 7 ใบ → รวมสร้างในชั่วโมงนี้ = 8
      for (let i = 0; i < MAX_ORDERS_PER_IP_PER_HOUR - 1; i++) {
        await db.insert(orders).values({
          token: `integration-iphour-${i}-${Date.now()}-${"y".repeat(20)}`,
          itemId: first.order.itemId,
          amount: 100,
          customerName: "ทดสอบ",
          phone: "0812345678",
          deliveryMethod: "pickup",
          status: "expired",
          expiresAt: sql`now() - interval '5 minutes'`,
          clientIpHash: ip,
        });
      }
      await cancelOrder(db, first.order.token);
      expect(await reserveItem(store, input(code(1)), newSid(), { clientIpHash: ip })).toEqual({
        ok: false,
        reason: "ip_too_many_per_hour",
      });
      await db.execute(
        sql`UPDATE orders SET created_at = now() - interval '2 hours' WHERE client_ip_hash = ${ip}`,
      );
      expect((await reserveItem(store, input(code(1)), newSid(), { clientIpHash: ip })).ok).toBe(true);
    });

    it("ยิงพร้อมกัน 8 คำขอจาก IP เดียวกันคนละ sid: สำเร็จพอดี 3 (advisory lock ต่อ IP)", async () => {
      await makeItems(8);
      const ip = ipHash(5);
      const rs = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          reserveItem(store, input(code(i)), newSid(), { clientIpHash: ip }),
        ),
      );
      expect(rs.filter((r) => r.ok)).toHaveLength(MAX_HOLDING_PER_IP);
      for (const r of rs.filter((x) => !x.ok)) {
        expect(r).toEqual({ ok: false, reason: "ip_too_many_holding" });
      }
      expect(await ownRows()).toHaveLength(MAX_HOLDING_PER_IP);
    });
  });

  describe("ไม่มีเพดานรวมทั้งร้าน (ถอดออกใน 3b-2-fix2)", () => {
    it("IP หนึ่งถึงเพดาน IP ของตัวเอง → IP อื่นยังจองชิ้นที่ว่างได้ (ไล่จนครบ 12 ชิ้นที่ถือพร้อมกัน)", async () => {
      await makeItems(12);
      const a = ipHash(700);
      for (let i = 0; i < MAX_HOLDING_PER_IP; i++) {
        expect((await reserveItem(store, input(code(i)), newSid(), { clientIpHash: a })).ok).toBe(true);
      }
      expect(await reserveItem(store, input(code(3)), newSid(), { clientIpHash: a })).toEqual({
        ok: false,
        reason: "ip_too_many_holding",
      });
      // IP อื่นอีก 9 ตัว จองชิ้นที่เหลือได้ทั้งหมด (รวม 12 ออเดอร์ที่ถือพร้อมกัน)
      for (let i = 3; i < 12; i++) {
        const r = await reserveItem(store, input(code(i)), newSid(), { clientIpHash: ipHash(710 + i) });
        expect(r.ok, `IP อื่นจอง ${code(i)}`).toBe(true);
      }
      expect(await ownRows()).toHaveLength(12);
    });

    it("ออเดอร์ที่ไม่มีวันหมดอายุ (awaiting_review/confirmed/shipped/completed) จากหลาย IP ไม่ทำให้ IP ใหม่ถูกปฏิเสธเพราะ 'ร้านเต็ม' — ปฏิเสธเฉพาะชิ้นที่ถูกถือ", async () => {
      await makeItems(12);
      const placed = [];
      for (let i = 0; i < 8; i++) {
        const r = await reserveItem(store, input(code(i)), newSid(), { clientIpHash: ipHash(800 + i) });
        if (!r.ok) throw new Error("setup");
        placed.push(r.order);
      }
      await makeNonExpiring(placed, [
        "awaiting_review",
        "awaiting_review",
        "awaiting_review",
        "awaiting_review",
        "confirmed",
        "shipped",
        "completed",
        "awaiting_review",
      ]);

      // IP ใหม่ 4 ตัว จองได้ครบ 4 ชิ้นที่ว่าง แม้มีออเดอร์ที่ไม่หมดอายุอยู่ 8 ใบ
      for (let i = 8; i < 12; i++) {
        const r = await reserveItem(store, input(code(i)), newSid(), { clientIpHash: ipHash(820 + i) });
        expect(r.ok, `IP ใหม่จอง ${code(i)}`).toBe(true);
      }
      // ชิ้นที่ถูกถืออยู่ → unavailable เท่านั้น (ไม่ใช่เหตุผล rate limit ใดๆ)
      for (const i of [0, 4, 5, 6]) {
        expect(
          await reserveItem(store, input(code(i)), newSid(), { clientIpHash: ipHash(840 + i) }),
        ).toEqual({ ok: false, reason: "unavailable" });
      }
    });

    it("POST /api/orders ตัวจริง: ออเดอร์ไม่หมดอายุจาก 3 IP × 3 ใบ ไม่ทำให้ IP ใหม่ได้ 429 (ได้ 201 สำหรับชิ้นว่าง, 409 สำหรับชิ้นที่ถูกถือ)", async () => {
      await makeItems(12);
      const post = (c: string, ip: string) =>
        postOrder(
          new NextRequest("http://localhost/api/orders", {
            method: "POST",
            headers: { "content-type": "application/json", "x-forwarded-for": ip },
            body: JSON.stringify(input(c)),
          }),
        );
      // รูปแบบการโจมตีที่ Reviewer พิสูจน์: 3 IP × 3 ออเดอร์ แล้วทุกใบกลายเป็นไม่หมดอายุ (เช่นใช้สลิปตัวอย่าง)
      for (let n = 0; n < 9; n++) {
        const res = await post(code(n), `198.51.100.${10 + Math.floor(n / 3)}`);
        expect(res.status, `ออเดอร์ที่ ${n + 1}`).toBe(201);
      }
      const mine = await ownRows();
      expect(mine).toHaveLength(9);
      await makeNonExpiring(mine, mine.map(() => "awaiting_review"));

      // IP ใหม่จองชิ้นว่างที่เหลือ (9, 10, 11) ได้ทั้งหมด ไม่มี 429 เพราะเหตุ "ร้านเต็ม"
      const fresh = [
        await post(code(9), "198.51.100.50"),
        await post(code(10), "198.51.100.51"),
        await post(code(11), "198.51.100.52"),
      ];
      expect(fresh.map((r) => r.status)).toEqual([201, 201, 201]);
      // ชิ้นที่ถูกถือ: 409 มีคนจองตัดหน้า (ไม่ใช่ 429)
      const taken = await post(code(0), "198.51.100.53");
      expect(taken.status).toBe(409);
      expect(((await taken.json()) as { error: string }).error).toBe("มีคนจองตัดหน้าไปแล้ว");
    });

    it("ยิงพร้อมกัน 12 คำขอจาก 12 IP (คนละชิ้น): สำเร็จครบ 12 ไม่ deadlock", async () => {
      await makeItems(12);
      const rs = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          reserveItem(store, input(code(i)), newSid(), { clientIpHash: ipHash(150 + i) }),
        ),
      );
      expect(rs.every((r) => r.ok)).toBe(true);
      expect(await ownRows()).toHaveLength(12);
    });

    it("ยิงสุ่มพร้อมกัน 36 คำขอ (IP/sid ปนกัน): ทุกคำขอจบ ไม่ deadlock และ invariants ครบ", async () => {
      await makeItems(12);
      const ipPool = [ipHash(500), ipHash(501), ipHash(502), ipHash(503)];
      const sidPool = [newSid(), newSid(), newSid()];
      const rs = await Promise.all(
        Array.from({ length: 36 }, (_, i) =>
          reserveItem(
            store,
            input(code(i % 12)), // หลายคำขอแย่งชิ้นเดียวกัน
            i % 4 === 0 ? null : sidPool[i % 3],
            { clientIpHash: ipPool[i % 4] },
          ),
        ),
      );
      // ทุก promise resolve (ถ้า deadlock Postgres จะ throw และ Promise.all จะ reject)
      expect(rs).toHaveLength(36);
      const rows = await ownRows();
      const holding = rows.filter((o) => o.status === "pending_payment" || o.status === "awaiting_review");
      for (const ip of ipPool) {
        expect(holding.filter((o) => o.clientIpHash === ip).length).toBeLessThanOrEqual(MAX_HOLDING_PER_IP);
      }
      for (const sid of sidPool) {
        expect(holding.filter((o) => o.demoSessionId === sid).length).toBeLessThanOrEqual(2);
      }
      // ไม่มีสินค้าชิ้นเดียวถูกจองซ้ำ
      const perItem = new Map<number, number>();
      for (const o of holding) perItem.set(o.itemId, (perItem.get(o.itemId) ?? 0) + 1);
      for (const n of perItem.values()) expect(n).toBe(1);
      for (const r of rs.filter((x) => !x.ok)) {
        expect(["unavailable", "ip_too_many_holding", "too_many_pending"]).toContain(r.reason);
      }
    });
  });

  describe("เพดาน Blob upload token ต่อออเดอร์ (reserveSlipTokenSlot)", () => {
    async function pendingOrder(c: string, ip: number) {
      const r = await reserveItem(store, input(c), newSid(), { clientIpHash: ipHash(ip) });
      if (!r.ok) throw new Error(`setup: ${r.reason}`);
      return r.order;
    }
    async function issuedCount(orderId: string) {
      const rows = await db.select().from(orderEvents).where(eq(orderEvents.orderId, orderId));
      return rows.filter((e) => e.type === SLIP_TOKEN_EVENT && e.actor === "customer").length;
    }

    it(`ออกได้ ${MAX_SLIP_TOKENS_PER_ORDER} ครั้ง ครั้งถัดไป token_limit; ออเดอร์อื่นไม่กระทบ`, async () => {
      await makeItems(2);
      const o = await pendingOrder(code(0), 600);
      const other = await pendingOrder(code(1), 601);
      for (let i = 1; i <= MAX_SLIP_TOKENS_PER_ORDER; i++) {
        expect(await reserveSlipTokenSlot(db, o.token)).toEqual({ ok: true, used: i });
      }
      expect(await reserveSlipTokenSlot(db, o.token)).toEqual({ ok: false, error: "token_limit" });
      expect(await issuedCount(o.id)).toBe(MAX_SLIP_TOKENS_PER_ORDER);
      expect(await reserveSlipTokenSlot(db, other.token)).toEqual({ ok: true, used: 1 });
    });

    it("ยิงพร้อมกัน 12 คำขอ: สำเร็จพอดี 3 ไม่มี race", async () => {
      await makeItems(1);
      const o = await pendingOrder(code(0), 610);
      const rs = await Promise.all(
        Array.from({ length: 12 }, () => reserveSlipTokenSlot(db, o.token)),
      );
      expect(rs.filter((r) => r.ok)).toHaveLength(MAX_SLIP_TOKENS_PER_ORDER);
      for (const r of rs.filter((x) => !x.ok)) {
        expect(r).toEqual({ ok: false, error: "token_limit" });
      }
      expect(await issuedCount(o.id)).toBe(MAX_SLIP_TOKENS_PER_ORDER);
    });

    it("ไม่ใช่ pending / หมดเวลา / ไม่พบ → ปฏิเสธและไม่เขียน event", async () => {
      await makeItems(3);
      const cancelled = await pendingOrder(code(0), 620);
      await cancelOrder(db, cancelled.token);
      expect(await reserveSlipTokenSlot(db, cancelled.token)).toMatchObject({
        ok: false,
        error: "invalid_state",
      });

      const lapsed = await pendingOrder(code(1), 621);
      await db.execute(
        sql`UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id = ${lapsed.id}`,
      );
      expect(await reserveSlipTokenSlot(db, lapsed.token)).toMatchObject({
        ok: false,
        error: "window_closed",
      });

      expect(await reserveSlipTokenSlot(db, "Z".repeat(43))).toEqual({ ok: false, error: "not_found" });
      expect(await issuedCount(cancelled.id)).toBe(0);
      expect(await issuedCount(lapsed.id)).toBe(0);
    });
  });
});
