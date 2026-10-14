/**
 * คำเตือนสำหรับเจ้าของร้าน: cron รีเซ็ตรายวันคืนสินค้าทั้งร้านเป็น db/seed-data.json
 * (สินค้าที่เพิ่ม/แก้ผ่านหลังบ้านจึงไม่ถาวร) — ข้อความคงที่ ไม่ขึ้นกับสภาพแวดล้อม
 */
export const ITEM_RESET_NOTICE =
  "สินค้าที่เพิ่ม/แก้จะถูกคืนเป็นข้อมูลตั้งต้นทุกวัน ตี 3 (ถ้าต้องการถาวรให้ใส่ใน db/seed-data.json)";

export function ItemResetNotice() {
  return (
    <p className="mt-4 border-l-4 border-l-accent pl-3 text-sm leading-7 text-ink" role="note" data-testid="item-reset-notice">
      {ITEM_RESET_NOTICE}
    </p>
  );
}
