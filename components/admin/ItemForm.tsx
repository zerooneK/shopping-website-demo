"use client";

import { useActionState, useRef, useState } from "react";
import { createItemAction, updateItemAction } from "@/app/admin/(protected)/items/actions";
import { SafeImage } from "@/components/ui/SafeImage";
import { INITIAL_ACTION_STATE } from "@/lib/admin/action-state";
import { fitWithin } from "@/lib/slip";
import {
  isItemImageType,
  ITEM_IMAGE_MAX_BYTES,
  ITEM_IMAGE_MAX_EDGE,
  ITEM_IMAGES_MAX,
  itemImageUrlFromPathname,
} from "@/lib/item-image";
import { CATEGORY_LABEL, CONDITION_LABEL } from "@/lib/labels";

export type ItemFormInitial = {
  id: number;
  code: string;
  title: string;
  description: string;
  flaws: string;
  condition: "like_new" | "good" | "fair";
  category: "fashion" | "books" | "home" | "tech" | "other";
  price: number;
  sortOrder: number;
  status: "available" | "reserved" | "sold" | "hidden";
  held: boolean;
  images: { url: string; alt: string }[];
};

type Props = {
  mode: "create" | "edit";
  initial?: ItemFormInitial;
  /** แก้ข้อความ/ราคา/สถานะได้ (owner) — false = ดูอย่างเดียว (demo) */
  canEdit: boolean;
  /** อัปโหลด/ลบรูปได้ (owner) */
  canUpload: boolean;
  /** server ตั้ง BLOB_READ_WRITE_TOKEN ไว้หรือไม่ */
  blobEnabled: boolean;
};

const fieldCls = "tap mt-1 block w-full border border-ink bg-paper px-3 text-ink disabled:opacity-70";
const areaCls = "mt-1 block w-full border border-ink bg-paper px-3 py-2 text-ink disabled:opacity-70";
const labelCls = "block text-sm text-muted";
const primaryBtn =
  "tap inline-flex w-full items-center justify-center bg-accent px-6 font-medium text-paper hover:opacity-90 disabled:opacity-60";
const smallBtn =
  "tap inline-flex min-w-11 items-center justify-center border border-ink px-3 text-ink hover:bg-ink hover:text-paper disabled:opacity-40";

type ImgState = { url: string; alt: string };

/** ย่อรูปให้ยาวสุด 1600px แล้วแปลงเป็น JPEG (พื้นขาวสำหรับ PNG โปร่งใส) — decode ไม่ได้ (เช่น HEIC) = โยน error */
async function prepareImage(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const { width, height } = fitWithin(bitmap.width, bitmap.height, ITEM_IMAGE_MAX_EDGE);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
  if (!blob) throw new Error("encode failed");
  return blob;
}

export function ItemForm({ mode, initial, canEdit, canUpload, blobEnabled }: Props) {
  const [state, formAction, pending] = useActionState(
    mode === "create" ? createItemAction : updateItemAction,
    INITIAL_ACTION_STATE,
  );
  const fe = state.fieldErrors ?? {};

  const [values, setValues] = useState({
    code: initial?.code ?? "",
    title: initial?.title ?? "",
    description: initial?.description ?? "",
    flaws: initial?.flaws ?? "",
    condition: initial?.condition ?? "good",
    category: initial?.category ?? "other",
    price: initial ? String(initial.price) : "",
    sortOrder: initial ? String(initial.sortOrder) : "0",
    status: mode === "create" ? "available" : initial?.status === "reserved" ? "available" : (initial?.status ?? "available"),
  });
  const set = (k: keyof typeof values) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [k]: e.target.value }));

  const [images, setImages] = useState<ImgState[]>(initial?.images ?? []);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const held = mode === "edit" && !!initial?.held;
  const locked = !canEdit;

  async function onFile(file: File | undefined) {
    if (!file || !canUpload) return;
    setUploadError(null);
    if (images.length >= ITEM_IMAGES_MAX) {
      setUploadError(`ใส่รูปได้ไม่เกิน ${ITEM_IMAGES_MAX} รูป`);
      return;
    }
    setUploading(true);
    try {
      let blob: Blob;
      try {
        blob = await prepareImage(file);
      } catch {
        setUploadError("เปิดไฟล์นี้ไม่ได้ ลองใช้รูป JPG, PNG หรือ WebP");
        return;
      }
      if (!isItemImageType(blob.type) || blob.size > ITEM_IMAGE_MAX_BYTES) {
        setUploadError("ไฟล์รูปใหญ่เกิน 5MB หลังย่อ ลองเลือกรูปอื่น");
        return;
      }
      const { upload } = await import("@vercel/blob/client");
      const name = `up-${crypto.randomUUID().slice(0, 8)}.jpg`;
      const result = await upload(`items/${name}`, blob, {
        access: "private",
        handleUploadUrl: "/api/admin/item-images/upload",
        contentType: "image/jpeg",
      });
      setImages((list) => [...list, { url: itemImageUrlFromPathname(result.pathname), alt: "" }]);
    } catch {
      setUploadError("อัปโหลดไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  const move = (i: number, d: -1 | 1) =>
    setImages((list) => {
      const j = i + d;
      if (j < 0 || j >= list.length) return list;
      const next = [...list];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const err = (k: string) =>
    fe[k] ? (
      <p role="alert" className="mt-1 text-sm text-accent" data-testid={`error-${k}`}>
        {fe[k]}
      </p>
    ) : null;

  return (
    <form action={formAction} className="mt-8 space-y-6" data-testid="item-form" noValidate>
      {mode === "edit" ? <input type="hidden" name="itemId" value={initial?.id} /> : null}
      <input type="hidden" name="images" value={JSON.stringify(images)} />

      {locked ? (
        <p className="border-l-4 border-l-ink pl-3 text-sm leading-7 text-muted" data-testid="item-readonly-note">
          โหมดเดโม: ดูข้อมูลสินค้าได้อย่างเดียว แก้ไข เปลี่ยนสถานะ อัปโหลดหรือลบรูป และลบสินค้าไม่ได้
          (สินค้าเป็นเนื้อหาสาธารณะที่ทุกคนเห็น จึงเปิดให้เฉพาะเจ้าของร้านแก้)
        </p>
      ) : null}
      {state.error ? (
        <p role="alert" className="border-l-4 border-l-accent pl-3 text-accent" data-testid="item-form-error">
          {state.error}
        </p>
      ) : null}
      {state.ok && state.message ? (
        <p role="status" className="border-l-4 border-l-ink pl-3" data-testid="item-form-success">
          {state.message}
        </p>
      ) : null}

      <div>
        <label htmlFor="f-code" className={labelCls}>
          รหัสสินค้า (รูปแบบ A + ตัวเลข 3 หลัก เช่น A013)
        </label>
        {mode === "create" ? (
          <input
            id="f-code"
            name="code"
            value={values.code}
            onChange={set("code")}
            maxLength={4}
            autoComplete="off"
            disabled={locked}
            className={fieldCls}
          />
        ) : (
          <p id="f-code" className="tap mt-1 flex items-center border border-rule px-3 text-ink" data-testid="item-code">
            {initial?.code}
          </p>
        )}
        {err("code")}
      </div>

      <div>
        <label htmlFor="f-title" className={labelCls}>ชื่อสินค้า</label>
        <input id="f-title" name="title" value={values.title} onChange={set("title")} maxLength={120} disabled={locked} className={fieldCls} />
        {err("title")}
      </div>

      <div>
        <label htmlFor="f-desc" className={labelCls}>คำบรรยาย</label>
        <textarea id="f-desc" name="description" value={values.description} onChange={set("description")} rows={5} maxLength={2000} disabled={locked} className={areaCls} />
        {err("description")}
      </div>

      <div>
        <label htmlFor="f-flaws" className={labelCls}>
          ตำหนิ (บังคับ — ถ้าไม่มีให้ใส่ “ไม่มีตำหนิที่สังเกตเห็น”)
        </label>
        <textarea id="f-flaws" name="flaws" value={values.flaws} onChange={set("flaws")} rows={3} maxLength={1000} disabled={locked} className={areaCls} />
        {err("flaws")}
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        <div>
          <label htmlFor="f-cond" className={labelCls}>สภาพ</label>
          <select id="f-cond" name="condition" value={values.condition} onChange={set("condition")} disabled={locked} className={fieldCls}>
            {Object.entries(CONDITION_LABEL).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
          {err("condition")}
        </div>
        <div>
          <label htmlFor="f-cat" className={labelCls}>หมวดหมู่</label>
          <select id="f-cat" name="category" value={values.category} onChange={set("category")} disabled={locked} className={fieldCls}>
            {Object.entries(CATEGORY_LABEL).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
          {err("category")}
        </div>
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        <div>
          <label htmlFor="f-price" className={labelCls}>ราคา (บาท จำนวนเต็ม มากกว่า 0)</label>
          <input id="f-price" name="price" value={values.price} onChange={set("price")} inputMode="numeric" autoComplete="off" disabled={locked} className={fieldCls} />
          {err("price")}
        </div>
        <div>
          <label htmlFor="f-sort" className={labelCls}>ลำดับการแสดง (น้อยขึ้นก่อน)</label>
          <input id="f-sort" name="sortOrder" value={values.sortOrder} onChange={set("sortOrder")} inputMode="numeric" autoComplete="off" disabled={locked} className={fieldCls} />
          {err("sortOrder")}
        </div>
      </div>

      <div>
        <label htmlFor="f-status" className={labelCls}>สถานะ</label>
        {held ? (
          <p className="mt-1 border border-rule p-3 text-sm leading-7 text-muted" data-testid="item-held-note">
            มีออเดอร์ถือสินค้านี้อยู่ จึงเปลี่ยนสถานะไม่ได้ — ต้องยืนยันหรือปฏิเสธออเดอร์ก่อน (แก้ข้อความ ราคา และรูปได้)
          </p>
        ) : (
          <select id="f-status" name="status" value={values.status} onChange={set("status")} disabled={locked} className={fieldCls}>
            <option value="available">ว่าง (แสดงบนหน้าร้าน)</option>
            <option value="hidden">ซ่อน (ฉบับร่าง ไม่แสดงบนหน้าร้าน)</option>
            {mode === "edit" ? <option value="sold">ขายแล้ว</option> : null}
          </select>
        )}
        {err("status")}
      </div>

      <fieldset className="border-t border-rule pt-6" data-testid="item-images">
        <legend className="meta meta-th text-ink">รูปสินค้า (ลำดับแรกคือรูปปก)</legend>
        {err("images")}
        {images.length === 0 ? (
          <p className="mt-3 text-sm text-muted">ยังไม่มีรูป (สินค้าที่แสดงบนหน้าร้านต้องมีอย่างน้อย 1 รูป)</p>
        ) : (
          <ol className="mt-3 space-y-4">
            {images.map((img, i) => (
              <li key={img.url} className="border border-rule p-3" data-testid="item-image-row">
                <div className="flex gap-3">
                  <div className="relative aspect-[4/5] w-20 shrink-0 overflow-hidden border border-rule bg-rule/40">
                    <SafeImage src={img.url} alt={img.alt || "รูปสินค้า"} sizes="80px" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <label htmlFor={`alt-${i}`} className={labelCls}>
                      รูปที่ {i + 1} · คำอธิบายรูป (alt)
                    </label>
                    <input
                      id={`alt-${i}`}
                      value={img.alt}
                      onChange={(e) =>
                        setImages((list) => list.map((x, j) => (j === i ? { ...x, alt: e.target.value } : x)))
                      }
                      maxLength={200}
                      disabled={locked}
                      className={fieldCls}
                    />
                  </div>
                </div>
                {canUpload ? (
                  <div className="mt-3 flex gap-2">
                    <button type="button" className={smallBtn} onClick={() => move(i, -1)} disabled={i === 0} aria-label={`เลื่อนรูปที่ ${i + 1} ขึ้น`}>
                      ↑
                    </button>
                    <button type="button" className={smallBtn} onClick={() => move(i, 1)} disabled={i === images.length - 1} aria-label={`เลื่อนรูปที่ ${i + 1} ลง`}>
                      ↓
                    </button>
                    <button
                      type="button"
                      className={`${smallBtn} ml-auto`}
                      onClick={() => setImages((list) => list.filter((_, j) => j !== i))}
                      aria-label={`ลบรูปที่ ${i + 1}`}
                    >
                      ลบรูป
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        )}

        {canUpload ? (
          <div className="mt-4">
            {blobEnabled ? (
              <>
                <label htmlFor="f-file" className={labelCls}>
                  เพิ่มรูป (ระบบจะย่อให้ยาวสุด {ITEM_IMAGE_MAX_EDGE}px) · ไม่เกิน {ITEM_IMAGES_MAX} รูป
                </label>
                <input
                  ref={fileInput}
                  id="f-file"
                  type="file"
                  accept="image/*"
                  disabled={uploading}
                  onChange={(e) => void onFile(e.target.files?.[0])}
                  className="tap mt-2 block w-full border border-rule p-2 text-base file:mr-3 file:border-0 file:bg-ink file:px-4 file:py-2 file:text-paper disabled:opacity-60"
                />
                {uploading ? <p role="status" className="mt-2 text-sm text-muted">กำลังอัปโหลด…</p> : null}
              </>
            ) : (
              <p className="text-sm text-muted" data-testid="blob-disabled-note">
                ยังไม่ได้เชื่อมที่เก็บไฟล์ (Vercel Blob) จึงอัปโหลดรูปใหม่ไม่ได้ในสภาพแวดล้อมนี้
              </p>
            )}
            {uploadError ? (
              <p role="alert" className="mt-2 text-accent" data-testid="upload-error">{uploadError}</p>
            ) : null}
          </div>
        ) : (
          <p className="mt-3 text-sm text-muted" data-testid="upload-denied-note">
            บัญชีนี้อัปโหลดหรือลบรูปไม่ได้
          </p>
        )}
      </fieldset>

      <button type="submit" disabled={pending || uploading || locked} className={primaryBtn} data-testid="item-save">
        {pending ? "กำลังบันทึก…" : mode === "create" ? "เพิ่มสินค้า" : "บันทึกสินค้า"}
      </button>
    </form>
  );
}
