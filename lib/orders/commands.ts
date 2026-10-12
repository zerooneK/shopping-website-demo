import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { items, orderEvents, orders } from "../../db/schema";
import { transition } from "./transition";

/**
 * คำสั่งเปลี่ยนสถานะออเดอร์ฝั่งลูกค้า (อัปสลิป / ยกเลิก / หมดอายุแบบ lazy)
 *
 * หลักการ (บทเรียนขั้น 3a):
 *  - ทุกการตัดสินเรื่องเวลาใช้ now() ของ DB ทั้งหมด ห้ามเทียบกับ new Date() ของแอป
 *    (now() ใน Postgres = เวลาเริ่ม transaction จึงคงที่ตลอด tx และสอดคล้องกันทุก statement)
 *  - transition() ใช้ตัดสินความถูกต้องของการเปลี่ยนสถานะ แต่ตัวชี้ขาดการแข่งกันคือ CAS ใน SQL
 *    (`WHERE status = 'pending_payment' AND expires_at >= now()`) — ผู้ชนะมีได้คนเดียว
 *  - อัปเดตออเดอร์ + อัปเดตสินค้า + เขียน order_events อยู่ใน transaction เดียว
 */

export type OrderCommandError =
  /** ไม่พบออเดอร์ */
  | "not_found"
  /** สถานะไม่ใช่ pending_payment แล้ว (ถูกยกเลิก/ส่งสลิปไปแล้ว/หมดอายุที่ถูก mark แล้ว ฯลฯ) */
  | "invalid_state"
  /** pending_payment แต่เลยเวลาชำระแล้ว */
  | "window_closed";

export type OrderCommandResult =
  | { ok: true }
  | { ok: false; error: OrderCommandError; status?: string };

type OrderSnapshot = {
  id: string;
  itemId: number;
  status: typeof orders.$inferSelect.status;
  deliveryMethod: typeof orders.$inferSelect.deliveryMethod;
  expiresAt: Date;
  dbNow: Date;
};

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function readSnapshot(tx: Tx, token: string): Promise<OrderSnapshot | null> {
  const [row] = await tx
    .select({
      id: orders.id,
      itemId: orders.itemId,
      status: orders.status,
      deliveryMethod: orders.deliveryMethod,
      expiresAt: orders.expiresAt,
      dbNow: sql<Date | string>`now()`,
    })
    .from(orders)
    .where(eq(orders.token, token));
  if (!row) return null;
  return { ...row, dbNow: new Date(row.dbNow) };
}

/** CAS ล้มเหลว (มีคนชนะไปก่อน) → อ่านสถานะล่าสุดเพื่อบอกเหตุผลที่ถูกต้อง */
async function classifyFailure(tx: Tx, token: string): Promise<OrderCommandResult> {
  const [row] = await tx
    .select({
      status: orders.status,
      inWindow: sql<boolean>`${orders.expiresAt} >= now()`,
    })
    .from(orders)
    .where(eq(orders.token, token));
  if (!row) return { ok: false, error: "not_found" };
  if (row.status === "pending_payment" && !row.inWindow) {
    return { ok: false, error: "window_closed", status: row.status };
  }
  return { ok: false, error: "invalid_state", status: row.status };
}

/**
 * อัปสลิป: pending_payment → awaiting_review
 * สัญญากับ transition(): clearReservedUntil → ตั้ง items.reserved_until = NULL ใน tx เดียวกัน
 * `slipPath` ต้องผ่านการตรวจแล้ว (pathname ของออเดอร์นี้ / สลิปตัวอย่าง) — ฟังก์ชันนี้ไม่ตรวจซ้ำ
 */
export async function uploadSlip(
  db: Db,
  input: { token: string; slipPath: string; sample?: boolean },
): Promise<OrderCommandResult> {
  return db.transaction(async (tx) => {
    const snap = await readSnapshot(tx, input.token);
    if (!snap) return { ok: false, error: "not_found" } as const;

    const t = transition(
      { status: snap.status, deliveryMethod: snap.deliveryMethod, expiresAt: snap.expiresAt },
      { type: "upload_slip", now: snap.dbNow },
    );
    if (!t.ok) {
      return t.error === "payment_window_closed"
        ? ({ ok: false, error: "window_closed", status: snap.status } as const)
        : ({ ok: false, error: "invalid_state", status: snap.status } as const);
    }

    // compare-and-set ตัวจริง — ถ้ามีคนอัปสลิป/ยกเลิก/หมดอายุไปก่อน จะไม่มีแถวคืนมา
    const won = await tx
      .update(orders)
      .set({
        status: t.to,
        slipPath: input.slipPath,
        slipUploadedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(orders.id, snap.id),
          eq(orders.status, "pending_payment"),
          gte(orders.expiresAt, sql`now()`),
        ),
      )
      .returning({ id: orders.id });
    if (won.length === 0) return classifyFailure(tx, input.token);

    if (t.clearReservedUntil) {
      await tx
        .update(items)
        .set({ reservedUntil: null, updatedAt: sql`now()` })
        .where(and(eq(items.id, snap.itemId), eq(items.status, t.itemStatus)));
    }

    await tx.insert(orderEvents).values({
      orderId: snap.id,
      type: t.eventType,
      actor: t.actor,
      meta: input.sample ? { sample: true } : null,
    });
    return { ok: true } as const;
  });
}

/** event ภายใน: บันทึกการออก Blob upload token หนึ่งครั้ง (ใช้นับเพดาน; ไม่แสดงใน timeline ลูกค้า) */
export const SLIP_TOKEN_EVENT = "slip_token_issued";
/** ออก Blob upload token ได้ไม่เกินนี้ต่อออเดอร์ (กันไฟล์กำพร้า/storage เต็มจากการอัปซ้ำๆ) */
export const MAX_SLIP_TOKENS_PER_ORDER = 3;

export type SlipTokenSlotResult =
  | { ok: true; used: number }
  | { ok: false; error: OrderCommandError | "token_limit"; status?: string };

/**
 * จองสิทธิ์ออก Blob upload token 1 ครั้งของออเดอร์ (เรียกใน onBeforeGenerateToken ก่อนคืน token)
 *
 * กัน race: อยู่ใน transaction เดียว — `SELECT ... FOR UPDATE` ล็อกแถวออเดอร์ก่อน แล้วค่อยนับ event
 * และเขียน event ถัดไป คำขอที่มาพร้อมกันจึงเรียงคิวผ่านล็อกแถวนี้ และเห็นการนับที่ commit แล้วของคนก่อนหน้า
 * (READ COMMITTED: statement ที่รันหลังได้ล็อกเห็นข้อมูลล่าสุด) ไม่มีทางเกินเพดาน
 * ตรวจสถานะ/หน้าต่างเวลา (now() ของ DB) ภายใต้ล็อกเดียวกันด้วย
 * ล็อกแถวเดียว ไม่มีล็อกอื่นซ้อน จึงไม่เกิด deadlock กับ uploadSlip/cancelOrder
 */
export async function reserveSlipTokenSlot(db: Db, token: string): Promise<SlipTokenSlotResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: orders.id,
        status: orders.status,
        inWindow: sql<boolean>`${orders.expiresAt} >= now()`,
      })
      .from(orders)
      .where(eq(orders.token, token))
      .for("update");
    if (!row) return { ok: false, error: "not_found" } as const;
    if (row.status !== "pending_payment") {
      return { ok: false, error: "invalid_state", status: row.status } as const;
    }
    if (!row.inWindow) return { ok: false, error: "window_closed", status: row.status } as const;

    const [counted] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(orderEvents)
      .where(
        and(
          eq(orderEvents.orderId, row.id),
          eq(orderEvents.type, SLIP_TOKEN_EVENT),
          eq(orderEvents.actor, "customer"),
        ),
      );
    const used = counted?.n ?? 0;
    if (used >= MAX_SLIP_TOKENS_PER_ORDER) return { ok: false, error: "token_limit" } as const;

    await tx.insert(orderEvents).values({
      orderId: row.id,
      type: SLIP_TOKEN_EVENT,
      actor: "customer",
      meta: null,
    });
    return { ok: true, used: used + 1 } as const;
  });
}

/**
 * ลูกค้ายกเลิก: pending_payment → cancelled และคืนสินค้าเป็น available (CAS ที่ status='reserved')
 */
export async function cancelOrder(db: Db, token: string): Promise<OrderCommandResult> {
  return db.transaction(async (tx) => {
    const snap = await readSnapshot(tx, token);
    if (!snap) return { ok: false, error: "not_found" } as const;

    const t = transition(
      { status: snap.status, deliveryMethod: snap.deliveryMethod, expiresAt: snap.expiresAt },
      { type: "cancel", now: snap.dbNow },
    );
    if (!t.ok) return { ok: false, error: "invalid_state", status: snap.status } as const;

    const won = await tx
      .update(orders)
      .set({ status: t.to, updatedAt: sql`now()` })
      .where(and(eq(orders.id, snap.id), eq(orders.status, "pending_payment")))
      .returning({ id: orders.id });
    if (won.length === 0) return classifyFailure(tx, token);

    await tx
      .update(items)
      .set({ status: t.itemStatus, reservedUntil: null, updatedAt: sql`now()` })
      .where(and(eq(items.id, snap.itemId), eq(items.status, "reserved")));

    await tx.insert(orderEvents).values({
      orderId: snap.id,
      type: t.eventType,
      actor: t.actor,
      meta: null,
    });
    return { ok: true } as const;
  });
}

/**
 * หมดอายุแบบ lazy ตอนอ่าน (SPEC §5 กฎข้อ 2): pending_payment ที่ expires_at < now() → expired + event
 * ไม่แตะ items (สินค้าที่ reserved_until ผ่านแล้วและไม่มีออเดอร์ถือ ถือเป็น available อยู่แล้วตามกฎจอง)
 * คืน true ถ้าครั้งนี้เป็นผู้ mark (ใช้ CAS จึงเขียน event ครั้งเดียว)
 */
export async function expireOrderIfStale(db: Db, token: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(orders)
      .set({ status: "expired", updatedAt: sql`now()` })
      .where(
        and(
          eq(orders.token, token),
          eq(orders.status, "pending_payment"),
          lt(orders.expiresAt, sql`now()`),
        ),
      )
      .returning({ id: orders.id });
    if (rows.length === 0) return false;
    await tx.insert(orderEvents).values({
      orderId: rows[0].id,
      type: "expire",
      actor: "system",
      meta: null,
    });
    return true;
  });
}
