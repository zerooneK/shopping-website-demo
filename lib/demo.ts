import { randomBytes } from "node:crypto";

/**
 * ตัวช่วยโหมดเดโม + cookie `demo_sid` (SPEC §7)
 * demo_sid ใช้ระบุ "browser นี้" เพื่อทำ rate limit และ (ขั้น 3c) ตัดสินว่าเห็นสลิปของตัวเองได้
 * ไม่ใช่ตัวยืนยันตัวตน — ห้ามใช้เป็นสิทธิ์เข้าถึงข้อมูลอย่างอื่น
 */

export const DEMO_SID_COOKIE = "demo_sid";
/** 24 bytes = 192 บิต (ขั้นต่ำตามคำสั่ง 128 บิต) */
const SID_BYTES = 24;
const SID_PATTERN = /^[A-Za-z0-9_-]{32,64}$/;
export const DEMO_SID_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

export function isDemoMode(): boolean {
  return process.env.DEMO_MODE === "true";
}

export function generateDemoSid(): string {
  return randomBytes(SID_BYTES).toString("base64url");
}

/** คืนค่า sid ถ้ารูปแบบถูกต้อง ไม่เช่นนั้น null (ไม่เชื่อค่าจาก cookie ที่รูปแบบแปลก) */
export function parseDemoSid(raw: string | undefined | null): string | null {
  if (!raw) return null;
  return SID_PATTERN.test(raw) ? raw : null;
}

export function demoSidCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: DEMO_SID_MAX_AGE_SECONDS,
  };
}
