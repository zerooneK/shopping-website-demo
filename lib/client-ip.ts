import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { MIN_SECRET_LENGTH } from "./auth";

/**
 * ระบุ IP ของผู้เรียก + hash ด้วย HMAC-SHA256 (ห้ามเก็บ/ log IP ดิบ) สำหรับ rate limit ตาม IP (SPEC §7)
 *
 * ความน่าเชื่อถือของ header ขึ้นกับ Vercel:
 *  เอกสาร "Request headers" ของ Vercel ระบุว่า `x-forwarded-for` คือ public IP ของ client และ Vercel
 *  "overwrite" header นี้เองและไม่ forward IP ภายนอก เพื่อกัน IP spoofing; `x-real-ip` มีค่าเหมือนกัน
 *  (ฟังก์ชัน `ipAddress()` ของ @vercel/functions อ่าน `x-real-ip`) — ดังนั้นบน Vercel ค่าเหล่านี้เชื่อได้
 *  แต่นอก Vercel (เช่น `next start` บนเครื่อง local) client ปลอม header เองได้ — ยอมรับได้เพราะ
 *  ใช้เฉพาะ dev/test เท่านั้น ห้ามเอาไปรันหลัง proxy ที่ไม่ได้เขียนทับ header เหล่านี้
 *
 * ก่อน hash จะ normalize ให้เป็น "ตัวแทนของผู้ใช้หนึ่งราย":
 *  - IPv4 → ใช้ทั้งค่า
 *  - IPv4-mapped IPv6 (::ffff:a.b.c.d) → ถือเป็น IPv4 ตัวนั้น
 *  - IPv6 อื่นๆ → ใช้เฉพาะ prefix /64 (ผู้ใช้ปลายทางมักได้ทั้ง /64 จึงหมุน address ภายใน /64
 *    เพื่อหลบ limit ได้ฟรีถ้า hash ทั้ง 128 bit); zone id (%eth0) ถูกตัดทิ้ง
 *
 * หา IP ไม่ได้/รูปแบบไม่ใช่ IP → ใช้ bucket เดียว "unknown" (ปลอดภัยไว้ก่อน: ทุกคนที่หา IP ไม่ได้ใช้โควตาร่วมกัน)
 */

export const UNKNOWN_IP = "unknown";

/** ค่าคงที่สำหรับ dev/test เท่านั้น — ห้ามใช้ใน production (อยู่ใน repo สาธารณะ) */
const DEV_FALLBACK_KEY = "dev-only-ip-hash-key-not-a-secret";

/** production ที่ไม่ตั้ง SESSION_SECRET: ไม่มีกุญแจให้ hash IP → ต้อง fail-closed (route ตอบ 503) */
export class IpHashKeyMissingError extends Error {
  constructor() {
    // ข้อความมีเฉพาะชื่อ env (ไม่มีค่าใดๆ)
    super("missing required env: SESSION_SECRET");
    this.name = "IpHashKeyMissingError";
  }
}

/**
 * SESSION_SECRET ที่ "ใช้ได้" — เกณฑ์เดียวกับกุญแจเซ็น session (getSessionKey ใน lib/auth.ts: ต้องยาวอย่างน้อย
 * MIN_SECRET_LENGTH = 32 ตัวอักษร) ค่าที่ตั้งไว้แต่สั้นเกินไปถือว่า "ไม่ได้ตั้ง" ทั้งที่นี่และที่หลังบ้าน
 * จะได้ไม่มีกรณีที่หลังบ้านปฏิเสธเพราะสั้น แต่ HMAC ของ IP ยังใช้กุญแจสั้นนั้นเงียบๆ
 */
function usableSecret(): string | null {
  const secret = process.env.SESSION_SECRET;
  return secret && secret.length >= MIN_SECRET_LENGTH ? secret : null;
}

/** true = มีกุญแจให้ hash (มี SESSION_SECRET ที่ยาวพอ หรือไม่ใช่ production ซึ่งใช้กุญแจสำรองได้) */
export function isIpHashKeyConfigured(): boolean {
  if (usableSecret()) return true;
  return process.env.NODE_ENV !== "production";
}

function hmacKey(): string {
  const secret = usableSecret();
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") throw new IpHashKeyMissingError();
  return DEV_FALLBACK_KEY;
}

function stripZone(ip: string): string {
  const i = ip.indexOf("%");
  return i >= 0 ? ip.slice(0, i) : ip;
}

/** คืน IP (รูปแบบ IPv4/IPv6 ที่ถูกต้อง ตัวพิมพ์เล็ก ไม่มี zone id) หรือ "unknown" */
export function getClientIp(headers: Pick<Headers, "get">): string {
  const candidates = [
    headers.get("x-real-ip"),
    headers.get("x-vercel-forwarded-for")?.split(",")[0],
    headers.get("x-forwarded-for")?.split(",")[0],
  ];
  for (const c of candidates) {
    const v = c?.trim();
    if (!v) continue;
    const bare = stripZone(v);
    if (isIP(bare) !== 0) return bare.toLowerCase();
  }
  return UNKNOWN_IP;
}

/**
 * แตก IPv6 (ที่ผ่าน isIP แล้ว) เป็น 8 กลุ่ม 16 บิต รองรับ `::` ย่อ, ตัวพิมพ์ใหญ่/เล็ก,
 * และ IPv4 แบบจุดที่ต่อท้าย (::ffff:1.2.3.4)
 */
function parseIpv6Groups(addr: string): number[] | null {
  let s = addr.toLowerCase();
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (isIP(tail) !== 4) return null;
    const [a, b, c, d] = tail.split(".").map(Number);
    s = `${s.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest].map((g) =>
    /^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN,
  );
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g))) return null;
  return groups;
}

/**
 * ค่าตัวแทนผู้ใช้สำหรับ rate limit (ดูหัวไฟล์) — รับ IP รูปแบบใดก็ได้ที่ Node ตีความว่าเป็น IP
 * ค่าผิดรูปแบบ → "unknown"
 */
export function normalizeIpForRateLimit(ip: string): string {
  const v = stripZone(ip.trim());
  const kind = isIP(v);
  if (kind === 4) return v;
  if (kind !== 6) return UNKNOWN_IP;
  const g = parseIpv6Groups(v);
  if (!g) return UNKNOWN_IP;
  // IPv4-mapped (::ffff:0:0/96) → IPv4
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    return `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
  }
  const hex4 = (n: number) => n.toString(16).padStart(4, "0");
  return `${g.slice(0, 4).map(hex4).join(":")}::/64`;
}

/** HMAC-SHA256 ของค่าที่ normalize แล้ว (IPv6 = /64) เป็น hex 64 ตัวอักษร; production ไม่มี SESSION_SECRET → throw IpHashKeyMissingError */
export function hashClientIp(ip: string): string {
  return createHmac("sha256", hmacKey()).update(`ip:${normalizeIpForRateLimit(ip)}`).digest("hex");
}

export function getClientIpHash(headers: Pick<Headers, "get">): string {
  return hashClientIp(getClientIp(headers));
}
