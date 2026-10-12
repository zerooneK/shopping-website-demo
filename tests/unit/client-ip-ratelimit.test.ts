import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getClientIp,
  getClientIpHash,
  hashClientIp,
  IpHashKeyMissingError,
  isIpHashKeyConfigured,
  normalizeIpForRateLimit,
  UNKNOWN_IP,
} from "@/lib/client-ip";
import {
  decideIpRateLimit,
  MAX_HOLDING_PER_IP,
  MAX_ORDERS_PER_IP_PER_HOUR,
  RATE_LIMIT_MESSAGE,
  RATE_LIMIT_RETRY_AFTER,
} from "@/lib/rate-limit";
import { buildTimeline } from "@/lib/orders/view";

const h = (init: Record<string, string>) => new Headers(init);

describe("getClientIp", () => {
  it("อ่าน x-real-ip ก่อน แล้ว x-vercel-forwarded-for แล้ว x-forwarded-for (ค่าแรก)", () => {
    expect(getClientIp(h({ "x-real-ip": "203.0.113.5", "x-forwarded-for": "198.51.100.1" }))).toBe("203.0.113.5");
    expect(getClientIp(h({ "x-vercel-forwarded-for": "203.0.113.6, 10.0.0.1" }))).toBe("203.0.113.6");
    expect(getClientIp(h({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }))).toBe("203.0.113.7");
  });
  it("รองรับ IPv6 (ตัวพิมพ์เล็ก) และตัด zone id", () => {
    expect(getClientIp(h({ "x-forwarded-for": "2001:DB8::1" }))).toBe("2001:db8::1");
    expect(getClientIp(h({ "x-real-ip": "FE80::1%eth0" }))).toBe("fe80::1");
  });
  it("ไม่มี header หรือไม่ใช่ IP → bucket เดียว unknown", () => {
    expect(getClientIp(h({}))).toBe(UNKNOWN_IP);
    expect(getClientIp(h({ "x-forwarded-for": "not-an-ip" }))).toBe(UNKNOWN_IP);
    expect(getClientIp(h({ "x-forwarded-for": "'; DROP TABLE orders;--" }))).toBe(UNKNOWN_IP);
    expect(getClientIp(h({ "x-real-ip": "" }))).toBe(UNKNOWN_IP);
  });
});

describe("hashClientIp", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("เป็น hex 64 ตัว ไม่มี IP ดิบ และค่าเดิมได้ hash เดิม", () => {
    const a = hashClientIp("203.0.113.5");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain("203");
    expect(hashClientIp("203.0.113.5")).toBe(a);
    expect(hashClientIp("203.0.113.6")).not.toBe(a);
    expect(hashClientIp(UNKNOWN_IP)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("กุญแจต่างกัน (SESSION_SECRET) ให้ hash ต่างกัน", () => {
    vi.stubEnv("SESSION_SECRET", "secret-one-secret-one-secret-one-xx");
    const a = hashClientIp("203.0.113.5");
    vi.stubEnv("SESSION_SECRET", "secret-two-secret-two-secret-two-xx");
    expect(hashClientIp("203.0.113.5")).not.toBe(a);
  });

  it("production ไม่มี SESSION_SECRET: fail-closed — hash ไม่ได้ (throw ที่มีเฉพาะชื่อ env) และไม่ใช้กุญแจสำรอง", () => {
    vi.stubEnv("SESSION_SECRET", "");
    vi.stubEnv("NODE_ENV", "production");
    expect(isIpHashKeyConfigured()).toBe(false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let thrown: unknown;
    try {
      hashClientIp("203.0.113.5");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(IpHashKeyMissingError);
    expect(String((thrown as Error).message)).toBe("missing required env: SESSION_SECRET");
    expect(() => getClientIpHash(h({ "x-forwarded-for": "203.0.113.5" }))).toThrow(IpHashKeyMissingError);
    expect(warn).not.toHaveBeenCalled();
  });

  it("production ที่มี SESSION_SECRET: ทำงานปกติ และ hash ต่างจากกุญแจสำรองของ dev", () => {
    vi.stubEnv("SESSION_SECRET", "prod-secret-prod-secret-prod-secret-xx");
    vi.stubEnv("NODE_ENV", "production");
    expect(isIpHashKeyConfigured()).toBe(true);
    const prod = hashClientIp("203.0.113.5");
    expect(prod).toMatch(/^[0-9a-f]{64}$/);
    vi.stubEnv("SESSION_SECRET", "");
    vi.stubEnv("NODE_ENV", "development");
    expect(hashClientIp("203.0.113.5")).not.toBe(prod);
  });

  it("dev/test ไม่มี SESSION_SECRET: ใช้กุญแจสำรองได้ ไม่เตือน ไม่ throw", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const env of ["development", "test"]) {
      vi.stubEnv("SESSION_SECRET", "");
      vi.stubEnv("NODE_ENV", env);
      expect(isIpHashKeyConfigured()).toBe(true);
      expect(hashClientIp("203.0.113.5")).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("getClientIpHash = hash ของ getClientIp", () => {
    const headers = h({ "x-forwarded-for": "203.0.113.5" });
    expect(getClientIpHash(headers)).toBe(hashClientIp("203.0.113.5"));
  });
});

describe("normalizeIpForRateLimit / hash ของ IPv6 (/64)", () => {
  it("IPv4: ใช้ทั้งค่า (ต่างกัน 1 บิตก็คนละ hash)", () => {
    expect(normalizeIpForRateLimit("203.0.113.5")).toBe("203.0.113.5");
    expect(hashClientIp("203.0.113.5")).not.toBe(hashClientIp("203.0.113.4"));
  });

  it("IPv6: normalize เป็น prefix /64 (รองรับรูปแบบ :: ย่อ และตัวพิมพ์ใหญ่/เล็ก)", () => {
    expect(normalizeIpForRateLimit("2001:db8:1:2:3:4:5:6")).toBe("2001:0db8:0001:0002::/64");
    expect(normalizeIpForRateLimit("2001:DB8:1:2::9")).toBe("2001:0db8:0001:0002::/64");
    expect(normalizeIpForRateLimit("2001:db8::1")).toBe("2001:0db8:0000:0000::/64");
    expect(normalizeIpForRateLimit("::1")).toBe("0000:0000:0000:0000::/64");
    expect(normalizeIpForRateLimit("::")).toBe("0000:0000:0000:0000::/64");
    expect(normalizeIpForRateLimit("1:2:3:4:5:6:7::")).toBe("0001:0002:0003:0004::/64");
  });

  it("address ต่างกันภายใน /64 เดียวกัน → hash เดียวกัน (หมุน interface id ไม่ช่วยหลบ)", () => {
    const base = hashClientIp("2001:db8:aaaa:bbbb::1");
    expect(hashClientIp("2001:db8:aaaa:bbbb:1234:5678:9abc:def0")).toBe(base);
    expect(hashClientIp("2001:DB8:AAAA:BBBB:ffff:ffff:ffff:ffff")).toBe(base);
    expect(hashClientIp("2001:db8:aaaa:bbbb::")).toBe(base);
    expect(hashClientIp("2001:db8:aaaa:bbbb::1%eth0")).toBe(base);
  });

  it("ต่าง /64 → hash ต่างกัน (แม้ต่างกันแค่บิตสุดท้ายของ prefix)", () => {
    const base = hashClientIp("2001:db8:aaaa:bbbb::1");
    expect(hashClientIp("2001:db8:aaaa:bbbc::1")).not.toBe(base);
    expect(hashClientIp("2001:db8:aaab:bbbb::1")).not.toBe(base);
    expect(hashClientIp("2001:db9:aaaa:bbbb::1")).not.toBe(base);
  });

  it("IPv4-mapped (::ffff:a.b.c.d, ทั้งแบบจุดและ hex) ถือเป็น IPv4 ตัวนั้น", () => {
    expect(normalizeIpForRateLimit("::ffff:203.0.113.5")).toBe("203.0.113.5");
    expect(normalizeIpForRateLimit("::FFFF:203.0.113.5")).toBe("203.0.113.5");
    expect(normalizeIpForRateLimit("0:0:0:0:0:ffff:203.0.113.5")).toBe("203.0.113.5");
    expect(normalizeIpForRateLimit("::ffff:cb00:7105")).toBe("203.0.113.5");
    expect(hashClientIp("::ffff:203.0.113.5")).toBe(hashClientIp("203.0.113.5"));
    // IPv4 คนละตัวผ่าน mapped ยังต่างกัน (ไม่ถูกยุบเป็น /64)
    expect(hashClientIp("::ffff:203.0.113.6")).not.toBe(hashClientIp("::ffff:203.0.113.5"));
  });

  it("ค่าผิดรูปแบบ → unknown (hash เท่ากับ bucket unknown)", () => {
    for (const bad of ["", "not-an-ip", "1:2:3", "2001:db8::1::2", "12345::1", "::g", "1.2.3", "999.1.1.1", "'; DROP TABLE orders;--"]) {
      expect(normalizeIpForRateLimit(bad)).toBe(UNKNOWN_IP);
      expect(hashClientIp(bad)).toBe(hashClientIp(UNKNOWN_IP));
    }
  });

  it("getClientIpHash: header IPv6 ใน /64 เดียวกันได้ hash เดียวกัน", () => {
    expect(getClientIpHash(h({ "x-forwarded-for": "2001:db8:1:2::a" }))).toBe(
      getClientIpHash(h({ "x-real-ip": "2001:DB8:1:2:dead:beef:0:1" })),
    );
  });
});

describe("decideIpRateLimit / ข้อความ rate limit", () => {
  it("ต่อ IP: ถือสินค้า >= 3 หรือ สร้าง >= 8/ชม. ถูกปฏิเสธ", () => {
    expect(decideIpRateLimit({ holding: MAX_HOLDING_PER_IP - 1, lastHour: 0 })).toEqual({ ok: true });
    expect(decideIpRateLimit({ holding: MAX_HOLDING_PER_IP, lastHour: 0 })).toEqual({
      ok: false,
      reason: "ip_too_many_holding",
    });
    expect(decideIpRateLimit({ holding: 0, lastHour: MAX_ORDERS_PER_IP_PER_HOUR - 1 })).toEqual({ ok: true });
    expect(decideIpRateLimit({ holding: 0, lastHour: MAX_ORDERS_PER_IP_PER_HOUR })).toEqual({
      ok: false,
      reason: "ip_too_many_per_hour",
    });
  });
  it("ทุกเหตุผลมีข้อความไทยและ Retry-After", () => {
    for (const reason of Object.keys(RATE_LIMIT_MESSAGE) as (keyof typeof RATE_LIMIT_MESSAGE)[]) {
      expect(RATE_LIMIT_MESSAGE[reason].length).toBeGreaterThan(10);
      expect(RATE_LIMIT_RETRY_AFTER[reason]).toBeGreaterThan(0);
    }
    // ไม่มีเพดานรวมทั้งร้านแล้ว: เหตุผลต้องมีเฉพาะชั้น browser และ IP
    expect(Object.keys(RATE_LIMIT_MESSAGE).sort()).toEqual([
      "ip_too_many_holding",
      "ip_too_many_per_hour",
      "too_many_pending",
      "too_many_per_hour",
    ]);
  });
});

describe("buildTimeline", () => {
  it("ไม่แสดง event ภายใน slip_token_issued ให้ลูกค้า", () => {
    const t = buildTimeline([
      { type: "created", meta: null, createdAtMs: 1 },
      { type: "slip_token_issued", meta: null, createdAtMs: 2 },
      { type: "slip_token_issued", meta: null, createdAtMs: 3 },
      { type: "upload_slip", meta: null, createdAtMs: 4 },
    ]);
    expect(t.map((e) => e.label)).toEqual([
      "สร้างออเดอร์และจองสินค้าไว้ให้",
      "ส่งสลิปแล้ว รอร้านตรวจสอบ",
    ]);
  });
});
