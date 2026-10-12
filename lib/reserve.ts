import { randomBytes } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { items, orderEvents, orders } from "../db/schema";
import type { NewOrder, Order } from "../db/schema";
import { calcAmount, calcShippingFee, type CreateOrderInput } from "./validation";

/**
 * การจองแบบ atomic (SPEC §5 กฎข้อ 1-2)
 *
 * แยก logic ออกจาก DB ด้วย interface `ReserveStore` เพื่อให้เทสต์ได้โดยไม่ต้องต่อ Neon:
 *  - `reserveItem` = logic (ลำดับขั้น, ราคาฝั่ง server, event, token)
 *  - `createDrizzleReserveStore` = ตัวทำงานจริงบน Postgres (UPDATE ... RETURNING)
 */

export const RESERVE_MINUTES = 15;

export type ClaimedItem = {
  id: number;
  price: number;
  /** ค่า reserved_until ที่ DB คำนวณจาก now() + 15 นาที — ใช้เป็น expiresAt ของออเดอร์ */
  reservedUntil: Date;
};

export type NewOrderEvent = {
  orderId: string;
  type: string;
  actor: "customer" | "admin" | "system";
  meta?: Record<string, unknown>;
};

/**
 * การดำเนินการภายใน transaction เดียว
 *
 * เวลาทั้งหมดใช้ `now()` ของ DB เท่านั้น (SPEC §5 ข้อ 1) ไม่รับเวลาจากแอป เพราะ clock ของ
 * serverless instance แต่ละตัวอาจเหลื่อมกัน ทำให้จอง/หมดอายุผิดจังหวะ
 *
 * นิยามหมดอายุ (ตรงกับ SPEC และ transition()): "หมดอายุ" คือ `now() > expiresAt` (strict)
 * ดังนั้นที่ `now() == expiresAt` ยังอัปสลิปได้ และยังไม่ถูกแย่งสินค้า
 *
 * สัญญากับ handler ขั้น 3c: เมื่อ transition() คืน `clearReservedUntil: true` (upload_slip)
 * handler ต้องตั้ง items.reserved_until = NULL ใน transaction เดียวกับการอัปเดตออเดอร์
 * (claimItem ป้องกันซ้ำอีกชั้นด้วย NOT EXISTS แต่ห้ามพึ่งชั้นเดียว)
 */
export interface ReserveTx {
  /**
   * lazy expiry: mark ออเดอร์ pending_payment ของสินค้านี้ที่ `expires_at < now()` เป็น expired
   * แล้วคืน id ของออเดอร์เหล่านั้น — เทียบเท่า transition(order, "expire") แบบ bulk
   * (transition ถือว่าหมดอายุเมื่อ now > expiresAt เช่นเดียวกัน)
   */
  expireStaleOrders(code: string): Promise<string[]>;
  /**
   * คำสั่งเดียวแบบ compare-and-set:
   * UPDATE items SET status='reserved', reserved_until=now()+'15 min'
   * WHERE code=$code AND (status='available' OR (status='reserved' AND reserved_until < now()
   *   AND NOT EXISTS (ออเดอร์ที่ยังถือสินค้านี้อยู่: awaiting_review/confirmed/shipped/completed
   *                   หรือ pending_payment ที่ expires_at >= now())))
   * RETURNING id, price, reserved_until   — ไม่มีแถวคืน = null
   */
  claimItem(code: string): Promise<ClaimedItem | null>;
  insertOrder(values: NewOrder): Promise<Order>;
  insertEvents(events: NewOrderEvent[]): Promise<void>;
}

export interface ReserveStore {
  /** ถ้า fn throw ต้อง rollback ทุกอย่างที่ทำใน tx */
  transaction<T>(fn: (tx: ReserveTx) => Promise<T>): Promise<T>;
}

export type ReserveResult =
  | { ok: true; order: Order }
  /** ตอบ 409 "มีคนจองตัดหน้าไปแล้ว" */
  | { ok: false; reason: "unavailable" };

export type ReserveOptions = {
  generateToken?: () => string;
};

export function generateOrderToken(): string {
  return randomBytes(32).toString("base64url");
}

export async function reserveItem(
  store: ReserveStore,
  input: CreateOrderInput,
  demoSessionId: string | null = null,
  opts: ReserveOptions = {},
): Promise<ReserveResult> {
  const generateToken = opts.generateToken ?? generateOrderToken;

  return store.transaction(async (tx) => {
    // 1) lazy expiry ของออเดอร์เก่าที่ค้างบนสินค้านี้
    const expiredIds = await tx.expireStaleOrders(input.code);
    if (expiredIds.length > 0) {
      await tx.insertEvents(
        expiredIds.map((orderId) => ({
          orderId,
          type: "expire",
          actor: "system" as const,
        })),
      );
    }

    // 2) จองด้วยคำสั่งเดียว — สำเร็จได้ครั้งเดียวต่อชิ้น
    const claimed = await tx.claimItem(input.code);
    if (!claimed) return { ok: false, reason: "unavailable" } as const;

    // 3) ราคา/ค่าส่งคำนวณฝั่ง server จากราคาใน DB เท่านั้น
    const shippingFee = calcShippingFee(input.deliveryMethod);
    const order = await tx.insertOrder({
      token: generateToken(),
      itemId: claimed.id,
      amount: calcAmount(claimed.price, input.deliveryMethod),
      shippingFee,
      customerName: input.customerName,
      phone: input.phone,
      deliveryMethod: input.deliveryMethod,
      address: input.deliveryMethod === "post" ? (input.address ?? null) : null,
      note: input.note ?? null,
      status: "pending_payment",
      // ใช้ค่าที่ DB คืนมา (now()+15 นาที) เพื่อให้ order.expires_at == items.reserved_until เป๊ะ
      expiresAt: claimed.reservedUntil,
      demoSessionId,
    });

    await tx.insertEvents([
      {
        orderId: order.id,
        type: "created",
        actor: "customer",
        meta: { code: input.code },
      },
    ]);

    return { ok: true, order } as const;
  });
}

/** ตัวทำงานจริงบน Postgres (Neon) — ส่วนนี้ยังไม่ได้ทดสอบกับ DB จริงในขั้น 3a */
export function createDrizzleReserveStore(db: Db): ReserveStore {
  return {
    transaction: (fn) =>
      db.transaction(async (trx) => {
        const tx: ReserveTx = {
          async expireStaleOrders(code) {
            const rows = await trx
              .update(orders)
              .set({ status: "expired", updatedAt: sql`now()` })
              .where(
                and(
                  eq(orders.status, "pending_payment"),
                  lt(orders.expiresAt, sql`now()`),
                  eq(
                    orders.itemId,
                    trx
                      .select({ id: items.id })
                      .from(items)
                      .where(eq(items.code, code)),
                  ),
                ),
              )
              .returning({ id: orders.id });
            return rows.map((r) => r.id);
          },

          async claimItem(code) {
            // เวลาทั้งหมดมาจาก now() ของ DB ไม่ใช่ของแอป
            // NOT EXISTS: กันแย่งสินค้าที่ลูกค้าจ่ายแล้ว (awaiting_review ฯลฯ) แม้ reserved_until
            // จะค้างเป็นเวลาในอดีต — ป้องกันตัวเองโดยไม่พึ่งว่า handler ล้าง reserved_until แล้ว
            const res = await trx.execute<{
              id: number;
              price: number;
              reserved_until: Date | string;
            }>(sql`
              UPDATE items
              SET status = 'reserved',
                  reserved_until = now() + make_interval(mins => ${RESERVE_MINUTES}),
                  updated_at = now()
              WHERE code = ${code}
                AND (status = 'available'
                     OR (status = 'reserved'
                         AND reserved_until < now()
                         AND NOT EXISTS (
                           SELECT 1 FROM orders o
                           WHERE o.item_id = items.id
                             AND (o.status IN ('awaiting_review', 'confirmed', 'shipped', 'completed')
                                  OR (o.status = 'pending_payment' AND o.expires_at >= now()))
                         )))
              RETURNING id, price, reserved_until
            `);
            const row = res.rows[0];
            if (!row) return null;
            return {
              id: row.id,
              price: row.price,
              reservedUntil: new Date(row.reserved_until),
            };
          },

          async insertOrder(values) {
            const [row] = await trx.insert(orders).values(values).returning();
            return row;
          },

          async insertEvents(events) {
            if (events.length === 0) return;
            await trx.insert(orderEvents).values(events);
          },
        };
        return fn(tx);
      }),
  };
}
