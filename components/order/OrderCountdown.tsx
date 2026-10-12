"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { formatCountdown } from "@/lib/labels";

/**
 * นับถอยหลังถึง expiresAt โดยอิงเวลาของ DB: `serverNow` คือ now() ของ DB ตอนเรนเดอร์
 * เราคำนวณส่วนต่างกับนาฬิกาเครื่องครั้งเดียวตอน hydrate แล้วใช้ส่วนต่างนั้นต่อ
 * เพื่อไม่ให้นาฬิกาเครื่องลูกค้าที่เดินเพี้ยนทำให้เวลาเหลือผิด
 * เมื่อหมดเวลา → router.refresh() ให้ server mark ออเดอร์ expired และอัปเดตหน้า
 */
export function OrderCountdown({ expiresAt, serverNow }: { expiresAt: string; serverNow: string }) {
  const router = useRouter();
  const offset = useRef<number | null>(null);

  const subscribe = (onTick: () => void) => {
    const id = setInterval(onTick, 1000);
    queueMicrotask(onTick);
    return () => clearInterval(id);
  };
  const getNow = () => {
    offset.current ??= Date.parse(serverNow) - Date.now();
    return Math.floor((Date.now() + offset.current) / 1000) * 1000;
  };
  const now = useSyncExternalStore(subscribe, getNow, () => 0);

  const left = now === 0 ? null : Date.parse(expiresAt) - now;
  const done = left !== null && left <= 0;

  useEffect(() => {
    if (done) router.refresh();
  }, [done, router]);

  return (
    <span
      className="font-mono tabular-nums text-accent"
      role="timer"
      aria-label="เวลาที่เหลือในการชำระเงิน"
      data-testid="order-countdown"
    >
      {left === null ? "--:--" : formatCountdown(left)}
    </span>
  );
}
