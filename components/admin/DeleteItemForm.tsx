"use client";

import { useActionState } from "react";
import { deleteItemAction } from "@/app/admin/(protected)/items/actions";
import { INITIAL_ACTION_STATE } from "@/lib/admin/action-state";

/** ลบสินค้า (owner เท่านั้น — server ตรวจสิทธิ์ซ้ำ และปฏิเสธถ้ามีออเดอร์) ต้องติ๊กยืนยันก่อน */
export function DeleteItemForm({ id, orderCount }: { id: number; orderCount: number }) {
  const [state, formAction, pending] = useActionState(deleteItemAction, INITIAL_ACTION_STATE);

  return (
    <section aria-labelledby="delete-heading" className="mt-12 border-t border-rule pt-6">
      <h2 id="delete-heading" className="meta meta-th text-ink">
        ลบสินค้า
      </h2>
      {orderCount > 0 ? (
        <p className="mt-3 text-sm leading-7 text-muted" data-testid="delete-blocked-note">
          สินค้านี้มีประวัติออเดอร์ {orderCount} รายการ จึงลบไม่ได้ ให้ตั้งสถานะเป็น “ซ่อน” แทน
        </p>
      ) : (
        <form action={formAction} className="mt-3 space-y-3">
          <input type="hidden" name="itemId" value={id} />
          <label className="flex min-h-11 items-center gap-3 text-sm">
            <input type="checkbox" name="confirm" value="yes" className="size-5" />
            ยืนยันว่าต้องการลบสินค้านี้ถาวร (รวมไฟล์รูปที่อัปโหลดไว้)
          </label>
          {state.error ? (
            <p role="alert" className="border-l-4 border-l-accent pl-3 text-accent" data-testid="delete-error">
              {state.error}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={pending}
            className="tap inline-flex w-full items-center justify-center border border-accent px-6 font-medium text-accent hover:bg-accent hover:text-paper disabled:opacity-60"
          >
            {pending ? "กำลังลบ…" : "ลบสินค้า"}
          </button>
        </form>
      )}
    </section>
  );
}
