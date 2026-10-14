import type { ItemImage } from "../../db/schema";
import {
  isItemImageType,
  ITEM_IMAGE_MAX_BYTES,
  pathnameFromItemImageUrl,
} from "../item-image";
import type { ImageInput } from "./item-validation";

/**
 * ตรวจรายการรูปที่ฟอร์มส่งมา "ก่อนบันทึกลง DB" (ฝั่ง server) — ไม่เชื่อ url ที่ client ส่ง:
 *  - url ที่ตรงกับรูปเดิมของสินค้านี้ (เทียบทั้งสตริง) → ผ่าน และคง credit เดิมไว้ (ฟอร์มไม่ส่ง credit)
 *  - url ที่เป็นพาธอัปโหลดของเรา (/api/item-images/<ไฟล์>) → ต้องมีไฟล์อยู่ใน Blob จริง (head) ชนิด/ขนาดผ่านเกณฑ์
 *  - อย่างอื่น (URL ภายนอก, พาธแปลก) → ปฏิเสธ (กันฝังรูปจากเว็บอื่น/พาธไปที่ slips/)
 *  - url ซ้ำกันในรายการเดียวกัน → ปฏิเสธ
 */

export type ImageVerifyError =
  | "duplicate"
  | "unknown_image"
  | "blob_unconfigured"
  | "blob_missing"
  | "blob_invalid"
  | "blob_check_failed";

export type HeadResult = { pathname: string; contentType: string; size: number } | null;

export type ImageVerifyDeps = {
  /** มีโทเค็น Blob ตั้งไว้หรือไม่ (ไม่มี = อัปโหลดใหม่ไม่ได้) */
  blobConfigured: boolean;
  /** ตรวจไฟล์ใน Blob (null = ไม่พบ) — ถ้า throw ถือว่าตรวจไม่สำเร็จ */
  head: (pathname: string) => Promise<HeadResult>;
};

export type ImageVerifyResult =
  | { ok: true; images: ItemImage[] }
  | { ok: false; error: ImageVerifyError };

export async function verifyItemImages(
  submitted: readonly ImageInput[],
  existing: readonly ItemImage[],
  deps: ImageVerifyDeps,
): Promise<ImageVerifyResult> {
  const seen = new Set<string>();
  const known = new Map(existing.map((e) => [e.url, e]));
  const out: ItemImage[] = [];

  for (const img of submitted) {
    if (seen.has(img.url)) return { ok: false, error: "duplicate" };
    seen.add(img.url);

    const prev = known.get(img.url);
    if (prev) {
      out.push({ ...prev, alt: img.alt });
      continue;
    }

    const pathname = pathnameFromItemImageUrl(img.url);
    if (!pathname) return { ok: false, error: "unknown_image" };
    if (!deps.blobConfigured) return { ok: false, error: "blob_unconfigured" };

    let meta: HeadResult;
    try {
      meta = await deps.head(pathname);
    } catch {
      return { ok: false, error: "blob_check_failed" };
    }
    if (!meta) return { ok: false, error: "blob_missing" };
    const type = meta.contentType.toLowerCase().split(";")[0].trim();
    if (
      meta.pathname !== pathname ||
      !isItemImageType(type) ||
      meta.size <= 0 ||
      meta.size > ITEM_IMAGE_MAX_BYTES
    ) {
      return { ok: false, error: "blob_invalid" };
    }
    out.push({ url: img.url, alt: img.alt });
  }
  return { ok: true, images: out };
}

/** pathname (items/...) ของรูปที่ถูกเอาออกจากสินค้า — ใช้ลบไฟล์หลังบันทึกสำเร็จ (เฉพาะรูปที่เราอัปโหลดเอง) */
export function removedUploadedPathnames(
  before: readonly ItemImage[],
  after: readonly ItemImage[],
): string[] {
  const keep = new Set(after.map((a) => a.url));
  const out: string[] = [];
  for (const b of before) {
    if (keep.has(b.url)) continue;
    const p = pathnameFromItemImageUrl(b.url);
    if (p) out.push(p);
  }
  return out;
}

export const IMAGE_ERROR_MESSAGE: Record<ImageVerifyError, string> = {
  duplicate: "มีรูปซ้ำกันในรายการ กรุณาลบรูปที่ซ้ำ",
  unknown_image: "พบรูปที่ไม่รู้จัก กรุณาอัปโหลดรูปผ่านปุ่มอัปโหลดของหน้านี้เท่านั้น",
  blob_unconfigured: "ยังไม่ได้เชื่อมที่เก็บไฟล์ (Vercel Blob) จึงเพิ่มรูปใหม่ไม่ได้",
  blob_missing: "ไม่พบไฟล์รูปที่อัปโหลด กรุณาอัปโหลดใหม่",
  blob_invalid: "ไฟล์รูปไม่ถูกต้อง (ชนิดหรือขนาดไม่ผ่านเกณฑ์)",
  blob_check_failed: "ตรวจไฟล์รูปไม่สำเร็จ กรุณาลองใหม่อีกครั้ง",
};
