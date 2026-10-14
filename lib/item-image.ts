/**
 * ค่าคงที่/ตัวช่วยเกี่ยวกับ "รูปสินค้าที่อัปโหลดเอง" (ไม่มี import ฝั่ง server ใช้ได้ทั้ง client/server)
 *
 * สถาปัตยกรรม (ขั้น 3c-2):
 *  - Vercel Blob "access" เป็นคุณสมบัติของ store (private/public ต่อ store) ไม่ใช่ต่อไฟล์ — store เดียวที่ใช้เก็บสลิปเป็น private
 *    จึงเก็บรูปสินค้าไว้ใน store เดียวกันใต้ prefix `items/` (private) แล้วเสิร์ฟให้สาธารณะผ่าน proxy
 *    `GET /api/item-images/<ชื่อไฟล์>` (ตรวจ pathname แบบ allowlist + sniff ชนิดไฟล์ จำกัดเฉพาะ `items/` เท่านั้น)
 *  - URL ที่เก็บใน items.images[].url จึงเป็นพาธภายในของเราเอง ไม่ใช่ URL ของ Blob
 */

export const ITEM_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type ItemImageType = (typeof ITEM_IMAGE_TYPES)[number];

export const ITEM_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const ITEM_IMAGE_MAX_EDGE = 1600;
export const ITEM_IMAGES_MAX = 8;

export const ITEM_IMAGE_BLOB_PREFIX = "items/";
export const ITEM_IMAGE_URL_PREFIX = "/api/item-images/";

const FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.(?:jpg|jpeg|png|webp)$/i;

/** ชื่อไฟล์ล้วน (ไม่มี / ไม่มี ..) ที่อยู่ใต้ items/ */
export function isValidItemImageFile(name: string): boolean {
  return !name.includes("..") && FILE_PATTERN.test(name);
}

/** `items/<ชื่อไฟล์>` เท่านั้น — ไม่ยอมให้มี sub-folder หรือ .. (กันหลุดไป slips/) */
export function isValidItemImagePathname(pathname: string): boolean {
  if (!pathname.startsWith(ITEM_IMAGE_BLOB_PREFIX)) return false;
  return isValidItemImageFile(pathname.slice(ITEM_IMAGE_BLOB_PREFIX.length));
}

export function itemImageUrlFromPathname(pathname: string): string {
  return ITEM_IMAGE_URL_PREFIX + pathname.slice(ITEM_IMAGE_BLOB_PREFIX.length);
}

/** `/api/item-images/<file>` → `items/<file>` (null ถ้าไม่ใช่รูปแบบของเรา) */
export function pathnameFromItemImageUrl(url: string): string | null {
  if (!url.startsWith(ITEM_IMAGE_URL_PREFIX)) return null;
  const file = url.slice(ITEM_IMAGE_URL_PREFIX.length);
  return isValidItemImageFile(file) ? ITEM_IMAGE_BLOB_PREFIX + file : null;
}

export function isItemImageType(v: string): v is ItemImageType {
  return (ITEM_IMAGE_TYPES as readonly string[]).includes(v);
}
