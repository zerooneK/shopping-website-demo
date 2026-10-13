import { expect, test, type Page } from "@playwright/test";
import { E2E_CODES } from "./fixtures";

/**
 * e2e ที่ viewport 375x812 (ตั้งใน playwright.config.ts) ต่อกับ Neon จริงผ่านเซิร์ฟเวอร์ที่ build แล้ว
 * ใช้สินค้า fixture T981-T987 ที่สร้าง/ลบเอง (ไม่ใช้สินค้า seed) — Blob ไม่ได้ตั้งค่าในสภาพแวดล้อมนี้
 * จึงทดสอบการส่งสลิปด้วย "สลิปตัวอย่าง" เท่านั้น (ไม่ได้ทดสอบ Blob upload จริง)
 */

async function expectNoHorizontalScroll(page: Page) {
  const m = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    win: window.innerWidth,
  }));
  expect(m.doc, "documentElement.scrollWidth").toBeLessThanOrEqual(m.win);
  expect(m.body, "body.scrollWidth").toBeLessThanOrEqual(m.win);
}

const headline = (page: Page) => page.getByTestId("order-headline");

test.describe("flow สั่งซื้อ (375x812)", () => {
  test("หน้าแรก → สินค้า → จอง → กรอกฟอร์ม → QR/นับถอยหลัง → สลิปตัวอย่าง → awaiting_review", async ({
    page,
  }) => {
    // ---- หน้าแรก: ช่องค้นหาเหลือช่องเดียว + เห็นแถบหมวดและส่วนบนของสินค้าชิ้นแรกในจอแรก
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // แถบเดโมต้องไม่อ้างสิ่งที่ระบบยังไม่ทำ (ยังไม่มี cron รีเซ็ต) — ข้อความจริงเท่านั้น
    await expect(
      page.getByText("Demo store — ไม่มีการเรียกเก็บเงินจริง · อย่ากรอกข้อมูลจริง", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("รีเซ็ตทุกวัน")).toHaveCount(0);
    const visibleSearch = page.locator('input[type="search"]:visible');
    await expect(visibleSearch).toHaveCount(1);
    const nav = page.getByRole("navigation", { name: "หมวดสินค้า" });
    const navBox = await nav.boundingBox();
    expect(navBox, "category nav").not.toBeNull();
    expect(navBox!.y + navBox!.height).toBeLessThan(812);
    const firstCard = page.locator("article").first();
    const cardBox = await firstCard.boundingBox();
    expect(cardBox, "first card").not.toBeNull();
    expect(cardBox!.y, "ส่วนบนของสินค้าชิ้นแรกต้องอยู่ในจอแรก").toBeLessThan(812 - 60);
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: "test-results/shots/home-375.png" });

    // ---- เปิดสินค้า (fixture อยู่ต้นรายการเพราะ sortOrder ติดลบ)
    await page.locator(`a[href="/item/${E2E_CODES.main}"]`).first().click();
    await expect(page).toHaveURL(new RegExp(`/item/${E2E_CODES.main}$`));
    await expect(page.getByRole("heading", { level: 1 })).toContainText("ของทดสอบ e2e หลัก");

    // ลิงก์เครดิตช่างภาพ touch target >= 44px
    const credits = page.locator('section[aria-labelledby="credit-heading"] a');
    expect(await credits.count()).toBeGreaterThan(0);
    for (const link of await credits.all()) {
      const box = await link.boundingBox();
      expect(box!.height, "credit link height").toBeGreaterThanOrEqual(44);
    }
    await expectNoHorizontalScroll(page);

    // ---- จอง
    await page.locator("a:visible", { hasText: "จองชิ้นนี้" }).click();
    await expect(page).toHaveURL(new RegExp(`/checkout/${E2E_CODES.main}$`));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("กรอกข้อมูลสั่งซื้อ");
    await expect(page.getByText("อย่าใส่ข้อมูลจริง")).toBeVisible();
    await expectNoHorizontalScroll(page);

    // กรอกด้วยปุ่มตัวอย่าง + เลือกส่งไปรษณีย์ (ที่อยู่แสดงเมื่อเลือกส่ง)
    await expect(page.getByLabel("ที่อยู่จัดส่ง")).toHaveCount(0);
    await page.getByRole("button", { name: "กรอกข้อมูลตัวอย่าง" }).click();
    await expect(page.getByLabel("ชื่อ", { exact: true })).not.toHaveValue("");
    await page.getByText("ส่งไปรษณีย์", { exact: true }).click();
    await expect(page.getByLabel("ที่อยู่จัดส่ง")).toBeVisible();
    await page.getByLabel("ที่อยู่จัดส่ง").fill("99/9 ถนนตัวอย่าง กรุงเทพฯ 10000");
    await expect(page.getByRole("button", { name: /ยืนยันการจอง/ })).toContainText("฿500");
    await page.screenshot({ path: "test-results/shots/checkout-375.png", fullPage: true });
    await page.getByRole("button", { name: /ยืนยันการจอง/ }).click();

    // ---- หน้าออเดอร์
    await expect(page).toHaveURL(/\/order\/[A-Za-z0-9_-]{43}$/);
    await expect(headline(page)).toHaveAttribute("data-status", "pending_payment");
    await expect(page.getByAltText(/QR PromptPay ตัวอย่าง/)).toBeVisible();
    await expect(page.getByText("DEMO", { exact: true })).toBeVisible();
    await expect(page.getByText("สแกนจ่ายจริงไม่ได้")).toBeVisible();
    await expect(page.getByTestId("order-amount")).toHaveText("฿500");

    // นับถอยหลัง: เริ่ม ~15:00 และลดลงจริง
    const countdown = page.getByTestId("order-countdown");
    await expect(countdown).toHaveText(/^1[45]:\d\d$/);
    const first = await countdown.textContent();
    await expect.poll(async () => countdown.textContent(), { timeout: 5000 }).not.toBe(first);
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: "test-results/shots/order-pending-375.png", fullPage: true });

    // ไม่มี Blob token → ซ่อนช่องเลือกไฟล์ แสดงข้อความ dev-only และปุ่มสลิปตัวอย่าง
    await expect(page.locator('input[type="file"]')).toHaveCount(0);
    await expect(page.getByText("dev-only")).toBeVisible();

    // ---- header ของหน้า: no-store / noindex / no-referrer
    const resp = await page.reload();
    expect(resp!.headers()["cache-control"]).toContain("no-store");
    expect(resp!.headers()["referrer-policy"]).toBe("no-referrer");
    expect(resp!.headers()["x-robots-tag"]).toContain("noindex");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);

    // ---- สลิปตัวอย่าง → awaiting_review
    await page.getByRole("button", { name: "ใช้สลิปตัวอย่าง" }).click();
    await expect(headline(page)).toHaveAttribute("data-status", "awaiting_review");
    await expect(headline(page)).toHaveText("รอร้านตรวจสอบสลิป");
    await expect(page.getByAltText(/QR PromptPay/)).toHaveCount(0);
    await expect(page.getByText("ส่งสลิปแล้ว รอร้านตรวจสอบ")).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: "test-results/shots/order-awaiting-375.png", fullPage: true });

    // หน้าสินค้ายังแสดงว่ามีคนจองอยู่ (ไม่ใช่ว่าง)
    await page.goto(`/item/${E2E_CODES.main}`);
    await expect(page.locator("button[disabled]:visible", { hasText: "มีคนจองอยู่" })).toBeVisible();
  });

  test("flow ยกเลิก: จอง → ยกเลิก → สินค้ากลับมาจองได้", async ({ page }) => {
    await page.goto(`/item/${E2E_CODES.cancel}`);
    await page.locator("a:visible", { hasText: "จองชิ้นนี้" }).click();
    await page.getByRole("button", { name: "กรอกข้อมูลตัวอย่าง" }).click();
    await page.getByRole("button", { name: /ยืนยันการจอง/ }).click();

    await expect(page).toHaveURL(/\/order\/[A-Za-z0-9_-]{43}$/);
    await expect(headline(page)).toHaveAttribute("data-status", "pending_payment");

    await page.getByRole("button", { name: "ยกเลิกออเดอร์" }).click();
    await page.getByRole("button", { name: "ยืนยันยกเลิก" }).click();
    await expect(headline(page)).toHaveAttribute("data-status", "cancelled");
    await expect(headline(page)).toHaveText("ยกเลิกออเดอร์แล้ว");
    await expect(page.getByText("คุณยกเลิกออเดอร์", { exact: true })).toBeVisible();
    await expect(page.getByAltText(/QR PromptPay/)).toHaveCount(0);
    await expectNoHorizontalScroll(page);

    // สินค้ากลับมาว่าง จองใหม่ได้ (ฟอร์มแสดง ไม่ใช่ข้อความ "จองไม่ได้")
    await page.goto(`/checkout/${E2E_CODES.cancel}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("กรอกข้อมูลสั่งซื้อ");
    await expect(page.getByRole("button", { name: /ยืนยันการจอง/ })).toBeVisible();
  });
});

test.describe("หน้าอื่นๆ (375x812)", () => {
  test("checkout: สินค้าที่ขายแล้วแสดงข้อความ + ลิงก์กลับ (ไม่ใช่ฟอร์ม); รหัสที่ไม่มี = 404", async ({
    page,
  }) => {
    await page.goto(`/checkout/${E2E_CODES.sold}`);
    await expect(page.getByText("ชิ้นนี้ขายไปแล้ว")).toBeVisible();
    await expect(page.getByRole("button", { name: /ยืนยันการจอง/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "เลือกชิ้นอื่น" })).toBeVisible();
    await expectNoHorizontalScroll(page);

    const res = await page.goto("/checkout/Z999");
    expect(res!.status()).toBe(404);
  });

  test("order: token ที่ไม่มีอยู่/รูปแบบผิด = 404", async ({ page }) => {
    const a = await page.goto(`/order/${"A".repeat(43)}`);
    expect(a!.status()).toBe(404);
    const b = await page.goto("/order/abc");
    expect(b!.status()).toBe(404);
  });

  test("about: อ่าน BUILD_LOG จริง ไม่มี horizontal scroll ลิงก์ GitHub ถูกต้อง", async ({ page }) => {
    await page.goto("/about");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("ทีม AI สร้าง");
    // ไทม์ไลน์มาจาก docs/BUILD_LOG.md (มีอย่างน้อย 3a และ 3b-1)
    await expect(page.getByText("ขั้น 3a", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("ขั้น 3b-1", { exact: true }).first()).toBeVisible();
    expect(await page.locator("#timeline ~ ol > li").count()).toBeGreaterThan(5);
    await expect(page.getByRole("link", { name: "ดูโค้ดบน GitHub" })).toHaveAttribute(
      "href",
      "https://github.com/zerooneK/shopping-website-demo",
    );
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: "test-results/shots/about-375.png", fullPage: true });
  });

  test("privacy: ไม่ 404 และมีคำเตือนห้ามกรอกข้อมูลจริง", async ({ page }) => {
    const res = await page.goto("/privacy");
    expect(res!.status()).toBe(200);
    await expect(page.getByText("กรุณาอย่าใส่ข้อมูลจริง")).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});

test.describe("API (ผ่าน request context ที่มี cookie jar ของตัวเอง)", () => {
  const payload = (code: string, over: Record<string, unknown> = {}) => ({
    code,
    customerName: "ตัวอย่าง ทดสอบ",
    phone: "0812345678",
    deliveryMethod: "pickup",
    ...over,
  });

  test("ราคาไม่รับจาก client, cookie demo_sid ปลอดภัย, 409/400/429 ตาม SPEC", async ({ playwright, baseURL }) => {
    // x-forwarded-for ปลอมได้บน next start ในเครื่อง (บน Vercel ถูกเขียนทับโดยแพลตฟอร์ม) — ใช้แยก bucket IP
    // ของเทสต์นี้ออกจากเทสต์อื่น เพื่อให้ยืนยัน limit "ต่อ browser (demo_sid)" ได้ตรงๆ
    const ctx = await playwright.request.newContext({
      baseURL: baseURL!,
      extraHTTPHeaders: { "x-forwarded-for": "198.51.100.21" },
    });

    // 400: error ต่อ field
    const bad = await ctx.post("/api/orders", {
      data: payload(E2E_CODES.api1, { customerName: "", phone: "1" }),
    });
    expect(bad.status()).toBe(400);
    const badBody = (await bad.json()) as { fieldErrors: Record<string, string[]> };
    expect(Object.keys(badBody.fieldErrors).sort()).toEqual(["customerName", "phone"]);

    // ราคาปลอมถูกเมิน: ยอดจริง = 300 (ราคาใน DB) ไม่ใช่ 1
    const ok1 = await ctx.post("/api/orders", {
      data: payload(E2E_CODES.api1, { price: 1, amount: 1, shippingFee: 0 }),
    });
    expect(ok1.status()).toBe(201);
    const cookie = ok1.headers()["set-cookie"] ?? "";
    expect(cookie).toContain("demo_sid=");
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Secure/i); // next start = production
    const sid = /demo_sid=([^;]+)/.exec(cookie)![1];
    expect(sid.length * 6).toBeGreaterThanOrEqual(128);

    const { token } = (await ok1.json()) as { token: string };
    const html = await (await ctx.get(`/order/${token}`)).text();
    expect(html).toContain('data-testid="order-amount">฿300<');
    expect(html).not.toContain("blob.vercel-storage.com");

    // 409: คนอื่นจองชิ้นเดียวกัน
    const other = await playwright.request.newContext({
      baseURL: baseURL!,
      extraHTTPHeaders: { "x-forwarded-for": "198.51.100.22" },
    });
    const conflict = await other.post("/api/orders", { data: payload(E2E_CODES.api1) });
    expect(conflict.status()).toBe(409);
    expect(((await conflict.json()) as { error: string }).error).toBe("มีคนจองตัดหน้าไปแล้ว");

    // 429: ออเดอร์ค้างชำระได้ไม่เกิน 2 ต่อ browser (cookie jar เดิม = demo_sid เดิม)
    const ok2 = await ctx.post("/api/orders", { data: payload(E2E_CODES.api2) });
    expect(ok2.status()).toBe(201);
    const limited = await ctx.post("/api/orders", { data: payload(E2E_CODES.api3) });
    expect(limited.status()).toBe(429);
    expect(limited.headers()["retry-after"]).toBeTruthy();

    // ยกเลิกใบหนึ่ง → จองต่อได้
    const { token: token2 } = (await ok2.json()) as { token: string };
    expect((await ctx.post(`/api/orders/${token2}/cancel`)).status()).toBe(200);
    expect((await ctx.post(`/api/orders/${token2}/cancel`)).status()).toBe(409); // ยกเลิกซ้ำ
    expect((await ctx.post("/api/orders", { data: payload(E2E_CODES.api3) })).status()).toBe(201);

    // status endpoint: ข้อมูลน้อยที่สุด ไม่ cache
    const st = await ctx.get(`/api/orders/${token}/status`);
    expect(st.status()).toBe(200);
    expect(st.headers()["cache-control"]).toContain("no-store");
    expect(Object.keys((await st.json()) as object).sort()).toEqual(["expiresAt", "serverNow", "status"]);
    expect((await ctx.get(`/api/orders/${"B".repeat(43)}/status`)).status()).toBe(404);

    // รับเฉพาะ JSON; slip: ไม่ได้ตั้ง BLOB_READ_WRITE_TOKEN ในสภาพแวดล้อมนี้ จึงได้ 503 เสมอ
    // (ชั้น e2e ไม่ได้ทดสอบ pathname ของออเดอร์อื่น — ส่วนนั้นครอบคลุมด้วย unit test
    // tests/unit/blob-slip-routes.test.ts ที่ mock head()/Blob SDK)
    expect((await ctx.post("/api/orders", { form: { code: E2E_CODES.api1 } })).status()).toBe(415);
    const slip = await ctx.post(`/api/orders/${token}/slip`, { data: { pathname: "slips/x/y.jpg" } });
    expect(slip.status()).toBe(503);

    // สลิปตัวอย่าง: ครั้งแรกผ่าน ครั้งที่สอง 409 (สถานะเปลี่ยนแล้ว)
    expect((await ctx.post(`/api/orders/${token}/slip`, { data: { sample: true } })).status()).toBe(200);
    expect((await ctx.post(`/api/orders/${token}/slip`, { data: { sample: true } })).status()).toBe(409);
    expect((await ctx.post(`/api/orders/${token}/cancel`)).status()).toBe(409); // ส่งสลิปแล้วยกเลิกไม่ได้

    await ctx.dispose();
    await other.dispose();
  });

  test("ไม่ส่ง cookie (browser ใหม่ทุกครั้ง) จาก IP เดียวกัน: 429 ที่ IP limit ฝั่ง server", async ({
    playwright,
    baseURL,
  }) => {
    const codes = [E2E_CODES.ip1, E2E_CODES.ip2, E2E_CODES.ip3, E2E_CODES.ip4];
    const statuses: number[] = [];
    let limited: { headers: Record<string, string>; body: { error: string; reason: string } } | null = null;
    for (const code of codes) {
      // context ใหม่ทุกครั้ง = ไม่มี demo_sid (เหมือน curl ที่ไม่แนบ cookie)
      const c = await playwright.request.newContext({
        baseURL: baseURL!,
        extraHTTPHeaders: { "x-forwarded-for": "198.51.100.77" },
      });
      const res = await c.post("/api/orders", { data: payload(code) });
      statuses.push(res.status());
      if (res.status() === 429) {
        limited = { headers: res.headers(), body: (await res.json()) as { error: string; reason: string } };
      }
      await c.dispose();
    }
    expect(statuses).toEqual([201, 201, 201, 429]);
    expect(limited!.body.reason).toBe("ip_too_many_holding");
    expect(limited!.body.error.length).toBeGreaterThan(10);
    expect(limited!.headers["retry-after"]).toBeTruthy();
    expect(limited!.headers["cache-control"]).toContain("no-store");

    // IP อื่นไม่ถูกกระทบ
    const other = await playwright.request.newContext({
      baseURL: baseURL!,
      extraHTTPHeaders: { "x-forwarded-for": "198.51.100.78" },
    });
    expect((await other.post("/api/orders", { data: payload(E2E_CODES.ip4) })).status()).toBe(201);
    await other.dispose();
  });
});

test.describe("ถ้อยคำสอดคล้องกับสิ่งที่ระบบทำจริง", () => {
  test("/about และ /privacy ไม่อ้างการรีเซ็ตรายวัน และบอกสถานะหลังบ้านตรงความจริง", async ({ page }) => {
    await page.goto("/about");
    // เฉพาะส่วนคำอธิบาย (ไม่รวมไทม์ไลน์ที่ดึงจาก BUILD_LOG ซึ่งอาจเอ่ยถึงถ้อยคำเหล่านี้ตอนบันทึกการแก้)
    const about =
      (await page.locator("main > p").nth(1).innerText()) +
      "\n" +
      (await page.locator('section[aria-labelledby="why-demo"]').innerText());
    expect(about).not.toContain("ถูกรีเซ็ตเป็นรายวัน");
    expect(about).not.toContain("ทำงานครบทุกขั้น");
    expect(about).toContain("ยังอยู่ระหว่างพัฒนา");

    await page.goto("/privacy");
    const privacy = await page.locator("main").innerText();
    expect(privacy).not.toContain("รีเซ็ตทุกวัน");
    expect(privacy).toContain("ยังไม่มีระบบล้างอัตโนมัติ");
    // หลังบ้านเปิดแล้ว (ขั้น 3c-1): ข้อความต้องไม่บอกว่า "ยังไม่มีหลังบ้าน" และต้องบอกพฤติกรรมของ role เดโมที่ทำจริง
    expect(privacy).not.toContain("ยังไม่มีหลังบ้านเปิดใช้งาน");
    expect(privacy).toContain("เปิดดูสลิปได้เฉพาะออเดอร์ที่สร้างจากเบราว์เซอร์ของตัวเอง");
    expect(about).not.toContain("หลังบ้านยังไม่เปิดใช้");
    // L2: ใช้คำว่า "ปิดบังบางส่วน" และบอกว่า demo เปลี่ยนสถานะ/เขียนเหตุผลได้เฉพาะออเดอร์ของตัวเอง; ไม่อ้างรีเซ็ตรายวัน
    expect(privacy).toContain("ปิดบังบางส่วน");
    expect(privacy).toContain("เปลี่ยนสถานะออเดอร์");
    expect(privacy).toContain("เฉพาะออเดอร์ที่ตัวเองสร้างจากเบราว์เซอร์นั้น");
    expect(privacy).toContain("(ข้อความจากผู้ลองเดโม)");
    // DEMO_MODE=true ใน e2e → ประโยค "ลองหลังบ้านได้" ต้องแสดง (ผูกกับ isDemoMode())
    expect(about).toContain("ลองได้แบบเดโม");
  });
});
