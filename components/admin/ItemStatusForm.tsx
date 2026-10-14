"use client";

import Link from "next/link";
import { useActionState } from "react";
import { changeItemStatusAction } from "@/app/admin/(protected)/items/actions";
import { INITIAL_ACTION_STATE } from "@/lib/admin/action-state";
import type { AdminItemStatus } from "@/lib/admin/item-queries";

export const ITEM_STATUS_LABEL: Record<AdminItemStatus, string> = {
  available: "ว่าง",
  reserved: "มีออเดอร์ถืออยู่",
  sold: "ขายแล้ว",
  hidden: "ซ่อน",
};

/**
 * เปลี่ยนสถานะเร็วในแถวของตารางสินค้า
 * - สินค้าที่มีออเดอร์ถืออยู่: ปิดตัวเลือก + ลิงก์ไปจัดการออเดอร์ (ตัวชี้ขาดจริงอยู่ที่ server: เปลี่ยนไม่ได้แม้ส่งฟอร์มเอง)
 * - ไม่มีสิทธิ์แก้ (demo): แสดงเป็นข้อความเฉยๆ ไม่มีตัวเลือก
 */
export function ItemStatusForm({
  id,
  code,
  status,
  held,
  canEdit,
}: {
  id: number;
  code: string;
  status: AdminItemStatus;
  held: boolean;
  canEdit: boolean;
}) {
  const [state, formAction, pending] = useActionState(changeItemStatusAction, INITIAL_ACTION_STATE);

  if (!canEdit) {
    return (
      <p className="meta meta-th" data-testid="item-status-text">
        {ITEM_STATUS_LABEL[status]}
      </p>
    );
  }

  if (held) {
    return (
      <div data-testid="item-held">
        <p className="meta meta-th text-ink">{ITEM_STATUS_LABEL.reserved}</p>
        <p className="mt-1 text-sm text-muted">
          เปลี่ยนสถานะไม่ได้ ต้องยืนยันหรือปฏิเสธออเดอร์ก่อน{" "}
          <Link href="/admin" className="underline underline-offset-4">
            ไปที่ออเดอร์
          </Link>
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-wrap items-stretch gap-2">
      <input type="hidden" name="itemId" value={id} />
      <label htmlFor={`status-${id}`} className="sr-only">
        สถานะสินค้า {code}
      </label>
      <select
        id={`status-${id}`}
        name="status"
        defaultValue={status === "reserved" ? "available" : status}
        className="tap min-w-0 flex-1 border border-ink bg-paper px-2 text-ink"
        data-testid="item-status-select"
      >
        <option value="available">ว่าง</option>
        <option value="hidden">ซ่อน</option>
        <option value="sold">ขายแล้ว</option>
      </select>
      <button
        type="submit"
        disabled={pending}
        className="tap border border-ink px-4 font-medium text-ink hover:bg-ink hover:text-paper disabled:opacity-60"
      >
        {pending ? "…" : "บันทึก"}
      </button>
      {state.error ? (
        <p role="alert" className="basis-full border-l-4 border-l-accent pl-3 text-sm text-accent" data-testid="item-status-error">
          {state.error}
        </p>
      ) : null}
      {state.ok && state.message ? (
        <p role="status" className="basis-full text-sm text-muted" data-testid="item-status-ok">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
