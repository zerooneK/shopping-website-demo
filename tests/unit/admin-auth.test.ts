import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import {
  can,
  canViewSlip,
  DEMO_SESSION_SECONDS,
  getSessionKey,
  isDemoLoginAvailable,
  isOwnerLoginConfigured,
  MIN_ADMIN_PASSWORD_LENGTH,
  OWNER_SESSION_SECONDS,
  signSession,
  verifyOwnerPassword,
  verifySession,
  type AdminSession,
} from "@/lib/auth";

const SECRET = "s".repeat(32);
const KEY = new TextEncoder().encode(SECRET);
const OTHER_KEY = new TextEncoder().encode("o".repeat(32));
const SID = "A".repeat(32);
const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);

describe("getSessionKey / การตั้งค่า (ไม่มี fallback)", () => {
  it("ไม่มี SESSION_SECRET = null ทุก environment (รวม dev/test)", () => {
    expect(getSessionKey({})).toBeNull();
    expect(getSessionKey({ NODE_ENV: "development" })).toBeNull();
    expect(getSessionKey({ NODE_ENV: "test" })).toBeNull();
    expect(getSessionKey({ NODE_ENV: "production" })).toBeNull();
  });

  it("สั้นกว่า 32 ตัวอักษร = null, 32 ตัวขึ้นไป = ใช้ได้", () => {
    expect(getSessionKey({ SESSION_SECRET: "x".repeat(31) })).toBeNull();
    expect(getSessionKey({ SESSION_SECRET: "x".repeat(32) })).not.toBeNull();
  });

  it("owner login ต้องมีทั้งกุญแจ session และ ADMIN_PASSWORD (>= 16 ตัว)", () => {
    expect(MIN_ADMIN_PASSWORD_LENGTH).toBe(16);
    expect(isOwnerLoginConfigured({ SESSION_SECRET: SECRET })).toBe(false);
    expect(isOwnerLoginConfigured({ ADMIN_PASSWORD: "x".repeat(16) })).toBe(false);
    expect(isOwnerLoginConfigured({ SESSION_SECRET: SECRET, ADMIN_PASSWORD: "short" })).toBe(false);
    // เดิมรหัส 8-15 ตัวใช้ได้ ตอนนี้ไม่ได้
    expect(isOwnerLoginConfigured({ SESSION_SECRET: SECRET, ADMIN_PASSWORD: "longenough" })).toBe(false);
    expect(isOwnerLoginConfigured({ SESSION_SECRET: SECRET, ADMIN_PASSWORD: "x".repeat(15) })).toBe(false);
    expect(isOwnerLoginConfigured({ SESSION_SECRET: SECRET, ADMIN_PASSWORD: "x".repeat(16) })).toBe(true);
  });

  it("ปุ่มเดโมใช้ได้เฉพาะ DEMO_MODE=true และมีกุญแจ", () => {
    expect(isDemoLoginAvailable({ SESSION_SECRET: SECRET })).toBe(false);
    expect(isDemoLoginAvailable({ SESSION_SECRET: SECRET, DEMO_MODE: "false" })).toBe(false);
    expect(isDemoLoginAvailable({ SESSION_SECRET: SECRET, DEMO_MODE: "TRUE" })).toBe(false);
    expect(isDemoLoginAvailable({ DEMO_MODE: "true" })).toBe(false);
    expect(isDemoLoginAvailable({ SESSION_SECRET: SECRET, DEMO_MODE: "true" })).toBe(true);
  });
});

describe("verifyOwnerPassword (constant-time)", () => {
  it("รหัสถูก = true, ผิด/ต่างตัวพิมพ์/สั้นกว่า/ยาวกว่า = false", () => {
    const pw = "correct horse battery";
    expect(verifyOwnerPassword(pw, pw)).toBe(true);
    expect(verifyOwnerPassword("Correct horse battery", pw)).toBe(false);
    expect(verifyOwnerPassword("correct horse", pw)).toBe(false);
    expect(verifyOwnerPassword(pw + "x", pw)).toBe(false);
    expect(verifyOwnerPassword("", pw)).toBe(false);
  });

  it("ไม่ได้ตั้งรหัส/รหัสสั้นเกินไป = ปฏิเสธเสมอ แม้ input ว่างหรือเท่ากัน", () => {
    expect(verifyOwnerPassword("", undefined)).toBe(false);
    expect(verifyOwnerPassword("", "")).toBe(false);
    expect(verifyOwnerPassword("undefined", undefined)).toBe(false);
    expect(verifyOwnerPassword("short", "short")).toBe(false);
    // สั้นกว่า 16 ตัว: ปฏิเสธแม้ input เท่ากับค่าที่ตั้ง
    expect(verifyOwnerPassword("x".repeat(15), "x".repeat(15))).toBe(false);
    expect(verifyOwnerPassword("x".repeat(16), "x".repeat(16))).toBe(true);
  });
});

describe("signSession / verifySession", () => {
  it("owner: round-trip ได้ role owner ไม่มี sid", async () => {
    const t = await signSession({ role: "owner" }, KEY, NOW);
    expect(await verifySession(t, KEY, NOW + 1000)).toEqual({ role: "owner" });
  });

  it("demo: round-trip ได้ role demo พร้อม sid เดิม", async () => {
    const t = await signSession({ role: "demo", sid: SID }, KEY, NOW);
    expect(await verifySession(t, KEY, NOW + 1000)).toEqual({ role: "demo", sid: SID });
  });

  it("อายุ: owner 7 วัน, demo 1 วัน (หมดอายุแล้วใช้ไม่ได้)", async () => {
    const owner = await signSession({ role: "owner" }, KEY, NOW);
    const demo = await signSession({ role: "demo", sid: SID }, KEY, NOW);
    expect(OWNER_SESSION_SECONDS).toBe(7 * 24 * 3600);
    expect(DEMO_SESSION_SECONDS).toBe(24 * 3600);
    expect(await verifySession(owner, KEY, NOW + (OWNER_SESSION_SECONDS - 5) * 1000)).not.toBeNull();
    expect(await verifySession(owner, KEY, NOW + (OWNER_SESSION_SECONDS + 5) * 1000)).toBeNull();
    expect(await verifySession(demo, KEY, NOW + (DEMO_SESSION_SECONDS - 5) * 1000)).not.toBeNull();
    expect(await verifySession(demo, KEY, NOW + (DEMO_SESSION_SECONDS + 5) * 1000)).toBeNull();
  });

  it("เซ็นด้วยกุญแจอื่น / ไม่มีกุญแจ / token ว่าง / ขยะ = null", async () => {
    const t = await signSession({ role: "owner" }, OTHER_KEY, NOW);
    expect(await verifySession(t, KEY, NOW)).toBeNull();
    const good = await signSession({ role: "owner" }, KEY, NOW);
    expect(await verifySession(good, null, NOW)).toBeNull();
    expect(await verifySession(undefined, KEY, NOW)).toBeNull();
    expect(await verifySession("", KEY, NOW)).toBeNull();
    expect(await verifySession("not.a.jwt", KEY, NOW)).toBeNull();
  });

  it("แก้ payload แล้วลายเซ็นไม่ตรง = null (เปลี่ยน demo เป็น owner ไม่ได้)", async () => {
    const t = await signSession({ role: "demo", sid: SID }, KEY, NOW);
    const [h, , s] = t.split(".");
    const forged = Buffer.from(
      JSON.stringify({ role: "owner", sub: "admin", iss: "shop-website", aud: "shop-admin", iat: NOW / 1000, exp: NOW / 1000 + 9999999 }),
    ).toString("base64url");
    expect(await verifySession(`${h}.${forged}.${s}`, KEY, NOW)).toBeNull();
  });

  it("alg=none ถูกปฏิเสธ", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(
      JSON.stringify({ role: "owner", sub: "admin", iss: "shop-website", aud: "shop-admin", exp: NOW / 1000 + 1000 }),
    ).toString("base64url");
    expect(await verifySession(`${header}.${body}.`, KEY, NOW)).toBeNull();
  });

  it("token ที่เซ็นถูกแต่ issuer/audience/subject ผิด = null", async () => {
    const mk = (over: { iss?: string; aud?: string; sub?: string }) =>
      new SignJWT({ role: "owner" })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer(over.iss ?? "shop-website")
        .setAudience(over.aud ?? "shop-admin")
        .setSubject(over.sub ?? "admin")
        .setIssuedAt(NOW / 1000)
        .setExpirationTime(NOW / 1000 + 600)
        .sign(KEY);
    expect(await verifySession(await mk({}), KEY, NOW)).toEqual({ role: "owner" });
    expect(await verifySession(await mk({ iss: "other" }), KEY, NOW)).toBeNull();
    expect(await verifySession(await mk({ aud: "other" }), KEY, NOW)).toBeNull();
    expect(await verifySession(await mk({ sub: "other" }), KEY, NOW)).toBeNull();
  });

  it("role แปลก / demo ที่ sid ผิดรูปแบบ / owner ที่มี sid = null", async () => {
    const mk = (payload: Record<string, unknown>) =>
      new SignJWT(payload)
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer("shop-website")
        .setAudience("shop-admin")
        .setSubject("admin")
        .setIssuedAt(NOW / 1000)
        .setExpirationTime(NOW / 1000 + 600)
        .sign(KEY);
    expect(await verifySession(await mk({ role: "root" }), KEY, NOW)).toBeNull();
    expect(await verifySession(await mk({}), KEY, NOW)).toBeNull();
    expect(await verifySession(await mk({ role: "demo" }), KEY, NOW)).toBeNull();
    expect(await verifySession(await mk({ role: "demo", sid: "short" }), KEY, NOW)).toBeNull();
    expect(await verifySession(await mk({ role: "owner", sid: SID }), KEY, NOW)).toBeNull();
  });
});

describe("สิทธิ์ตาม role (SPEC §7)", () => {
  const owner: AdminSession = { role: "owner" };
  const demo: AdminSession = { role: "demo", sid: SID };

  it("ไม่มี session = ไม่มีสิทธิ์ใดเลย", () => {
    expect(can(null, "order.transition")).toBe(false);
    expect(canViewSlip(null, SID)).toBe(false);
  });

  it("owner ทำได้ทุกอย่าง", () => {
    for (const p of ["order.transition", "pii.read", "slip.read_all", "item.edit", "image.upload", "item.delete"] as const) {
      expect(can(owner, p)).toBe(true);
    }
  });

  it("demo: เปลี่ยนสถานะออเดอร์ได้ แต่ดูสินค้าได้อย่างเดียว (ไม่แก้/ไม่ลบ/ไม่อัปโหลดรูป) ไม่เห็น PII ไม่ดูสลิปทุกใบ", () => {
    expect(can(demo, "order.transition")).toBe(true);
    expect(can(demo, "item.edit")).toBe(false);
    expect(can(demo, "pii.read")).toBe(false);
    expect(can(demo, "item.delete")).toBe(false);
    expect(can(demo, "image.upload")).toBe(false);
    expect(can(demo, "slip.read_all")).toBe(false);
  });

  it("canViewSlip: owner เห็นทุกใบ, demo เห็นเฉพาะ sid ตรง", () => {
    expect(canViewSlip(owner, null)).toBe(true);
    expect(canViewSlip(owner, "whatever")).toBe(true);
    expect(canViewSlip(demo, SID)).toBe(true);
    expect(canViewSlip(demo, "B".repeat(32))).toBe(false);
    expect(canViewSlip(demo, null)).toBe(false);
    expect(canViewSlip(demo, "")).toBe(false);
  });
});
