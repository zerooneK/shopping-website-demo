import { randomBytes } from "node:crypto";
import { defineConfig } from "@playwright/test";

/**
 * e2e ที่ viewport มือถือ 375x812 — ใช้ Google Chrome ที่ติดตั้งในเครื่อง (channel: "chrome")
 * ห้ามรัน `playwright install` (ไม่ดาวน์โหลดเบราว์เซอร์); ถ้าไม่พบ Chrome เทสต์จะล้มพร้อมข้อความแจ้ง
 *
 * เซิร์ฟเวอร์: tests/e2e/serve.ts สร้างสินค้า fixture (T981-T987) → next build → next start (พอร์ต 3100)
 *  - ต้อง build หลังสร้าง fixture เพราะรายการสินค้าหน้าแรกถูก cache ตอน build
 *  - E2E_SKIP_BUILD=1 ข้ามขั้น build (ใช้ .next เดิม) เพื่อรันซ้ำเร็วขึ้น
 * ข้อมูลทดสอบถูกลบใน globalTeardown (เฉพาะแถวของตัวเอง)
 */
const PORT = 3100;

/**
 * เซิร์ฟเวอร์ e2e รันด้วย `next start` (NODE_ENV=production) ซึ่ง POST /api/orders ต้องมี SESSION_SECRET (fail-closed)
 * จึงสร้างค่าสุ่มต่อการรันที่นี่: ไม่ hardcode, ไม่เขียนลงดิสก์ และไม่อ่าน/แสดงค่าใน .env.local
 * (env ที่ส่งให้ webServer ทับค่าจาก --env-file เสมอ)
 */
const E2E_SESSION_SECRET = randomBytes(32).toString("hex");

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  outputDir: "test-results",
  globalSetup: "./tests/e2e/global-setup.ts",
  globalTeardown: "./tests/e2e/global-teardown.ts",
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: "chrome",
    viewport: { width: 375, height: 812 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
    locale: "th-TH",
    screenshot: "only-on-failure",
    trace: "off",
  },
  webServer: {
    command: "npx tsx --env-file=.env.local tests/e2e/serve.ts",
    url: `http://localhost:${PORT}`,
    timeout: 5 * 60_000,
    reuseExistingServer: false,
    stdout: "ignore",
    stderr: "pipe",
    env: { PORT: String(PORT), SESSION_SECRET: E2E_SESSION_SECRET },
  },
});
