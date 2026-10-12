import "server-only";
import { asc, sql } from "drizzle-orm";
import { cacheLife, cacheTag } from "next/cache";
import { connection } from "next/server";
import { getDb } from "../db/client";
import { items } from "../db/schema";
import type { ItemImage } from "../db/schema";
import { holdingOrderExistsSql, resolveDisplayStatus } from "./availability";
import type { DisplayStatus } from "./availability";
import type { ItemCategory, ItemCondition } from "./items-types";

/**
 * Data layer ของหน้าร้าน (อ่านอย่างเดียว) — กลยุทธ์ caching แบ่ง 2 ชั้น:
 *
 *  1) เนื้อหาที่เปลี่ยนไม่บ่อย (ชื่อ ราคา รูป ตำหนิ ฯลฯ) → `'use cache'` + cacheTag("items")
 *     cache นาน ~5 นาที; หลังบ้าน (ขั้น 3c) ต้องเรียก revalidateTag("items") หลังแก้สินค้า
 *     ใช้สร้าง static shell, generateMetadata และตัดสิน 404 ก่อน stream ได้
 *  2) สถานะ (available/reserved/sold) → ไม่ cache เลย อ่านสดจาก DB ทุก request
 *     (เรียก connection() ก่อน) เพราะต้องตรงกับระบบจอง; ห่อด้วย <Suspense> ที่หน้าเรียกใช้
 */


export type PublicItem = {
  code: string;
  title: string;
  description: string;
  flaws: string;
  condition: ItemCondition;
  category: ItemCategory;
  price: number;
  images: ItemImage[];
};

export type LiveStatus = {
  status: DisplayStatus;
  /** ISO string; ส่งเฉพาะเมื่อ reserved และยังนับเวลาอยู่ (ไม่ใช่รอตรวจสลิป) */
  reservedUntil: string | null;
};

export type ShopItem = PublicItem & LiveStatus;

/** รายการสินค้าที่ไม่ซ่อน เรียง sortOrder แล้วตามรหัส (cache) */
export async function getPublicItems(): Promise<PublicItem[]> {
  "use cache";
  cacheLife({ stale: 60, revalidate: 300, expire: 3600 });
  cacheTag("items");

  const rows = await getDb()
    .select({
      code: items.code,
      title: items.title,
      description: items.description,
      flaws: items.flaws,
      condition: items.condition,
      category: items.category,
      price: items.price,
      images: items.images,
    })
    .from(items)
    .where(sql`${items.status} <> 'hidden'`)
    .orderBy(asc(items.sortOrder), asc(items.code));
  return rows;
}

export async function getPublicItem(code: string): Promise<PublicItem | null> {
  const all = await getPublicItems();
  return all.find((i) => i.code === code) ?? null;
}

/** สถานะสดของทุกชิ้น (ไม่ cache) — key = code; ชิ้นที่ซ่อนอยู่จะไม่อยู่ใน map */
export async function getLiveStatuses(): Promise<Map<string, LiveStatus>> {
  await connection();
  const rows = await getDb()
    .select({
      code: items.code,
      status: items.status,
      reservedUntil: items.reservedUntil,
      // เทียบเวลาที่ DB (now()) ไม่ใช้ clock ของแอป ให้ตรงกับ claimItem
      lapsed: sql<boolean>`coalesce(${items.reservedUntil} < now(), false)`,
      held: sql<boolean>`${holdingOrderExistsSql(sql`${items.id}`)}`,
    })
    .from(items);

  const map = new Map<string, LiveStatus>();
  for (const r of rows) {
    const status = resolveDisplayStatus(r);
    if (!status) continue;
    map.set(r.code, {
      status,
      reservedUntil:
        status === "reserved" && r.reservedUntil && !r.lapsed
          ? r.reservedUntil.toISOString()
          : null,
    });
  }
  return map;
}

function merge(base: PublicItem[], live: Map<string, LiveStatus>): ShopItem[] {
  const out: ShopItem[] = [];
  for (const item of base) {
    const l = live.get(item.code);
    if (l) out.push({ ...item, ...l });
  }
  return out;
}

/** รายการสำหรับหน้าแรก (กรองหมวดได้) พร้อมสถานะสด */
export async function listItems(category?: ItemCategory): Promise<ShopItem[]> {
  const [base, live] = await Promise.all([getPublicItems(), getLiveStatuses()]);
  const filtered = category ? base.filter((i) => i.category === category) : base;
  return merge(filtered, live);
}

/** สินค้าชิ้นเดียวพร้อมสถานะสด (null = ไม่มี หรือถูกซ่อน) */
export async function getItemByCode(code: string): Promise<ShopItem | null> {
  const [base, live] = await Promise.all([getPublicItem(code), getLiveStatuses()]);
  if (!base) return null;
  const l = live.get(code);
  return l ? { ...base, ...l } : null;
}
