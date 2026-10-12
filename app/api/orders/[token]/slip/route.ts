import { BlobNotFoundError, head } from "@vercel/blob";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { json, readJsonBody } from "@/lib/api";
import { isDemoMode } from "@/lib/demo";
import { uploadSlip } from "@/lib/orders/commands";
import { getOrderForSlip } from "@/lib/orders/queries";
import {
  DEMO_SLIP_PATH,
  isSlipContentType,
  isValidSlipPathname,
  SLIP_MAX_BYTES,
} from "@/lib/slip";

const bodySchema = z.union([
  z.object({ sample: z.literal(true) }),
  z.object({ pathname: z.string().min(1).max(300) }),
]);

/**
 * POST /api/orders/[token]/slip — บันทึกว่าลูกค้าส่งสลิปแล้ว (SPEC §6 ข้อ 4)
 *
 *  - { pathname }: ไฟล์ที่ client อัปโหลดเข้า Vercel Blob แล้ว — server ตรวจเองว่า
 *      1) pathname อยู่ใต้ slips/<orderId>/ ของออเดอร์นี้เท่านั้น
 *      2) ไฟล์มีอยู่จริงใน Blob (head()) และ content-type/ขนาดอยู่ในเกณฑ์
 *    ไม่ส่ง/ไม่เก็บ URL ของ Blob (เก็บเฉพาะ pathname ลงคอลัมน์ slip_path)
 *  - { sample: true }: สลิปตัวอย่างใน repo (public/demo) — ผ่านเฉพาะ DEMO_MODE=true และไม่ผ่าน Blob
 *
 * การเปลี่ยนสถานะทำใน lib/orders/commands.ts#uploadSlip (CAS + ล้าง reserved_until + event ใน tx เดียว)
 */
export async function POST(
  request: NextRequest,
  ctx: RouteContext<"/api/orders/[token]/slip">,
) {
  const { token } = await ctx.params;

  const read = await readJsonBody(request);
  if (!read.ok) return read.response;
  const parsed = bodySchema.safeParse(read.body);
  if (!parsed.success) return json({ error: "ข้อมูลไม่ถูกต้อง" }, 400);

  const order = await getOrderForSlip(token);
  if (!order) return json({ error: "ไม่พบออเดอร์" }, 404);
  // ตรวจเบื้องต้นเพื่อข้อความที่เข้าใจง่าย — ตัวชี้ขาดจริงคือ CAS ใน uploadSlip
  if (order.status !== "pending_payment") {
    return json({ error: "ออเดอร์นี้ไม่ได้อยู่ในสถานะรอชำระเงินแล้ว", status: order.status }, 409);
  }
  if (!order.inWindow) {
    return json({ error: "หมดเวลาชำระเงินแล้ว ไม่สามารถส่งสลิปได้", status: "expired" }, 409);
  }

  let slipPath: string;
  let sample = false;

  if ("sample" in parsed.data) {
    if (!isDemoMode()) return json({ error: "สลิปตัวอย่างใช้ได้เฉพาะโหมดเดโม" }, 403);
    slipPath = DEMO_SLIP_PATH;
    sample = true;
  } else {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return json({ error: "ยังไม่ได้เชื่อมที่เก็บไฟล์ (Vercel Blob)" }, 503);
    }
    const { pathname } = parsed.data;
    if (!isValidSlipPathname(order.id, pathname)) {
      return json({ error: "ไฟล์สลิปไม่ถูกต้อง" }, 400);
    }
    try {
      const meta = await head(pathname);
      const type = meta.contentType.toLowerCase().split(";")[0].trim();
      if (
        meta.pathname !== pathname ||
        !isSlipContentType(type) ||
        meta.size > SLIP_MAX_BYTES ||
        meta.size <= 0
      ) {
        return json({ error: "ไฟล์สลิปไม่ถูกต้อง (ชนิดหรือขนาดไม่ผ่านเกณฑ์)" }, 400);
      }
    } catch (e) {
      if (e instanceof BlobNotFoundError) {
        return json({ error: "ไม่พบไฟล์ที่อัปโหลด กรุณาอัปโหลดใหม่" }, 400);
      }
      console.error("[slip] head failed:", e instanceof Error ? e.name : "unknown");
      return json({ error: "ตรวจไฟล์สลิปไม่สำเร็จ กรุณาลองใหม่" }, 502);
    }
    slipPath = pathname;
  }

  let result;
  try {
    result = await uploadSlip(getDb(), { token, slipPath, sample });
  } catch (e) {
    console.error("[slip] save failed:", e instanceof Error ? e.name : "unknown");
    return json({ error: "ระบบขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้ง" }, 500);
  }

  if (result.ok) return json({ status: "awaiting_review" });
  if (result.error === "not_found") return json({ error: "ไม่พบออเดอร์" }, 404);
  if (result.error === "window_closed") {
    return json({ error: "หมดเวลาชำระเงินแล้ว ไม่สามารถส่งสลิปได้", status: "expired" }, 409);
  }
  return json(
    { error: "สถานะออเดอร์เปลี่ยนไปแล้ว (อาจส่งสลิปไปแล้วหรือถูกยกเลิก)", status: result.status },
    409,
  );
}
