import { eq, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { items, orders } from "../../db/schema";
import type { ItemImage, ItemStatus } from "../../db/schema";
import { holdingOrderExistsSql } from "../availability";
import type { SettableStatus } from "./item-validation";

/**
 * คำสั่งจัดการสินค้าหลังบ้าน (เขียน DB) — ผู้เรียก (server action) ต้องตรวจ Origin/session/สิทธิ์/Zod ก่อนเสมอ
 *
 * กฎความถูกต้อง (บังคับที่นี่ ไม่พึ่ง UI):
 *  - ทุกคำสั่งที่แตะแถวสินค้าที่มีอยู่ทำใน transaction เดียว และ "ล็อกแถวสินค้า" (SELECT ... FOR UPDATE) เป็นอย่างแรก
 *    ระบบจอง (claimItem) ก็ล็อกแถวเดียวกันตอนจองและสร้างออเดอร์ใน tx เดียว → ถ้าลูกค้าจองพร้อมกัน เราจะรอให้ tx นั้น commit
 *    แล้วค่อยอ่านสถานะ/ออเดอร์ด้วย statement ใหม่ (READ COMMITTED เห็นออเดอร์ที่เพิ่ง commit) จึงไม่มีช่องให้เขียนทับสถานะที่ออเดอร์ถืออยู่
 *    (ไม่ใช้ UPDATE ... WHERE NOT EXISTS ครั้งเดียว เพราะ subquery ไม่ถูกประเมินใหม่ด้วย snapshot ใหม่หลังรอล็อก)
 *  - สินค้าที่ "มีออเดอร์ถืออยู่" (holdingOrderExistsSql นิยามเดียวกับระบบจอง) เปลี่ยนสถานะไม่ได้ — ต้องไปจัดการที่ออเดอร์
 *    (ยืนยัน/ปฏิเสธ) ก่อน; แก้ข้อความ/ราคา/รูปได้ (ออเดอร์เก็บราคา snapshot แล้ว)
 *  - สินค้าที่ไม่ใช่ hidden ต้องมีรูปอย่างน้อย 1 รูป (หน้าร้านแสดงรูปแรกเสมอ); ฉบับร่าง (hidden) ไม่มีรูปได้
 *  - ลบสินค้าไม่ได้ถ้ามีออเดอร์ (แม้ปิดแล้ว) เพื่อไม่ให้ประวัติหาย — เหลือทางซ่อน (hidden)
 *  - เวลาใช้ now() ของ DB เท่านั้น
 */

export type ItemFields = {
  title: string;
  description: string;
  flaws: string;
  condition: "like_new" | "good" | "fair";
  category: "fashion" | "books" | "home" | "tech" | "other";
  price: number;
  sortOrder: number;
};

export type ItemCommandError =
  | "not_found"
  | "code_taken"
  /** มีออเดอร์ถือสินค้าอยู่ — เปลี่ยนสถานะไม่ได้ */
  | "item_held"
  | "images_required"
  | "has_orders";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

type LiveItem = {
  stored: ItemStatus;
  held: boolean;
  images: ItemImage[];
};

async function lockAndRead(tx: Tx, id: number): Promise<LiveItem | null> {
  const locked = await tx.select({ id: items.id }).from(items).where(eq(items.id, id)).for("update");
  if (locked.length === 0) return null;
  // statement ใหม่หลังได้ล็อก: เห็นออเดอร์ที่ tx จองเพิ่ง commit
  const [row] = await tx
    .select({
      stored: items.status,
      images: items.images,
      held: sql<boolean>`${holdingOrderExistsSql(sql`items.id`)}`,
    })
    .from(items)
    .where(eq(items.id, id));
  return row ?? null;
}

/**
 * สถานะ "ตามจริง" ที่ใช้เทียบกับสถานะเป้าหมาย: reserved ที่ไม่มีออเดอร์ถือแล้ว = available (lazy expiry เหมือนหน้าร้าน/claimItem)
 */
function currentStatus(live: LiveItem): ItemStatus {
  return live.stored === "reserved" && !live.held ? "available" : live.stored;
}

export type UpdateItemResult =
  | { ok: true; statusChanged: boolean; removedImages: ItemImage[] }
  | { ok: false; error: ItemCommandError };

export async function updateItem(
  db: Db,
  input: { id: number; fields: ItemFields; images: ItemImage[]; status?: SettableStatus },
): Promise<UpdateItemResult> {
  return db.transaction(async (tx) => {
    const live = await lockAndRead(tx, input.id);
    if (!live) return { ok: false, error: "not_found" } as const;

    const current = currentStatus(live);
    const changing = input.status !== undefined && input.status !== current;
    if (changing && live.held) return { ok: false, error: "item_held" } as const;

    const finalStatus: ItemStatus = changing ? input.status! : current;
    if (finalStatus !== "hidden" && input.images.length === 0) {
      return { ok: false, error: "images_required" } as const;
    }

    await tx
      .update(items)
      .set({
        ...input.fields,
        images: input.images,
        ...(changing ? { status: input.status!, reservedUntil: null } : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(items.id, input.id));

    const keep = new Set(input.images.map((i) => i.url));
    return {
      ok: true,
      statusChanged: changing,
      removedImages: live.images.filter((i) => !keep.has(i.url)),
    } as const;
  });
}

export type ChangeStatusResult =
  | { ok: true; changed: boolean }
  | { ok: false; error: ItemCommandError };

/** เปลี่ยนสถานะเร็วจากตารางสินค้า */
export async function changeItemStatus(
  db: Db,
  input: { id: number; status: SettableStatus },
): Promise<ChangeStatusResult> {
  return db.transaction(async (tx) => {
    const live = await lockAndRead(tx, input.id);
    if (!live) return { ok: false, error: "not_found" } as const;

    const current = currentStatus(live);
    if (input.status === current) return { ok: true, changed: false } as const;
    if (live.held) return { ok: false, error: "item_held" } as const;
    if (input.status !== "hidden" && live.images.length === 0) {
      return { ok: false, error: "images_required" } as const;
    }

    await tx
      .update(items)
      .set({ status: input.status, reservedUntil: null, updatedAt: sql`now()` })
      .where(eq(items.id, input.id));
    return { ok: true, changed: true } as const;
  });
}

export type CreateItemResult =
  | { ok: true; id: number }
  | { ok: false; error: ItemCommandError };

export async function createItem(
  db: Db,
  input: { code: string; fields: ItemFields; images: ItemImage[]; status: "available" | "hidden" },
): Promise<CreateItemResult> {
  if (input.status !== "hidden" && input.images.length === 0) {
    return { ok: false, error: "images_required" };
  }
  const rows = await db
    .insert(items)
    .values({
      code: input.code,
      ...input.fields,
      images: input.images,
      status: input.status,
    })
    .onConflictDoNothing({ target: items.code })
    .returning({ id: items.id });
  if (rows.length === 0) return { ok: false, error: "code_taken" };
  return { ok: true, id: rows[0].id };
}

export type DeleteItemResult =
  | { ok: true; images: ItemImage[] }
  | { ok: false; error: ItemCommandError };

export async function deleteItem(db: Db, input: { id: number }): Promise<DeleteItemResult> {
  return db.transaction(async (tx) => {
    const live = await lockAndRead(tx, input.id);
    if (!live) return { ok: false, error: "not_found" } as const;

    const [{ n }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(orders)
      .where(eq(orders.itemId, input.id));
    if (n > 0) return { ok: false, error: "has_orders" } as const;

    await tx.delete(items).where(eq(items.id, input.id));
    return { ok: true, images: live.images } as const;
  });
}
