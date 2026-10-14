import { createHash, timingSafeEqual } from "node:crypto";

/**
 * ตรวจ `Authorization: Bearer ${CRON_SECRET}` ของ /api/cron/reset (SPEC §9) — pure ไม่แตะ next/*
 *
 * - fail-closed: ไม่ได้ตั้ง CRON_SECRET หรือสั้นกว่า 16 ตัวอักษร (ตามที่ Vercel แนะนำ) = ปฏิเสธทุกคำขอ
 * - เทียบแบบ timing-safe: hash ทั้งสองฝั่งด้วย SHA-256 ก่อน (ความยาวเท่ากันเสมอ ไม่รั่วความยาวความลับ) แล้ว timingSafeEqual
 * - header ต้องเป็นรูปแบบ `Bearer <ค่า>` เท่านั้น (scheme ไม่สนตัวพิมพ์เล็กใหญ่); query string / cookie ใช้ไม่ได้
 */

export const MIN_CRON_SECRET_LENGTH = 16;

export type CronAuthResult = "ok" | "unauthorized" | "not_configured";

const sha256 = (v: string) => createHash("sha256").update(v, "utf8").digest();

export function checkCronAuth(
  authorizationHeader: string | null | undefined,
  secret: string | undefined,
): CronAuthResult {
  const configured = !!secret && secret.length >= MIN_CRON_SECRET_LENGTH;
  const m = /^Bearer (.+)$/i.exec(authorizationHeader ?? "");
  const presented = m ? m[1] : "";
  // เทียบเสมอแม้ไม่ได้ตั้งค่า/ไม่มี header เพื่อให้เวลาตอบใกล้เคียงกัน
  const equal = timingSafeEqual(sha256(presented), sha256(configured ? secret! : ""));
  if (!configured) return "not_configured";
  return equal && m !== null ? "ok" : "unauthorized";
}
