import { describe, expect, it } from "vitest";
import {
  buildDemoPayload,
  buildDemoQrDataUrl,
  DEMO_PROMPTPAY_TARGET,
} from "@/lib/promptpay";
import {
  calcAmount,
  createOrderSchema,
  normalizeItemCode,
} from "@/lib/validation";

const base = {
  code: "A012",
  customerName: "สมชาย",
  phone: "081-234-5678",
  deliveryMethod: "pickup" as const,
};

describe("createOrderSchema", () => {
  it("accepts pickup without address and normalizes phone", () => {
    const r = createOrderSchema.safeParse(base);
    expect(r.success && r.data.phone).toBe("0812345678");
  });

  it("requires address for post", () => {
    expect(createOrderSchema.safeParse({ ...base, deliveryMethod: "post" }).success).toBe(false);
    expect(createOrderSchema.safeParse({ ...base, deliveryMethod: "post", address: "  " }).success).toBe(false);
    expect(createOrderSchema.safeParse({ ...base, deliveryMethod: "post", address: "1 ถ.ก" }).success).toBe(true);
  });

  it("rejects bad code, phone, empty name, bad method", () => {
    expect(createOrderSchema.safeParse({ ...base, code: "a12" }).success).toBe(false);
    expect(createOrderSchema.safeParse({ ...base, phone: "12345" }).success).toBe(false);
    expect(createOrderSchema.safeParse({ ...base, customerName: " " }).success).toBe(false);
    expect(createOrderSchema.safeParse({ ...base, deliveryMethod: "drone" }).success).toBe(false);
  });

  it("strips client-supplied price/amount fields", () => {
    const r = createOrderSchema.parse({ ...base, price: 1, amount: 1, shippingFee: 0 });
    expect(Object.keys(r)).not.toContain("price");
    expect(Object.keys(r)).not.toContain("amount");
    expect(Object.keys(r)).not.toContain("shippingFee");
  });
});

describe("calcAmount / normalizeItemCode", () => {
  it("adds 50 baht shipping only for post", () => {
    expect(calcAmount(450, "post")).toBe(500);
    expect(calcAmount(450, "pickup")).toBe(450);
  });

  it("normalizes 012, A012, #12 to A012", () => {
    for (const raw of ["012", "A012", "#12", " a12 ", "12"]) {
      expect(normalizeItemCode(raw)).toBe("A012");
    }
    expect(normalizeItemCode("hello")).toBeNull();
    expect(normalizeItemCode("")).toBeNull();
  });
});

describe("promptpay demo QR", () => {
  it("encodes the unusable demo number and the amount", () => {
    const p = buildDemoPayload(500);
    expect(DEMO_PROMPTPAY_TARGET).toBe("0000000000");
    expect(p).toContain("A000000677010111");
    expect(p).toContain("0066000000000"); // 0000000000 -> 0066 + 9 digits
    expect(p).toContain("5406500.00");
    expect(p).toMatch(/6304[0-9A-F]{4}$/); // CRC
  });

  it("rejects non-positive amounts", () => {
    expect(() => buildDemoPayload(0)).toThrow(RangeError);
  });

  it("renders a PNG data URL", async () => {
    expect(await buildDemoQrDataUrl(500)).toMatch(/^data:image\/png;base64,/);
  });
});
