import { and, eq, ne } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "./db/client";
import { getSessionKey, SESSION_COOKIE, verifySession } from "./lib/auth";
import { isDemoMode } from "./lib/demo";
import { items, orders } from "./db/schema";
import { isValidOrderToken } from "./lib/orders/view";
import { itemCodeSchema } from "./lib/validation";

/**
 * ตอบ HTTP 404 จริงสำหรับ /item/[code], /checkout/[code] ที่ไม่มีสินค้า และ /order/[token] ที่ไม่มีออเดอร์
 *
 * เหตุผล: ภายใต้ Cache Components หน้านี้ส่ง static shell ก่อน แล้วค่อยรัน notFound() ใน
 * หน้า → status ถูกล็อกเป็น 200 (+ noindex) ตามเอกสาร Next 16 ("Status codes" ใน loading.md)
 * จึงตรวจตั้งแต่ก่อน render ที่นี่แทน (page.tsx ยังเรียก notFound() เป็นชั้นสำรอง)
 *
 * - รูปแบบรหัสผิด → 404 ทันที (ไม่แตะ DB)
 * - รูปแบบถูก → เช็กว่ามีใน DB และไม่ใช่ hidden (cache ผลที่พบในหน่วยความจำ 60 วินาที)
 * - DB ล้มเหลว → ปล่อยผ่าน (fail open) ให้หน้าจัดการเอง
 */
const FOUND_TTL_MS = 60_000;
const found = new Map<string, number>(); // code -> หมดอายุเมื่อ (epoch ms)

async function itemExists(code: string): Promise<boolean> {
  const exp = found.get(code);
  if (exp && exp > Date.now()) return true;
  const rows = await getDb()
    .select({ id: items.id })
    .from(items)
    .where(and(eq(items.code, code), ne(items.status, "hidden")))
    .limit(1);
  if (rows.length === 0) return false;
  found.set(code, Date.now() + FOUND_TTL_MS);
  return true;
}

async function orderExists(token: string): Promise<boolean> {
  // ไม่ memo: ออเดอร์ถูกลบได้ทุกวัน (cron reset) และต้องการคำตอบสดทุกครั้ง (query เดียวผ่าน unique index)
  const rows = await getDb()
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.token, token))
    .limit(1);
  return rows.length > 0;
}

/**
 * ด่านแรกของหลังบ้าน (optimistic): ไม่มี session ที่ถูกต้อง → /admin/* ไปหน้า login, /api/admin/* ตอบ 401
 * นี่เป็นแค่ชั้นแรก — ทุกหน้า/server action/route handler ของหลังบ้านตรวจ session ซ้ำเองฝั่ง server
 * (lib/auth-server.ts) ห้ามพึ่งไฟล์นี้ชั้นเดียว
 */
async function adminGate(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname === "/admin/login" || pathname.startsWith("/admin/login/")) {
    return NextResponse.next();
  }
  const session = await verifySession(request.cookies.get(SESSION_COOKIE)?.value, getSessionKey());
  const valid = session !== null && (session.role !== "demo" || isDemoMode());
  if (valid) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401, headers: { "Cache-Control": "private, no-store" } },
    );
  }
  const url = request.nextUrl.clone();
  url.pathname = "/admin/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname === "/admin" || pathname.startsWith("/admin/") || pathname.startsWith("/api/admin/")) {
    return adminGate(request);
  }

  const [, section, rawParam = ""] = request.nextUrl.pathname.split("/");
  let param = rawParam;
  try {
    param = decodeURIComponent(rawParam);
  } catch {
    // %-encoding เสีย → ถือว่าไม่ตรงรูปแบบ (ตกไป 404 ด้านล่าง)
  }

  let exists: boolean;
  try {
    if (section === "order") {
      exists = isValidOrderToken(param) && (await orderExists(param));
    } else {
      const parsed = itemCodeSchema.safeParse(param);
      exists = parsed.success && (await itemExists(parsed.data));
    }
  } catch {
    return NextResponse.next(); // fail open
  }
  if (exists) return NextResponse.next();

  // rewrite ไปเส้นทางที่ไม่มีอยู่ → Next เรนเดอร์ not-found.tsx ด้วย status 404
  const url = request.nextUrl.clone();
  url.pathname = "/__not-found";
  return NextResponse.rewrite(url);
}

export const config = {
  matcher: [
    "/item/:code",
    "/checkout/:code",
    "/order/:token",
    "/admin",
    "/admin/:path*",
    "/api/admin/:path*",
  ],
};
