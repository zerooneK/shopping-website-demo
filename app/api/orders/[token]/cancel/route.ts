import type { NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { json } from "@/lib/api";
import { cancelOrder } from "@/lib/orders/commands";
import { isValidOrderToken } from "@/lib/orders/view";

/**
 * POST /api/orders/[token]/cancel — ลูกค้ายกเลิก (เฉพาะ pending_payment)
 * ยกเลิก + คืนสินค้าเป็น available (CAS) + เขียน event ใน transaction เดียว (lib/orders/commands.ts)
 * ยืนยันตัวตนด้วย token ที่เป็นความลับใน URL เท่านั้น (ไม่ใช้ cookie จึงไม่มีความเสี่ยง CSRF)
 */
export async function POST(
  _request: NextRequest,
  ctx: RouteContext<"/api/orders/[token]/cancel">,
) {
  const { token } = await ctx.params;
  if (!isValidOrderToken(token)) return json({ error: "ไม่พบออเดอร์" }, 404);

  let result;
  try {
    result = await cancelOrder(getDb(), token);
  } catch (e) {
    console.error("[orders] cancel failed:", e instanceof Error ? e.name : "unknown");
    return json({ error: "ระบบขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้ง" }, 500);
  }

  if (result.ok) return json({ status: "cancelled" });
  if (result.error === "not_found") return json({ error: "ไม่พบออเดอร์" }, 404);
  return json(
    { error: "ยกเลิกไม่ได้แล้ว ออเดอร์นี้ไม่ได้อยู่ในสถานะรอชำระเงิน", status: result.status },
    409,
  );
}
