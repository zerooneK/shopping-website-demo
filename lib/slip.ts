/**
 * ค่าคงที่/ตัวช่วยเกี่ยวกับสลิป ใช้ได้ทั้ง client และ server (ไม่มี import ฝั่ง server)
 * SPEC §6: jpeg|png|webp|heic, ≤ 8MB, ย่อยาวสุด 1600px, pathname ใต้ slips/<orderId>/
 */

export const SLIP_ALLOWED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
] as const;
export type SlipContentType = (typeof SLIP_ALLOWED_TYPES)[number];

export const SLIP_MAX_BYTES = 8 * 1024 * 1024;
export const SLIP_MAX_EDGE = 1600;

/** pathname ของสลิปตัวอย่าง (ไฟล์อยู่ใน public/demo, ไม่ผ่าน Blob) */
export const DEMO_SLIP_PATH = "demo/sample-slip.png";

const EXT_BY_TYPE: Record<SlipContentType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
};

export function isSlipContentType(v: string): v is SlipContentType {
  return (SLIP_ALLOWED_TYPES as readonly string[]).includes(v);
}

export function slipExtension(type: SlipContentType): string {
  return EXT_BY_TYPE[type];
}

/**
 * ประเภทไฟล์ที่ browser รายงานบางครั้งว่าง/เป็น image/heif สำหรับ HEIC — เดาจากนามสกุลเพิ่มเติม
 * คืน null ถ้าไม่ใช่ชนิดที่รับ
 */
export function guessSlipContentType(name: string, reported: string): SlipContentType | null {
  const t = reported.toLowerCase();
  if (isSlipContentType(t)) return t;
  if (t === "image/jpg") return "image/jpeg";
  if (t === "image/heif") return "image/heic";
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "heic" || ext === "heif") return "image/heic";
  return null;
}

export function slipPrefix(orderId: string): string {
  return `slips/${orderId}/`;
}

const SLIP_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.(?:jpg|jpeg|png|webp|heic)$/i;

/**
 * pathname ต้องอยู่ตรง `slips/<orderId>/<ชื่อไฟล์>` เท่านั้น (ไม่มี / เพิ่ม ไม่มี ..)
 * Blob SDK ไม่ให้ server เขียนทับ pathname ที่ client ส่งมา จึงต้อง "ตรวจแล้วปฏิเสธ" ไม่ใช่ "แก้ให้"
 */
export function isValidSlipPathname(orderId: string, pathname: string): boolean {
  const prefix = slipPrefix(orderId);
  if (!pathname.startsWith(prefix)) return false;
  const file = pathname.slice(prefix.length);
  return !file.includes("..") && SLIP_FILE_PATTERN.test(file);
}

/** ขนาดใหม่ที่ยาวสุดไม่เกิน max (ไม่ขยายรูปเล็ก) ปัดเป็นจำนวนเต็ม ≥ 1 */
export function fitWithin(
  width: number,
  height: number,
  max: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= max) return { width, height };
  const scale = max / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
