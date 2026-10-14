import { get } from "@vercel/blob";
import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { getSession } from "@/lib/auth-server";
import { isItemImageReferenced } from "@/lib/item-image-ref";
import { readStreamCapped, SlipTooLargeError, sniffImageType } from "@/lib/admin/slip-proxy";
import {
  isItemImageType,
  isValidItemImageFile,
  ITEM_IMAGE_BLOB_PREFIX,
  ITEM_IMAGE_MAX_BYTES,
} from "@/lib/item-image";

function fail(status: number, error: string) {
  return NextResponse.json(
    { error },
    { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
  );
}

/**
 * 404 ที่ edge cache ได้สั้นๆ (กันคำขอซ้ำชื่อเดิมถึง DB/Blob ซ้ำ)
 * ใช้ Vercel-CDN-Cache-Control / CDN-Cache-Control คุมเฉพาะ CDN ส่วนฝั่ง browser ให้ตรวจใหม่ทุกครั้ง
 * (ไม่ใช้ no-store ใน Cache-Control เพราะเกณฑ์ "cacheable response" ของ Vercel ระบุว่า no-store/private ห้าม cache)
 * Vercel-CDN-Cache-Control ถูกตัดออกก่อนถึง browser; CDN-Cache-Control ส่งต่อได้ (ไม่มีผลกับ browser)
 */
const NOT_FOUND_EDGE_SECONDS = 60;
/** รูปที่อ้างจริง: edge เก็บ 1 วัน (ชื่อไฟล์ไม่ซ้ำ เนื้อไม่เปลี่ยน แต่จำกัดอายุไว้ให้รูปที่ถูกลบหายจาก edge ภายใน 1 วัน) */
const IMAGE_EDGE_SECONDS = 86_400;

function notFound() {
  return NextResponse.json(
    { error: "not found" },
    {
      status: 404,
      headers: {
        "Cache-Control": "public, max-age=0, must-revalidate",
        "CDN-Cache-Control": `max-age=${NOT_FOUND_EDGE_SECONDS}`,
        "Vercel-CDN-Cache-Control": `max-age=${NOT_FOUND_EDGE_SECONDS}`,
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

/**
 * GET /api/item-images/[name] — เสิร์ฟ "รูปสินค้าที่อัปโหลดเอง" ให้สาธารณะ (ขั้น 3c-2)
 *
 * ไฟล์อยู่ใน Blob store แบบ private (store เดียวกับสลิป — access เป็นของ store) จึงอ่านผ่าน get() แล้วส่งเนื้อไฟล์เอง
 * ความปลอดภัย: เส้นทางนี้เป็นสาธารณะ จึงต้องเข้าถึงได้เฉพาะ `items/<ชื่อไฟล์>`:
 *  - name ผ่าน allowlist (ตัวอักษร/ตัวเลข . _ - และนามสกุลรูป; ไม่มี / ไม่มี ..) แล้วต่อ prefix `items/` เองฝั่ง server
 *    → ไม่มีทางอ่าน `slips/...` หรือไฟล์อื่นใน store ได้
 *  - ชนิดไฟล์ตัดสินจากเนื้อไฟล์ (magic bytes) เฉพาะ jpeg/png/webp; ชนิดอื่น (รวม HEIC/HTML/SVG) = 415
 *  - ขนาดจำกัดเท่าเพดานอัปโหลด
 *
 * ลดการยิง Blob ซ้ำ (cost/quota):
 *  1) ต้องมีสินค้าอ้างไฟล์นี้ใน items.images ก่อน (query DB) ไม่งั้น 404 โดยไม่แตะ Blob — ชื่อสุ่มที่ไม่มีจริงจึงไม่ถึง Blob
 *     ข้อยกเว้นเดียว: owner ที่ล็อกอินอยู่ (รูปที่เพิ่งอัปโหลดแต่ยังไม่กดบันทึกฟอร์มต้องพรีวิวได้) — ตอบแบบ private/no-store
 *     เพื่อไม่ให้ไปติด cache ของ edge (cache key ไม่รวม cookie) จึงไม่มีทางส่งรูปที่ยังไม่ถูกอ้างให้คนทั่วไป
 *  2) รูปที่อ้างจริง: Cache-Control public immutable ฝั่ง browser + Vercel-CDN-Cache-Control/CDN-Cache-Control ฝั่ง edge
 *     (ชื่อไฟล์มี random suffix ไม่ซ้ำ จึง cache ได้)
 *  3) 404 cache ที่ edge 60 วินาที
 */
export async function GET(_request: Request, ctx: RouteContext<"/api/item-images/[name]">) {
  const { name } = await ctx.params;
  if (!isValidItemImageFile(name)) return notFound();
  if (!process.env.BLOB_READ_WRITE_TOKEN) return fail(503, "ยังไม่ได้เชื่อมที่เก็บไฟล์ (Vercel Blob)");

  let referenced: boolean;
  try {
    referenced = await isItemImageReferenced(getDb(), name);
  } catch (e) {
    console.error("[item-image] reference check failed:", e instanceof Error ? e.name : "unknown");
    return fail(502, "อ่านไฟล์รูปไม่สำเร็จ");
  }
  if (!referenced) {
    // รูปที่ยังไม่ได้บันทึกกับสินค้า: เฉพาะ owner (พรีวิวในฟอร์ม) — คนทั่วไป 404 โดยไม่แตะ Blob
    const session = await getSession();
    if (session?.role !== "owner") return notFound();
  }

  let bytes: Uint8Array;
  try {
    const blob = await get(ITEM_IMAGE_BLOB_PREFIX + name, { access: "private" });
    if (!blob || blob.statusCode !== 200) return referenced ? notFound() : fail(404, "not found");
    bytes = await readStreamCapped(blob.stream, ITEM_IMAGE_MAX_BYTES);
  } catch (e) {
    if (e instanceof SlipTooLargeError) return fail(502, "ไฟล์รูปใหญ่เกินกำหนด");
    console.error("[item-image] read failed:", e instanceof Error ? e.name : "unknown");
    return fail(502, "อ่านไฟล์รูปไม่สำเร็จ");
  }

  const type = sniffImageType(bytes);
  if (!type || !isItemImageType(type)) return fail(415, "ไฟล์เป็นชนิดที่แสดงผลไม่ได้");

  const cacheHeaders: Record<string, string> = referenced
    ? {
        "Cache-Control": "public, max-age=31536000, immutable",
        "CDN-Cache-Control": `max-age=${IMAGE_EDGE_SECONDS}`,
        "Vercel-CDN-Cache-Control": `max-age=${IMAGE_EDGE_SECONDS}`,
      }
    : { "Cache-Control": "private, no-store" };

  return new NextResponse(bytes as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": type,
      "Content-Length": String(bytes.byteLength),
      "X-Content-Type-Options": "nosniff",
      ...cacheHeaders,
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": "inline",
    },
  });
}
