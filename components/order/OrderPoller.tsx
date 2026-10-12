"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

const INTERVAL_MS = 10_000;

/**
 * Poll สถานะออเดอร์ทุก 10 วินาทีขณะเปิดหน้า (SPEC §6 ข้อ 5 — ไม่ใช้ websocket)
 * ถ้าสถานะเปลี่ยน → router.refresh() ให้ server component เรนเดอร์ใหม่ (timeline/ปุ่ม/QR)
 * หยุด poll เมื่อสถานะสุดท้าย (keepPolling = false) และพักเมื่อแท็บถูกซ่อน
 */
export function OrderPoller({
  token,
  initialStatus,
  keepPolling,
}: {
  token: string;
  initialStatus: string;
  keepPolling: boolean;
}) {
  const router = useRouter();
  const last = useRef(initialStatus);

  useEffect(() => {
    last.current = initialStatus;
  }, [initialStatus]);

  useEffect(() => {
    if (!keepPolling) return;
    let stopped = false;

    async function poll() {
      if (stopped || document.visibilityState !== "visible") return;
      try {
        const res = await fetch(`/api/orders/${token}/status`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { status?: string };
        if (data.status && data.status !== last.current) {
          last.current = data.status;
          router.refresh();
        }
      } catch {
        // เครือข่ายหลุดชั่วคราว: รอรอบถัดไป
      }
    }

    const id = setInterval(poll, INTERVAL_MS);
    const onVisible = () => void poll();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [token, keepPolling, router]);

  return null;
}
