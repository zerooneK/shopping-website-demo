import type { DeliveryMethod, OrderStatus } from "@/db/schema";
import { DEMO_ORDER_RETURN_MINUTES } from "@/lib/availability";

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
  /** ออเดอร์ที่ role demo ยืนยันและเลยเวลาคืนสินค้าแล้ว (ตาม now() ของ DB) */
  demoEnded?: boolean;
  /** ออเดอร์นี้ role demo เป็นผู้ยืนยัน → แสดงข้อความว่าจะคืนสินค้าอัตโนมัติ */
  demoConfirmed?: boolean;
};

export type OrderViewModel = {
  /** สถานะที่ใช้แสดงจริง (pending_payment ที่เลยเวลาแล้ว = expired; ออเดอร์เดโมที่คืนสินค้าแล้ว = demo_ended) */
  effectiveStatus: OrderStatus | "demo_ended";
  /** ข้อความเสริมสำหรับออเดอร์ที่ผู้ลองเดโมยืนยัน (null = ไม่มี) */
  demoNote: string | null;
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

const TERMINAL: (OrderStatus | "demo_ended")[] = ["completed", "rejected", "expired", "cancelled", "demo_ended"];

const SOLD_STATUSES: readonly OrderStatus[] = ["confirmed", "shipped", "completed"];

export function describeOrder(input: OrderViewInput): OrderViewModel {
  // นิยามหมดเวลาตรงกับ transition()/SQL: หมดเมื่อ now > expiresAt
  const lapsed = input.status === "pending_payment" && input.nowMs > input.expiresAtMs;
  const demoEnded = input.demoEnded === true && SOLD_STATUSES.includes(input.status);
  const status: OrderStatus | "demo_ended" = lapsed ? "expired" : demoEnded ? "demo_ended" : input.status;
  const demoNote =
    input.demoConfirmed === true && !demoEnded && SOLD_STATUSES.includes(input.status)
      ? `โหมดเดโม: ออเดอร์นี้เป็นการทดลอง ไม่ใช่การขายจริง ระบบจะคืนสินค้าเข้าร้านให้เองภายใน ${DEMO_ORDER_RETURN_MINUTES} นาทีหลังยืนยัน`
      : null;
  const base = {
    effectiveStatus: status,
    demoNote,
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
      // cancelled ที่มี reject_reason = ร้าน (owner) คืนสินค้าเข้าร้านเอง ไม่ใช่ลูกค้ายกเลิก
      if (input.rejectReason) {
        return {
          ...base,
          headline: "ร้านยกเลิกออเดอร์และคืนสินค้าเข้าร้านแล้ว",
          body: `เหตุผล: ${input.rejectReason}`,
          tone: "bad",
          showBackToShop: true,
        };
      }
      return {
        ...base,
        headline: "ยกเลิกออเดอร์แล้ว",
        body: "คุณยกเลิกออเดอร์นี้ สินค้าถูกปล่อยกลับเข้าร้านแล้ว",
        tone: "neutral",
        showBackToShop: true,
      };
    case "demo_ended":
      return {
        ...base,
        headline: "เดโมสิ้นสุดแล้ว",
        body: "ออเดอร์นี้ถูกยืนยันในโหมดเดโม ซึ่งไม่ใช่การขายจริง ระบบจึงคืนสินค้าเข้าร้านให้เองแล้ว ถ้ายังสนใจ ลองจองใหม่ได้ถ้ายังไม่มีคนจองไป",
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
  return: "ร้านยกเลิกออเดอร์และคืนสินค้าเข้าร้าน",
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
      if (e.type === "reject" || e.type === "return") detail = str(e.meta?.reason);
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
