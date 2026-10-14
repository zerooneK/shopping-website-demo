export function DemoBanner() {
  if (process.env.DEMO_MODE !== "true") return null;
  return (
    <div
      role="note"
      className="meta meta-th border-b border-rule bg-ink px-4 py-2 text-center text-paper"
    >
      Demo store — ไม่มีการเรียกเก็บเงินจริง · ข้อมูลรีเซ็ตทุกวัน · อย่ากรอกข้อมูลจริง
    </div>
  );
}
