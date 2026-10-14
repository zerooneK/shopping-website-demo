import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getDb } from "./client";
import { parseSeedItems, type SeedItem } from "./seed-schema";
import { orderEvents, orders, items } from "./schema";

export type { SeedItem };

export function loadSeedItems(
  path = resolve(process.cwd(), "db", "seed-data.json"),
): SeedItem[] {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  return parseSeedItems(raw);
}

/** ล้างออเดอร์และสินค้าทั้งหมด แล้ว seed ใหม่ (ใช้เฉพาะ dev: npm run db:seed — cron รายวันใช้ lib/cron/reset.ts ที่มี advisory lock) */
export async function seedDatabase(seedItems = loadSeedItems()) {
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.delete(orderEvents);
    await tx.delete(orders);
    await tx.delete(items);
    if (seedItems.length > 0) {
      await tx.insert(items).values(
        seedItems.map((i) => ({ ...i, status: "available" as const })),
      );
    }
  });
  return seedItems.length;
}

// รันโดยตรง: npm run db:seed
if (process.argv[1] && /seed\.ts$/.test(process.argv[1])) {
  seedDatabase()
    .then((n) => {
      console.log(`seeded ${n} items`);
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
