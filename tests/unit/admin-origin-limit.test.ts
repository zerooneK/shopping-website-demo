import { describe, expect, it } from "vitest";
import { createLoginLimiter } from "@/lib/admin/login-limit";
import { isSameOrigin } from "@/lib/admin/origin";

const h = (init: Record<string, string>) => new Headers(init);

describe("isSameOrigin (กัน CSRF ของ mutation หลังบ้าน)", () => {
  it("Origin ตรงกับ Host = ผ่าน (รวมพอร์ต)", () => {
    expect(isSameOrigin(h({ origin: "https://shop.example", host: "shop.example" }))).toBe(true);
    expect(isSameOrigin(h({ origin: "http://localhost:3100", host: "localhost:3100" }))).toBe(true);
    expect(isSameOrigin(h({ origin: "HTTPS://Shop.Example", host: "shop.example" }))).toBe(true);
  });

  it("Origin ของเว็บอื่น = ไม่ผ่าน", () => {
    expect(isSameOrigin(h({ origin: "https://evil.example", host: "shop.example" }))).toBe(false);
    expect(isSameOrigin(h({ origin: "https://shop.example.evil.com", host: "shop.example" }))).toBe(false);
    expect(isSameOrigin(h({ origin: "https://evil.com/shop.example", host: "shop.example" }))).toBe(false);
  });

  it("พอร์ตไม่ตรง = ไม่ผ่าน", () => {
    expect(isSameOrigin(h({ origin: "http://localhost:3000", host: "localhost:3100" }))).toBe(false);
    expect(isSameOrigin(h({ origin: "http://localhost", host: "localhost:3100" }))).toBe(false);
  });

  it("ไม่มี Origin / Origin: null / ไม่ใช่ URL / scheme แปลก = ไม่ผ่าน (fail-closed)", () => {
    expect(isSameOrigin(h({ host: "shop.example" }))).toBe(false);
    expect(isSameOrigin(h({ origin: "null", host: "shop.example" }))).toBe(false);
    expect(isSameOrigin(h({ origin: "shop.example", host: "shop.example" }))).toBe(false);
    expect(isSameOrigin(h({ origin: "ftp://shop.example", host: "shop.example" }))).toBe(false);
    expect(isSameOrigin(h({ origin: "https://shop.example" }))).toBe(false);
  });

  it("x-forwarded-host (ค่าแรก) ใช้แทน host เมื่อมี", () => {
    expect(
      isSameOrigin(h({ origin: "https://shop.example", host: "internal:3000", "x-forwarded-host": "shop.example" })),
    ).toBe(true);
    expect(
      isSameOrigin(
        h({ origin: "https://shop.example", host: "shop.example", "x-forwarded-host": "evil.example, shop.example" }),
      ),
    ).toBe(false);
    expect(
      isSameOrigin(
        h({ origin: "https://shop.example", host: "internal", "x-forwarded-host": "shop.example, proxy.internal" }),
      ),
    ).toBe(true);
  });
});

describe("เพดานรวมแบบชะลอ (global backoff) — ชะลอ ไม่ล็อก", () => {
  const g = { freeFailures: 4, windowMs: 60_000, baseDelayMs: 500, stepFailures: 2, maxDelayMs: 4000 };
  const opts = { maxFailures: 3, windowMs: 60_000, lockMs: 120_000, globalBackoff: g };

  function make() {
    let t = 1_000_000;
    const limiter = createLoginLimiter(opts, () => t);
    return { limiter, advance: (ms: number) => (t += ms) };
  }
  /** ล้มเหลวจากหลาย IP (ไม่ติดเพดานต่อ IP) */
  const failFrom = (limiter: ReturnType<typeof createLoginLimiter>, n: number, from = 0) => {
    for (let i = 0; i < n; i++) limiter.recordFailure("ip-" + (from + i));
  };

  it("ล้มเหลวรวมไม่เกิน freeFailures = ไม่ชะลอ", () => {
    const { limiter } = make();
    expect(limiter.globalDelayMs()).toBe(0);
    failFrom(limiter, 4);
    expect(limiter.globalDelayMs()).toBe(0);
  });

  it("เกิน freeFailures → ชะลอและโตแบบ exponential จนถึงเพดานตายตัว (ไม่เกิน maxDelayMs)", () => {
    const { limiter } = make();
    const delays: number[] = [];
    for (let i = 0; i < 14; i++) {
      limiter.recordFailure("ip-" + i);
      delays.push(limiter.globalDelayMs());
    }
    // 4 ครั้งแรก 0, แล้ว 500,500, 1000,1000, 2000,2000, 4000... และคงที่ที่ 4000
    expect(delays.slice(0, 4)).toEqual([0, 0, 0, 0]);
    expect(delays.slice(4, 10)).toEqual([500, 500, 1000, 1000, 2000, 2000]);
    expect(Math.max(...delays)).toBe(4000);
    expect(delays.at(-1)).toBe(4000);
  });

  it("ชะลอเท่านั้น ไม่ปฏิเสธ: หลังล้มเหลวหลายร้อยครั้งจากหลาย IP เจ้าของร้าน (IP ใหม่) ยัง check() ผ่าน และรอไม่เกินเพดาน", () => {
    const { limiter } = make();
    failFrom(limiter, 500);
    expect(limiter.check("owner-ip")).toEqual({ allowed: true });
    expect(limiter.globalDelayMs()).toBeLessThanOrEqual(g.maxDelayMs);
    expect(limiter.globalDelayMs()).toBe(g.maxDelayMs);
  });

  it("ล็อกอินสำเร็จของเจ้าของร้านไม่ถูกบล็อกด้วยตัวนับรวม: reset คีย์ตัวเองได้ และตัวนับรวมหมดอายุตามเวลา", () => {
    const { limiter, advance } = make();
    failFrom(limiter, 12);
    expect(limiter.globalDelayMs()).toBeGreaterThan(0);
    limiter.reset("owner-ip");
    expect(limiter.check("owner-ip").allowed).toBe(true);
    advance(60_001);
    expect(limiter.globalDelayMs()).toBe(0);
  });

  it("ไม่ตั้ง globalBackoff = ไม่ชะลอ (พฤติกรรมเดิม); resetAll ล้างทุกอย่าง", () => {
    const t = 0;
    const plain = createLoginLimiter({ maxFailures: 3, windowMs: 1000, lockMs: 1000 }, () => t);
    for (let i = 0; i < 50; i++) plain.recordFailure("ip-" + i);
    expect(plain.globalDelayMs()).toBe(0);

    const { limiter } = make();
    failFrom(limiter, 20);
    limiter.resetAll();
    expect(limiter.globalDelayMs()).toBe(0);
    expect(limiter.size()).toBe(0);
  });

  it("ค่าจริง (LOGIN_LIMIT): ไม่ชะลอจนกว่าจะผิดเกิน 10 ครั้งรวม และเพดาน 5 วินาที", async () => {
    const { LOGIN_LIMIT } = await import("@/lib/admin/login-limit");
    const real = createLoginLimiter(LOGIN_LIMIT);
    for (let i = 0; i < 10; i++) real.recordFailure("x-" + i);
    expect(real.globalDelayMs()).toBe(0);
    for (let i = 10; i < 300; i++) real.recordFailure("x-" + i);
    expect(real.globalDelayMs()).toBe(5000);
  });
});

describe("createLoginLimiter (จำกัดการลองรหัส)", () => {
  const opts = { maxFailures: 3, windowMs: 60_000, lockMs: 120_000 };

  function make() {
    let t = 1_000_000;
    const limiter = createLoginLimiter(opts, () => t);
    return { limiter, advance: (ms: number) => (t += ms) };
  }

  it("ผิดไม่ถึงเพดาน = ยังลองได้; ถึงเพดาน = ล็อกพร้อมเวลารอ", () => {
    const { limiter } = make();
    limiter.recordFailure("ip");
    limiter.recordFailure("ip");
    expect(limiter.check("ip")).toEqual({ allowed: true });
    limiter.recordFailure("ip");
    expect(limiter.check("ip")).toEqual({ allowed: false, retryAfterSeconds: 120 });
  });

  it("ล็อกหมดเวลาแล้วลองได้อีก และตัวนับเริ่มใหม่", () => {
    const { limiter, advance } = make();
    for (let i = 0; i < 3; i++) limiter.recordFailure("ip");
    advance(119_000);
    expect(limiter.check("ip").allowed).toBe(false);
    advance(2_000);
    expect(limiter.check("ip").allowed).toBe(true);
    limiter.recordFailure("ip");
    limiter.recordFailure("ip");
    expect(limiter.check("ip").allowed).toBe(true);
  });

  it("ความล้มเหลวที่เก่ากว่าช่วงเวลาไม่นับ", () => {
    const { limiter, advance } = make();
    limiter.recordFailure("ip");
    limiter.recordFailure("ip");
    advance(61_000);
    limiter.recordFailure("ip");
    expect(limiter.check("ip").allowed).toBe(true);
  });

  it("ล็อกอินสำเร็จ (reset) ล้างตัวนับ", () => {
    const { limiter } = make();
    limiter.recordFailure("ip");
    limiter.recordFailure("ip");
    limiter.reset("ip");
    limiter.recordFailure("ip");
    limiter.recordFailure("ip");
    expect(limiter.check("ip").allowed).toBe(true);
  });

  it("แยกคีย์: IP หนึ่งโดนล็อกไม่กระทบอีก IP (ไม่มีตัวนับรวมที่ล็อกเจ้าของร้าน)", () => {
    const { limiter } = make();
    for (let i = 0; i < 3; i++) limiter.recordFailure("attacker");
    expect(limiter.check("attacker").allowed).toBe(false);
    expect(limiter.check("owner").allowed).toBe(true);
  });

  it("จำกัดจำนวนคีย์ที่จำไว้ (กันหน่วยความจำบวม)", () => {
    let t = 0;
    const limiter = createLoginLimiter({ ...opts, maxKeys: 10 }, () => t);
    for (let i = 0; i < 50; i++) {
      limiter.recordFailure(`ip-${i}`);
      t += 120_000; // ทุกคีย์เก่าเกินช่วงเวลา → ถูกเก็บกวาดได้
    }
    expect(limiter.size()).toBeLessThanOrEqual(11);
  });
});
