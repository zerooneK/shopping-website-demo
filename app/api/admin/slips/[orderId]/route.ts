import { get } from "@vercel/blob";
import { NextResponse, type NextRequest } from "next/server";
import { canViewSlip } from "@/lib/auth";
import { getSession } from "@/lib/auth-server";
import { getSlipRecord } from "@/lib/admin/queries";
import {
  readStreamCapped,
  SlipTooLargeError,
  sniffImageType,
  slipResponseHeaders,
} from "@/lib/admin/slip-proxy";
import { orderIdSchema } from "@/lib/admin/view";
import { DEMO_SLIP_PATH, isValidSlipPathname, SLIP_MAX_BYTES } from "@/lib/slip";

const NO_STORE = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } as const;

function fail(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

/**
 * GET /api/admin/slips/[orderId] — proxy ดูสลิป (SPEC §6 ข้อ 3, §9)
 *
 *  ลำดับตรวจ (ทุกครั้งที่ฝั่ง server ไม่พึ่ง proxy.ts):
 *   1) Sec-Fetch-Site: cross-site → 403 (ไม่ให้เว็บอื่นฝังรูปด้วย cookie ของแอดมิน)
 *   2) session → 401
 *   3) orderId ต้องเป็น uuid → 404
 *   4) role demo ดูได้เฉพาะออเดอร์ที่ demo_session_id ตรงกับ sid ของ session → ไม่ตรง 403
 *   5) อ่านไฟล์จาก Blob แบบ private ด้วย get(pathname, { access: "private" }) แล้วส่งเนื้อไฟล์เอง
 *      — ไม่เคยส่ง URL ของ Blob ให้ client; Content-Type มาจากการตรวจเนื้อไฟล์ (allowlist jpeg/png/webp)
 *  สลิปตัวอย่าง (public/demo) ไม่ผ่าน Blob → 307 ไปไฟล์ใน repo (เป็นรูปปลอมที่เปิดเผยอยู่แล้ว)
 */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/admin/slips/[orderId]">) {
  if (request.headers.get("sec-fetch-site") === "cross-site") return fail(403, "forbidden");

  const session = await getSession();
  if (!session) return fail(401, "unauthorized");

  const { orderId: rawId } = await ctx.params;
  const parsed = orderIdSchema.safeParse(rawId);
  if (!parsed.success) return fail(404, "not found");
  const orderId = parsed.data;

  const record = await getSlipRecord(orderId);
  if (!record || !record.slipPath) return fail(404, "not found");
  if (!canViewSlip(session, record.demoSessionId)) return fail(403, "forbidden");

  if (record.slipPath === DEMO_SLIP_PATH) {
    return new NextResponse(null, {
      status: 307,
      headers: { Location: "/demo/sample-slip.png", ...NO_STORE },
    });
  }

  // pathname ใน DB ต้องอยู่ใต้ slips/<orderId>/ ของออเดอร์นี้เท่านั้น (กันค่าเพี้ยน)
  if (!isValidSlipPathname(orderId, record.slipPath)) return fail(404, "not found");
  if (!process.env.BLOB_READ_WRITE_TOKEN) return fail(503, "ยังไม่ได้เชื่อมที่เก็บไฟล์ (Vercel Blob)");

  let bytes: Uint8Array;
  try {
    const blob = await get(record.slipPath, { access: "private" });
    if (!blob || blob.statusCode !== 200) return fail(404, "not found");
    bytes = await readStreamCapped(blob.stream, SLIP_MAX_BYTES);
  } catch (e) {
    if (e instanceof SlipTooLargeError) return fail(502, "ไฟล์สลิปใหญ่เกินกำหนด");
    console.error("[admin-slip] read failed:", e instanceof Error ? e.name : "unknown");
    return fail(502, "อ่านไฟล์สลิปไม่สำเร็จ");
  }

  const type = sniffImageType(bytes);
  if (!type) return fail(415, "ไฟล์สลิปเป็นชนิดที่แสดงผลไม่ได้");

  return new NextResponse(bytes as BodyInit, {
    status: 200,
    headers: slipResponseHeaders(type, bytes.byteLength),
  });
}
