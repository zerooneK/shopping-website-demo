import type { NextRequest } from "next/server";
import { json } from "@/lib/api";
import { getOrderStatusSnapshot } from "@/lib/orders/queries";

/**
 * GET /api/orders/[token]/status — ใช้ poll ทุก 10 วินาทีจากหน้า /order/[token]
 * ส่งเฉพาะ: สถานะ, เวลาหมดอายุ, เวลาปัจจุบันของ DB (ไม่มี PII/สลิป/ราคา/เหตุผลปฏิเสธ)
 * ไม่ cache เด็ดขาด — token อยู่ใน URL
 */
export async function GET(
  _request: NextRequest,
  ctx: RouteContext<"/api/orders/[token]/status">,
) {
  const { token } = await ctx.params;
  const snap = await getOrderStatusSnapshot(token);
  if (!snap) return json({ error: "ไม่พบออเดอร์" }, 404);
  return json(
    {
      status: snap.status,
      expiresAt: snap.expiresAt.toISOString(),
      serverNow: snap.dbNow.toISOString(),
    },
    200,
    { "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow" },
  );
}
