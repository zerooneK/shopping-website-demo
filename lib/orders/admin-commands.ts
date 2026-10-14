import { and, eq, inArray, not, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { items, orderEvents, orders } from "../../db/schema";
import type { OrderStatus } from "../../db/schema";
import type { AdminSession } from "../auth";
import { DEMO_ORDER_RETURN_MINUTES, demoEndedSql, holdingOrderExistsSql } from "../availability";
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
 *  - confirm โดย owner → sold (เฉพาะแถวที่ยังเป็น reserved/available; ไม่ปลด hidden) และล้าง reserved_until
 *  - confirm โดย role demo → ออเดอร์เก็บ confirmedByRole='demo'; สินค้า "ไม่เป็น sold" แต่เป็น reserved โดย
 *    reserved_until = now() + DEMO_ORDER_RETURN_MINUTES (ค่าเดียวกับที่ holdingOrderCondition ใช้ตัดสินว่าเดโมสิ้นสุด)
 *    เมื่อครบเวลา กฎ lazy expiry เดิม (reserved + lapsed + ไม่มีผู้ถือ) คืนสินค้าเป็นว่างเอง — ไม่มีงานเขียน DB ตามเวลา
 *  - ship/complete → sold เฉพาะออเดอร์ที่ owner ยืนยัน; ออเดอร์ที่ demo ยืนยันไม่แตะสินค้า และถ้าเดโมสิ้นสุดแล้ว
 *    (สินค้าอาจถูกคนอื่นจองไปแล้ว) ปฏิเสธด้วย demo_ended — กันการทับสินค้าของออเดอร์ใหม่
 *  - reject → available + reserved_until = NULL เฉพาะเมื่อสินค้ายัง reserved และไม่มีออเดอร์อื่นถืออยู่
 *    ทำได้แม้ออเดอร์ "ค้าง" (reserved_until เป็น NULL หรือค่าในอดีต) เพราะไม่พึ่งค่า reserved_until เดิม
 *  - return (owner เท่านั้น; confirmed/shipped/completed → cancelled) → available + reserved_until = NULL เมื่อสินค้ายัง
 *    sold/reserved และไม่มีออเดอร์อื่นถืออยู่ — เป็นทางเดียวที่ owner เอาสินค้าที่ขายแล้วกลับเข้าร้าน
 */

export type AdminIntent =
  | { type: "confirm" }
  | { type: "reject"; reason: string }
  | { type: "ship"; trackingNo: string }
  | { type: "complete" }
  /** owner เท่านั้น: คืนสินค้าเข้าร้าน/ยกเลิกออเดอร์ที่ยืนยันแล้ว (ต้องมีเหตุผล) */
  | { type: "return"; reason: string };

export type AdminCommandError =
  | "not_found"
  /** role demo พยายามเปลี่ยนสถานะออเดอร์ที่ไม่ได้สร้างจาก browser ของตน */
  | "not_your_order"
  /** สถานะเปลี่ยนไปแล้ว หรือ transition นี้ใช้ไม่ได้กับสถานะปัจจุบัน */
  | "invalid_state"
  /** ออเดอร์เดโมที่ยืนยันแล้วและคืนสินค้าเข้าร้านเองไปแล้ว — เปลี่ยนสถานะต่อไม่ได้ */
  | "demo_ended"
  /** คำสั่งนี้ (return) ใช้ได้เฉพาะ owner */
  | "owner_only"
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
  // สิทธิ์ตามชนิดคำสั่ง (ไม่พึ่ง UI): คืนสินค้าเข้าร้านเป็นของ owner เท่านั้น
  if (input.intent.type === "return" && input.actor.role !== "owner") {
    return { ok: false, error: "owner_only" };
  }
  return db.transaction(async (tx) => {
    const [snap] = await tx
      .select({
        id: orders.id,
        itemId: orders.itemId,
        status: orders.status,
        deliveryMethod: orders.deliveryMethod,
        expiresAt: orders.expiresAt,
        demoSessionId: orders.demoSessionId,
        confirmedByRole: orders.confirmedByRole,
        // เดโมสิ้นสุดแล้วหรือยัง (นิยามเดียวใน lib/availability.ts; เวลาตาม now() ของ DB)
        demoEnded: sql<boolean>`${demoEndedSql("orders")}`,
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

    // ออเดอร์เดโมที่สิ้นสุดแล้วเป็นปลายทาง: สินค้าคืนเข้าร้านไปแล้ว (อาจมีคนจองใหม่) ห้ามขยับ/ทับสถานะสินค้า
    if (snap.demoEnded && (intent.type === "ship" || intent.type === "complete" || intent.type === "return")) {
      return { ok: false, error: "demo_ended", status: snap.status } as const;
    }

    const t = transition(
      { status: snap.status, deliveryMethod: snap.deliveryMethod, expiresAt: snap.expiresAt },
      {
        type: intent.type,
        now: new Date(snap.dbNow),
        reason: intent.type === "reject" || intent.type === "return" ? intent.reason : undefined,
        trackingNo: intent.type === "ship" ? intent.trackingNo : undefined,
      },
      "admin",
    );
    if (!t.ok) {
      return { ok: false, error: mapError(t.error), status: snap.status } as const;
    }

    // เหตุผล reject (ต่อท้ายป้ายถ้ามาจาก demo) และเหตุผล return (owner เท่านั้น — ไม่ต้องมีป้าย) เก็บใน reject_reason
    // ลูกค้าจึงเห็นเหตุผลที่หน้าออเดอร์ (cancelled ที่มี reject_reason = ร้านคืนสินค้า ไม่ใช่ลูกค้ายกเลิกเอง)
    const storedReason =
      t.to === "rejected"
        ? String(t.meta.reason) + (actor.role === "demo" ? DEMO_REASON_SUFFIX : "")
        : intent.type === "return"
          ? String(t.meta.reason)
          : null;

    // ผู้ยืนยันเป็น demo → ออเดอร์ทดลองที่ถือสินค้าได้แค่ช่วงสั้น; ship/complete ใช้ค่าที่บันทึกตอน confirm
    const demoConfirmed = t.to === "confirmed" ? actor.role === "demo" : snap.confirmedByRole === "demo";

    // compare-and-set ตัวจริง: ต้องยังเป็นสถานะเดิมที่ transition() ตัดสินจากมัน
    const won = await tx
      .update(orders)
      .set({
        status: t.to,
        updatedAt: sql`now()`,
        ...(t.to === "confirmed" ? { confirmedAt: sql`now()`, confirmedByRole: actor.role } : {}),
        ...(t.to === "shipped"
          ? { shippedAt: sql`now()`, trackingNo: String(t.meta.trackingNo) }
          : {}),
        ...(t.to === "completed" ? { completedAt: sql`now()` } : {}),
        ...(storedReason !== null ? { rejectReason: storedReason } : {}),
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
      if (t.to === "confirmed" && demoConfirmed) {
        // ออเดอร์เดโม: ไม่ขายถาวร — ถือสินค้าไว้ (reserved) จนถึง confirmed_at + N นาที (now() ใน tx นี้ = confirmed_at)
        await tx
          .update(items)
          .set({
            status: "reserved",
            reservedUntil: sql`now() + make_interval(mins => ${sql.raw(String(DEMO_ORDER_RETURN_MINUTES))})`,
            updatedAt: sql`now()`,
          })
          .where(and(eq(items.id, snap.itemId), inArray(items.status, ["reserved", "available"])));
      } else if (!demoConfirmed) {
        await tx
          .update(items)
          .set({ status: "sold", reservedUntil: null, updatedAt: sql`now()` })
          .where(and(eq(items.id, snap.itemId), inArray(items.status, ["reserved", "available"])));
      }
      // ship/complete ของออเดอร์เดโม: สินค้าอยู่ในสถานะที่ตั้งตอน confirm แล้ว ไม่แตะ
    } else if (t.itemStatus === "available") {
      // ออเดอร์นี้เปลี่ยนเป็น rejected/cancelled แล้วใน tx นี้ จึงไม่นับเป็นผู้ถือ — เหลือเฉพาะออเดอร์อื่นที่ถือจริง
      // reject: สินค้าอยู่ในสถานะ reserved; return: สินค้าเป็น sold (owner ยืนยัน) หรือ reserved (demo ยืนยันในช่วงถือ)
      await tx
        .update(items)
        .set({ status: "available", reservedUntil: null, updatedAt: sql`now()` })
        .where(
          and(
            eq(items.id, snap.itemId),
            inArray(items.status, t.eventType === "return" ? ["reserved", "sold"] : ["reserved"]),
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
