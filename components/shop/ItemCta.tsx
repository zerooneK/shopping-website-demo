import Link from "next/link";
import type { DisplayStatus } from "@/lib/availability";
import { formatPrice } from "@/lib/labels";
import { Countdown } from "./Countdown";

type Props = {
  code: string;
  price: number;
  /** null = ยังโหลดสถานะสดไม่เสร็จ (fallback ระหว่าง stream) */
  status: DisplayStatus | null;
  reservedUntil: string | null;
};

const BASE = "tap flex w-full items-center justify-center px-6 py-3 text-base font-medium";

/** ปุ่ม CTA ที่เปลี่ยนตามสถานะ ใช้ทั้งแบบ inline (desktop) และแถบล่าง (mobile) */
export function ItemCta({ code, price, status, reservedUntil }: Props) {
  if (status === "available") {
    return (
      <Link href={`/checkout/${code}`} className={`${BASE} bg-accent text-paper hover:opacity-90`}>
        จองชิ้นนี้ · {formatPrice(price)}
      </Link>
    );
  }

  const label =
    status === "sold" ? "ขายแล้ว" : status === "reserved" ? "มีคนจองอยู่" : "กำลังตรวจสถานะ…";

  return (
    <div>
      <button
        type="button"
        disabled
        aria-disabled="true"
        className={`${BASE} cursor-not-allowed border border-rule text-muted`}
      >
        {label}
      </button>
      {status === "reserved" && reservedUntil ? (
        <p className="meta meta-th mt-2 text-center">
          ปล่อยคืนใน <Countdown until={reservedUntil} />
        </p>
      ) : null}
      {status === "reserved" && !reservedUntil ? (
        <p className="meta meta-th mt-2 text-center">รอร้านตรวจสอบการชำระเงิน</p>
      ) : null}
    </div>
  );
}
