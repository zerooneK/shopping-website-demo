import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { z } from "zod";
import { json, readJsonBody } from "@/lib/api";
import { getDb } from "@/db/client";
import { MAX_SLIP_TOKENS_PER_ORDER, reserveSlipTokenSlot } from "@/lib/orders/commands";
import { getOrderForSlip } from "@/lib/orders/queries";
import { isValidSlipPathname, SLIP_ALLOWED_TYPES, SLIP_MAX_BYTES } from "@/lib/slip";

const payloadSchema = z.object({ token: z.string().min(1).max(100) });
const TOKEN_TTL_MS = 10 * 60 * 1000;

/** ข้อความที่ปลอดภัยพอจะส่งกลับให้ client (ไม่รั่วรายละเอียดภายใน) */
class UploadRejected extends Error {}

/**
 * POST /api/blob/upload — ออก Vercel Blob client token สำหรับอัปโหลดสลิป (SPEC §6)
 *
 * onBeforeGenerateToken ตรวจก่อนออก token ทุกครั้ง:
 *  - order token ใน clientPayload ถูกต้อง, สถานะ pending_payment, ยังไม่หมดเวลา (เวลาของ DB)
 *  - pathname ที่ client ขอ ต้องอยู่ใต้ slips/<orderId>/ ของออเดอร์นั้นเท่านั้น
 *    (SDK ไม่ให้ server เปลี่ยน pathname ได้ จึงใช้วิธี "ตรวจแล้วปฏิเสธ" — token ที่ออกผูกกับ pathname ที่ผ่านการตรวจ)
 *  - ออก token ได้ไม่เกิน MAX_SLIP_TOKENS_PER_ORDER (3) ครั้งต่อออเดอร์ (reserveSlipTokenSlot: ล็อกแถว + นับ order_events)
 *  - บังคับ content-type, ขนาดสูงสุด, random suffix, ห้ามเขียนทับ, อายุ token สั้น
 * ไม่ใช้ onUploadCompleted — ให้ client เรียก /api/orders/[token]/slip ซึ่งตรวจด้วย head() อีกชั้น
 */
export async function POST(request: Request) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return json({ error: "ยังไม่ได้เชื่อมที่เก็บไฟล์ (Vercel Blob)" }, 503);
  }

  const read = await readJsonBody(request);
  if (!read.ok) return read.response;
  const body = read.body as HandleUploadBody;
  if (typeof body !== "object" || body === null || typeof body.type !== "string") {
    return json({ error: "ข้อมูลไม่ถูกต้อง" }, 400);
  }

  try {
    const result = await handleUpload({
      request,
      body,
      onBeforeGenerateToken: async (pathname, clientPayload, multipart) => {
        if (multipart) throw new UploadRejected("ไม่รองรับการอัปโหลดแบบ multipart");

        let parsedPayload;
        try {
          parsedPayload = payloadSchema.parse(JSON.parse(clientPayload ?? ""));
        } catch {
          throw new UploadRejected("ข้อมูลออเดอร์ไม่ถูกต้อง");
        }

        const order = await getOrderForSlip(parsedPayload.token);
        if (!order) throw new UploadRejected("ไม่พบออเดอร์");
        if (order.status !== "pending_payment" || !order.inWindow) {
          throw new UploadRejected("ออเดอร์นี้ส่งสลิปไม่ได้แล้ว (หมดเวลาหรือเปลี่ยนสถานะ)");
        }
        if (!isValidSlipPathname(order.id, pathname)) {
          throw new UploadRejected("ชื่อไฟล์สลิปไม่ถูกต้อง");
        }

        // จำกัดจำนวน token ที่ออกได้ต่อออเดอร์ (นับจาก order_events ใน tx เดียวกับการล็อกแถว — ไม่มี race)
        // ทำหลังตรวจ pathname เพื่อไม่ให้คำขอที่ผิดรูปแบบกินโควตา
        const slot = await reserveSlipTokenSlot(getDb(), parsedPayload.token);
        if (!slot.ok) {
          if (slot.error === "token_limit") {
            throw new UploadRejected(
              `ขอสิทธิ์อัปโหลดสลิปครบ ${MAX_SLIP_TOKENS_PER_ORDER} ครั้งแล้วสำหรับออเดอร์นี้ ไม่สามารถอัปโหลดเพิ่มได้`,
            );
          }
          if (slot.error === "not_found") throw new UploadRejected("ไม่พบออเดอร์");
          throw new UploadRejected("ออเดอร์นี้ส่งสลิปไม่ได้แล้ว (หมดเวลาหรือเปลี่ยนสถานะ)");
        }

        return {
          allowedContentTypes: [...SLIP_ALLOWED_TYPES],
          maximumSizeInBytes: SLIP_MAX_BYTES,
          addRandomSuffix: true,
          allowOverwrite: false,
          validUntil: Date.now() + TOKEN_TTL_MS,
          tokenPayload: order.id,
        };
      },
    });
    return json(result);
  } catch (e) {
    if (e instanceof UploadRejected) return json({ error: e.message }, 400);
    console.error("[blob] handleUpload failed:", e instanceof Error ? e.name : "unknown");
    return json({ error: "ขอสิทธิ์อัปโหลดไม่สำเร็จ" }, 400);
  }
}
