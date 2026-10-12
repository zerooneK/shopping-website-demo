import { sql, type SQL } from "drizzle-orm";

/**
 * นิยามเดียวของ "สินค้าชิ้นนี้ยังมีออเดอร์ถืออยู่หรือไม่" — ใช้ร่วมกันระหว่าง
 *  - claimItem ใน lib/reserve.ts (กฎจอง: NOT EXISTS)
 *  - lib/items.ts (ปรับสถานะที่แสดงบนหน้าร้านให้ตรงกับกฎจอง)
 * เพื่อไม่ให้หน้าร้านบอก "ว่าง" ทั้งที่จองไม่ได้ (หรือกลับกัน)
 *
 * ออเดอร์ที่ถือสินค้า: awaiting_review / confirmed / shipped / completed
 * หรือ pending_payment ที่ expires_at >= now()   (เวลาใช้ now() ของ DB เสมอ)
 */
export function holdingOrderExistsSql(itemIdRef: SQL): SQL {
  return sql`EXISTS (
    SELECT 1 FROM orders o
    WHERE o.item_id = ${itemIdRef}
      AND (o.status IN ('awaiting_review', 'confirmed', 'shipped', 'completed')
           OR (o.status = 'pending_payment' AND o.expires_at >= now()))
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
