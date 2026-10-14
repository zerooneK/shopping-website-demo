import { inArray, notInArray, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { items, orderEvents, orders } from "../../db/schema";
import type { SeedItem } from "../../db/seed-schema";

/**
 * รีเซ็ตร้านเดโมกลับสู่สถานะ seed (SPEC §7 "Daily reset") — ส่วน DB ทั้งหมดอยู่ใน transaction เดียว
 *
 * นโยบาย (ตัดสินใจแล้ว): รีเซ็ต "ทั้งร้าน" เป็นข้อมูล seed
 *  - ลบ order_events + orders ทุกแถว (รวม client_ip_hash / demo_session_id ที่อยู่ในแถวนั้น → ข้อมูลผู้สั่งหายหมด
 *    และเพดาน rate limit ต่อ IP/เซสชันเริ่มนับใหม่)
 *  - สินค้า: upsert ตาม code จาก seed ทุกชิ้น (คืน title/ราคา/รูป/สถานะ available/reserved_until NULL — id คงเดิม)
 *    และ "ลบสินค้าที่ไม่อยู่ใน seed" ด้วย (รวมสินค้าที่เจ้าของเพิ่มเองผ่านหลังบ้าน) เพราะนี่คือร้านเดโมที่เนื้อหาร้านต้อง
 *    กลับมาเป็นแบบที่ออกแบบไว้ทุกวัน — เจ้าของที่อยากเก็บสินค้าถาวรต้องเพิ่มใน db/seed-data.json
 *    (ข้อควรระวัง: ไฟล์รูปที่อัปโหลดไว้ใต้ items/ ของสินค้าที่ถูกลบจะกลายเป็นไฟล์กำพร้าใน Blob — cron ไม่ลบ items/ โดยเจตนา)
 *  - สุ่ม 2–3 ชิ้นเป็น sold ให้ร้านดูมีชีวิต (อย่างน้อย 1 ชิ้นยังว่างเสมอ)
 *
 * ความปลอดภัยเมื่อรันซ้ำ/พร้อมกัน:
 *  - pg_try_advisory_xact_lock: ถ้ามีรอบอื่นกำลังรันอยู่ รอบนี้ "ข้าม" (skipped_locked) ไม่รอและไม่ทำซ้ำซ้อน; ล็อกปล่อยเองเมื่อ tx จบ
 *  - ผลลัพธ์ไม่ขึ้นกับจำนวนครั้งที่รัน (idempotent): รันซ้ำได้สถานะ seed เหมือนเดิม (ต่างกันแค่ชิ้นที่สุ่มเป็น sold)
 *  - ผู้ชมไม่เห็นสถานะครึ่งๆ กลางๆ เพราะทุกอย่างอยู่ใน tx เดียว
 *
 * ฟังก์ชันรับ `db` เป็นพารามิเตอร์ จึงทดสอบกับ schema แยกใน Neon ได้โดยไม่แตะตารางจริง (ดู tests/integration/cron-reset.pg.test.ts)
 */

/** กุญแจ advisory lock ของงานรีเซ็ต */
export const RESET_LOCK_KEY = 7_301_001;

/** รอล็อกตารางสูงสุดเท่านี้ (maxDuration ของ route = 60 วินาที) */
export const RESET_LOCK_TIMEOUT_MS = 15_000;

export const SOLD_MIN = 2;
export const SOLD_MAX = 3;

export type ResetRan = {
  status: "ran";
  /** now() ของ DB ตอนเริ่มรีเซ็ต — ใช้เป็นเส้นแบ่งเวลาของการลบสลิปใน Blob */
  dbNow: Date;
  ordersDeleted: number;
  eventsDeleted: number;
  itemsUpserted: number;
  itemsRemoved: number;
  soldCodes: string[];
};
export type ResetResult = { status: "skipped_locked" } | ResetRan;

/** สุ่ม 2–3 รหัส (ไม่ซ้ำ) แต่ไม่เกิน n-1 เพื่อให้เหลือของว่างอย่างน้อย 1 ชิ้น */
export function pickSoldCodes(codes: readonly string[], random: () => number = Math.random): string[] {
  if (codes.length <= 1) return [];
  const want = SOLD_MIN + Math.floor(random() * (SOLD_MAX - SOLD_MIN + 1));
  const n = Math.min(want, codes.length - 1);
  const pool = [...codes];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

export async function resetDemoData(
  db: Db,
  opts: { seedItems: readonly SeedItem[]; random?: () => number; lockTimeoutMs?: number },
): Promise<ResetResult> {
  if (opts.seedItems.length === 0) {
    // ป้องกันความผิดพลาด: seed ว่างจะลบสินค้าทั้งร้าน
    throw new Error("seed items are empty; refusing to reset");
  }
  const seedCodes = opts.seedItems.map((i) => i.code);

  return db.transaction(async (tx): Promise<ResetResult> => {
    const lock = await tx.execute(
      sql`SELECT pg_try_advisory_xact_lock(${RESET_LOCK_KEY}::bigint) AS locked`,
    );
    const locked = (lock.rows as { locked: boolean }[])[0]?.locked === true;
    if (!locked) return { status: "skipped_locked" };

    // รอ transaction ที่ค้างอยู่ (เช่น reserve ที่ insert ออเดอร์แล้วยังไม่ commit) ให้จบก่อน แล้วค่อยลบ
    // ปัญหาเดิม: READ COMMITTED — DELETE orders มองไม่เห็นแถวที่ยังไม่ commit จึงลบไม่ได้ แต่ upsert สินค้าไปรอแถวที่ reserve
    // ล็อกไว้ แล้วทับเป็น available → ออเดอร์นั้นถือสินค้าที่ว่าง (ขายซ้ำได้) และ DELETE สินค้านอก seed ชน FK ทำให้ rollback ทั้งรอบ
    // วิธีแก้: ล็อกตารางโหมด EXCLUSIVE (ชนกับ ROW EXCLUSIVE ของ INSERT/UPDATE และ ROW SHARE ของ SELECT ... FOR UPDATE;
    // อ่านธรรมดายังได้ หน้าร้านไม่สะดุด) เมื่อได้ล็อกแล้ว statement ถัดไปเห็นข้อมูลที่ commit ครบ
    //  - เลือก EXCLUSIVE แทน SHARE ROW EXCLUSIVE: SELECT ... FOR UPDATE (item-commands) เป็น ROW SHARE ซึ่งโหมดหลังไม่ชน →
    //    คำสั่งนั้นถือล็อกแถวสินค้าแล้วไปรอล็อกตารางที่เราถือ ขณะเราไปรอล็อกแถวเดียวกัน = deadlock
    //  - ลำดับ orders → items → order_events ตรงกับ reserve (UPDATE orders ก่อน แล้ว items แล้ว events) ลดโอกาสวงรอ
    //  - lock_timeout: ไม่แขวนเกินกำหนด (ล้ม = throw → 500 ทั้ง tx rollback, ข้อมูลไม่เปลี่ยน, รอบวันถัดไปทำใหม่) ปล่อยเองเมื่อ tx จบ
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${Math.trunc(opts.lockTimeoutMs ?? RESET_LOCK_TIMEOUT_MS)}ms'`));
    await tx.execute(sql`LOCK TABLE ${orders}, ${items}, ${orderEvents} IN EXCLUSIVE MODE`);

    const nowRows = await tx.execute(sql`SELECT now() AS now`);
    const dbNow = new Date((nowRows.rows as { now: string | Date }[])[0].now);

    const events = await tx.delete(orderEvents).returning({ id: orderEvents.id });
    const removedOrders = await tx.delete(orders).returning({ id: orders.id });
    const removedItems = await tx
      .delete(items)
      .where(notInArray(items.code, seedCodes))
      .returning({ id: items.id });

    await tx
      .insert(items)
      .values(opts.seedItems.map((i) => ({ ...i, status: "available" as const, reservedUntil: null })))
      .onConflictDoUpdate({
        target: items.code,
        set: {
          title: sql`excluded.title`,
          description: sql`excluded.description`,
          flaws: sql`excluded.flaws`,
          condition: sql`excluded.condition`,
          category: sql`excluded.category`,
          price: sql`excluded.price`,
          images: sql`excluded.images`,
          sortOrder: sql`excluded.sort_order`,
          status: sql`'available'`,
          reservedUntil: sql`NULL`,
          updatedAt: sql`now()`,
        },
      });

    const soldCodes = pickSoldCodes(seedCodes, opts.random);
    if (soldCodes.length > 0) {
      await tx
        .update(items)
        .set({ status: "sold", reservedUntil: null, updatedAt: sql`now()` })
        .where(inArray(items.code, soldCodes));
    }

    return {
      status: "ran",
      dbNow,
      ordersDeleted: removedOrders.length,
      eventsDeleted: events.length,
      itemsUpserted: opts.seedItems.length,
      itemsRemoved: removedItems.length,
      soldCodes,
    };
  });
}
