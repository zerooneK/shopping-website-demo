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

export type ClaimedItem = { id: number; price: number };

export type NewOrderEvent = {
  orderId: string;
  type: string;
  actor: "customer" | "admin" | "system";
  meta?: Record<string, unknown>;
};

/** การดำเนินการภายใน transaction เดียว */
export interface ReserveTx {
  /**
   * lazy expiry: mark ออเดอร์ pending_payment ของสินค้านี้ที่เลยเวลา (expiresAt < now)
   * เป็น expired แล้วคืน id ของออเดอร์เหล่านั้น
   */
  expireStaleOrders(code: string, now: Date): Promise<string[]>;
  /**
   * คำสั่งเดียวแบบ compare-and-set:
   * UPDATE items SET status='reserved', reserved_until=$until
   * WHERE code=$code AND (status='available' OR (status='reserved' AND reserved_until < $now))
   * RETURNING id, price     — ไม่มีแถวคืน = null
   */
  claimItem(code: string, now: Date, until: Date): Promise<ClaimedItem | null>;
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
  now?: Date;
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
  const now = opts.now ?? new Date();
  const until = new Date(now.getTime() + RESERVE_MINUTES * 60_000);
  const generateToken = opts.generateToken ?? generateOrderToken;

  return store.transaction(async (tx) => {
    // 1) lazy expiry ของออเดอร์เก่าที่ค้างบนสินค้านี้
    const expiredIds = await tx.expireStaleOrders(input.code, now);
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
    const claimed = await tx.claimItem(input.code, now, until);
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
      expiresAt: until,
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
          async expireStaleOrders(code, now) {
            const rows = await trx
              .update(orders)
              .set({ status: "expired", updatedAt: now })
              .where(
                and(
                  eq(orders.status, "pending_payment"),
                  lt(orders.expiresAt, now),
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

          async claimItem(code, now, until) {
            const res = await trx.execute<{ id: number; price: number }>(sql`
              UPDATE items
              SET status = 'reserved', reserved_until = ${until}, updated_at = ${now}
              WHERE code = ${code}
                AND (status = 'available'
                     OR (status = 'reserved' AND reserved_until < ${now}))
              RETURNING id, price
            `);
            return res.rows[0] ?? null;
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

