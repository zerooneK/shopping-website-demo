import type { DisplayStatus } from "@/lib/availability";

/** ป้ายสถานะข้อความ (อ่านออกเสียงได้ ไม่พึ่งสี) */
export function StatusTag({ status }: { status: DisplayStatus }) {
  if (status === "available") return null;
  return (
    <span
      className={`meta meta-th inline-block border px-2 py-0.5 ${
        status === "sold" ? "border-accent text-accent" : "border-ink text-ink"
      }`}
    >
      {status === "sold" ? "ขายแล้ว" : "มีคนจองอยู่"}
    </span>
  );
}
