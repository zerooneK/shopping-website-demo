import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

/**
 * header ที่ตั้งใน next.config.ts — หลังบ้านต้องห้ามถูกฝังใน iframe (clickjacking)
 * ตรวจที่ตัว config โดยตรง (การส่ง header จริงตรวจในขั้น e2e ผ่าน HTTP)
 */
type Rule = { source: string; headers: { key: string; value: string }[] };

async function rules(): Promise<Rule[]> {
  return (await nextConfig.headers!()) as Rule[];
}

function headerMap(rule: Rule) {
  return new Map(rule.headers.map((h) => [h.key.toLowerCase(), h.value]));
}

describe("next.config headers: กัน clickjacking ของหลังบ้าน", () => {
  it.each(["/admin/:path*", "/api/admin/:path*"])(
    "%s: CSP frame-ancestors 'none' + X-Frame-Options DENY (และ header ส่วนตัวเดิมยังอยู่)",
    async (source) => {
      const rule = (await rules()).find((r) => r.source === source);
      expect(rule, `ต้องมีกฎสำหรับ ${source}`).toBeDefined();
      const h = headerMap(rule!);
      expect(h.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(h.get("x-frame-options")).toBe("DENY");
      expect(h.get("cache-control")).toBe("no-store");
      expect(h.get("x-robots-tag")).toContain("noindex");
      expect(h.get("x-content-type-options")).toBe("nosniff");
    },
  );
});
