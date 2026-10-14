import "server-only";
import { asc, eq, sql } from "drizzle-orm";
import { getDb } from "../../db/client";
import { items } from "../../db/schema";
import type { ItemImage } from "../../db/schema";
import { holdingOrderExistsSql } from "../availability";

/**
 * Data layer ของหน้าจัดการสินค้า (อ่านอย่างเดียว) — ผู้เรียกต้องผ่าน requireSession() แล้ว
 * ทุกบทบาทที่ล็อกอินอ่านข้อมูลสินค้าได้ (ไม่มี PII ในตารางสินค้า)
 * เวลา/สถานะตัดสินด้วย now() ของ DB: reserved ที่ไม่มีออเดอร์ถือ = available (เหมือนหน้าร้าน)
 */

export type AdminItemStatus = "available" | "reserved" | "sold" | "hidden";

export type AdminItemRow = {
  id: number;
  code: string;
  title: string;
  price: number;
  sortOrder: number;
  imageCount: number;
  firstImage: ItemImage | null;
  /** สถานะที่มีผลจริง (reserved ที่ไม่มีผู้ถือ = available) */
  status: AdminItemStatus;
  /** มีออเดอร์ถือสินค้าอยู่ → เปลี่ยนสถานะไม่ได้ */
  held: boolean;
  orderCount: number;
};

export async function listAdminItems(): Promise<AdminItemRow[]> {
  const rows = await getDb()
    .select({
      id: items.id,
      code: items.code,
      title: items.title,
      price: items.price,
      sortOrder: items.sortOrder,
      images: items.images,
      stored: items.status,
      held: sql<boolean>`${holdingOrderExistsSql(sql`items.id`)}`,
      orderCount: sql<number>`(SELECT count(*)::int FROM orders oc WHERE oc.item_id = items.id)`,
    })
    .from(items)
    .orderBy(asc(items.sortOrder), asc(items.code));

  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    title: r.title,
    price: r.price,
    sortOrder: r.sortOrder,
    imageCount: r.images.length,
    firstImage: r.images[0] ?? null,
    status: r.stored === "reserved" && !r.held ? "available" : r.stored,
    held: r.held,
    orderCount: r.orderCount,
  }));
}

export type AdminItemDetail = AdminItemRow & {
  description: string;
  flaws: string;
  condition: "like_new" | "good" | "fair";
  category: "fashion" | "books" | "home" | "tech" | "other";
  images: ItemImage[];
};

export async function getAdminItem(id: number): Promise<AdminItemDetail | null> {
  const [r] = await getDb()
    .select({
      id: items.id,
      code: items.code,
      title: items.title,
      description: items.description,
      flaws: items.flaws,
      condition: items.condition,
      category: items.category,
      price: items.price,
      sortOrder: items.sortOrder,
      images: items.images,
      stored: items.status,
      held: sql<boolean>`${holdingOrderExistsSql(sql`items.id`)}`,
      orderCount: sql<number>`(SELECT count(*)::int FROM orders oc WHERE oc.item_id = items.id)`,
    })
    .from(items)
    .where(eq(items.id, id));
  if (!r) return null;
  return {
    id: r.id,
    code: r.code,
    title: r.title,
    description: r.description,
    flaws: r.flaws,
    condition: r.condition,
    category: r.category,
    price: r.price,
    sortOrder: r.sortOrder,
    images: r.images,
    imageCount: r.images.length,
    firstImage: r.images[0] ?? null,
    status: r.stored === "reserved" && !r.held ? "available" : r.stored,
    held: r.held,
    orderCount: r.orderCount,
  };
}
