import type { DeliveryMethod, ItemStatus, OrderStatus } from "@/db/schema";

/**
 * State machine ของออเดอร์ (SPEC §5) — pure function ไม่แตะ DB
 * ผู้เรียกต้องเขียน order_events และอัปเดตสินค้าตามผลลัพธ์เอง
 */

export type OrderEventType =
  | "upload_slip"
  | "cancel"
  | "expire"
  | "confirm"
  | "reject"
  | "ship"
  | "complete";

export type Actor = "customer" | "admin" | "system";

export type TransitionOrder = {
  status: OrderStatus;
  deliveryMethod: DeliveryMethod;
  expiresAt: Date;
};

export type TransitionEvent = {
  type: OrderEventType;
  now: Date;
  reason?: string; // reject
  trackingNo?: string; // ship
};

export type TransitionError =
  | "invalid_transition"
  | "wrong_actor"
  | "payment_window_closed"
  | "not_yet_expired"
  | "reason_required"
  | "tracking_required"
  | "pickup_cannot_ship";

export type TransitionResult =
  | {
      ok: true;
      from: OrderStatus;
      to: OrderStatus;
      actor: Actor;
      /** สถานะสินค้าที่ต้องเป็นหลัง transition */
      itemStatus: ItemStatus;
      /**
       * true = ผู้เรียกต้องตั้ง items.reserved_until = NULL ใน transaction เดียวกับการอัปเดตออเดอร์
       * (upload_slip: เลิกนับเวลา ไม่ให้ใครแย่งสินค้าที่จ่ายแล้วด้วย lazy expiry — SPEC §5)
       */
      clearReservedUntil: boolean;
      eventType: OrderEventType;
      meta: Record<string, unknown>;
    }
  | { ok: false; error: TransitionError };

const ACTOR: Record<OrderEventType, Actor> = {
  upload_slip: "customer",
  cancel: "customer",
  expire: "system",
  confirm: "admin",
  reject: "admin",
  ship: "admin",
  complete: "admin",
};

function itemStatusFor(to: OrderStatus): ItemStatus {
  switch (to) {
    case "pending_payment":
    case "awaiting_review":
      return "reserved";
    case "confirmed":
    case "shipped":
    case "completed":
      return "sold";
    case "expired":
    case "rejected":
    case "cancelled":
      return "available";
  }
}

export function transition(
  order: TransitionOrder,
  event: TransitionEvent,
  actor: Actor = ACTOR[event.type],
): TransitionResult {
  if (actor !== ACTOR[event.type]) {
    return { ok: false, error: "wrong_actor" };
  }

  const { status } = order;
  // นิยามเดียวกับ SQL (SPEC §5): หมดอายุเมื่อ now > expiresAt (strict)
  // bulk expire ใน reserve.ts (expires_at < now()) จึงเทียบเท่า transition(..., "expire")
  const expired = event.now.getTime() > order.expiresAt.getTime();
  const meta: Record<string, unknown> = {};
  let to: OrderStatus;

  switch (event.type) {
    case "upload_slip":
      if (status !== "pending_payment") {
        return { ok: false, error: "invalid_transition" };
      }
      if (expired) return { ok: false, error: "payment_window_closed" };
      to = "awaiting_review";
      break;

    case "cancel":
      if (status !== "pending_payment") {
        return { ok: false, error: "invalid_transition" };
      }
      to = "cancelled";
      break;

    case "expire":
      if (status !== "pending_payment") {
        return { ok: false, error: "invalid_transition" };
      }
      if (!expired) return { ok: false, error: "not_yet_expired" };
      to = "expired";
      break;

    case "confirm":
      if (status !== "awaiting_review") {
        return { ok: false, error: "invalid_transition" };
      }
      to = "confirmed";
      break;

    case "reject": {
      if (status !== "awaiting_review") {
        return { ok: false, error: "invalid_transition" };
      }
      const reason = event.reason?.trim();
      if (!reason) return { ok: false, error: "reason_required" };
      meta.reason = reason;
      to = "rejected";
      break;
    }

    case "ship": {
      if (status !== "confirmed") {
        return { ok: false, error: "invalid_transition" };
      }
      if (order.deliveryMethod !== "post") {
        return { ok: false, error: "pickup_cannot_ship" };
      }
      const trackingNo = event.trackingNo?.trim();
      if (!trackingNo) return { ok: false, error: "tracking_required" };
      meta.trackingNo = trackingNo;
      to = "shipped";
      break;
    }

    case "complete":
      // ส่งไปรษณีย์: shipped → completed / นัดรับ: confirmed → completed ได้เลย
      if (
        status === "shipped" ||
        (status === "confirmed" && order.deliveryMethod === "pickup")
      ) {
        to = "completed";
        break;
      }
      return { ok: false, error: "invalid_transition" };
  }

  return {
    ok: true,
    from: status,
    to,
    actor,
    itemStatus: itemStatusFor(to),
    clearReservedUntil: to === "awaiting_review",
    eventType: event.type,
    meta,
  };
}
