"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import {
  fitWithin,
  guessSlipContentType,
  SLIP_MAX_BYTES,
  SLIP_MAX_EDGE,
  slipExtension,
  type SlipContentType,
} from "@/lib/slip";

type Props = {
  token: string;
  /** `slips/<orderId>/` — server เป็นคนกำหนด และ server ตรวจซ้ำทุกครั้งที่ออก token และบันทึกสลิป */
  pathPrefix: string;
  /** มี BLOB_READ_WRITE_TOKEN ตั้งไว้ฝั่ง server หรือไม่ (false = ซ่อนช่องเลือกไฟล์) */
  blobEnabled: boolean;
  demoMode: boolean;
};

type Prepared = { blob: Blob; type: SlipContentType };

/** ย่อรูปให้ยาวสุด 1600px แล้วแปลงเป็น JPEG; ถ้า browser decode ไม่ได้ (เช่น HEIC) ส่งไฟล์เดิม */
async function prepareSlip(file: File, type: SlipContentType): Promise<Prepared> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const { width, height } = fitWithin(bitmap.width, bitmap.height, SLIP_MAX_EDGE);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.85),
    );
    if (!blob) throw new Error("encode failed");
    return { blob, type: "image/jpeg" };
  } catch {
    return { blob: file, type };
  }
}

export function SlipUploader({ token, pathPrefix, blobEnabled, demoMode }: Props) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<null | "upload" | "sample">(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function saveSlip(body: { pathname: string } | { sample: true }) {
    const res = await fetch(`/api/orders/${token}/slip`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      router.refresh();
      return;
    }
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    setError(data.error ?? "บันทึกสลิปไม่สำเร็จ กรุณาลองใหม่");
    if (res.status === 409) router.refresh(); // หมดเวลา/สถานะเปลี่ยน → แสดงสถานะล่าสุด
  }

  async function submitSample() {
    setBusy("sample");
    setError(null);
    try {
      await saveSlip({ sample: true });
    } catch {
      setError("เชื่อมต่อไม่ได้ กรุณาลองใหม่");
    } finally {
      setBusy(null);
    }
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    const type = guessSlipContentType(file.name, file.type);
    if (!type) {
      setError("รองรับเฉพาะไฟล์รูป JPG, PNG, WebP หรือ HEIC");
      return;
    }
    setBusy("upload");
    try {
      const prepared = await prepareSlip(file, type);
      if (prepared.blob.size > SLIP_MAX_BYTES) {
        setError("ไฟล์ใหญ่เกิน 8MB ลองเลือกรูปอื่นหรือแคปหน้าจอใหม่");
        return;
      }
      const { upload } = await import("@vercel/blob/client");
      const result = await upload(
        `${pathPrefix}slip.${slipExtension(prepared.type)}`,
        prepared.blob,
        {
          access: "private",
          handleUploadUrl: "/api/blob/upload",
          clientPayload: JSON.stringify({ token }),
          contentType: prepared.type,
        },
      );
      // ส่งเฉพาะ pathname กลับไปให้ server ตรวจ (head) — ไม่ใช้/ไม่เก็บ URL ของ Blob
      await saveSlip({ pathname: result.pathname });
    } catch {
      setError("อัปโหลดไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
    } finally {
      setBusy(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("คัดลอกไม่ได้ ให้กดค้างที่แถบที่อยู่เพื่อคัดลอกเอง");
    }
  }

  const disabled = busy !== null;

  return (
    <section aria-labelledby="slip-heading" className="border-t border-rule pt-6">
      <h2 id="slip-heading" className="meta meta-th text-ink">
        ส่งสลิปการโอนเงิน
      </h2>

      {blobEnabled ? (
        <div className="mt-3">
          <label htmlFor="slip-file" className="block text-sm text-muted">
            เลือกรูปสลิปจากเครื่อง (ระบบจะย่อรูปให้ก่อนส่ง)
          </label>
          <input
            ref={fileInput}
            id="slip-file"
            type="file"
            accept="image/*"
            disabled={disabled}
            onChange={(e) => void onFile(e.target.files?.[0])}
            className="tap mt-2 block w-full border border-rule p-2 text-base file:mr-3 file:border-0 file:bg-ink file:px-4 file:py-2 file:text-paper disabled:opacity-60"
          />
          {busy === "upload" ? (
            <p role="status" className="mt-2 text-sm text-muted">
              กำลังอัปโหลดสลิป…
            </p>
          ) : null}

          <details className="mt-3">
            <summary className="tap meta meta-th flex cursor-pointer items-center text-ink">
              เลือกรูปไม่ได้ (เปิดจากแอป TikTok/Facebook)?
            </summary>
            <p className="mt-2 text-sm leading-7 text-muted">
              เบราว์เซอร์ในบางแอปไม่ให้เลือกรูปจากคลังภาพ ลองคัดลอกลิงก์นี้ไปเปิดใน Safari หรือ Chrome
              แล้วส่งสลิปจากที่นั่น
            </p>
            <button
              type="button"
              onClick={copyLink}
              className="tap meta meta-th mt-2 inline-flex items-center border border-ink px-4 text-ink hover:bg-ink hover:text-paper"
            >
              {copied ? "คัดลอกแล้ว" : "คัดลอกลิงก์ออเดอร์"}
            </button>
          </details>
        </div>
      ) : (
        <p className="mt-3 border border-rule p-3 text-sm leading-7 text-muted">
          dev-only: ยังไม่ได้เชื่อมที่เก็บไฟล์ (Vercel Blob) จึงซ่อนช่องเลือกไฟล์ไว้
          {demoMode ? " — ใช้ปุ่ม “ใช้สลิปตัวอย่าง” ด้านล่างเพื่อลองครบทุกขั้นตอนได้" : " — ตอนนี้ส่งสลิปยังไม่ได้"}
        </p>
      )}

      {demoMode ? (
        <div className="mt-4">
          <button
            type="button"
            onClick={() => void submitSample()}
            disabled={disabled}
            className="tap flex w-full items-center justify-center border border-ink px-5 text-ink hover:bg-ink hover:text-paper disabled:opacity-60"
          >
            {busy === "sample" ? "กำลังส่ง…" : "ใช้สลิปตัวอย่าง"}
          </button>
          <p className="mt-2 text-sm text-muted">
            ไม่ต้องโอนเงินหรืออัปโหลดไฟล์ — ใช้รูปสลิปปลอมที่มากับระบบเพื่อลอง flow
          </p>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-3 border border-accent p-3 text-accent">
          {error}
        </p>
      ) : null}
    </section>
  );
}
