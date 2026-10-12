import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { getDb } from "./client";
import { orderEvents, orders, items } from "./schema";

const seedItemSchema = z.object({
  code: z.string().regex(/^[A-Z]\d{3}$/),
  title: z.string().min(1),
  description: z.string().min(1),
  flaws: z.string().min(1, "ตำหนิห้ามว่าง"),
  condition: z.enum(["like_new", "good", "fair"]),
  category: z.enum(["fashion", "books", "home", "tech", "other"]),
  price: z.number().int().positive(),
  images: z
    .array(
      z.object({
        url: z.string().url(),
        alt: z.string().min(1),
        credit: z.object({ name: z.string(), url: z.string().url() }).optional(),
      }),
    )
    .min(1),
  sortOrder: z.number().int().default(0),
});

export type SeedItem = z.infer<typeof seedItemSchema>;

export function loadSeedItems(
  path = resolve(process.cwd(), "db", "seed-data.json"),
): SeedItem[] {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  return z.array(seedItemSchema).parse(raw);
}

/** ล้างออเดอร์และสินค้าทั้งหมด แล้ว seed ใหม่ (ใช้ซ้ำใน cron reset ภายหลัง) */
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
