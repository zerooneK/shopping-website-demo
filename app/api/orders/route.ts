import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { json, parseCreateOrderBody, readJsonBody } from "@/lib/api";
import {
  DEMO_SID_COOKIE,
  demoSidCookieOptions,
  generateDemoSid,
  parseDemoSid,
} from "@/lib/demo";
import { getClientIpHash, IpHashKeyMissingError, isIpHashKeyConfigured } from "@/lib/client-ip";
import { RATE_LIMIT_MESSAGE, RATE_LIMIT_RETRY_AFTER } from "@/lib/rate-limit";
import { createDrizzleReserveStore, reserveItem } from "@/lib/reserve";

function serviceMisconfigured() {
  // log เฉพาะชื่อ env ที่ขาด (ห้ามพิมพ์ค่าใดๆ)
  console.error("[orders] missing required env: SESSION_SECRET");
  return json({ error: "ระบบยังไม่พร้อมให้บริการ กรุณาลองใหม่ภายหลัง" }, 503);
}

/**
 * POST /api/orders — จองสินค้า + สร้างออเดอร์ (SPEC §5-6)
 *  - ราคา/ยอดไม่รับจาก client (schema ตัด key แปลกปลอมทิ้ง; amount คำนวณใน reserveItem จากราคาใน DB)
 *  - ตั้ง cookie demo_sid (httpOnly, SameSite=Lax, Secure เมื่อ production) แล้วเก็บเป็น demoSessionId
 *  - rate limit 2 ชั้น (ต่อ IP / ต่อ demo_sid) อยู่ใน reserveItem (นับจาก DB ใน tx เดียวกับการจอง)
 *  - 400 = ข้อมูลผิด (error ต่อ field) · 409 = มีคนจองตัดหน้า · 429 = เกิน rate limit
 *  - 503 = production ที่ไม่ได้ตั้ง SESSION_SECRET (fail-closed: ไม่ใช้กุญแจสำรองที่อยู่ใน repo สาธารณะ)
 *  - ห้าม log ข้อมูลลูกค้า (ชื่อ/เบอร์/ที่อยู่)
 */
export async function POST(request: NextRequest) {
  // fail-closed: production ที่ไม่มี SESSION_SECRET ห้ามรับออเดอร์ (ข้อความตอบกลับทั่วไป ไม่บอกรายละเอียดภายใน)
  if (!isIpHashKeyConfigured()) return serviceMisconfigured();

  const read = await readJsonBody(request);
  if (!read.ok) return read.response;

  const parsed = parseCreateOrderBody(read.body);
  if (!parsed.ok) {
    return json({ error: "ข้อมูลไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง", fieldErrors: parsed.fieldErrors }, 400);
  }

  const existingSid = parseDemoSid(request.cookies.get(DEMO_SID_COOKIE)?.value);
  const sid = existingSid ?? generateDemoSid();

  let result;
  try {
    result = await reserveItem(createDrizzleReserveStore(getDb()), parsed.input, sid, {
      clientIpHash: getClientIpHash(request.headers),
    });
  } catch (e) {
    if (e instanceof IpHashKeyMissingError) return serviceMisconfigured();
    console.error("[orders] reserve failed:", e instanceof Error ? e.name : "unknown");
    return json({ error: "ระบบขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้ง" }, 500);
  }

  let response: NextResponse;
  if (result.ok) {
    response = json({ token: result.order.token, redirectTo: `/order/${result.order.token}` }, 201);
  } else if (result.reason === "unavailable") {
    response = json({ error: "มีคนจองตัดหน้าไปแล้ว" }, 409);
  } else {
    // 429 ทุกชั้น (IP / browser) ตอบรูปแบบเดียวกัน: ข้อความไทย + reason + Retry-After
    response = json({ error: RATE_LIMIT_MESSAGE[result.reason], reason: result.reason }, 429, {
      "Retry-After": String(RATE_LIMIT_RETRY_AFTER[result.reason]),
    });
  }

  // ตั้ง/ต่ออายุ cookie ในทุกกรณี (browser ใหม่ที่โดน 409/429 ก็ได้ sid ไว้นับ limit ต่อไป)
  response.cookies.set(DEMO_SID_COOKIE, sid, demoSidCookieOptions());
  return response;
}
