import { createHash, timingSafeEqual } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { parseDemoSid } from "./demo";

/**
 * Session หลังบ้าน (SPEC §3, §7, §9) — ส่วน pure ไม่แตะ next/headers จึงใช้ได้ทั้งใน proxy.ts,
 * server action, route handler และ unit test (ส่วนอ่าน/เขียน cookie อยู่ที่ lib/auth-server.ts)
 *
 * หลักการ:
 *  - ไม่มี fallback ของ SESSION_SECRET เลย (ทุก environment): ไม่มี/สั้นกว่า 32 ตัวอักษร = ระบบหลังบ้านปิด (fail-closed)
 *  - เซ็นด้วย HS256 (ล็อก algorithm ตอนตรวจ) พร้อม issuer/audience กัน token ต่างบริบท
 *  - role มี 2 แบบ: owner (รหัสผ่านจาก ADMIN_PASSWORD) และ demo (ปุ่มเดโม ใช้ได้เมื่อ DEMO_MODE=true)
 *    demo ผูกกับ demo_sid ของ browser เพื่อตัดสินว่าเห็นสลิปของออเดอร์ไหนได้
 *  - ไม่มีรายการเพิกถอนฝั่ง server: logout = ลบ cookie; token ที่หลุดไปแล้วใช้ได้จนหมดอายุ
 *    (ยอมรับสำหรับเดโม — เปลี่ยน SESSION_SECRET เพื่อเพิกถอนทุก session พร้อมกัน)
 */

export type AdminRole = "owner" | "demo";

export type AdminSession =
  | { role: "owner" }
  /** sid = ค่า demo_sid ของ browser ที่กดปุ่มเดโม (ตรงกับ orders.demo_session_id ที่ browser นั้นสร้าง) */
  | { role: "demo"; sid: string };

export const SESSION_COOKIE = "admin_session";
export const OWNER_SESSION_SECONDS = 60 * 60 * 24 * 7; // SPEC §9: 7 วัน
export const DEMO_SESSION_SECONDS = 60 * 60 * 24; // role เดโมเปิดให้คนแปลกหน้า จึงอายุสั้นกว่า
export const MIN_SECRET_LENGTH = 32;
/** รหัสเจ้าของร้านสั้นกว่านี้ = ล็อกอิน owner ไม่ได้ (ตัวป้องกันหลักต่อการเดารหัสคือความยาว/ความสุ่ม) */
export const MIN_ADMIN_PASSWORD_LENGTH = 16;

const ISSUER = "shop-website";
const AUDIENCE = "shop-admin";

type EnvLike = Record<string, string | undefined>;

/** กุญแจเซ็น session — null = ไม่ได้ตั้ง/สั้นเกินไป (ห้ามเดา/ห้ามมีค่าสำรอง) */
export function getSessionKey(env: EnvLike = process.env): Uint8Array | null {
  const secret = env.SESSION_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) return null;
  return new TextEncoder().encode(secret);
}

/** ล็อกอิน owner ได้เมื่อมีทั้งกุญแจ session และ ADMIN_PASSWORD ที่ยาวพอ */
export function isOwnerLoginConfigured(env: EnvLike = process.env): boolean {
  const pw = env.ADMIN_PASSWORD;
  return getSessionKey(env) !== null && !!pw && pw.length >= MIN_ADMIN_PASSWORD_LENGTH;
}

/** ปุ่มเดโมใช้ได้เมื่อ DEMO_MODE=true และมีกุญแจ session */
export function isDemoLoginAvailable(env: EnvLike = process.env): boolean {
  return env.DEMO_MODE === "true" && getSessionKey(env) !== null;
}

export function sessionMaxAge(role: AdminRole): number {
  return role === "owner" ? OWNER_SESSION_SECONDS : DEMO_SESSION_SECONDS;
}

/**
 * เทียบรหัสผ่านแบบ constant-time: hash ทั้งสองฝั่งด้วย SHA-256 ก่อน (ความยาวเท่ากันเสมอ ไม่รั่วความยาว)
 * แล้ว timingSafeEqual; ไม่ได้ตั้งรหัส/สั้นเกินไป = ปฏิเสธเสมอ
 */
export function verifyOwnerPassword(input: string, expected: string | undefined): boolean {
  const a = createHash("sha256").update(input, "utf8").digest();
  const b = createHash("sha256")
    .update(expected && expected.length >= MIN_ADMIN_PASSWORD_LENGTH ? expected : "", "utf8")
    .digest();
  const equal = timingSafeEqual(a, b);
  return equal && !!expected && expected.length >= MIN_ADMIN_PASSWORD_LENGTH;
}

export async function signSession(
  session: AdminSession,
  key: Uint8Array,
  nowMs: number = Date.now(),
): Promise<string> {
  const iat = Math.floor(nowMs / 1000);
  const payload: Record<string, unknown> =
    session.role === "demo" ? { role: "demo", sid: session.sid } : { role: "owner" };
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject("admin")
    .setIssuedAt(iat)
    .setExpirationTime(iat + sessionMaxAge(session.role))
    .sign(key);
}

/** ตรวจ token: ลายเซ็น, อายุ, issuer/audience, รูปแบบ payload — ผิดอย่างใดอย่างหนึ่ง = null */
export async function verifySession(
  token: string | undefined | null,
  key: Uint8Array | null,
  nowMs: number = Date.now(),
): Promise<AdminSession | null> {
  if (!token || !key) return null;
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ["HS256"],
      issuer: ISSUER,
      audience: AUDIENCE,
      subject: "admin",
      currentDate: new Date(nowMs),
    });
    const role = payload.role;
    if (role === "owner") {
      // owner ต้องไม่มี sid (กัน token แปลกรูปแบบ)
      return "sid" in payload ? null : { role: "owner" };
    }
    if (role === "demo") {
      const sid = parseDemoSid(typeof payload.sid === "string" ? payload.sid : null);
      return sid ? { role: "demo", sid } : null;
    }
    return null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------- สิทธิ์ (SPEC §7)

export type Permission =
  /** ยืนยัน/ปฏิเสธ/จัดส่ง/ปิดงาน */
  | "order.transition"
  /** เห็นชื่อ/เบอร์/ที่อยู่/หมายเหตุของลูกค้าจริง */
  | "pii.read"
  /** ดูสลิปของทุกออเดอร์ (demo ดูได้เฉพาะของ browser ตัวเอง) */
  | "slip.read_all"
  /**
   * แก้ข้อความ/ราคา/สถานะสินค้า และเพิ่มสินค้า (ขั้น 3c-2) — owner เท่านั้น
   * demo ดูอย่างเดียว: ใครก็กดปุ่มเดโมได้ และสินค้าเป็นเนื้อหาสาธารณะที่ทุกคนเห็น การให้คนแปลกหน้าแก้ชื่อ/ราคา/ซ่อนสินค้า
   * ทำให้หน้าร้านถูกทำลายได้ (ข้อความหยาบ ราคา 1 บาท ซ่อนทั้งร้าน) จนกว่ารีเซ็ตรายวัน — เลือกแบบปลอดภัยกว่า SPEC §7 เดิม
   */
  | "item.edit"
  /** อัปโหลด/ลบรูปสินค้า (ขั้น 3c-2) — owner เท่านั้น */
  | "image.upload"
  /** ลบสินค้า (ขั้น 3c-2) — owner เท่านั้น */
  | "item.delete";

const OWNER_PERMISSIONS: ReadonlySet<Permission> = new Set([
  "order.transition",
  "pii.read",
  "slip.read_all",
  "item.edit",
  "image.upload",
  "item.delete",
]);
const DEMO_PERMISSIONS: ReadonlySet<Permission> = new Set(["order.transition"]);

export function can(session: AdminSession | null, permission: Permission): boolean {
  if (!session) return false;
  return (session.role === "owner" ? OWNER_PERMISSIONS : DEMO_PERMISSIONS).has(permission);
}

/** owner ดูสลิปได้ทุกใบ; demo ดูได้เฉพาะออเดอร์ที่ demo_session_id ตรงกับ sid ใน session */
export function canViewSlip(
  session: AdminSession | null,
  orderDemoSessionId: string | null,
): boolean {
  if (!session) return false;
  if (can(session, "slip.read_all")) return true;
  return session.role === "demo" && !!orderDemoSessionId && orderDemoSessionId === session.sid;
}
