import { and, eq, inArray, not, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { items, orderEvents, orders } from "../../db/schema";
import type { OrderStatus } from "../../db/schema";
import type { AdminSession } from "../auth";
import { holdingOrderExistsSql } from "../availability";
import { transition, type TransitionError } from "./transition";

/**
 * คำสั่งเปลี่ยนสถานะออเดอร์ฝั่งแอดมิน (ยืนยัน / ปฏิเสธ / จัดส่ง / ปิดงาน) — SPEC §5, §6
 *
 * หลักการเดียวกับ commands.ts (ฝั่งลูกค้า):
 *  - transition() ตัดสินว่าเปลี่ยนได้ไหม; ตัวชี้ขาดการแข่งกันคือ compare-and-set ใน SQL
 *    (`WHERE id = ? AND status = <สถานะที่อ่านมา>`) — กดพร้อมกัน ผู้ชนะมีได้คนเดียว
 *  - ออเดอร์ + สินค้า + order_events อยู่ใน transaction เดียว ผิดพลาดตรงไหน rollback ทั้งหมด
 *  - ฟังก์ชันนี้ "ไม่ตรวจ Origin/session" — ผู้เรียก (server action) ต้องตรวจก่อนเสมอ แต่ "ขอบเขตออเดอร์" บังคับที่นี่:
 *    role demo เปลี่ยนสถานะได้เฉพาะออเดอร์ที่ orders.demo_session_id = sid ของ session (ตรวจก่อน transition และซ้ำใน
 *    WHERE ของ compare-and-set) ส่วน owner ไม่ถูกจำกัด
 *  - เหตุผล reject ที่มาจาก role demo ถูกต่อท้ายด้วย DEMO_REASON_SUFFIX ตอนบันทึก (ทั้งคอลัมน์ reject_reason และ event)
 *    เพื่อให้ทุกที่ที่ลูกค้าเห็นข้อความนี้ติดป้ายว่าไม่ใช่ข้อความจากร้านจริง
 *
 * สินค้า:
 *  - confirm/ship/complete → sold (เฉพาะแถวที่ยังเป็น reserved/available; ไม่ปลด hidden) และล้าง reserved_until
 *  - reject → available + reserved_until = NULL เฉพาะเมื่อสินค้ายัง reserved และไม่มีออเดอร์อื่นถืออยู่
 *    ทำได้แม้ออเดอร์ "ค้าง" (reserved_until เป็น NULL หรือค่าในอดีต) เพราะไม่พึ่งค่า reserved_until เดิม
 */

export type AdminIntent =
  | { type: "confirm" }
  | { type: "reject"; reason: string }
  | { type: "ship"; trackingNo: string }
  | { type: "complete" };

export type AdminCommandError =
  | "not_found"
  /** role demo พยายามเปลี่ยนสถานะออเดอร์ที่ไม่ได้สร้างจาก browser ของตน */
  | "not_your_order"
  /** สถานะเปลี่ยนไปแล้ว หรือ transition นี้ใช้ไม่ได้กับสถานะปัจจุบัน */
  | "invalid_state"
  | "reason_required"
  | "tracking_required"
  | "pickup_cannot_ship";

export type AdminCommandResult =
  | { ok: true; from: OrderStatus; to: OrderStatus }
  | { ok: false; error: AdminCommandError; status?: OrderStatus };

export type AdminActorRole = "owner" | "demo";

/** ป้ายต่อท้ายเหตุผล reject ที่เขียนโดย role demo (ลูกค้าเห็นข้อความนี้) */
export const DEMO_REASON_SUFFIX = " (ข้อความจากผู้ลองเดโม)";

function mapError(e: TransitionError): AdminCommandError {
  switch (e) {
    case "reason_required":
    case "tracking_required":
    case "pickup_cannot_ship":
      return e;
    default:
      return "invalid_state";
  }
}

export async function adminTransition(
  db: Db,
  input: { orderId: string; intent: AdminIntent; actor: AdminSession },
): Promise<AdminCommandResult> {
  return db.transaction(async (tx) => {
    const [snap] = await tx
      .select({
        id: orders.id,
        itemId: orders.itemId,
        status: orders.status,
        deliveryMethod: orders.deliveryMethod,
        expiresAt: orders.expiresAt,
        demoSessionId: orders.demoSessionId,
        dbNow: sql<Date | string>`now()`,
      })
      .from(orders)
      .where(eq(orders.id, input.orderId));
    if (!snap) return { ok: false, error: "not_found" } as const;

    // ขอบเขตออเดอร์ของ role demo: ต้องเป็นออเดอร์ที่ sid ตรงกันเท่านั้น (ไม่พึ่ง UI)
    const actor = input.actor;
    if (actor.role === "demo" && (!snap.demoSessionId || snap.demoSessionId !== actor.sid)) {
      return { ok: false, error: "not_your_order" } as const;
    }

    const intent = input.intent;
    const t = transition(
      { status: snap.status, deliveryMethod: snap.deliveryMethod, expiresAt: snap.expiresAt },
      {
        type: intent.type,
        now: new Date(snap.dbNow),
        reason: intent.type === "reject" ? intent.reason : undefined,
        trackingNo: intent.type === "ship" ? intent.trackingNo : undefined,
      },
      "admin",
    );
    if (!t.ok) {
      return { ok: false, error: mapError(t.error), status: snap.status } as const;
    }

    const storedReason =
      t.to === "rejected" ? String(t.meta.reason) + (actor.role === "demo" ? DEMO_REASON_SUFFIX : "") : null;

    // compare-and-set ตัวจริง: ต้องยังเป็นสถานะเดิมที่ transition() ตัดสินจากมัน
    const won = await tx
      .update(orders)
      .set({
        status: t.to,
        updatedAt: sql`now()`,
        ...(t.to === "confirmed" ? { confirmedAt: sql`now()` } : {}),
        ...(t.to === "shipped"
          ? { shippedAt: sql`now()`, trackingNo: String(t.meta.trackingNo) }
          : {}),
        ...(t.to === "completed" ? { completedAt: sql`now()` } : {}),
        ...(t.to === "rejected" ? { rejectReason: storedReason } : {}),
      })
      .where(
        and(
          eq(orders.id, snap.id),
          eq(orders.status, snap.status),
          // ซ้ำอีกชั้นใน WHERE: demo อัปเดตได้เฉพาะแถวที่ sid ตรงกัน
          actor.role === "demo" ? eq(orders.demoSessionId, actor.sid) : undefined,
        ),
      )
      .returning({ id: orders.id });
    if (won.length === 0) {
      const [now] = await tx
        .select({ status: orders.status })
        .from(orders)
        .where(eq(orders.id, snap.id));
      return now
        ? ({ ok: false, error: "invalid_state", status: now.status } as const)
        : ({ ok: false, error: "not_found" } as const);
    }

    if (t.itemStatus === "sold") {
      await tx
        .update(items)
        .set({ status: "sold", reservedUntil: null, updatedAt: sql`now()` })
        .where(and(eq(items.id, snap.itemId), inArray(items.status, ["reserved", "available"])));
    } else if (t.itemStatus === "available") {
      // ออเดอร์นี้เปลี่ยนเป็น rejected แล้วใน tx นี้ จึงไม่นับเป็นผู้ถือ — เหลือเฉพาะออเดอร์อื่นที่ถือจริง
      await tx
        .update(items)
        .set({ status: "available", reservedUntil: null, updatedAt: sql`now()` })
        .where(
          and(
            eq(items.id, snap.itemId),
            eq(items.status, "reserved"),
            not(holdingOrderExistsSql(sql`items.id`)),
          ),
        );
    }

    await tx.insert(orderEvents).values({
      orderId: snap.id,
      type: t.eventType,
      actor: "admin",
      meta: {
        ...t.meta,
        ...(storedReason !== null ? { reason: storedReason } : {}),
        adminRole: actor.role,
      },
    });
    return { ok: true, from: t.from, to: t.to } as const;
  });
}
