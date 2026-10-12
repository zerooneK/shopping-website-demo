import { describe, expect, it } from "vitest";
import { resolveDisplayStatus } from "@/lib/availability";
import {
  codeNumber,
  formatCountdown,
  formatPrice,
  parseCategory,
} from "@/lib/labels";

describe("resolveDisplayStatus", () => {
  it("hidden ไม่แสดง", () => {
    expect(resolveDisplayStatus({ status: "hidden", lapsed: false, held: false })).toBeNull();
  });
  it("available / sold คงเดิม", () => {
    expect(resolveDisplayStatus({ status: "available", lapsed: false, held: false })).toBe("available");
    expect(resolveDisplayStatus({ status: "sold", lapsed: true, held: false })).toBe("sold");
  });
  it("reserved ที่ยังไม่หมดเวลา = reserved", () => {
    expect(resolveDisplayStatus({ status: "reserved", lapsed: false, held: true })).toBe("reserved");
    expect(resolveDisplayStatus({ status: "reserved", lapsed: false, held: false })).toBe("reserved");
  });
  it("reserved ที่หมดเวลาและไม่มีออเดอร์ถือ = available (lazy expiry)", () => {
    expect(resolveDisplayStatus({ status: "reserved", lapsed: true, held: false })).toBe("available");
  });
  it("reserved ที่หมดเวลาแต่ยังมีออเดอร์ถือ (รอตรวจสลิป) = reserved", () => {
    expect(resolveDisplayStatus({ status: "reserved", lapsed: true, held: true })).toBe("reserved");
  });
});

describe("labels", () => {
  it("parseCategory", () => {
    expect(parseCategory("books")).toBe("books");
    expect(parseCategory(["tech", "home"])).toBe("tech");
    expect(parseCategory("nope")).toBeUndefined();
    expect(parseCategory(undefined)).toBeUndefined();
  });
  it("formatPrice / codeNumber", () => {
    expect(formatPrice(1450)).toBe("฿1,450");
    expect(codeNumber("A012")).toBe("012");
  });
  it("formatCountdown", () => {
    expect(formatCountdown(15 * 60 * 1000)).toBe("15:00");
    expect(formatCountdown(61_000)).toBe("01:01");
    expect(formatCountdown(-5)).toBe("00:00");
    expect(formatCountdown(500)).toBe("00:01");
  });
});
