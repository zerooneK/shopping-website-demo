/**
 * Rate limit การสร้างออเดอร์ (SPEC §7) — ส่วน "ตัดสิน" แยกจาก DB เพื่อเทสต์ได้
 * จำนวนนับมาจาก DB ใน transaction เดียวกับการจอง (ดู lib/reserve.ts) แบ่งเป็น 2 ชั้น:
 *
 *  1) ต่อ IP (hash ฝั่ง server) — กันการหลบด้วยการไม่ส่ง/เปลี่ยน cookie demo_sid
 *  2) ต่อ browser (demo_sid)   — ชั้นเดิม
 *
 * ไม่มีเพดานรวมทั้งร้าน (ถอดออกในขั้น 3b-2-fix2): เพดานรวมนับออเดอร์ที่ไม่มีวันหมดอายุ
 * (awaiting_review/confirmed/shipped/completed) จึงทำให้ร้านปฏิเสธทุกคำขอถาวรได้ ดู docs/BUILD_LOG.md
 */

/** ต่อ browser (demo_sid) */
export const MAX_PENDING_PER_SESSION = 2;
export const MAX_ORDERS_PER_HOUR = 5;

/** ต่อ IP: ออเดอร์ที่ยังถือสินค้า (pending_payment ที่ยังไม่หมดเวลา + awaiting_review) */
export const MAX_HOLDING_PER_IP = 3;
/** ต่อ IP: ออเดอร์ที่สร้างใน 1 ชั่วโมง (ทุกสถานะ) */
export const MAX_ORDERS_PER_IP_PER_HOUR = 8;

export type RateLimitCounts = {
  /** ออเดอร์ pending_payment ที่ยังไม่หมดเวลา (expires_at >= now() ของ DB) */
  pending: number;
  /** ออเดอร์ที่สร้างใน 1 ชั่วโมงล่าสุด (created_at > now() - 1 hour ของ DB) ทุกสถานะ */
  lastHour: number;
};

export type IpRateLimitCounts = {
  /** pending_payment ที่ยังไม่หมดเวลา + awaiting_review ของ IP นี้ */
  holding: number;
  lastHour: number;
};

export type RateLimitReason =
  | "too_many_pending"
  | "too_many_per_hour"
  | "ip_too_many_holding"
  | "ip_too_many_per_hour";

export type RateLimitDecision = { ok: true } | { ok: false; reason: RateLimitReason };

/** ชั้น browser (demo_sid) */
export function decideRateLimit(counts: RateLimitCounts): RateLimitDecision {
  if (counts.pending >= MAX_PENDING_PER_SESSION) {
    return { ok: false, reason: "too_many_pending" };
  }
  if (counts.lastHour >= MAX_ORDERS_PER_HOUR) {
    return { ok: false, reason: "too_many_per_hour" };
  }
  return { ok: true };
}

/** ชั้น IP */
export function decideIpRateLimit(counts: IpRateLimitCounts): RateLimitDecision {
  if (counts.holding >= MAX_HOLDING_PER_IP) {
    return { ok: false, reason: "ip_too_many_holding" };
  }
  if (counts.lastHour >= MAX_ORDERS_PER_IP_PER_HOUR) {
    return { ok: false, reason: "ip_too_many_per_hour" };
  }
  return { ok: true };
}

export const RATE_LIMIT_MESSAGE: Record<RateLimitReason, string> = {
  too_many_pending:
    "คุณมีออเดอร์ที่รอชำระเงินครบ 2 รายการแล้ว กรุณาชำระหรือยกเลิกรายการเดิมก่อนจองชิ้นใหม่",
  too_many_per_hour: "สร้างออเดอร์ครบ 5 รายการในชั่วโมงนี้แล้ว (จำกัดเพื่อกันการกดจองเล่น) กรุณารอสักครู่",
  ip_too_many_holding:
    "การเชื่อมต่อนี้มีออเดอร์ที่ยังค้างอยู่ครบ 3 รายการแล้ว กรุณาชำระหรือยกเลิกรายการเดิมก่อนจองชิ้นใหม่",
  ip_too_many_per_hour:
    "การเชื่อมต่อนี้สร้างออเดอร์ครบ 8 รายการในชั่วโมงนี้แล้ว (จำกัดเพื่อกันการกดจองเล่น) กรุณาลองใหม่ภายหลัง",
};

/** Retry-After (วินาที) เป็นค่าประมาณที่เป็นมิตร ไม่ใช่คำมั่นสัญญา */
export const RATE_LIMIT_RETRY_AFTER: Record<RateLimitReason, number> = {
  too_many_pending: 60,
  too_many_per_hour: 600,
  ip_too_many_holding: 60,
  ip_too_many_per_hour: 600,
};
