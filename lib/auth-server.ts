import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import {
  getSessionKey,
  SESSION_COOKIE,
  sessionMaxAge,
  signSession,
  verifySession,
  type AdminSession,
} from "./auth";
import { isDemoMode } from "./demo";
import { isSameOrigin } from "./admin/origin";

/**
 * ส่วนอ่าน/เขียน session ผ่าน cookie (ต้องรันในบริบท request) — ตรรกะ sign/verify อยู่ใน lib/auth.ts
 *
 * Data Access Layer: ทุกหน้า/action/route ของหลังบ้านต้องเรียก getSession()/requireSession() เอง
 * (ห้ามพึ่ง proxy.ts หรือ layout อย่างเดียว — layout ไม่ render ซ้ำตอนนำทางในเซกเมนต์เดียวกัน)
 */

/** session ที่ใช้ได้จริง ณ ตอนนี้ หรือ null (ไม่มี cookie / ลายเซ็นผิด / หมดอายุ / เดโมถูกปิด) */
export async function getSession(): Promise<AdminSession | null> {
  // ตรวจอายุ token ใช้เวลาปัจจุบัน (Date.now) ซึ่งภายใต้ Cache Components ต้องไม่ถูกคำนวณตอน prerender/prefetch
  await connection();
  const key = getSessionKey();
  if (!key) return null;
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = await verifySession(token, key);
  if (!session) return null;
  // ปิด DEMO_MODE แล้ว session เดโมที่ค้างอยู่ต้องใช้ไม่ได้ทันที
  if (session.role === "demo" && !isDemoMode()) return null;
  return session;
}

/** ใช้ในหน้า/layout: ไม่มี session → ไปหน้า login (redirect throw จึงไม่คืนค่า null) */
export async function requireSession(): Promise<AdminSession> {
  const session = await getSession();
  if (!session) redirect("/admin/login");
  return session;
}

/** ตั้ง cookie session (httpOnly, SameSite=Lax, Secure เมื่อ production) — ใช้ใน server action ตอน login */
export async function startSession(session: AdminSession): Promise<boolean> {
  const key = getSessionKey();
  if (!key) return false;
  const token = await signSession(session, key);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: sessionMaxAge(session.role),
  });
  return true;
}

export async function endSession(): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
}

/** ตรวจ Origin ของคำขอปัจจุบัน (ใช้ใน server action ทุกตัวที่เปลี่ยนข้อมูล/ session) */
export async function requestHasSameOrigin(): Promise<boolean> {
  return isSameOrigin(await headers());
}
