import { expect, test, type Page } from "@playwright/test";
import { E2E_CODES } from "./fixtures";

/**
 * e2e จัดการสินค้าหลังบ้าน + ด่าน cron (ขั้น 3c-2) ที่ viewport 375x812 ต่อ Neon จริงผ่านเซิร์ฟเวอร์ที่ build แล้ว
 *
 * - รหัส owner / SESSION_SECRET / CRON_SECRET เป็นค่าสุ่มต่อการรัน (playwright.config.ts)
 * - Blob ไม่ได้ตั้งค่า → "ไม่ได้ทดสอบ" การอัปโหลดรูปจริง/proxy รูปจริง (ครอบคลุมด้วย unit test ที่ mock SDK เท่านั้น)
 *   เทสต์นี้ยืนยันว่า demo ถูกปฏิเสธที่ server (403) และ owner ผ่านด่านสิทธิ์/Origin ไปถึงจุดตรวจ Blob (503)
 * - cron: ยิงเฉพาะแบบที่ "ต้องถูกปฏิเสธ" เท่านั้น — การรีเซ็ตจริงล้างทั้งตาราง orders ของ Neon จริง จึงทดสอบกับ schema แยกใน
 *   tests/integration/cron-reset.pg.test.ts
 */

const OWNER_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "";
const ORIGIN = "http://localhost:3100";

const TITLE = {
  edit: "ของทดสอบ e2e แก้ราคา",
  status: "ของทดสอบ e2e เปลี่ยนสถานะ",
  held: "ของทดสอบ e2e ออเดอร์ถือ",
  demo: "ของทดสอบ e2e เดโมดูสินค้า",
} as const;

function randomIp() {
  return `198.19.${Math.floor(Math.random() * 256)}.${1 + Math.floor(Math.random() * 254)}`;
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

const row = (page: Page, code: string) =>
  page.locator(`[data-testid="admin-item-row"][data-code="${code}"]`);

/** เปิดหน้าแก้สินค้าจากแถวในตาราง (ผ่านลิงก์ชื่อสินค้า) แล้วคืน id */
async function openEdit(page: Page, code: string) {
  await page.goto("/admin/items");
  await row(page, code).getByRole("link").first().click();
  await expect(page).toHaveURL(/\/admin\/items\/\d+$/);
  return Number(new URL(page.url()).pathname.split("/").pop());
}

async function shopPrice(page: Page, code: string) {
  await page.goto(`/item/${code}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  return page.locator("body").innerText();
}

test.describe("จัดการสินค้าหลังบ้าน: ด่านเข้าถึง (375x812)", () => {
  test("ยังไม่ล็อกอิน: /admin/items เด้งไป login, API อัปโหลดรูป 401, proxy รูปไม่ยอมให้อ่านนอก items/", async ({
    page,
    request,
  }) => {
    for (const path of ["/admin/items", "/admin/items/new", "/admin/items/1"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/admin\/login$/);
    }
    const up = await request.post("/api/admin/item-images/upload", {
      headers: { origin: ORIGIN },
      data: { type: "blob.generate-client-token", payload: { pathname: "items/x.jpg", clientPayload: null, multipart: false } },
    });
    expect(up.status()).toBe(401);

    // ชื่อไฟล์ที่ไม่ผ่าน allowlist → 404 ก่อนแตะ Blob (กันอ่าน slips/ ผ่านเส้นทางสาธารณะ)
    for (const name of ["..%2Fslips%2Fx.jpg", "x.html", "sub%2Fx.jpg", "x.heic"]) {
      expect((await request.get(`/api/item-images/${name}`)).status(), name).toBe(404);
    }
    // ชื่อถูกต้องแต่ e2e ไม่มี Blob → 503 (ไม่ใช่ 200: ไม่มีไฟล์ให้ส่ง)
    expect((await request.get("/api/item-images/up-12345678.jpg")).status()).toBe(503);
  });

  test("cron: ไม่มี header / secret ผิด / รูปแบบแปลก / query string → 401 ทั้ง GET และ POST และร้านยังไม่ถูกรีเซ็ต", async ({
    request,
    page,
  }) => {
    for (const method of ["get", "post"] as const) {
      const none = await request[method]("/api/cron/reset");
      expect(none.status()).toBe(401);
      expect(await none.json()).toEqual({ error: "unauthorized" });
      for (const auth of ["Bearer wrong-secret-value-1234567890", "Bearer", "Bearer undefined", "Basic abc", ""]) {
        const r = await request[method]("/api/cron/reset", { headers: { authorization: auth } });
        expect(r.status(), `${method} ${auth}`).toBe(401);
      }
    }
    const viaQuery = await request.get(`/api/cron/reset?secret=${process.env.E2E_CRON_SECRET}`);
    expect(viaQuery.status()).toBe(401);

    // fixture ยังอยู่ = ไม่มีการรีเซ็ตเกิดขึ้น
    await page.goto(`/item/${E2E_CODES.itemEdit}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(TITLE.edit);
  });
});

test.describe("owner จัดการสินค้า (375x812)", () => {
  test("แก้ราคา: ตรวจ Zod ฝั่ง server (price 0 / ทศนิยม / ตำหนิว่าง) แล้วบันทึก → หน้าแรกและหน้าสินค้าเปลี่ยนทันที", async ({
    page,
  }) => {
    const code = E2E_CODES.itemEdit;

    // ก่อนแก้: หน้าสินค้าและหน้าแรกแสดง ฿480 (และอุ่น cache ของ 'use cache' ให้มีค่าเก่า — ถ้า updateTag ไม่ทำงาน จะเห็นค่านี้ค้าง)
    expect(await shopPrice(page, code)).toContain("฿480");
    await page.goto("/");
    const card = page.locator("article", { hasText: TITLE.edit });
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("฿480");

    await loginOwner(page);
    await page.getByTestId("nav-items").click();
    await expect(page).toHaveURL(/\/admin\/items$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("สินค้า");
    await expect(row(page, code)).toContainText("฿480");
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: "test-results/shots/admin-items-375.png", fullPage: true });

    await openEdit(page, code);
    await expect(page.getByTestId("item-code")).toHaveText(code);
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: "test-results/shots/admin-item-edit-375.png", fullPage: true });

    // --- ราคาไม่ถูกต้อง → ข้อความไทยใต้ช่อง และข้อมูลจริงไม่เปลี่ยน
    for (const bad of ["0", "-5", "12.5", "abc", ""]) {
      await page.locator("#f-price").fill(bad);
      await page.getByTestId("item-save").click();
      await expect(page.getByTestId("error-price"), `price=${bad}`).toBeVisible();
      await expect(page.getByTestId("error-price")).toContainText("ราคา");
    }
    await page.locator("#f-price").fill("520");
    await page.locator("#f-flaws").fill("   ");
    await page.getByTestId("item-save").click();
    await expect(page.getByTestId("error-flaws")).toContainText("ตำหนิ");
    await expect(page.getByTestId("error-price")).toHaveCount(0);
    // ข้อมูลที่พิมพ์ไว้ไม่หายหลัง server ตอบ error
    await expect(page.locator("#f-price")).toHaveValue("520");

    expect(await shopPrice(page, code)).toContain("฿480"); // ยังเป็นราคาเดิม (ไม่มีอะไรถูกบันทึก)

    // --- บันทึกจริง
    await openEdit(page, code);
    await page.locator("#f-price").fill("520");
    await page.locator("#f-title").fill(`${TITLE.edit} (แก้แล้ว)`);
    await page.getByTestId("item-save").click();
    await expect(page.getByTestId("item-form-success")).toHaveText("บันทึกสินค้าแล้ว");

    // หน้าสินค้าเปลี่ยนทันที: ราคาใหม่/ชื่อใหม่ และไม่มีราคาเดิม
    const itemText = await shopPrice(page, code);
    expect(itemText).toContain("฿520");
    expect(itemText).not.toContain("฿480");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("(แก้แล้ว)");

    await page.goto("/");
    const card2 = page.locator("article", { hasText: `${TITLE.edit} (แก้แล้ว)` });
    await expect(card2).toHaveCount(1);
    await expect(card2).toContainText("฿520");
    await expect(card2).not.toContainText("฿480");
  });

  test("เปลี่ยนสถานะเร็ว: ซ่อน → หายจากหน้าร้าน (หน้าสินค้า 404 ใน UI), ว่าง → กลับมา", async ({ page }) => {
    const code = E2E_CODES.itemStatus;
    await loginOwner(page);
    await page.goto("/admin/items");
    const r = row(page, code);
    await expect(r).toHaveAttribute("data-status", "available");

    await r.getByTestId("item-status-select").selectOption("hidden");
    await r.getByRole("button", { name: "บันทึก" }).click();
    await expect(r.getByTestId("item-status-ok")).toHaveText("เปลี่ยนสถานะแล้ว");
    await expect(r).toHaveAttribute("data-status", "hidden");

    await page.goto("/");
    await expect(page.locator("article", { hasText: TITLE.status })).toHaveCount(0);
    await page.goto(`/item/${code}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("ไม่มีอะไร");

    await page.goto("/admin/items");
    await row(page, code).getByTestId("item-status-select").selectOption("available");
    await row(page, code).getByRole("button", { name: "บันทึก" }).click();
    await expect(row(page, code)).toHaveAttribute("data-status", "available");
    await page.goto("/");
    await expect(page.locator("article", { hasText: TITLE.status })).toHaveCount(1);
  });

  test("สินค้าที่มีออเดอร์ถืออยู่: เปลี่ยนสถานะไม่ได้ (ไม่มีตัวเลือก) แต่แก้ราคาได้และสถานะยัง reserved", async ({
    page,
    request,
  }) => {
    const code = E2E_CODES.itemHeld;
    const created = await request.post("/api/orders", {
      headers: { "x-forwarded-for": randomIp() },
      data: { code, customerName: "ตัวอย่าง ทดสอบ", phone: "0812345678", deliveryMethod: "pickup" },
    });
    expect(created.status()).toBe(201);

    await loginOwner(page);
    await page.goto("/admin/items");
    const r = row(page, code);
    await expect(r).toHaveAttribute("data-status", "reserved");
    await expect(r.getByTestId("item-held")).toContainText("เปลี่ยนสถานะไม่ได้");
    await expect(r.getByTestId("item-status-select")).toHaveCount(0);
    await expect(r).toContainText("ออเดอร์ 1");

    await openEdit(page, code);
    await expect(page.getByTestId("item-held-note")).toBeVisible();
    await expect(page.locator("#f-status")).toHaveCount(0);
    await page.locator("#f-price").fill("777");
    await page.getByTestId("item-save").click();
    await expect(page.getByTestId("item-form-success")).toBeVisible();

    await page.goto("/admin/items");
    await expect(row(page, code)).toContainText("฿777");
    await expect(row(page, code)).toHaveAttribute("data-status", "reserved");
    // ลบไม่ได้ (มีประวัติออเดอร์): หน้าแก้แสดงเหตุผลและไม่มีฟอร์มลบ
    await openEdit(page, code);
    await expect(page.getByTestId("delete-blocked-note")).toContainText("ลบไม่ได้");
    // หน้าร้านยังเป็น "มีคนจองอยู่" (ไม่ถูกเปลี่ยนเป็นอย่างอื่น)
    await page.goto(`/item/${code}`);
    await expect(page.locator("body")).toContainText("฿777");
  });

  test("owner ผ่านด่านสิทธิ์/Origin ของ API อัปโหลดรูป (ไปหยุดที่ Blob ที่ยังไม่ตั้งค่า = 503) และ Origin ไม่ตรง = 403", async ({
    page,
  }) => {
    await loginOwner(page);
    const body = {
      type: "blob.generate-client-token",
      payload: { pathname: "items/up-12345678.jpg", clientPayload: null, multipart: false },
    };
    const ok = await page.request.post("/api/admin/item-images/upload", { headers: { origin: ORIGIN }, data: body });
    expect(ok.status()).toBe(503);
    expect(((await ok.json()) as { error: string }).error).toContain("Vercel Blob");

    const evil = await page.request.post("/api/admin/item-images/upload", {
      headers: { origin: "https://evil.example" },
      data: body,
    });
    expect(evil.status()).toBe(403);
    const noOrigin = await page.request.post("/api/admin/item-images/upload", { data: body });
    expect(noOrigin.status()).toBe(403);
  });
});

test.describe("demo ดูสินค้าได้อย่างเดียว (375x812)", () => {
  test("ตารางสินค้า: ไม่มีปุ่มเพิ่ม/ตัวเลือกสถานะ; หน้าแก้: ช่องถูกล็อก ไม่มีอัปโหลด/ลบรูป/ลบสินค้า", async ({ page }) => {
    await loginDemo(page);
    await page.getByTestId("nav-items").click();
    await expect(page.getByTestId("items-readonly-note")).toBeVisible();
    await expect(page.getByRole("link", { name: "เพิ่มสินค้า" })).toHaveCount(0);
    await expect(page.getByTestId("item-status-select")).toHaveCount(0);
    await expect(row(page, E2E_CODES.itemDemo)).toContainText("฿510");
    await expectNoHorizontalScroll(page);

    await openEdit(page, E2E_CODES.itemDemo);
    await expect(page.getByTestId("item-readonly-note")).toBeVisible();
    await expect(page.locator("#f-price")).toBeDisabled();
    await expect(page.locator("#f-title")).toBeDisabled();
    await expect(page.getByTestId("item-save")).toBeDisabled();
    await expect(page.locator('input[type="file"]')).toHaveCount(0);
    await expect(page.getByTestId("upload-denied-note")).toBeVisible();
    await expect(page.getByRole("button", { name: /ลบรูป/ })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "ลบสินค้า" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "ลบสินค้า" })).toHaveCount(0);
    await expectNoHorizontalScroll(page);

    await page.goto("/admin/items/new");
    await expect(page.getByTestId("item-readonly-note")).toBeVisible();
    await expect(page.getByTestId("item-save")).toBeDisabled();
  });

  test("ปลดล็อกฟอร์มด้วย devtools แล้วส่ง → server ปฏิเสธ (ไม่มีสิทธิ์) และราคาบนหน้าร้านไม่เปลี่ยน", async ({ page }) => {
    const code = E2E_CODES.itemDemo;
    await loginDemo(page);
    await openEdit(page, code);

    await page.evaluate(() => {
      document
        .querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement | HTMLSelectElement>(
          "[data-testid=item-form] input, [data-testid=item-form] textarea, [data-testid=item-form] select, [data-testid=item-form] button",
        )
        .forEach((el) => el.removeAttribute("disabled"));
    });
    await page.locator("#f-price").fill("1");
    await page.locator("#f-title").fill("ถูกแก้โดยคนแปลกหน้า");
    await page.getByTestId("item-save").click();
    await expect(page.getByTestId("item-form-error")).toContainText("ไม่มีสิทธิ์");
    await expect(page.getByTestId("item-form-success")).toHaveCount(0);

    const text = await shopPrice(page, code);
    expect(text).toContain("฿510");
    expect(text).not.toContain("ถูกแก้โดยคนแปลกหน้า");
    await expect(page.getByRole("heading", { level: 1 })).toContainText(TITLE.demo);
  });

  test("API อัปโหลดรูป: demo ได้ 403 (ไม่ใช่ 503/200) แม้ Origin ถูกต้อง", async ({ page }) => {
    await loginDemo(page);
    const res = await page.request.post("/api/admin/item-images/upload", {
      headers: { origin: ORIGIN },
      data: {
        type: "blob.generate-client-token",
        payload: { pathname: "items/up-12345678.jpg", clientPayload: null, multipart: false },
      },
    });
    expect(res.status()).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("โหมดเดโม");
  });
});
