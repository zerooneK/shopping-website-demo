import { describe, expect, it } from "vitest";
import { parseCreateOrderBody } from "@/lib/api";
import { generateDemoSid, parseDemoSid } from "@/lib/demo";
import {
  decideRateLimit,
  MAX_ORDERS_PER_HOUR,
  MAX_PENDING_PER_SESSION,
} from "@/lib/rate-limit";
import {
  DEMO_SLIP_PATH,
  fitWithin,
  guessSlipContentType,
  isValidSlipPathname,
  slipPrefix,
} from "@/lib/slip";

const base = {
  code: "A012",
  customerName: "สมชาย",
  phone: "081-234-5678",
  deliveryMethod: "pickup",
};

describe("parseCreateOrderBody", () => {
  it("accepts a valid body and normalizes the phone number", () => {
    const r = parseCreateOrderBody(base);
    expect(r).toMatchObject({ ok: true, input: { code: "A012", phone: "0812345678" } });
  });

  it("never carries client-supplied price/amount into the parsed input", () => {
    const r = parseCreateOrderBody({ ...base, price: 1, amount: 1, shippingFee: 0 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.keys(r.input)).not.toContain("price");
      expect(Object.keys(r.input)).not.toContain("amount");
      expect(Object.keys(r.input)).not.toContain("shippingFee");
    }
  });

  it("returns per-field errors", () => {
    const r = parseCreateOrderBody({ ...base, customerName: "  ", phone: "123" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.fieldErrors.customerName?.[0]).toBeTruthy();
      expect(r.fieldErrors.phone?.[0]).toBe("เบอร์โทรไม่ถูกต้อง");
    }
  });

  it("requires an address for post delivery", () => {
    const r = parseCreateOrderBody({ ...base, deliveryMethod: "post" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fieldErrors.address?.[0]).toBe("กรุณากรอกที่อยู่สำหรับจัดส่ง");
    expect(
      parseCreateOrderBody({ ...base, deliveryMethod: "post", address: "1 ถ.ตัวอย่าง" }).ok,
    ).toBe(true);
  });

  it("rejects non-object bodies and bad item codes", () => {
    expect(parseCreateOrderBody(null).ok).toBe(false);
    expect(parseCreateOrderBody("x").ok).toBe(false);
    expect(parseCreateOrderBody({ ...base, code: "12" }).ok).toBe(false);
  });
});

describe("decideRateLimit", () => {
  it("allows below both limits", () => {
    expect(
      decideRateLimit({ pending: MAX_PENDING_PER_SESSION - 1, lastHour: MAX_ORDERS_PER_HOUR - 1 }),
    ).toEqual({ ok: true });
  });
  it("blocks at 2 pending", () => {
    expect(decideRateLimit({ pending: 2, lastHour: 2 })).toEqual({
      ok: false,
      reason: "too_many_pending",
    });
  });
  it("blocks at 5 per hour", () => {
    expect(decideRateLimit({ pending: 0, lastHour: 5 })).toEqual({
      ok: false,
      reason: "too_many_per_hour",
    });
  });
  it("reports pending first when both are exceeded", () => {
    expect(decideRateLimit({ pending: 2, lastHour: 9 })).toEqual({
      ok: false,
      reason: "too_many_pending",
    });
  });
});

describe("demo_sid", () => {
  it("generates at least 128 bits of base64url randomness, unique each time", () => {
    const a = generateDemoSid();
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length * 6).toBeGreaterThanOrEqual(128);
    expect(generateDemoSid()).not.toBe(a);
    expect(parseDemoSid(a)).toBe(a);
  });
  it("rejects malformed cookie values", () => {
    expect(parseDemoSid(undefined)).toBeNull();
    expect(parseDemoSid("short")).toBeNull();
    expect(parseDemoSid("a".repeat(31))).toBeNull();
    expect(parseDemoSid("a".repeat(30) + "; DROP")).toBeNull();
    expect(parseDemoSid("x".repeat(65))).toBeNull();
  });
});

describe("slip helpers", () => {
  const id = "11111111-2222-3333-4444-555555555555";
  it("accepts only pathnames directly under slips/<orderId>/", () => {
    expect(isValidSlipPathname(id, `${slipPrefix(id)}slip-abc123.jpg`)).toBe(true);
    expect(isValidSlipPathname(id, `${slipPrefix(id)}slip.HEIC`)).toBe(true);
  });
  it("rejects other orders, traversal, nesting, odd extensions", () => {
    const other = "99999999-2222-3333-4444-555555555555";
    expect(isValidSlipPathname(id, `${slipPrefix(other)}slip.jpg`)).toBe(false);
    expect(isValidSlipPathname(id, `slips/${id}/../${other}/slip.jpg`)).toBe(false);
    expect(isValidSlipPathname(id, `${slipPrefix(id)}sub/slip.jpg`)).toBe(false);
    expect(isValidSlipPathname(id, `${slipPrefix(id)}slip.svg`)).toBe(false);
    expect(isValidSlipPathname(id, `${slipPrefix(id)}slip.jpg.exe`)).toBe(false);
    expect(isValidSlipPathname(id, slipPrefix(id))).toBe(false);
    expect(isValidSlipPathname(id, `uploads/${id}/slip.jpg`)).toBe(false);
    expect(isValidSlipPathname(id, DEMO_SLIP_PATH)).toBe(false);
    expect(isValidSlipPathname(id, `${slipPrefix(id)}a..b.jpg`)).toBe(false);
  });
  it("fitWithin shrinks the long edge to 1600 and never upscales", () => {
    expect(fitWithin(3200, 1600, 1600)).toEqual({ width: 1600, height: 800 });
    expect(fitWithin(1200, 4800, 1600)).toEqual({ width: 400, height: 1600 });
    expect(fitWithin(800, 600, 1600)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(10000, 1, 1600)).toEqual({ width: 1600, height: 1 });
  });
  it("guesses content type from the reported type or the extension", () => {
    expect(guessSlipContentType("a.png", "image/png")).toBe("image/png");
    expect(guessSlipContentType("IMG_1.HEIC", "")).toBe("image/heic");
    expect(guessSlipContentType("x.heif", "image/heif")).toBe("image/heic");
    expect(guessSlipContentType("x.jpg", "image/jpg")).toBe("image/jpeg");
    expect(guessSlipContentType("x.gif", "image/gif")).toBeNull();
    expect(guessSlipContentType("x.pdf", "application/pdf")).toBeNull();
  });
});
