import { z } from "zod";

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

/** ตรวจรูปแบบข้อมูล seed (ใช้ซ้ำใน cron reset ที่ import seed-data.json เข้า bundle ตรงๆ) */
export function parseSeedItems(raw: unknown): SeedItem[] {
  return z.array(seedItemSchema).parse(raw);
}
