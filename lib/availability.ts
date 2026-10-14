import { sql, type SQL } from "drizzle-orm";

/**
 * นิยามเดียวของ "ใครถือสินค้าอยู่" — ทุกจุดที่ต้องรู้ว่าสินค้าว่างหรือไม่ใช้ไฟล์นี้ไฟล์เดียว:
 * claimItem (reserve.ts), หน้าร้าน (items.ts), คำสั่งสินค้าหลังบ้าน (item-commands.ts), หน้ารายการหลังบ้าน,
 * rate limit ต่อ IP (reserve.ts) และ view ของออเดอร์ (demoEndedSql)
 * ห้ามเขียนเงื่อนไขเหล่านี้ซ้ำที่อื่น — เวลาทั้งหมดใช้ now() ของ DB เท่านั้น
 */

/**
 * ออเดอร์เดโม (ยืนยันโดย role demo) คืนสินค้าเข้าร้านเองหลังยืนยันกี่นาที
 *
 * ทำไม: ปุ่ม "ลองหลังบ้านแบบเดโม" ทำให้ใครก็ยืนยันออเดอร์ตัวเองได้ ถ้าถือสินค้านั้นถาวรผู้ชมไม่กี่คนก็ทำให้ทั้งร้าน
 * "ขายแล้ว" ได้ และเจ้าของคืนของไม่ได้ จึงให้ออเดอร์ที่ demo ยืนยันถือสินค้าได้แค่ช่วงสั้นๆ
 * ออเดอร์ที่ owner ยืนยันไม่ถูกจำกัด (ขายถาวรตามเดิม)
 * (ค่าคงที่ตัวเลขล้วน ฝังเป็น literal ใน SQL ได้อย่างปลอดภัย และต้องเป็น literal เพื่อให้ใช้ใน GROUP BY ได้)
 */
export const DEMO_ORDER_RETURN_MINUTES = 20;

/** ชื่อ alias/ตารางที่อนุญาตให้ใช้อ้างคอลัมน์ orders ใน SQL ข้างล่าง (ค่าคงที่ภายในเท่านั้น ไม่รับจากผู้ใช้) */
export type OrdersRef = "o" | "orders";

/**
 * "เดโมสิ้นสุดแล้ว": ออเดอร์ที่ role demo ยืนยัน และผ่านไปเกิน DEMO_ORDER_RETURN_MINUTES นาทีตามเวลา DB
 * (strict: now() > confirmed_at + N เหมือนนิยามหมดอายุอื่นในระบบ) — เป็น false เสมอเมื่อ owner ยืนยัน/ไม่เคยยืนยัน
 * ผลเป็น boolean ไม่ใช่ NULL (COALESCE) จึง NOT ได้อย่างปลอดภัย
 */
export function demoEndedSql(ref: OrdersRef = "o"): SQL {
  const r = sql.raw(ref);
  const mins = sql.raw(String(DEMO_ORDER_RETURN_MINUTES));
  return sql`COALESCE(
    ${r}.confirmed_by_role = 'demo'
      AND ${r}.confirmed_at + make_interval(mins => ${mins}) < now(),
    false)`;
}

/** เวลาที่ออเดอร์เดโมจะคืนสินค้า (confirmed_at + N) — NULL ถ้าไม่ใช่ออเดอร์ที่ demo ยืนยัน */
export function demoReturnAtSql(ref: OrdersRef = "o"): SQL {
  const r = sql.raw(ref);
  const mins = sql.raw(String(DEMO_ORDER_RETURN_MINUTES));
  return sql`(CASE WHEN ${r}.confirmed_by_role = 'demo'
                   THEN ${r}.confirmed_at + make_interval(mins => ${mins}) END)`;
}

/** ออเดอร์ที่ผ่านการยืนยันแล้ว (ขายแล้ว หรือกำลังขาย) */
const CONFIRMED_STATUSES = sql`('confirmed', 'shipped', 'completed')`;

/**
 * ออเดอร์ที่ "ถือสินค้า" ตามกฎจอง:
 *  - awaiting_review (ไม่มีวันหมดอายุ จนกว่าร้านจะยืนยัน/ปฏิเสธ)
 *  - pending_payment ที่ expires_at >= now()
 *  - confirmed / shipped / completed ที่ "ไม่ใช่เดโมที่สิ้นสุดแล้ว" (owner ยืนยัน = ถือถาวร, demo ยืนยัน = ถือแค่ N นาที)
 */
function holdingOrderCondition(ref: OrdersRef = "o"): SQL {
  const r = sql.raw(ref);
  return sql`(${r}.status = 'awaiting_review'
           OR (${r}.status = 'pending_payment' AND ${r}.expires_at >= now())
           OR (${r}.status IN ${CONFIRMED_STATUSES} AND NOT ${demoEndedSql(ref)}))`;
}

/**
 * ออเดอร์ที่นับเข้า "ถือสินค้าต่อ IP" (rate limit): pending_payment ที่ยังไม่หมดเวลา + awaiting_review
 * + ออเดอร์ที่ demo ยืนยันและยังอยู่ในช่วงถือสินค้า (กันคนเดียวใช้ปุ่มเดโมกวาดสินค้า — ดูเหตุผลที่ DEMO_ORDER_RETURN_MINUTES)
 * ออเดอร์ที่ owner ยืนยันไม่นับ (ลูกค้าจริงซื้อหลายชิ้นได้ตามเดิม)
 */
export function ipHoldingOrderCondition(ref: OrdersRef = "o"): SQL {
  const r = sql.raw(ref);
  return sql`(${r}.status = 'awaiting_review'
           OR (${r}.status = 'pending_payment' AND ${r}.expires_at >= now())
           OR (${r}.status IN ${CONFIRMED_STATUSES}
               AND ${r}.confirmed_by_role = 'demo'
               AND NOT ${demoEndedSql(ref)}))`;
}

/**
 * "สินค้าชิ้นนี้ยังมีออเดอร์ถืออยู่หรือไม่" — ใช้ร่วมกันระหว่าง
 *  - claimItem ใน lib/reserve.ts (กฎจอง: NOT EXISTS)
 *  - lib/items.ts (ปรับสถานะที่แสดงบนหน้าร้านให้ตรงกับกฎจอง)
 *  - lib/admin/item-commands.ts, lib/admin/item-queries.ts, lib/admin/queries.ts, lib/orders/admin-commands.ts
 * เพื่อไม่ให้หน้าร้านบอก "ว่าง" ทั้งที่จองไม่ได้ (หรือกลับกัน)
 *
 * หมายเหตุ: ออเดอร์ที่ demo ยืนยันจะทิ้งแถวสินค้าไว้เป็น status='reserved' + reserved_until = confirmed_at + N
 * (ไม่ใช่ 'sold') ดังนั้นเมื่อเดโมสิ้นสุด "reserved ที่หมดเวลาและไม่มีผู้ถือ" ของกฎ lazy expiry เดิม
 * (resolveDisplayStatus / claimItem) ก็คืนสินค้าเป็นว่างเองโดยไม่ต้องมีงานเขียน DB ตามเวลา
 */
export function holdingOrderExistsSql(itemIdRef: SQL): SQL {
  return sql`EXISTS (
    SELECT 1 FROM orders o
    WHERE o.item_id = ${itemIdRef}
      AND ${holdingOrderCondition("o")}
  )`;
}

export type StoredItemStatus = "available" | "reserved" | "sold" | "hidden";
export type DisplayStatus = "available" | "reserved" | "sold";

export type LiveStatusInput = {
  /** items.status ตามที่เก็บใน DB */
  status: StoredItemStatus;
  /** reserved_until < now() (คำนวณที่ DB; false ถ้า reserved_until เป็น NULL) */
  lapsed: boolean;
  /** มีออเดอร์ที่ยังถือสินค้าอยู่ (holdingOrderExistsSql) */
  held: boolean;
};

/**
 * สถานะที่ลูกค้าควรเห็น (SPEC §5 กฎข้อ 2: lazy expiry)
 * - hidden → null (ไม่แสดง)
 * - reserved ที่หมดเวลาแล้วและไม่มีออเดอร์ถือ → available (ตรงกับเงื่อนไขใน claimItem)
 *   รวมกรณีออเดอร์เดโมที่สิ้นสุดแล้ว (reserved_until = confirmed_at + N และ holdingOrderCondition เป็น false)
 * - reserved ที่ reserved_until เป็น NULL (รอตรวจสลิป) → reserved
 */
export function resolveDisplayStatus(input: LiveStatusInput): DisplayStatus | null {
  switch (input.status) {
    case "hidden":
      return null;
    case "sold":
      return "sold";
    case "available":
      return "available";
    case "reserved":
      return input.lapsed && !input.held ? "available" : "reserved";
  }
}
