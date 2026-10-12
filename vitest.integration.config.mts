import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// โปรเจกต์แยกสำหรับ integration test ที่ต่อ Postgres (Neon) จริง — ไม่รวมใน `npm test`
// รันด้วย `npm run test:integration` (โหลด .env.local ผ่าน node --env-file)
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
