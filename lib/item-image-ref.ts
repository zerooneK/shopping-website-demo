import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { items } from "../db/schema";
import type { ItemImage } from "../db/schema";
import { ITEM_IMAGE_URL_PREFIX, ITEM_IMAGE_BLOB_PREFIX, pathnameFromItemImageUrl } from "./item-image";

/**
 * มีสินค้า (ทุกสถานะ รวมที่ซ่อน) ที่ items.images อ้าง `/api/item-images/<ไฟล์>` นี้อยู่หรือไม่
 * ใช้เป็นด่านก่อนยิง Blob ใน proxy รูปสาธารณะ (กันชื่อสุ่มที่ไม่มีจริงยิง Blob ซ้ำๆ) — ถูกกว่า get() ของ Blob มาก
 * images เป็น jsonb array ของ { url, alt, credit? } จึงใช้ containment (@>) ที่ parameter เป็นค่า JSON ล้วน (ไม่ต่อ SQL)
 */
export async function isItemImageReferenced(db: Db, file: string): Promise<boolean> {
  const needle = JSON.stringify([{ url: ITEM_IMAGE_URL_PREFIX + file }]);
  const res = await db.execute(
    sql`SELECT 1 AS ok FROM ${items} WHERE ${items.images} @> ${needle}::jsonb LIMIT 1`,
  );
  return res.rows.length > 0;
}

/**
 * จากรูปที่เพิ่ง "ถูกเอาออก" จากสินค้า → pathname (`items/<ไฟล์>`) ที่ปลอดภัยจะลบจาก Blob:
 * เฉพาะรูปอัปโหลดของเรา และ "ไม่มีสินค้าอื่นอ้างไฟล์เดียวกันอยู่" (เรียกหลัง commit การแก้/ลบสินค้าแล้ว)
 * ถ้าเช็ก DB ไม่ได้ ให้ throw — ผู้เรียกควรข้ามการลบ (เหลือไฟล์กำพร้า ดีกว่าลบรูปที่ยังมีสินค้าใช้)
 */
export async function unreferencedUploadPathnames(db: Db, removed: readonly ItemImage[]): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const img of removed) {
    const pathname = pathnameFromItemImageUrl(img.url);
    if (!pathname || seen.has(pathname)) continue;
    seen.add(pathname);
    const file = pathname.slice(ITEM_IMAGE_BLOB_PREFIX.length);
    if (!(await isItemImageReferenced(db, file))) out.push(pathname);
  }
  return out;
}
