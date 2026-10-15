import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../../next.config";
import { slipResponseHeaders } from "../../lib/admin/slip-proxy";

/**
 * header ที่ตั้งใน next.config.ts (SPEC §9) — ตรวจที่ตัว config โดยตรง (การส่ง header จริงตรวจในขั้น e2e ผ่าน HTTP)
 *
 * กฎของ Next: หลายกฎที่ match path เดียวกันและตั้ง key เดียวกัน "กฎหลังทับกฎก่อน" — จึงจำลองการรวมกฎตามลำดับ
 * (effectiveHeaders) แล้วตรวจผลลัพธ์ต่อ path ว่า header เฉพาะเจาะจงไม่ทำให้ความปลอดภัยอ่อนลง
 */
type Rule = { source: string; headers: { key: string; value: string }[] };

async function rules(): Promise<Rule[]> {
  return (await nextConfig.headers!()) as Rule[];
}

function headerMap(rule: Rule) {
  return new Map(rule.headers.map((h) => [h.key.toLowerCase(), h.value]));
}

/** แปลง source แบบ `/x/:path*` (รูปแบบเดียวที่ config นี้ใช้) เป็น regex: `/x` และ `/x/...` */
function matches(source: string, path: string): boolean {
  if (source === "/:path*") return true;
  const m = /^(\/[^:]+?)\/:path\*$/.exec(source);
  if (!m) throw new Error(`test ไม่รองรับรูปแบบ source: ${source}`);
  return path === m[1] || path.startsWith(`${m[1]}/`);
}

/** ผลรวม header ของ path หนึ่งตามลำดับกฎ (กฎหลังทับกฎก่อน, key ไม่สนตัวพิมพ์) */
async function effectiveHeaders(path: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const r of await rules()) {
    if (!matches(r.source, path)) continue;
    for (const h of r.headers) out.set(h.key.toLowerCase(), h.value);
  }
  return out;
}

function directives(csp: string): Map<string, string[]> {
  return new Map(
    csp
      .split(";")
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const [name, ...values] = d.split(/\s+/);
        return [name, values] as const;
      }),
  );
}

afterEach(() => vi.unstubAllEnvs());

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

describe("next.config headers: security headers ทั้งเว็บ (SPEC §9)", () => {
  it("กฎ /:path* เป็นกฎแรกเสมอ (กฎเฉพาะต้องมาทีหลังเพื่อทับได้ ไม่ใช่ถูกทับ)", async () => {
    const all = await rules();
    expect(all[0].source).toBe("/:path*");
    expect(all.filter((r) => r.source === "/:path*")).toHaveLength(1);
  });

  it("ทั้งเว็บมี nosniff, Referrer-Policy strict-origin-when-cross-origin, X-Frame-Options DENY และ CSP", async () => {
    const h = headerMap((await rules())[0]);
    expect(h.get("x-content-type-options")).toBe("nosniff");
    expect(h.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(h.get("x-frame-options")).toBe("DENY");
    expect(h.get("content-security-policy")).toBeTruthy();
  });

  it("CSP production: static (ไม่มี nonce / strict-dynamic), ไม่มี unsafe-eval, ไม่มี wildcard หรือ http:", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const csp = headerMap((await rules())[0]).get("content-security-policy")!;
    expect(csp).not.toMatch(/nonce-|strict-dynamic|unsafe-eval/);
    expect(csp).not.toMatch(/(^|\s)\*(\s|;|$)/); // ไม่มี source เป็น * เฉยๆ
    expect(csp).not.toMatch(/\shttp:/);
    expect(csp).not.toContain("upgrade-insecure-requests");
    const d = directives(csp);
    expect(d.get("default-src")).toEqual(["'self'"]);
    expect(d.get("script-src")).toEqual(["'self'", "'unsafe-inline'"]);
    expect(d.get("style-src")).toEqual(["'self'", "'unsafe-inline'"]);
    expect(d.get("font-src")).toEqual(["'self'"]);
    expect(d.get("object-src")).toEqual(["'none'"]);
    expect(d.get("base-uri")).toEqual(["'self'"]);
    expect(d.get("form-action")).toEqual(["'self'"]);
    expect(d.get("frame-ancestors")).toEqual(["'none'"]);
  });

  it("CSP: รูป = self + data: (QR) + blob: (ย่อรูปฝั่ง client) + Unsplash เท่านั้น; connect-src = self + vercel.com (Blob client upload)", async () => {
    const d = directives(headerMap((await rules())[0]).get("content-security-policy")!);
    expect(d.get("img-src")).toEqual(["'self'", "data:", "blob:", "https://images.unsplash.com"]);
    expect(d.get("connect-src")).toEqual(["'self'", "https://vercel.com"]);
  });

  it("'unsafe-eval' เฉพาะ next dev (React ใช้ eval ตอน dev) ไม่มีใน production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const dev = directives(headerMap((await rules())[0]).get("content-security-policy")!);
    expect(dev.get("script-src")).toContain("'unsafe-eval'");
    vi.stubEnv("NODE_ENV", "production");
    const prod = directives(headerMap((await rules())[0]).get("content-security-policy")!);
    expect(prod.get("script-src")).not.toContain("'unsafe-eval'");
  });
});

describe("next.config headers: กฎเฉพาะไม่ทำให้ header ทั่วไปอ่อนลง (ผลรวมต่อ path)", () => {
  const PAGE_PATHS = ["/", "/item/A001", "/about", "/privacy", "/not-found-xyz", "/search"];
  const PRIVATE_PATHS = [
    "/order/abc",
    "/checkout/A001",
    "/api/orders",
    "/api/orders/tok/status",
    "/admin",
    "/admin/login",
    "/admin/items/new",
    "/api/admin/item-images/upload",
  ];
  const FILE_PATHS = ["/api/admin/slips/123", "/api/item-images/abc.jpg"];

  it.each([...PAGE_PATHS, ...PRIVATE_PATHS])("%s: CSP เต็มเท่ากับของทั้งเว็บ (ไม่เหลือแค่ frame-ancestors)", async (path) => {
    const base = headerMap((await rules())[0]).get("content-security-policy");
    const eff = await effectiveHeaders(path);
    expect(eff.get("content-security-policy")).toBe(base);
    expect(eff.get("x-frame-options")).toBe("DENY");
    expect(eff.get("x-content-type-options")).toBe("nosniff");
  });

  it.each(FILE_PATHS)("%s: ไฟล์รูปล้วน ใช้ CSP เข้มกว่า (default-src 'none' + sandbox) และยังมี frame/nosniff", async (path) => {
    const eff = await effectiveHeaders(path);
    const d = directives(eff.get("content-security-policy")!);
    expect(d.get("default-src")).toEqual(["'none'"]);
    expect(d.has("sandbox")).toBe(true);
    expect(eff.get("x-frame-options")).toBe("DENY");
    expect(eff.get("x-content-type-options")).toBe("nosniff");
  });

  it.each(PAGE_PATHS)("%s: หน้าสาธารณะใช้ Referrer-Policy strict-origin-when-cross-origin", async (path) => {
    expect((await effectiveHeaders(path)).get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });

  it.each([...PRIVATE_PATHS, "/api/admin/slips/123"])(
    "%s: หน้าลับ/หลังบ้านคง no-referrer (ไม่ถูก strict-origin ทั่วไปทับ) + no-store + noindex",
    async (path) => {
      const eff = await effectiveHeaders(path);
      expect(eff.get("referrer-policy")).toBe("no-referrer");
      expect(eff.get("cache-control")).toBe("no-store");
      expect(eff.get("x-robots-tag")).toContain("noindex");
    },
  );

  it("CSP ของ proxy สลิป/รูปสินค้าในกฎ ตรงกับที่ route ตั้งเอง (config ทับ header ของ route จึงต้องเหมือนกัน)", async () => {
    const slipRoute = slipResponseHeaders("image/jpeg", 1)["Content-Security-Policy"];
    expect((await effectiveHeaders("/api/admin/slips/1")).get("content-security-policy")).toBe(slipRoute);

    const imageRouteSrc = readFileSync("app/api/item-images/[name]/route.ts", "utf8");
    const imageCsp = (await effectiveHeaders("/api/item-images/a.jpg")).get("content-security-policy")!;
    expect(imageRouteSrc).toContain(`"Content-Security-Policy": "${imageCsp}"`);
  });

  it("กฎเฉพาะทุกข้อที่ตั้ง CSP ต้องมี frame-ancestors 'none' (ไม่มีทางลดเหลือค่าที่ฝังหน้าได้)", async () => {
    for (const r of await rules()) {
      const csp = headerMap(r).get("content-security-policy");
      if (csp) expect(directives(csp).get("frame-ancestors"), r.source).toEqual(["'none'"]);
    }
  });
});
