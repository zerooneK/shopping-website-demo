import { z } from "zod";
import { ITEM_IMAGES_MAX, isValidItemImageFile, ITEM_IMAGE_URL_PREFIX } from "../item-image";

/**
 * Zod schema ของฟอร์มสินค้าหลังบ้าน (pure) — ใช้ฝั่ง server ทุกครั้งที่บันทึก ข้อความ error เป็นภาษาไทยทั้งหมด
 * (ข้อความภาษาอังกฤษของ Zod ห้ามรั่วถึงผู้ใช้)
 *
 * รับค่าจาก FormData เป็น string → แปลงเป็นชนิดที่ถูกต้องที่นี่ ราคาต้องเป็นจำนวนเต็มบาท > 0
 */

export const ITEM_CODE_PATTERN = /^A\d{3}$/;
export const MAX_PRICE = 1_000_000;

export const CONDITIONS = ["like_new", "good", "fair"] as const;
export const CATEGORIES_LIST = ["fashion", "books", "home", "tech", "other"] as const;
/** สถานะที่แอดมินตั้งเองได้ (reserved เกิดจากระบบจองเท่านั้น) */
export const SETTABLE_STATUSES = ["available", "hidden", "sold"] as const;
export type SettableStatus = (typeof SETTABLE_STATUSES)[number];

const text = (label: string, max: number) =>
  z
    .string({ error: `กรุณากรอก${label}` })
    .trim()
    .min(1, `กรุณากรอก${label}`)
    .max(max, `${label}ยาวเกินไป (ไม่เกิน ${max} ตัวอักษร)`);

const priceSchema = z.preprocess(
  (v) => (typeof v === "number" ? String(v) : v),
  z
    .string({ error: "กรุณากรอกราคา" })
    .trim()
    .regex(/^\d{1,7}$/, "ราคาต้องเป็นจำนวนเต็มบาทที่มากกว่า 0")
    .transform(Number)
    .refine((n) => n >= 1, "ราคาต้องมากกว่า 0")
    .refine((n) => n <= MAX_PRICE, `ราคาสูงสุด ${MAX_PRICE.toLocaleString("en-US")} บาท`),
);

const sortOrderSchema = z.preprocess(
  (v) => (v === undefined || v === null || v === "" ? "0" : typeof v === "number" ? String(v) : v),
  z
    .string()
    .trim()
    .regex(/^-?\d{1,4}$/, "ลำดับต้องเป็นจำนวนเต็ม (-9999 ถึง 9999)")
    .transform(Number),
);

/** รูปในฟอร์ม: url ต้องเป็นรูปแบบพาธภายในของเรา (/api/item-images/<ไฟล์>) หรือรูปเดิมของสินค้า (ตรวจที่ชั้น verify) */
export const imageInputSchema = z.object({
  url: z
    .string({ error: "รูปไม่ถูกต้อง" })
    .min(1, "รูปไม่ถูกต้อง")
    .max(500, "รูปไม่ถูกต้อง"),
  alt: text("คำอธิบายรูป (alt)", 200),
});
export type ImageInput = z.infer<typeof imageInputSchema>;

const imagesFieldSchema = z
  .string({ error: "รูปไม่ถูกต้อง" })
  .max(20_000, "ข้อมูลรูปใหญ่เกินไป")
  .transform((raw, ctx): unknown => {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      ctx.addIssue({ code: "custom", message: "ข้อมูลรูปไม่ถูกต้อง" });
      return z.NEVER;
    }
  })
  .pipe(
    z
      .array(imageInputSchema, { error: "ข้อมูลรูปไม่ถูกต้อง" })
      .max(ITEM_IMAGES_MAX, `ใส่รูปได้ไม่เกิน ${ITEM_IMAGES_MAX} รูป`),
  );

const fieldsShape = {
  title: text("ชื่อสินค้า", 120),
  description: text("คำบรรยาย", 2000),
  // ตำหนิ: ห้ามว่าง (SPEC §4) — ถ้าไม่มีตำหนิให้ใส่ "ไม่มีตำหนิที่สังเกตเห็น"
  flaws: z
    .string({ error: "กรุณาระบุตำหนิ" })
    .trim()
    .min(1, "กรุณาระบุตำหนิ ถ้าไม่มีให้ใส่ “ไม่มีตำหนิที่สังเกตเห็น”")
    .max(1000, "ตำหนิยาวเกินไป (ไม่เกิน 1000 ตัวอักษร)"),
  condition: z.enum(CONDITIONS, { error: "กรุณาเลือกสภาพสินค้า" }),
  category: z.enum(CATEGORIES_LIST, { error: "กรุณาเลือกหมวดหมู่" }),
  price: priceSchema,
  sortOrder: sortOrderSchema,
  images: imagesFieldSchema,
};

/** แก้สินค้า: status ไม่ส่ง = ไม่เปลี่ยนสถานะ (เช่นสินค้าที่มีออเดอร์ถืออยู่ ฟอร์มจะไม่ส่งช่องนี้) */
export const itemUpdateSchema = z.object({
  ...fieldsShape,
  status: z.enum(SETTABLE_STATUSES, { error: "สถานะไม่ถูกต้อง" }).optional(),
});

/** เพิ่มสินค้า: รหัสต้องเป็น A### และสถานะเริ่มต้นเป็น available หรือ hidden (ฉบับร่าง) เท่านั้น */
export const itemCreateSchema = z.object({
  ...fieldsShape,
  code: z
    .string({ error: "กรุณากรอกรหัสสินค้า" })
    .trim()
    .toUpperCase()
    .regex(ITEM_CODE_PATTERN, "รหัสสินค้าต้องเป็นรูปแบบ A ตามด้วยตัวเลข 3 หลัก เช่น A013"),
  status: z.enum(["available", "hidden"], { error: "สถานะเริ่มต้นไม่ถูกต้อง" }),
});

export type ItemUpdateInput = z.infer<typeof itemUpdateSchema>;
export type ItemCreateInput = z.infer<typeof itemCreateSchema>;

/** เปลี่ยนสถานะเร็วจากตาราง */
export const itemStatusChangeSchema = z.object({
  itemId: z.preprocess(
    (v) => (typeof v === "string" && /^\d{1,9}$/.test(v) ? Number(v) : v),
    z.number({ error: "ไม่พบสินค้า" }).int().positive(),
  ),
  status: z.enum(SETTABLE_STATUSES, { error: "สถานะไม่ถูกต้อง" }),
});

export const itemIdSchema = z.preprocess(
  (v) => (typeof v === "string" && /^\d{1,9}$/.test(v) ? Number(v) : v),
  z.number().int().positive(),
);

/** แปลง FormData → object ธรรมดาที่ schema อ่านได้ (ช่องที่ไม่มี = undefined; ไฟล์ถูกมองเป็นไม่มีค่า) */
export function formDataToRecord(formData: FormData, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = formData.get(k);
    out[k] = typeof v === "string" ? v : undefined;
  }
  return out;
}

export const ITEM_FORM_KEYS = [
  "code",
  "title",
  "description",
  "flaws",
  "condition",
  "category",
  "price",
  "sortOrder",
  "status",
  "images",
] as const;

/** error ของ Zod → { ชื่อช่อง: ข้อความแรก } สำหรับแสดงใต้ช่อง */
export function firstIssuePerField(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    out[key] ??= issue.message;
  }
  return out;
}

/** url ของรูปที่ผู้ใช้ส่งมา "ดูเหมือน" รูปที่อัปโหลดใหม่ของเราหรือไม่ (รูปแบบเท่านั้น ยังต้องตรวจว่ามีไฟล์จริง) */
export function looksLikeUploadedItemImage(url: string): boolean {
  return url.startsWith(ITEM_IMAGE_URL_PREFIX) && isValidItemImageFile(url.slice(ITEM_IMAGE_URL_PREFIX.length));
}
