"use client";

import { useRouter } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";
import { formatCountdown } from "@/lib/labels";

function subscribe(onTick: () => void) {
  const id = setInterval(onTick, 1000);
  queueMicrotask(onTick); // แสดงเวลาจริงทันทีหลัง hydrate ไม่ต้องรอ tick แรก
  return () => clearInterval(id);
}
// ปัดเป็นวินาทีเพื่อให้ snapshot นิ่งระหว่างวินาที
const getNow = () => Math.floor(Date.now() / 1000) * 1000;
// ฝั่ง server/hydration ยังไม่รู้เวลา → 0 แล้วค่อยแสดงเวลาจริงหลัง hydrate
const getServerNow = () => 0;

/** นับถอยหลังถึง reserved_until แล้วรีเฟรชหน้าเมื่อหมดเวลา เพื่อดึงสถานะจริงจากเซิร์ฟเวอร์ */
export function Countdown({ until }: { until: string }) {
  const router = useRouter();
  const now = useSyncExternalStore(subscribe, getNow, getServerNow);
  const left = now === 0 ? null : new Date(until).getTime() - now;
  const done = left !== null && left <= 0;

  useEffect(() => {
    if (done) router.refresh();
  }, [done, router]);

  return (
    <span
      className="font-mono tabular-nums text-accent"
      role="timer"
      aria-label="เวลาที่เหลือก่อนปล่อยสินค้าคืน"
    >
      {left === null ? "--:--" : formatCountdown(left)}
    </span>
  );
}
