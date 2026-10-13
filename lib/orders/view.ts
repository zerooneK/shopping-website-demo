import type { DeliveryMethod, OrderStatus } from "@/db/schema";

/**
 * ตัดสินว่าหน้า /order/[token] ต้องแสดงอะไร (pure function — ไม่แตะ DB/เวลาของแอป)
 * `nowMs` ต้องมาจาก now() ของ DB (หรือ serverNow ที่ DB ส่งมา) ไม่ใช่นาฬิกาของเบราว์เซอร์
 */

export type OrderTone = "pending" | "waiting" | "good" | "bad" | "neutral";

export type OrderViewInput = {
  status: OrderStatus;
  deliveryMethod: DeliveryMethod;
  expiresAtMs: number;
  nowMs: number;
  trackingNo?: string | null;
  rejectReason?: string | null;
};

export type OrderViewModel = {
  /** สถานะที่ใช้แสดงจริง (pending_payment ที่เลยเวลาแล้ว = expired) */
  effectiveStatus: OrderStatus;
  headline: string;
  body: string;
  tone: OrderTone;
  /** แสดง QR + อัปสลิป + ปุ่มยกเลิก */
  showPayment: boolean;
  /** ควร poll สถานะต่อ (ยังไม่ถึงสถานะสุดท้าย) */
  keepPolling: boolean;
  /** แสดงลิงก์กลับไปเลือกสินค้า */
  showBackToShop: boolean;
  trackingNo: string | null;
  rejectReason: string | null;
};

const TERMINAL: OrderStatus[] = ["completed", "rejected", "expired", "cancelled"];

export function describeOrder(input: OrderViewInput): OrderViewModel {
  // นิยามหมดเวลาตรงกับ transition()/SQL: หมดเมื่อ now > expiresAt
  const lapsed = input.status === "pending_payment" && input.nowMs > input.expiresAtMs;
  const status: OrderStatus = lapsed ? "expired" : input.status;
  const base = {
    effectiveStatus: status,
    showPayment: false,
    keepPolling: !TERMINAL.includes(status),
    showBackToShop: false,
    trackingNo: input.trackingNo ?? null,
    rejectReason: input.rejectReason ?? null,
  };

  switch (status) {
    case "pending_payment":
      return {
        ...base,
        headline: "รอชำระเงิน",
        body: "เราจองสินค้าชิ้นนี้ไว้ให้คุณแล้ว ชำระเงินและส่งสลิปก่อนหมดเวลา",
        tone: "pending",
        showPayment: true,
      };
    case "awaiting_review":
      return {
        ...base,
        headline: "รอร้านตรวจสอบสลิป",
        body: "ได้รับสลิปแล้ว ร้านกำลังตรวจสอบ ไม่ต้องรีบ สินค้าถูกกันไว้ให้คุณระหว่างรอ หน้านี้จะอัปเดตเองเมื่อมีความคืบหน้า",
        tone: "waiting",
      };
    case "confirmed":
      return {
        ...base,
        headline:
          input.deliveryMethod === "post" ? "ร้านยืนยันแล้ว เตรียมจัดส่ง" : "ร้านยืนยันแล้ว รอนัดรับ",
        body:
          input.deliveryMethod === "post"
            ? "ร้านยืนยันการชำระเงินแล้ว กำลังเตรียมพัสดุ จะแจ้งเลขพัสดุที่หน้านี้"
            : "ร้านยืนยันการชำระเงินแล้ว ร้านจะนัดหมายรับของกับคุณ",
        tone: "good",
      };
    case "shipped":
      return {
        ...base,
        headline: "จัดส่งแล้ว",
        body: input.trackingNo ? `เลขพัสดุ ${input.trackingNo}` : "ร้านจัดส่งพัสดุให้แล้ว",
        tone: "good",
      };
    case "completed":
      return {
        ...base,
        headline: "เสร็จสิ้น",
        body: "ออเดอร์นี้เสร็จสมบูรณ์แล้ว ขอบคุณที่แวะมา",
        tone: "good",
        showBackToShop: true,
      };
    case "rejected":
      return {
        ...base,
        headline: "ร้านไม่รับสลิปนี้",
        body: input.rejectReason
          ? `เหตุผล: ${input.rejectReason}`
          : "ร้านไม่สามารถยืนยันการชำระเงินได้ สินค้าถูกปล่อยกลับเข้าร้านแล้ว",
        tone: "bad",
        showBackToShop: true,
      };
    case "expired":
      return {
        ...base,
        headline: "หมดเวลาชำระเงิน",
        body: "เลยเวลาที่จองไว้แล้ว สินค้าถูกปล่อยกลับเข้าร้าน ถ้ายังสนใจ ลองจองใหม่ได้ถ้ายังไม่มีคนจองไป",
        tone: "bad",
        showBackToShop: true,
      };
    case "cancelled":
      return {
        ...base,
        headline: "ยกเลิกออเดอร์แล้ว",
        body: "คุณยกเลิกออเดอร์นี้ สินค้าถูกปล่อยกลับเข้าร้านแล้ว",
        tone: "neutral",
        showBackToShop: true,
      };
  }
}

// ---------- timeline ----------

export type TimelineEventInput = {
  type: string;
  meta: Record<string, unknown> | null;
  createdAtMs: number;
};

export type TimelineEntry = {
  key: string;
  label: string;
  detail: string | null;
  atMs: number;
};

const LABEL: Record<string, string> = {
  created: "สร้างออเดอร์และจองสินค้าไว้ให้",
  upload_slip: "ส่งสลิปแล้ว รอร้านตรวจสอบ",
  confirm: "ร้านยืนยันการชำระเงินแล้ว",
  reject: "ร้านไม่รับสลิป",
  ship: "จัดส่งพัสดุแล้ว",
  complete: "ออเดอร์เสร็จสิ้น",
  cancel: "คุณยกเลิกออเดอร์",
  expire: "หมดเวลาชำระเงิน ปล่อยสินค้าคืนแล้ว",
};

/** event ภายในระบบ (ไม่ใช่ความคืบหน้าของออเดอร์) — ไม่แสดงให้ลูกค้า; หลังบ้าน 3c ควรกรองด้วยเช่นกัน */
const INTERNAL_EVENT_TYPES = new Set(["slip_token_issued"]);

/** ใช้ร่วมกับหลังบ้าน (lib/admin/view.ts) เพื่อให้กรอง event ภายในด้วยนิยามเดียวกัน */
export function isInternalEventType(type: string): boolean {
  return INTERNAL_EVENT_TYPES.has(type);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** แปลง order_events เป็นรายการ timeline ภาษาไทย (เรียงเก่า → ใหม่) ไม่เปิดเผย meta ที่ไม่เกี่ยวข้อง */
export function buildTimeline(events: TimelineEventInput[]): TimelineEntry[] {
  return [...events]
    .filter((e) => !INTERNAL_EVENT_TYPES.has(e.type))
    .sort((a, b) => a.createdAtMs - b.createdAtMs)
    .map((e, i) => {
      let detail: string | null = null;
      if (e.type === "reject") detail = str(e.meta?.reason);
      if (e.type === "ship") {
        const t = str(e.meta?.trackingNo);
        detail = t ? `เลขพัสดุ ${t}` : null;
      }
      return {
        key: `${e.type}-${i}`,
        label: LABEL[e.type] ?? "อัปเดตสถานะ",
        detail,
        atMs: e.createdAtMs,
      };
    });
}

/** token ของออเดอร์ = base64url 32 bytes = 43 ตัวอักษร ตรวจรูปแบบก่อนแตะ DB */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export function isValidOrderToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}
