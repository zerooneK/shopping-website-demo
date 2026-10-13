"use client";

import { useState } from "react";

/**
 * รูปสลิปในหน้าตรวจออเดอร์ — รูปมาจาก proxy `/api/admin/slips/[id]` (ไม่ใช่ URL ของ Blob)
 *
 * HEIC: browser ส่วนใหญ่แสดงใน <img> ไม่ได้ (proxy เสิร์ฟเป็น attachment ให้ดาวน์โหลด)
 * จึงไม่พยายามโหลดเป็นรูป แสดงข้อความ + ลิงก์ดาวน์โหลดแทนรูปที่แตก
 * ถ้านามสกุลไม่ใช่ HEIC แต่รูปโหลดไม่ได้ (เช่นเนื้อไฟล์จริงเป็น HEIC) ก็ถอยมาแสดงข้อความ + ลิงก์เช่นกัน
 */
export function SlipImage({ orderId, isHeic }: { orderId: string; isHeic: boolean }) {
  const [failed, setFailed] = useState(false);
  const src = `/api/admin/slips/${orderId}`;

  if (isHeic || failed) {
    return (
      <div className="border border-rule p-4" data-testid="slip-download">
        <p className="leading-7">
          {isHeic
            ? "เบราว์เซอร์แสดง HEIC ไม่ได้ กดดาวน์โหลด"
            : "แสดงรูปสลิปในหน้านี้ไม่ได้ (ถ้าเป็นไฟล์ HEIC เบราว์เซอร์แสดงไม่ได้) กดดาวน์โหลด"}
        </p>
        <a
          href={src}
          download="slip.heic"
          className="tap mt-3 inline-flex items-center border border-ink px-6 font-medium text-ink hover:bg-ink hover:text-paper"
          data-testid="slip-download-link"
        >
          ดาวน์โหลดสลิป
        </a>
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- ต้อง no-store ผ่าน proxy จึงไม่ใช้ next/image
    <img
      src={src}
      alt="สลิปโอนเงินของลูกค้า"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="max-h-[70vh] w-full border border-rule bg-rule/40 object-contain"
      data-testid="slip-image"
    />
  );
}
