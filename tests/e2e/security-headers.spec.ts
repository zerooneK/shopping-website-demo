import { expect, test, type Page } from "@playwright/test";
import { E2E_CODES } from "./fixtures";

/**
 * e2e: security headers ทั้งเว็บ (SPEC §9) — ตรวจ response จริงจาก `next start` (production) และตรวจในเบราว์เซอร์จริง
 * ว่า CSP ไม่ทำให้หน้าหลัก/สินค้า/checkout/ออเดอร์+สลิปตัวอย่าง/หลังบ้านพัง (ไม่มี securitypolicyviolation, ไม่มี console "Refused to…")
 *
 * ไม่ได้ทดสอบ (ทำไม่ได้ในเครื่อง): Vercel Blob client upload จริง (ไม่มี BLOB_READ_WRITE_TOKEN) และพฤติกรรมบน Vercel จริง
 * — ค่า connect-src https://vercel.com มาจากการอ่าน @vercel/blob@2.8.1 ใน node_modules ไม่ใช่การยิงจริง
 */

const OWNER_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "";

/** เก็บ CSP violation (event ในหน้า) + console error/warning + pageerror ของ page นี้ */
async function watchViolations(page: Page) {
  const consoleMessages: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") consoleMessages.push(`[${m.type()}] ${m.text()}`);
  });
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      w.__csp.push(`${e.violatedDirective} blocked=${e.blockedURI} source=${e.sourceFile}:${e.lineNumber}`);
    });
  });
  return {
    async violations() {
      return page.evaluate(() => (window as unknown as { __csp: string[] }).__csp ?? []);
    },
    consoleMessages,
    pageErrors,
  };
}

/** เลื่อนจนสุดหน้าเพื่อให้รูป lazy ที่ถึงจอโหลด แล้วนับรูปที่ "พยายามโหลดแล้วล้มเหลว" */
async function brokenImageCount(page: Page) {
  await page.evaluate(async () => {
    for (let y = 0; y <= document.body.scrollHeight; y += 400) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 60));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForLoadState("networkidle");
  // เฉพาะรูปที่ "ถูกวาดจริง" (มีขนาดและไม่ถูกซ่อน) — รูปสำรองที่ซ่อน/ไม่มีขนาดไม่นับ
  return page.evaluate(() =>
    Array.from(document.images)
      .filter((i) => {
        const r = i.getBoundingClientRect();
        const cs = getComputedStyle(i);
        return r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden";
      })
      // complete แต่กว้าง 0 = โหลดแล้วล้มเหลว (ถูกบล็อก/404); รูป lazy ที่ยังไม่ถึงจอจะ complete=false จึงไม่นับ
      .filter((i) => i.complete && i.naturalWidth === 0)
      .map((i) => `${i.loading} ${i.currentSrc || i.src}`),
  );
}

test.describe("security headers: response จริง", () => {
  const CSP_FULL = /^default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:\/\/images\.unsplash\.com; font-src 'self'; connect-src 'self' https:\/\/vercel\.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'$/;

  const PUBLIC_URLS = ["/", `/item/${E2E_CODES.csp}`, "/about", "/privacy", "/demo/sample-slip.png", "/this-page-does-not-exist"];
  const PRIVATE_URLS = [`/checkout/${E2E_CODES.csp}`, "/order/" + "A".repeat(43), "/admin/login", "/api/orders/" + "A".repeat(43) + "/status"];

  for (const url of PUBLIC_URLS) {
    test(`${url}: CSP เต็ม + nosniff + strict-origin-when-cross-origin + X-Frame-Options DENY`, async ({ request }) => {
      const res = await request.get(url, { maxRedirects: 0 });
      const h = res.headers();
      expect(h["content-security-policy"], `CSP ${url} (status ${res.status()})`).toMatch(CSP_FULL);
      expect(h["x-content-type-options"]).toBe("nosniff");
      expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
      expect(h["x-frame-options"]).toBe("DENY");
    });
  }

  for (const url of PRIVATE_URLS) {
    test(`${url}: หน้าลับ — CSP เต็ม + no-referrer + no-store + noindex (กฎเฉพาะไม่ทับ CSP ให้อ่อนลง)`, async ({ request }) => {
      const res = await request.get(url, { maxRedirects: 0 });
      const h = res.headers();
      expect(h["content-security-policy"], `CSP ${url} (status ${res.status()})`).toMatch(CSP_FULL);
      expect(h["referrer-policy"]).toBe("no-referrer");
      expect(h["x-frame-options"]).toBe("DENY");
      expect(h["x-content-type-options"]).toBe("nosniff");
      expect(h["cache-control"]).toContain("no-store");
      expect(h["x-robots-tag"]).toContain("noindex");
    });
  }

  test("หลังบ้าน (ไม่ login): API ได้ CSP สลิปแบบเข้ม ส่วน /admin ที่ redirect ได้ CSP เต็ม", async ({ request }) => {
    const slip = await request.get("/api/admin/slips/11111111-1111-4111-8111-111111111111", { maxRedirects: 0 });
    expect(slip.status()).toBe(401);
    expect(slip.headers()["content-security-policy"]).toBe("default-src 'none'; frame-ancestors 'none'; sandbox");
    expect(slip.headers()["x-frame-options"]).toBe("DENY");
    expect(slip.headers()["referrer-policy"]).toBe("no-referrer");

    const upload = await request.post("/api/admin/item-images/upload", { data: {}, maxRedirects: 0 });
    expect(upload.headers()["content-security-policy"]).toMatch(CSP_FULL);
    expect(upload.headers()["x-frame-options"]).toBe("DENY");
  });

  test("proxy รูปสินค้า: ได้ CSP ของไฟล์รูป (none + sandbox) ไม่ใช่ CSP ของหน้า", async ({ request }) => {
    const res = await request.get("/api/item-images/not-a-real-file.jpg", { maxRedirects: 0 });
    const h = res.headers();
    expect(h["content-security-policy"]).toBe("default-src 'none'; frame-ancestors 'none'; sandbox");
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["x-content-type-options"]).toBe("nosniff");
  });
});

test.describe("CSP ในเบราว์เซอร์จริง (375x812)", () => {
  test("หน้าแรก → สินค้า → checkout → ออเดอร์ + สลิปตัวอย่าง → about/privacy: ไม่มี CSP violation, รูป/ฟอนต์โหลดครบ", async ({ page }) => {
    const watch = await watchViolations(page);
    const visit = async (url: string) => {
      const res = await page.goto(url, { waitUntil: "networkidle" });
      expect(res!.status(), url).toBeLessThan(400);
      expect(await brokenImageCount(page), `รูปที่โหลดไม่สำเร็จที่ ${url}`).toEqual([]);
      expect(await watch.violations(), `CSP violation ที่ ${url}`).toEqual([]);
    };

    await visit("/");
    // ฟอนต์ next/font (self-host) โหลดผ่าน font-src 'self'
    expect(await page.evaluate(() => Array.from(document.fonts).filter((f) => f.status === "loaded").length)).toBeGreaterThan(0);
    // รูปสินค้าผ่าน next/image (/_next/image) ต้องแสดงจริง
    expect(await page.locator("img").first().evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);

    await visit(`/item/${E2E_CODES.csp}`);
    await visit(`/checkout/${E2E_CODES.csp}`);

    await page.getByRole("button", { name: "กรอกข้อมูลตัวอย่าง" }).click();
    await page.getByRole("button", { name: /ยืนยันการจอง/ }).click();
    await expect(page).toHaveURL(/\/order\/[A-Za-z0-9_-]{43}$/);
    // QR เป็น data: URL → ต้องแสดง (img-src data:)
    const qr = page.getByAltText(/QR PromptPay ตัวอย่าง/);
    await expect(qr).toBeVisible();
    expect(await qr.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
    expect(await watch.violations(), "CSP violation ที่หน้าออเดอร์").toEqual([]);

    await page.getByRole("button", { name: "ใช้สลิปตัวอย่าง" }).click();
    await expect(page.getByTestId("order-headline")).toHaveAttribute("data-status", "awaiting_review");
    // poll สถานะ (fetch same-origin) ทำงานต่อโดยไม่ถูกบล็อก
    await page.waitForTimeout(1500);
    expect(await watch.violations(), "CSP violation หลังส่งสลิปตัวอย่าง").toEqual([]);

    await visit("/about");
    await visit("/privacy");

    const cspConsole = watch.consoleMessages.filter((m) => /content security policy|refused to|violates the following/i.test(m));
    expect(cspConsole, "console แจ้ง CSP").toEqual([]);
    expect(watch.pageErrors, "pageerror").toEqual([]);
  });

  test("หลังบ้าน (owner): dashboard, รายการสินค้า, ฟอร์มสินค้า/อัปโหลดรูป โหลดได้โดยไม่มี CSP violation", async ({ page }) => {
    const watch = await watchViolations(page);
    await page.goto("/admin/login");
    await page.getByLabel("รหัสผ่าน").fill(OWNER_PASSWORD);
    await page.getByRole("button", { name: "เข้าสู่ระบบ", exact: true }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByTestId("admin-role")).toHaveAttribute("data-role", "owner");
    expect(await watch.violations(), "/admin").toEqual([]);

    await page.goto("/admin/items");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(await watch.violations(), "/admin/items").toEqual([]);

    await page.goto("/admin/items/new");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(await watch.violations(), "/admin/items/new").toEqual([]);

    const cspConsole = watch.consoleMessages.filter((m) => /content security policy|refused to|violates the following/i.test(m));
    expect(cspConsole, "console แจ้ง CSP").toEqual([]);
    expect(watch.pageErrors, "pageerror").toEqual([]);
  });

  test("CSP บังคับใช้จริง (ไม่ใช่แค่มี header): ยิงออกโดเมนอื่น / eval / inline ที่ฝัง origin อื่น ถูกบล็อก", async ({ page }) => {
    const watch = await watchViolations(page);
    await page.goto("/privacy");

    // connect-src: ยิงไปโดเมนที่ไม่อนุญาตต้องถูกบล็อกก่อนออกเครือข่าย
    const fetchResult = await page.evaluate(() =>
      fetch("https://example.com/", { mode: "no-cors" }).then(
        () => "allowed",
        () => "blocked",
      ),
    );
    expect(fetchResult).toBe("blocked");

    // script-src (production ไม่มี 'unsafe-eval'): eval / new Function ในสคริปต์ของหน้าต้อง throw EvalError
    // (ต้องรันผ่าน <script> ของหน้าจริง — page.evaluate ของ CDP ข้ามข้อจำกัด eval ของ CSP)
    await page.evaluate(() => {
      const s = document.createElement("script");
      // setTimeout: ให้รันหลังจบการ evaluate (ระหว่าง evaluate ของ CDP จะอนุญาต eval ที่ CSP บล็อกโดยดีฟอลต์)
      s.textContent =
        "setTimeout(function () { try { new Function('return 1')(); document.documentElement.dataset.evalResult = 'ran'; } catch (e) { document.documentElement.dataset.evalResult = e.name; } }, 0);";
      document.head.appendChild(s);
    });
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.evalResult)).toBe("EvalError");

    // script-src: โหลด script จาก origin อื่นต้องถูกบล็อก
    await page.evaluate(() => {
      const s = document.createElement("script");
      s.src = "https://example.com/x.js";
      document.head.appendChild(s);
    });
    // img-src: รูปจากโดเมนที่ไม่อยู่ใน allowlist ต้องถูกบล็อก
    await page.evaluate(() => {
      const i = new Image();
      i.src = "https://example.com/x.png";
    });
    await page.waitForTimeout(500);

    const v = await watch.violations();
    expect(v.some((x) => x.startsWith("connect-src")), v.join(" | ")).toBe(true);
    expect(v.some((x) => x.startsWith("script-src")), v.join(" | ")).toBe(true);
    expect(v.some((x) => x.startsWith("img-src")), v.join(" | ")).toBe(true);
  });

  test("ฝังเว็บใน iframe ของ origin อื่นไม่ได้ (frame-ancestors 'none' + X-Frame-Options DENY)", async ({ page, baseURL }) => {
    // ผู้ฝังเป็น origin สมมติที่ Playwright ตอบ HTML เปล่า (ไม่มี CSP ของตัวเอง) — ไม่ให้ CSP ของผู้ฝังเป็นตัวบล็อกแทน
    await page.route("http://embedder.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body>embedder</body></html>" }),
    );
    await page.goto("http://embedder.test/");
    await page.evaluate((src) => {
      const f = document.createElement("iframe");
      f.src = src;
      document.body.appendChild(f);
    }, `${baseURL}/privacy`);
    await expect
      .poll(() => page.frames().filter((f) => f !== page.mainFrame()).map((f) => f.url()), { timeout: 8000 })
      .toEqual([expect.stringMatching(/^chrome-error:/)]);
  });
});
