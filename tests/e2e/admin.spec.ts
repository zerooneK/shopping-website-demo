import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { SignJWT } from "jose";
import { sql } from "drizzle-orm";
import { getDb } from "../../db/client";
import { E2E_CODES } from "./fixtures";

/**
 * e2e หลังบ้าน (ขั้น 3c-1) ที่ viewport 375x812 ต่อ Neon จริงผ่านเซิร์ฟเวอร์ที่ build แล้ว (NODE_ENV=production)
 *
 * - รหัส owner / SESSION_SECRET เป็นค่าสุ่มต่อการรัน (playwright.config.ts) ไม่ใช่ค่าจริงใน .env.local
 * - Blob ไม่ได้ตั้งค่า → สลิปที่ใช้ทั้งหมดเป็น "สลิปตัวอย่าง" (public/demo/sample-slip.png)
 *   จึง "ไม่ได้ทดสอบ" การดูสลิปจาก Blob private จริง (ครอบคลุมด้วย unit test ที่ mock SDK เท่านั้น)
 * - ลูกค้าถูกสร้างผ่าน API จริง (/api/orders + /api/orders/[token]/slip) ด้วย x-forwarded-for สุ่มต่อออเดอร์
 *   เพื่อไม่ให้ชน rate limit ต่อ IP ของเทสต์อื่น
 */

const OWNER_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "";
const CUSTOMER_NAME = "ตัวอย่าง ทดสอบ";
const CUSTOMER_PHONE = "0812345678";
const CUSTOMER_ADDRESS = "99/9 ถนนตัวอย่าง กรุงเทพฯ 10000";

const PRIORITY: Record<string, number> = {
  awaiting_review: 0,
  confirmed: 1,
  shipped: 2,
  pending_payment: 3,
  completed: 4,
  rejected: 5,
  expired: 5,
  cancelled: 5,
  demo_ended: 5,
};

function randomIp() {
  return `198.18.${Math.floor(Math.random() * 256)}.${1 + Math.floor(Math.random() * 254)}`;
}

async function expectNoHorizontalScroll(page: Page) {
  const m = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    win: window.innerWidth,
  }));
  expect(m.doc, "documentElement.scrollWidth").toBeLessThanOrEqual(m.win);
  expect(m.body, "body.scrollWidth").toBeLessThanOrEqual(m.win);
}

type Body = Record<string, unknown>;

/** สร้างออเดอร์ + ส่งสลิปตัวอย่าง → awaiting_review (ผ่าน API จริง) */
async function placeAwaitingOrder(request: APIRequestContext, code: string, over: Body = {}) {
  const created = await request.post("/api/orders", {
    headers: { "x-forwarded-for": randomIp() },
    data: { code, customerName: CUSTOMER_NAME, phone: CUSTOMER_PHONE, deliveryMethod: "pickup", ...over },
  });
  expect(created.status(), "POST /api/orders").toBe(201);
  const { token } = (await created.json()) as { token: string };
  const slip = await request.post(`/api/orders/${token}/slip`, { data: { sample: true } });
  expect(slip.status(), "POST slip").toBe(200);
  return token;
}

async function newCustomer(
  playwright: { request: { newContext: (o?: { baseURL?: string }) => Promise<APIRequestContext> } },
  baseURL: string | undefined,
) {
  return playwright.request.newContext({ baseURL });
}

async function loginOwner(page: Page) {
  await page.goto("/admin/login");
  await page.getByLabel("รหัสผ่าน").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "เข้าสู่ระบบ", exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByTestId("admin-role")).toHaveAttribute("data-role", "owner");
}

async function loginDemo(page: Page) {
  await page.goto("/admin/login");
  await page.getByRole("button", { name: "ลองหลังบ้านแบบเดโม", exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByTestId("admin-role")).toHaveAttribute("data-role", "demo");
}

/** เปิดหน้ารายละเอียดของออเดอร์จากแถวใน dashboard (หาด้วยชื่อสินค้าที่ไม่ซ้ำ) */
async function openOrderByItemCode(page: Page, code: string) {
  await page.goto("/admin");
  const title = TITLES[code];
  const row = page.locator('[data-testid="admin-order-row"]', { hasText: title });
  await expect(row).toHaveCount(1);
  const id = await row.getAttribute("data-order-id");
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  await row.locator("a").click();
  await expect(page).toHaveURL(new RegExp(`/admin/orders/${id}$`));
  return id!;
}

const TITLES: Record<string, string> = {
  [E2E_CODES.adminConfirm]: "ของทดสอบ e2e หลังบ้าน ยืนยัน",
  [E2E_CODES.adminReject]: "ของทดสอบ e2e หลังบ้าน ปฏิเสธ",
  [E2E_CODES.adminShip]: "ของทดสอบ e2e หลังบ้าน จัดส่ง",
  [E2E_CODES.demoOwn]: "ของทดสอบ e2e เดโม ของตัวเอง",
  [E2E_CODES.demoOther]: "ของทดสอบ e2e เดโม ของคนอื่น",
  [E2E_CODES.demoOwnReject]: "ของทดสอบ e2e เดโม ปฏิเสธเอง",
  [E2E_CODES.ownerReturn]: "ของทดสอบ e2e คืนสินค้า",
  [E2E_CODES.demoEnded]: "ของทดสอบ e2e เดโมสิ้นสุด",
};

const status = (page: Page) => page.getByTestId("admin-order-status");

test.describe("หลังบ้าน: การเข้าถึงและ login (375x812)", () => {
  test("ยังไม่ล็อกอิน: /admin และหน้าออเดอร์เด้งไป login, API สลิปตอบ 401, หน้า login ไม่มี horizontal scroll", async ({
    page,
  }) => {
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/admin\/login$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("หลังบ้าน");
    await expect(page.getByLabel("รหัสผ่าน")).toBeVisible();
    await expect(page.getByRole("button", { name: "ลองหลังบ้านแบบเดโม", exact: true })).toBeVisible();
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: "test-results/shots/admin-login-375.png", fullPage: true });

    await page.goto("/admin/orders/11111111-1111-4111-8111-111111111111");
    await expect(page).toHaveURL(/\/admin\/login$/);

    const slip = await page.request.get("/api/admin/slips/11111111-1111-4111-8111-111111111111", {
      maxRedirects: 0,
    });
    expect(slip.status()).toBe(401);
    expect(await slip.json()).toEqual({ error: "unauthorized" });
  });

  test("หลังบ้านกันถูกฝังใน iframe: /admin, /admin/login และ API ส่ง frame-ancestors 'none' + X-Frame-Options DENY", async ({ page }) => {
    const urls = ["/admin", "/admin/login", "/admin/orders/11111111-1111-4111-8111-111111111111", "/api/admin/slips/11111111-1111-4111-8111-111111111111"];
    for (const url of urls) {
      const res = await page.request.get(url, { maxRedirects: 0 });
      const h = res.headers();
      expect(h["x-frame-options"], `X-Frame-Options ${url} (status ${res.status()})`).toBe("DENY");
      expect(h["content-security-policy"], `CSP ${url}`).toContain("frame-ancestors 'none'");
    }
  });

  test("รหัสผิด: แจ้งข้อผิดพลาดจำเพาะ ไม่ได้ cookie session และยังอยู่หน้า login", async ({ page, context }) => {
    await page.goto("/admin/login");
    await page.getByLabel("รหัสผ่าน").fill("definitely-not-the-password");
    await page.getByRole("button", { name: "เข้าสู่ระบบ", exact: true }).click();
    await expect(page.getByTestId("login-error")).toHaveText("รหัสผ่านไม่ถูกต้อง");
    await expect(page).toHaveURL(/\/admin\/login$/);
    expect((await context.cookies()).some((c) => c.name === "admin_session")).toBe(false);
  });

  test("cookie session ปลอม / เซ็นด้วยกุญแจอื่น ถูกปฏิเสธฝั่ง server", async ({ page, context, baseURL }) => {
    const cookie = (value: string) => ({ name: "admin_session", value, url: baseURL!, httpOnly: true });
    await context.addCookies([cookie("garbage.value.here")]);
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/admin\/login$/);

    const forged = await new SignJWT({ role: "owner" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("shop-website")
      .setAudience("shop-admin")
      .setSubject("admin")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("x".repeat(40)));
    await context.addCookies([cookie(forged)]);
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/admin\/login$/);
    const api = await page.request.get("/api/admin/slips/11111111-1111-4111-8111-111111111111", { maxRedirects: 0 });
    expect(api.status()).toBe(401);
  });

  test("owner login: cookie httpOnly + SameSite=Lax + Secure, logout ล้าง session และกลับเข้า /admin ไม่ได้", async ({
    page,
    context,
  }) => {
    await loginOwner(page);
    const session = (await context.cookies()).find((c) => c.name === "admin_session");
    expect(session, "admin_session cookie").toBeDefined();
    expect(session!.httpOnly).toBe(true);
    expect(session!.sameSite).toBe("Lax");
    expect(session!.secure).toBe(true);
    // เข้า /admin/login ตอนล็อกอินแล้ว → ส่งกลับ /admin
    await page.goto("/admin/login");
    await expect(page).toHaveURL(/\/admin$/);
    // JS ฝั่ง client อ่าน cookie ไม่ได้
    expect(await page.evaluate(() => document.cookie)).not.toContain("admin_session");

    await page.getByRole("button", { name: "ออกจากระบบ" }).click();
    await expect(page).toHaveURL(/\/admin\/login$/);
    expect((await context.cookies()).some((c) => c.name === "admin_session" && c.value !== "")).toBe(false);
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/admin\/login$/);
  });
});

test.describe("หลังบ้าน: owner จัดการออเดอร์ (375x812)", () => {
  test("ยืนยัน → ปิดงาน (นัดรับ): เห็นข้อมูลจริงและสลิป, สินค้าเป็น SOLD, ลูกค้าเห็นสถานะใหม่", async ({
    page,
    playwright,
    baseURL,
  }) => {
    const customer = await newCustomer(playwright, baseURL);
    const token = await placeAwaitingOrder(customer, E2E_CODES.adminConfirm);

    await loginOwner(page);

    // dashboard: เรียง awaiting_review ก่อน, แท็บและจำนวน, ไม่มี horizontal scroll, target ≥ 44px
    const statuses = await page.getByTestId("admin-order-row").evaluateAll((els) => els.map((e) => e.getAttribute("data-status") ?? ""));
    expect(statuses).toContain("awaiting_review");
    const prios = statuses.map((s) => PRIORITY[s]);
    expect(prios, "ลำดับแถวต้องเรียงตามความสำคัญ").toEqual([...prios].sort((a, b) => a - b));
    expect(statuses[0]).toBe("awaiting_review");
    const reviewCount = Number((await page.getByTestId("tab-review").locator("span").innerText()).trim());
    expect(reviewCount).toBeGreaterThanOrEqual(1);
    for (const key of ["all", "review", "closed"]) {
      const box = await page.getByTestId(`tab-${key}`).boundingBox();
      expect(box!.height, `tab ${key} height`).toBeGreaterThanOrEqual(44);
    }
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: "test-results/shots/admin-dashboard-375.png" });

    // แท็บ "รอตรวจสลิป" มีเฉพาะ awaiting_review
    await page.getByTestId("tab-review").click();
    await expect(page).toHaveURL(/\/admin\?tab=review$/);
    const reviewStatuses = await page
      .getByTestId("admin-order-row")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-status")));
    expect(reviewStatuses.length).toBeGreaterThanOrEqual(1);
    expect(new Set(reviewStatuses)).toEqual(new Set(["awaiting_review"]));

    const orderId = await openOrderByItemCode(page, E2E_CODES.adminConfirm);
    await expect(status(page)).toHaveAttribute("data-status", "awaiting_review");
    await expect(status(page)).toHaveText("รอตรวจสลิป");
    // owner เห็นข้อมูลจริง
    await expect(page.getByTestId("customer-name")).toHaveText(CUSTOMER_NAME);
    await expect(page.getByTestId("customer-phone")).toHaveText(CUSTOMER_PHONE);
    await expect(page.getByTestId("masked-note")).toHaveCount(0);
    await expect(page.getByTestId("admin-order-amount")).toHaveText("฿410");
    await expect(page.getByTestId("admin-item-status")).toHaveText("มีคนจองอยู่");
    // สลิป: โหลดผ่าน proxy ได้จริง (รูปมีขนาด)
    const img = page.getByTestId("slip-image");
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
    expect(await img.getAttribute("src")).toBe(`/api/admin/slips/${orderId}`);
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: "test-results/shots/admin-order-375.png", fullPage: true });

    // ปุ่มตามสถานะ: awaiting_review มี ยืนยัน/ปฏิเสธ เท่านั้น
    await expect(page.getByRole("button", { name: "ยืนยันการชำระเงิน" })).toBeVisible();
    await expect(page.getByRole("button", { name: "ปฏิเสธสลิป" })).toBeVisible();
    await expect(page.getByRole("button", { name: "จัดส่งแล้ว" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "ปิดงาน" })).toHaveCount(0);
    const confirmBox = await page.getByRole("button", { name: "ยืนยันการชำระเงิน" }).boundingBox();
    expect(confirmBox!.height).toBeGreaterThanOrEqual(44);

    // timeline ไม่มี event ภายใน
    const timelineBefore = await page.locator("#timeline-heading + ol").innerText();
    expect(timelineBefore).toContain("ลูกค้าจองสินค้า");
    expect(timelineBefore).toContain("ลูกค้าส่งสลิป");
    expect(timelineBefore).not.toContain("slip_token");

    // ---- ยืนยัน
    await page.getByRole("button", { name: "ยืนยันการชำระเงิน" }).click();
    await expect(status(page)).toHaveAttribute("data-status", "confirmed");
    await expect(status(page)).toHaveText("ยืนยันแล้ว");
    await expect(page.getByTestId("action-success")).toHaveText("ยืนยันการชำระเงินแล้ว");
    await expect(page.getByTestId("admin-item-status")).toHaveText("ขายแล้ว");
    await expect(page.getByRole("button", { name: "ยืนยันการชำระเงิน" })).toHaveCount(0);
    await expect(page.locator("#timeline-heading + ol")).toContainText("ยืนยันการชำระเงิน");
    await expect(page.locator("#timeline-heading + ol")).toContainText("โดย เจ้าของร้าน");

    // ลูกค้าเห็นสถานะใหม่ และหน้าสินค้าเป็น SOLD
    await page.goto(`/order/${token}`);
    await expect(page.getByTestId("order-headline")).toHaveAttribute("data-status", "confirmed");
    await expect(page.getByTestId("order-headline")).toHaveText("ร้านยืนยันแล้ว รอนัดรับ");
    await page.goto(`/item/${E2E_CODES.adminConfirm}`);
    await expect(page.locator("button[disabled]:visible", { hasText: "ขายแล้ว" })).toBeVisible();

    // ---- ปิดงาน (นัดรับข้าม shipped ได้)
    await page.goto(`/admin/orders/${orderId}`);
    await expect(page.getByRole("button", { name: "จัดส่งแล้ว" })).toHaveCount(0);
    await page.getByRole("button", { name: "ปิดงาน" }).click();
    await expect(status(page)).toHaveAttribute("data-status", "completed");
    await expect(page.getByTestId("action-success")).toHaveText("ปิดงานแล้ว");
    // เสร็จสิ้นแล้ว: เหลือเฉพาะ "คืนสินค้าเข้าร้าน" ของ owner (ไม่มีปุ่มจัดส่ง/ปิดงาน/ยืนยันอีก)
    await expect(page.getByTestId("return-form")).toBeVisible();
    await expect(page.getByRole("button", { name: "ปิดงาน" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "ยืนยันการชำระเงิน" })).toHaveCount(0);
    await page.goto(`/order/${token}`);
    await expect(page.getByTestId("order-headline")).toHaveAttribute("data-status", "completed");
    await customer.dispose();
  });

  test("ปฏิเสธ: ต้องใส่เหตุผล, สินค้ากลับมาว่างและจองใหม่ได้จริง, ลูกค้าเห็นเหตุผล", async ({
    page,
    playwright,
    baseURL,
  }) => {
    const customer = await newCustomer(playwright, baseURL);
    const token = await placeAwaitingOrder(customer, E2E_CODES.adminReject);
    // ก่อนปฏิเสธ: ชิ้นนี้ถูกถือไว้ (จองซ้ำไม่ได้ → 409)
    const blocked = await (await newCustomer(playwright, baseURL)).post("/api/orders", {
      headers: { "x-forwarded-for": randomIp() },
      data: { code: E2E_CODES.adminReject, customerName: "คนอื่น", phone: CUSTOMER_PHONE, deliveryMethod: "pickup" },
    });
    expect(blocked.status()).toBe(409);

    await loginOwner(page);
    const orderId = await openOrderByItemCode(page, E2E_CODES.adminReject);

    // ไม่ใส่เหตุผล: browser validation กันไว้ สถานะไม่เปลี่ยน ไม่มี action-success
    await page.getByRole("button", { name: "ปฏิเสธสลิป" }).click();
    await expect(status(page)).toHaveAttribute("data-status", "awaiting_review");
    await expect(page.getByTestId("action-success")).toHaveCount(0);
    expect(
      await page.locator("#reject-reason").evaluate((el: HTMLTextAreaElement) => el.validity.valueMissing),
    ).toBe(true);

    // ใส่แต่ช่องว่าง: browser ผ่าน แต่ server ปฏิเสธด้วยข้อความจำเพาะ
    await page.locator("#reject-reason").fill("   ");
    await page.getByRole("button", { name: "ปฏิเสธสลิป" }).click();
    await expect(page.getByTestId("action-error")).toHaveText("กรุณาระบุเหตุผล");
    await expect(status(page)).toHaveAttribute("data-status", "awaiting_review");

    await page.locator("#reject-reason").fill("ยอดเงินในสลิปไม่ตรงกับออเดอร์");
    await page.getByRole("button", { name: "ปฏิเสธสลิป" }).click();
    await expect(status(page)).toHaveAttribute("data-status", "rejected");
    await expect(status(page)).toHaveText("ปฏิเสธแล้ว");
    await expect(page.getByTestId("action-success")).toContainText("ปฏิเสธสลิปแล้ว");
    await expect(page.getByTestId("admin-item-status")).toHaveText("ว่าง");
    await expect(page.locator("#timeline-heading + ol")).toContainText("เหตุผล: ยอดเงินในสลิปไม่ตรงกับออเดอร์");

    // ลูกค้าเห็นเหตุผล
    await page.goto(`/order/${token}`);
    await expect(page.getByTestId("order-headline")).toHaveAttribute("data-status", "rejected");
    await expect(page.getByTestId("order-body")).toHaveText("เหตุผล: ยอดเงินในสลิปไม่ตรงกับออเดอร์");

    // สินค้ากลับมาจองได้จริง
    await page.goto(`/item/${E2E_CODES.adminReject}`);
    await expect(page.locator("a:visible", { hasText: "จองชิ้นนี้" })).toBeVisible();
    const again = await (await newCustomer(playwright, baseURL)).post("/api/orders", {
      headers: { "x-forwarded-for": randomIp() },
      data: { code: E2E_CODES.adminReject, customerName: "คนใหม่", phone: CUSTOMER_PHONE, deliveryMethod: "pickup" },
    });
    expect(again.status()).toBe(201);

    // แท็บ "ปิดแล้ว" มีออเดอร์ที่ถูกปฏิเสธ
    await page.goto("/admin?tab=closed");
    await expect(page.locator(`[data-order-id="${orderId}"]`)).toHaveAttribute("data-status", "rejected");
    await customer.dispose();
  });

  test("จัดส่ง (ไปรษณีย์): ยืนยัน → จัดส่งแล้ว (ต้องมีเลขพัสดุที่ถูกรูปแบบ) → ปิดงาน", async ({
    page,
    playwright,
    baseURL,
  }) => {
    const customer = await newCustomer(playwright, baseURL);
    const token = await placeAwaitingOrder(customer, E2E_CODES.adminShip, {
      deliveryMethod: "post",
      address: CUSTOMER_ADDRESS,
    });
    await loginOwner(page);
    const orderId = await openOrderByItemCode(page, E2E_CODES.adminShip);
    await expect(page.getByTestId("customer-address")).toHaveText(CUSTOMER_ADDRESS);
    await expect(page.getByTestId("admin-order-amount")).toHaveText("฿480"); // 430 + ค่าส่ง 50 คำนวณที่ server

    await page.getByRole("button", { name: "ยืนยันการชำระเงิน" }).click();
    await expect(status(page)).toHaveAttribute("data-status", "confirmed");
    // ไปรษณีย์: ยังไม่มีปุ่มปิดงานตรงๆ ต้อง "จัดส่งแล้ว" ก่อน
    await expect(page.getByRole("button", { name: "ปิดงาน" })).toHaveCount(0);

    await page.locator("#tracking-no").fill("<b>x</b>");
    await page.getByRole("button", { name: "จัดส่งแล้ว" }).click();
    await expect(page.getByTestId("action-error")).toContainText("เลขพัสดุใช้ได้เฉพาะ");
    await expect(status(page)).toHaveAttribute("data-status", "confirmed");

    await page.locator("#tracking-no").fill("TH987654321");
    await page.getByRole("button", { name: "จัดส่งแล้ว" }).click();
    await expect(status(page)).toHaveAttribute("data-status", "shipped");
    await expect(page.getByTestId("admin-tracking")).toHaveText("TH987654321");

    await page.goto(`/order/${token}`);
    await expect(page.getByTestId("order-headline")).toHaveAttribute("data-status", "shipped");
    await expect(page.getByTestId("order-body")).toHaveText("เลขพัสดุ TH987654321");

    await page.goto(`/admin/orders/${orderId}`);
    await page.getByRole("button", { name: "ปิดงาน" }).click();
    await expect(status(page)).toHaveAttribute("data-status", "completed");
    await customer.dispose();
  });
});

test.describe("หลังบ้าน: role เดโม (375x812)", () => {
  test("mask ข้อมูลลูกค้า, ซ่อนสลิปของคนอื่น (หน้า + API), เห็นสลิปของออเดอร์ที่ตัวเองสร้าง, ทำ action ได้", async ({
    page,
    playwright,
    baseURL,
  }) => {
    // ออเดอร์ของ "ตัวเอง": สร้างผ่าน page.request (ใช้ cookie jar เดียวกับเบราว์เซอร์ → demo_sid เดียวกัน)
    const ownToken = await placeAwaitingOrder(page.request, E2E_CODES.demoOwn);
    const ownRejectToken = await placeAwaitingOrder(page.request, E2E_CODES.demoOwnReject);
    // ออเดอร์ของ "คนอื่น": คนละ cookie jar (demo_sid ต่างกัน) + ที่อยู่/หมายเหตุที่ต้องไม่หลุด
    const other = await newCustomer(playwright, baseURL);
    const otherToken = await placeAwaitingOrder(other, E2E_CODES.demoOther, {
      deliveryMethod: "post",
      address: CUSTOMER_ADDRESS,
      note: "โน้ตลับของลูกค้า",
    });

    await loginDemo(page);
    await expect(page.getByTestId("demo-note")).toBeVisible();

    // dashboard: ชื่อ mask ทุกแถว, HTML ทั้งก้อน (รวม RSC payload) ไม่มีค่าจริง
    const names = await page.getByTestId("row-customer").allInnerTexts();
    expect(names.length).toBeGreaterThanOrEqual(2);
    for (const n of names) expect(n).toMatch(/^.\*\*\*$/);
    let html = await page.content();
    for (const secret of [CUSTOMER_NAME, CUSTOMER_PHONE, "99/9", "โน้ตลับ"]) {
      expect(html, `dashboard HTML ต้องไม่มี "${secret}"`).not.toContain(secret);
    }
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: "test-results/shots/admin-demo-dashboard-375.png" });

    // ---- ออเดอร์ของคนอื่น
    const otherId = await openOrderByItemCode(page, E2E_CODES.demoOther);
    await expect(page.getByTestId("masked-note")).toBeVisible();
    await expect(page.getByTestId("customer-name")).toHaveText("ต***");
    await expect(page.getByTestId("customer-phone")).toHaveText("08x-xxx-xx78");
    await expect(page.getByTestId("customer-address")).toHaveText("(ซ่อนที่อยู่ในโหมดเดโม)");
    await expect(page.getByTestId("customer-note")).toHaveText("(ซ่อนหมายเหตุในโหมดเดโม)");
    await expect(page.getByTestId("slip-hidden")).toBeVisible();
    await expect(page.getByTestId("slip-image")).toHaveCount(0);
    html = await page.content();
    for (const secret of [CUSTOMER_NAME, CUSTOMER_PHONE, "99/9", "โน้ตลับ", "slips/", "sample-slip"]) {
      expect(html, `หน้าออเดอร์ของคนอื่นต้องไม่มี "${secret}"`).not.toContain(secret);
    }
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: "test-results/shots/admin-demo-other-375.png", fullPage: true });

    // API สลิปของคนอื่น: 403 (ทั้งที่มี session) ; ของตัวเอง: ผ่าน
    const otherSlip = await page.request.get(`/api/admin/slips/${otherId}`, { maxRedirects: 0 });
    expect(otherSlip.status()).toBe(403);
    expect(await otherSlip.json()).toEqual({ error: "forbidden" });

    // ---- ออเดอร์ของตัวเอง
    const ownId = await openOrderByItemCode(page, E2E_CODES.demoOwn);
    await expect(page.getByTestId("customer-name")).toHaveText("ต***"); // PII ยัง mask เสมอสำหรับ role demo
    await expect(page.getByTestId("customer-phone")).toHaveText("08x-xxx-xx78");
    const img = page.getByTestId("slip-image");
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
    const ownSlip = await page.request.get(`/api/admin/slips/${ownId}`, { maxRedirects: 0 });
    expect(ownSlip.status()).toBe(307);
    expect(ownSlip.headers()["location"]).toBe("/demo/sample-slip.png");
    // เว็บอื่นฝังรูปด้วย cookie ไม่ได้
    const crossSite = await page.request.get(`/api/admin/slips/${ownId}`, {
      maxRedirects: 0,
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(crossSite.status()).toBe(403);

    // ---- demo ทำ action สถานะได้: ยืนยันของตัวเอง
    await page.getByRole("button", { name: "ยืนยันการชำระเงิน" }).click();
    await expect(status(page)).toHaveAttribute("data-status", "confirmed");
    await expect(page.locator("#timeline-heading + ol")).toContainText("โดย ผู้ลองเดโม");
    await page.goto(`/order/${ownToken}`);
    await expect(page.getByTestId("order-headline")).toHaveAttribute("data-status", "confirmed");
    // ออเดอร์ที่ demo ยืนยัน = ทดลอง: หน้าลูกค้าบอกว่าจะคืนสินค้าอัตโนมัติ และสินค้า "ไม่ใช่ SOLD ถาวร" (ถูกกันไว้ชั่วคราว)
    await expect(page.getByTestId("order-demo-note")).toContainText("ระบบจะคืนสินค้าเข้าร้านให้เองภายใน 20 นาทีหลังยืนยัน");
    await page.goto(`/item/${E2E_CODES.demoOwn}`);
    await expect(page.locator("button[disabled]:visible", { hasText: "มีคนจองอยู่" })).toBeVisible();
    await expect(page.locator("button[disabled]:visible", { hasText: "ขายแล้ว" })).toHaveCount(0);
    await page.goto(`/admin/orders/${ownId}`);
    await expect(page.getByTestId("demo-return-note")).toContainText("ระบบจะคืนสินค้าเข้าร้านให้เอง");
    await expect(page.getByTestId("admin-item-status")).toHaveText("มีคนจองอยู่");
    // demo ไม่มีปุ่มคืนสินค้า (เป็นของ owner)
    await expect(page.getByRole("button", { name: "คืนสินค้าเข้าร้าน" })).toHaveCount(0);
    await expect(page.getByTestId("return-form")).toHaveCount(0);

    // ---- demo ปฏิเสธออเดอร์ "ของตัวเอง" ได้ และลูกค้า (หน้า order) เห็นป้ายว่าเป็นข้อความจากผู้ลองเดโม
    await openOrderByItemCode(page, E2E_CODES.demoOwnReject);
    await expect(page.getByTestId("read-only-note")).toHaveCount(0);
    await page.locator("#reject-reason").fill("ทดสอบปฏิเสธจากโหมดเดโม");
    await page.getByRole("button", { name: "ปฏิเสธสลิป" }).click();
    await expect(status(page)).toHaveAttribute("data-status", "rejected");
    await expect(page.getByTestId("customer-name")).toHaveText("ต***");
    await page.goto(`/order/${ownRejectToken}`);
    await expect(page.getByTestId("order-headline")).toHaveAttribute("data-status", "rejected");
    await expect(page.locator("main")).toContainText("ทดสอบปฏิเสธจากโหมดเดโม (ข้อความจากผู้ลองเดโม)");
    await page.goto(`/item/${E2E_CODES.demoOwnReject}`);
    await expect(page.locator("a:visible", { hasText: "จองชิ้นนี้" })).toBeVisible();

    // ---- ออเดอร์ของคนอื่น: ดูได้อย่างเดียว — ไม่มีปุ่ม/ฟอร์ม มีข้อความบอกเหตุผล และสถานะไม่เปลี่ยน
    await page.goto(`/admin/orders/${otherId}`);
    await expect(page.getByTestId("read-only-note")).toContainText("ดูได้อย่างเดียว");
    await expect(page.getByRole("button", { name: "ยืนยันการชำระเงิน" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "ปฏิเสธสลิป" })).toHaveCount(0);
    await expect(page.locator("#reject-reason")).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: "test-results/shots/admin-demo-readonly-375.png", fullPage: true });
    await expect(status(page)).toHaveAttribute("data-status", "awaiting_review");
    await page.goto(`/order/${otherToken}`);
    await expect(page.getByTestId("order-headline")).toHaveAttribute("data-status", "awaiting_review");

    // ออกจากระบบแล้วเข้า /admin ไม่ได้
    await page.goto("/admin");
    await page.getByRole("button", { name: "ออกจากระบบ" }).click();
    await expect(page).toHaveURL(/\/admin\/login$/);
    await page.goto(`/admin/orders/${ownId}`);
    await expect(page).toHaveURL(/\/admin\/login$/);
    await other.dispose();
  });

  test("demo ที่ไม่มีออเดอร์ของตัวเอง: เปิดสลิปของใครก็ไม่ได้ (browser ใหม่ = demo_sid ใหม่)", async ({ page }) => {
    await loginDemo(page);
    // ทุกแถวที่มีสลิป ต้องไม่ใช่ของ browser นี้ → API ตอบ 403 ทุกใบ
    const ids = await page.getByTestId("admin-order-row").evaluateAll((els) => els.map((e) => e.getAttribute("data-order-id")));
    for (const id of ids.slice(0, 5)) {
      const res = await page.request.get(`/api/admin/slips/${id}`, { maxRedirects: 0 });
      expect([403, 404], `slip ${id}`).toContain(res.status());
      expect(res.status()).not.toBe(307);
      expect(res.status()).not.toBe(200);
    }
  });
});

test.describe("หลังบ้าน: คืนสินค้าเข้าร้าน และออเดอร์เดโมที่สิ้นสุดแล้ว (375x812)", () => {
  test("owner ยืนยันแล้วคืนสินค้าเข้าร้านได้ (ต้องมีเหตุผล): ออเดอร์ cancelled, สินค้ากลับว่างและจองใหม่ได้, ลูกค้าเห็นเหตุผล", async ({
    page,
    playwright,
    baseURL,
  }) => {
    const customer = await newCustomer(playwright, baseURL);
    const token = await placeAwaitingOrder(customer, E2E_CODES.ownerReturn);
    await loginOwner(page);
    const orderId = await openOrderByItemCode(page, E2E_CODES.ownerReturn);
    await page.getByRole("button", { name: "ยืนยันการชำระเงิน" }).click();
    await expect(status(page)).toHaveAttribute("data-status", "confirmed");
    await expect(page.getByTestId("admin-item-status")).toHaveText("ขายแล้ว");
    // ออเดอร์ที่ owner ยืนยัน: ไม่มีหมายเหตุเดโม
    await expect(page.getByTestId("demo-return-note")).toHaveCount(0);
    await page.goto(`/item/${E2E_CODES.ownerReturn}`);
    await expect(page.locator("button[disabled]:visible", { hasText: "ขายแล้ว" })).toBeVisible();

    await page.goto(`/admin/orders/${orderId}`);
    await expect(page.getByTestId("return-form")).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: "test-results/shots/admin-owner-return-375.png", fullPage: true });
    // เหตุผลว่าง = ฟอร์มไม่ส่ง (required) สถานะไม่เปลี่ยน
    await page.getByRole("button", { name: "คืนสินค้าเข้าร้าน" }).click();
    await expect(status(page)).toHaveAttribute("data-status", "confirmed");
    await page.locator("#return-reason").fill("ลูกค้าขอยกเลิกการซื้อ");
    await page.getByRole("button", { name: "คืนสินค้าเข้าร้าน" }).click();
    await expect(status(page)).toHaveAttribute("data-status", "cancelled");
    await expect(page.getByTestId("action-success")).toHaveText("คืนสินค้าเข้าร้านและยกเลิกออเดอร์แล้ว");
    await expect(page.getByTestId("admin-item-status")).toHaveText("ว่าง");
    await expect(page.locator("#timeline-heading + ol")).toContainText("คืนสินค้าเข้าร้าน/ยกเลิกออเดอร์");
    await expect(page.locator("#timeline-heading + ol")).toContainText("โดย เจ้าของร้าน");

    // ลูกค้าเห็นว่าร้านเป็นผู้ยกเลิกพร้อมเหตุผล; หน้าสินค้ากลับมาจองได้
    await page.goto(`/order/${token}`);
    await expect(page.getByTestId("order-headline")).toHaveAttribute("data-status", "cancelled");
    await expect(page.getByTestId("order-headline")).toContainText("ร้านยกเลิกออเดอร์และคืนสินค้าเข้าร้านแล้ว");
    await expect(page.getByTestId("order-body")).toHaveText("เหตุผล: ลูกค้าขอยกเลิกการซื้อ");
    await page.goto(`/item/${E2E_CODES.ownerReturn}`);
    await expect(page.locator("a:visible", { hasText: "จองชิ้นนี้" })).toBeVisible();
    await customer.dispose();
  });

  test("ออเดอร์ที่ demo ยืนยันครบ 20 นาที: สินค้ากลับว่างเอง, หน้าลูกค้า/หลังบ้านแสดง 'เดโมสิ้นสุดแล้ว' ไม่ค้างเป็นยืนยันแล้ว, ย้ายไปแท็บปิดแล้ว", async ({
    page,
  }) => {
    const token = await placeAwaitingOrder(page.request, E2E_CODES.demoEnded);
    await loginDemo(page);
    const orderId = await openOrderByItemCode(page, E2E_CODES.demoEnded);
    await page.getByRole("button", { name: "ยืนยันการชำระเงิน" }).click();
    await expect(status(page)).toHaveAttribute("data-status", "confirmed");
    await page.goto(`/item/${E2E_CODES.demoEnded}`);
    await expect(page.locator("button[disabled]:visible", { hasText: "มีคนจองอยู่" })).toBeVisible();

    // จำลองเวลาผ่านไป 25 นาที (ตรรกะจริงตัดสินด้วย now() ของ DB: ย้อน confirmed_at และ reserved_until ที่ระบบตั้งไว้)
    const db = getDb();
    await db.execute(sql`UPDATE orders SET confirmed_at = now() - interval '25 minutes' WHERE id = ${orderId}`);
    await db.execute(
      sql`UPDATE items SET reserved_until = (SELECT confirmed_at + interval '20 minutes' FROM orders WHERE id = ${orderId})
          WHERE id = (SELECT item_id FROM orders WHERE id = ${orderId})`,
    );

    // หน้าสินค้า: ว่างและจองได้อีกครั้ง
    await page.goto(`/item/${E2E_CODES.demoEnded}`);
    await expect(page.locator("a:visible", { hasText: "จองชิ้นนี้" })).toBeVisible();

    // หน้าลูกค้า: เดโมสิ้นสุดแล้ว
    await page.goto(`/order/${token}`);
    await expect(page.getByTestId("order-headline")).toHaveAttribute("data-status", "demo_ended");
    await expect(page.getByTestId("order-headline")).toHaveText("เดโมสิ้นสุดแล้ว");
    await expect(page.getByTestId("order-body")).toContainText("ไม่ใช่การขายจริง");
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: "test-results/shots/order-demo-ended-375.png", fullPage: true });

    // หลังบ้าน: สถานะ demo_ended, ไม่มีปุ่ม, ไม่อยู่ในแท็บ "ยืนยันแล้ว" แต่อยู่ใน "ปิดแล้ว"
    await page.goto(`/admin/orders/${orderId}`);
    await expect(status(page)).toHaveAttribute("data-status", "demo_ended");
    await expect(status(page)).toContainText("เดโมสิ้นสุดแล้ว");
    await expect(page.getByTestId("demo-return-note")).toContainText("สิ้นสุดแล้ว");
    await expect(page.getByRole("button", { name: "ปิดงาน" })).toHaveCount(0);
    await expect(page.getByText("ไม่มีการดำเนินการที่ทำได้ในสถานะนี้")).toBeVisible();
    await expect(page.getByTestId("admin-item-status")).toHaveText("ว่าง");

    const title = TITLES[E2E_CODES.demoEnded];
    await page.goto("/admin?tab=confirmed");
    await expect(page.locator('[data-testid="admin-order-row"]', { hasText: title })).toHaveCount(0);
    await page.goto("/admin?tab=closed");
    const row = page.locator('[data-testid="admin-order-row"]', { hasText: title });
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute("data-status", "demo_ended");
    await expect(row.getByTestId("row-demo-return")).toHaveText("ออเดอร์เดโม · คืนสินค้าเข้าร้านแล้ว");
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: "test-results/shots/admin-demo-ended-375.png" });
  });
});
