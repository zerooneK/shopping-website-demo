import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import * as schema from "./schema";

// ใช้ driver แบบ Pool (WebSocket) เพราะต้องการ interactive transaction
// สำหรับ "จอง + สร้างออเดอร์" ใน transaction เดียว (SPEC §5 กฎข้อ 1)
// สร้างแบบ lazy เพื่อให้ build ผ่านได้โดยไม่ต้องมี DATABASE_URL

let _db: ReturnType<typeof createDb> | undefined;

function createDb() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set (ดู .env.example)");
  }
  const pool = new Pool({ connectionString: url });
  return drizzle(pool, { schema });
}

export function getDb() {
  _db ??= createDb();
  return _db;
}

export type Db = ReturnType<typeof getDb>;
export { schema };
