"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** ยกเลิกออเดอร์ (เฉพาะ pending_payment) — ยืนยัน 2 ขั้นกันกดพลาด */
export function CancelOrderButton({ token }: { token: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cancel() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/orders/${token}/cancel`, { method: "POST" });
      if (res.ok) {
        router.refresh();
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? "ยกเลิกไม่สำเร็จ");
      if (res.status === 409) router.refresh(); // สถานะเปลี่ยนไปแล้ว ดึงข้อมูลล่าสุด
    } catch {
      setError("เชื่อมต่อไม่ได้ กรุณาลองใหม่");
    } finally {
      setPending(false);
    }
  }

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="tap meta meta-th inline-flex items-center text-ink underline underline-offset-4"
      >
        ยกเลิกออเดอร์
      </button>
    );
  }

  return (
    <div className="border border-rule p-4">
      <p className="leading-7">ยกเลิกออเดอร์นี้? สินค้าจะถูกปล่อยกลับเข้าร้านทันที</p>
      <div className="mt-3 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={cancel}
          disabled={pending}
          className="tap inline-flex items-center border border-ink bg-ink px-5 text-paper disabled:opacity-60"
        >
          {pending ? "กำลังยกเลิก…" : "ยืนยันยกเลิก"}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          disabled={pending}
          className="tap inline-flex items-center border border-rule px-5 text-ink"
        >
          ไม่ยกเลิก
        </button>
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-accent">
          {error}
        </p>
      ) : null}
    </div>
  );
}
