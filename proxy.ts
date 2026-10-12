import { and, eq, ne } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "./db/client";
import { items } from "./db/schema";
import { itemCodeSchema } from "./lib/validation";

/**
 * ตอบ HTTP 404 จริงสำหรับ /item/[code] ที่ไม่มีสินค้า
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

export async function proxy(request: NextRequest) {
  const raw = request.nextUrl.pathname.split("/")[2] ?? "";
  const parsed = itemCodeSchema.safeParse(decodeURIComponent(raw));

  let exists = parsed.success;
  if (parsed.success) {
    try {
      exists = await itemExists(parsed.data);
    } catch {
      return NextResponse.next(); // fail open
    }
  }
  if (exists) return NextResponse.next();

  // rewrite ไปเส้นทางที่ไม่มีอยู่ → Next เรนเดอร์ not-found.tsx ด้วย status 404
  const url = request.nextUrl.clone();
  url.pathname = "/__item-not-found";
  return NextResponse.rewrite(url);
}

export const config = {
  matcher: "/item/:code",
};
