import { z } from "zod";

export const SHIPPING_FEE_POST = 50;

export const deliveryMethodSchema = z.enum(["pickup", "post"]);

/** รหัสสินค้า เช่น A012 */
export const itemCodeSchema = z.string().regex(/^[A-Z]\d{3}$/, "รหัสสินค้าไม่ถูกต้อง");

/** เบอร์มือถือไทย 10 หลัก ขึ้นต้น 0 (รับ - และช่องว่างแล้วตัดออก) */
const phoneSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, ""))
  .pipe(z.string().regex(/^0\d{9}$/, "เบอร์โทรไม่ถูกต้อง"));

/**
 * input สร้างออเดอร์ — ไม่มี field ราคา/ยอดเงิน เพราะคำนวณฝั่ง server เท่านั้น
 * (key แปลกปลอมอย่าง price/amount จะถูก strip ทิ้ง)
 */
export const createOrderSchema = z
  .object({
    code: itemCodeSchema,
    customerName: z.string().trim().min(1, "กรุณากรอกชื่อ").max(100),
    phone: phoneSchema,
    deliveryMethod: deliveryMethodSchema,
    address: z.string().trim().max(500).optional(),
    note: z.string().trim().max(500).optional(),
  })
  .refine(
    (v) => v.deliveryMethod !== "post" || (v.address && v.address.length > 0),
    { path: ["address"], message: "กรุณากรอกที่อยู่สำหรับจัดส่ง" },
  );

export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export function calcShippingFee(method: "pickup" | "post"): number {
  return method === "post" ? SHIPPING_FEE_POST : 0;
}

/** ยอดรวม = ราคาสินค้าใน DB + ค่าส่ง */
export function calcAmount(itemPrice: number, method: "pickup" | "post"): number {
  return itemPrice + calcShippingFee(method);
}

/** normalize การค้นหา: "012", "A012", "#12" → "A012" (คืน null ถ้าอ่านไม่ได้) */
export function normalizeItemCode(raw: string): string | null {
  const m = raw.trim().toUpperCase().match(/^(?:#|A)?\s*(\d{1,3})$/);
  if (!m) return null;
  return `A${m[1].padStart(3, "0")}`;
}
