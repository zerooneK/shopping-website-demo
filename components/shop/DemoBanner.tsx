import { DEMO_ORDER_RETURN_MINUTES } from "@/lib/availability";

export function DemoBanner() {
  if (process.env.DEMO_MODE !== "true") return null;
  return (
    <div
      role="note"
      className="meta meta-th border-b border-rule bg-ink px-4 py-2 text-center text-paper"
    >
      Demo store — ไม่มีการเรียกเก็บเงินจริง · ข้อมูลรีเซ็ตทุกวัน · ออเดอร์ที่ลองยืนยันในหลังบ้านแบบเดโมจะคืนสินค้าเข้าร้านเองหลัง {DEMO_ORDER_RETURN_MINUTES} นาที · อย่ากรอกข้อมูลจริง
    </div>
  );
}
