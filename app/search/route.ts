import { NextResponse, type NextRequest } from "next/server";
import { getPublicItem } from "@/lib/items";
import { normalizeItemCode } from "@/lib/validation";

/**
 * ค้นหาด้วยรหัส: "012" / "A012" / "#12" → 307 ไป /item/A012
 * ไม่พบ/อ่านไม่ออก → กลับหน้าแรกพร้อม ?notfound= เพื่อแสดงข้อความเป็นมิตร
 */
export async function GET(request: NextRequest) {
  const q = (request.nextUrl.searchParams.get("q") ?? "").trim().slice(0, 40);
  const url = request.nextUrl.clone();
  url.search = "";

  if (!q) {
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  const code = normalizeItemCode(q);
  const item = code ? await getPublicItem(code) : null;
  if (code && item) {
    url.pathname = `/item/${code}`;
  } else {
    url.pathname = "/";
    url.searchParams.set("notfound", q);
  }
  return NextResponse.redirect(url);
}
