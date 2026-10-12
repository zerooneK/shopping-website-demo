import type { ItemCategory, ItemCondition } from "./items-types";

export const CONDITION_LABEL: Record<ItemCondition, string> = {
  like_new: "เหมือนใหม่",
  good: "สภาพดี",
  fair: "พอใช้",
};

export const CATEGORY_LABEL: Record<ItemCategory, string> = {
  fashion: "แฟชั่น",
  books: "หนังสือ",
  home: "ของใช้ในบ้าน",
  tech: "เครื่องใช้ไฟฟ้า",
  other: "อื่นๆ",
};

export const CATEGORIES = Object.keys(CATEGORY_LABEL) as ItemCategory[];

/** อ่านค่า ?category= จาก search params อย่างปลอดภัย (ค่าแปลก → undefined = ทั้งหมด) */
export function parseCategory(raw: string | string[] | undefined): ItemCategory | undefined {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return CATEGORIES.find((c) => c === v);
}

export function formatPrice(price: number): string {
  return `฿${price.toLocaleString("en-US")}`;
}

/** "A012" → "012" สำหรับแสดงเป็น № 012 */
export function codeNumber(code: string): string {
  return code.replace(/^[A-Z]/, "");
}

/** ข้อความเวลานับถอยหลัง mm:ss (ไม่ติดลบ) */
export function formatCountdown(msLeft: number): string {
  const total = Math.max(0, Math.ceil(msLeft / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export const DELIVERY_LABEL = {
  pickup: "นัดรับ",
  post: "ส่งไปรษณีย์",
} as const;

const THAI_DATE_TIME = new Intl.DateTimeFormat("th-TH", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Bangkok",
});

/** วันเวลาแบบไทย (เขตเวลากรุงเทพฯ) — ใช้ในฝั่ง server เท่านั้นเพื่อกัน hydration mismatch */
export function formatThaiDateTime(ms: number): string {
  return THAI_DATE_TIME.format(new Date(ms));
}
