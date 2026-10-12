import { spawn, spawnSync } from "node:child_process";
import { createFixtures } from "./fixtures";

/**
 * เซิร์ฟเวอร์สำหรับ e2e (เรียกจาก playwright.config.ts → webServer.command)
 * 1) สร้างสินค้า fixture T981-T987  2) next build (หน้าแรกจะ cache รายการสินค้ารวม fixture)  3) next start
 * ไม่พิมพ์ค่า env ใดๆ
 */
const port = process.env.PORT ?? "3100";
const nextBin = "node_modules/next/dist/bin/next";
const env = { ...process.env, NODE_ENV: "production" as const };

async function main() {
  await createFixtures();

  if (process.env.E2E_SKIP_BUILD !== "1") {
    const build = spawnSync(process.execPath, [nextBin, "build"], { stdio: "inherit", env });
    if (build.status !== 0) {
      console.error("next build failed");
      process.exit(build.status ?? 1);
    }
  }

  const server = spawn(process.execPath, [nextBin, "start", "-p", port], { stdio: "inherit", env });
  const stop = () => server.kill();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  server.on("exit", (code) => process.exit(code ?? 0));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.name : "error");
  process.exit(1);
});
