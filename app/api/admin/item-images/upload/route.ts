import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { json, readJsonBody } from "@/lib/api";
import { isSameOrigin } from "@/lib/admin/origin";
import { can } from "@/lib/auth";
import { getSession } from "@/lib/auth-server";
import {
  isValidItemImagePathname,
  ITEM_IMAGE_MAX_BYTES,
  ITEM_IMAGE_TYPES,
} from "@/lib/item-image";

const TOKEN_TTL_MS = 10 * 60 * 1000;

class UploadRejected extends Error {}

/**
 * POST /api/admin/item-images/upload — ออก Vercel Blob client token สำหรับ "รูปสินค้า" (ขั้น 3c-2)
 *
 * แยกจาก /api/blob/upload (สลิปลูกค้า) โดยเจตนา: ที่นี่ต้องมี session owner เท่านั้น
 * ลำดับตรวจ (ก่อนแตะ Blob SDK ทุกครั้ง ไม่พึ่ง proxy.ts ซึ่งเป็นแค่ชั้นแรก):
 *   1) Sec-Fetch-Site: cross-site → 403   2) Origin ต้องตรงโฮสต์ → 403   3) session → 401
 *   4) สิทธิ์ image.upload (owner เท่านั้น; demo → 403)   5) Blob ตั้งค่าแล้ว → 503 ถ้ายัง
 *   6) onBeforeGenerateToken: pathname ต้องเป็น items/<ชื่อไฟล์> เท่านั้น (ห้าม slips/ ห้าม sub-folder),
 *      ไม่ multipart, ชนิดไฟล์ jpeg/png/webp, ขนาด <= 5MB, random suffix, ห้ามเขียนทับ, token อายุสั้น
 * ไม่ใช้ onUploadCompleted — ไฟล์ถูกอ้างอิงเมื่อกดบันทึกฟอร์ม ซึ่ง server action ตรวจด้วย head() อีกชั้น
 * (SDK ไม่ให้ server เปลี่ยน pathname ที่ client ส่งมา จึงใช้ "ตรวจแล้วปฏิเสธ")
 */
export async function POST(request: Request) {
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return json({ error: "forbidden" }, 403);
  }
  if (!isSameOrigin(request.headers)) return json({ error: "forbidden" }, 403);

  const session = await getSession();
  if (!session) return json({ error: "unauthorized" }, 401);
  if (!can(session, "image.upload")) {
    return json({ error: "บัญชีนี้ไม่มีสิทธิ์อัปโหลดรูปสินค้า (โหมดเดโมอัปโหลดไม่ได้)" }, 403);
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return json({ error: "ยังไม่ได้เชื่อมที่เก็บไฟล์ (Vercel Blob)" }, 503);
  }

  const read = await readJsonBody(request);
  if (!read.ok) return read.response;
  const body = read.body as HandleUploadBody;
  if (typeof body !== "object" || body === null || body.type !== "blob.generate-client-token") {
    return json({ error: "ข้อมูลไม่ถูกต้อง" }, 400);
  }

  try {
    const result = await handleUpload({
      request,
      body,
      onBeforeGenerateToken: async (pathname, _clientPayload, multipart) => {
        if (multipart) throw new UploadRejected("ไม่รองรับการอัปโหลดแบบ multipart");
        if (!isValidItemImagePathname(pathname)) throw new UploadRejected("ชื่อไฟล์รูปไม่ถูกต้อง");
        return {
          allowedContentTypes: [...ITEM_IMAGE_TYPES],
          maximumSizeInBytes: ITEM_IMAGE_MAX_BYTES,
          addRandomSuffix: true,
          allowOverwrite: false,
          validUntil: Date.now() + TOKEN_TTL_MS,
        };
      },
    });
    return json(result);
  } catch (e) {
    if (e instanceof UploadRejected) return json({ error: e.message }, 400);
    console.error("[item-upload] handleUpload failed:", e instanceof Error ? e.name : "unknown");
    return json({ error: "ขอสิทธิ์อัปโหลดไม่สำเร็จ" }, 400);
  }
}
