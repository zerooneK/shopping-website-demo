"use client";

import { useActionState } from "react";
import { transitionOrderAction } from "@/app/admin/(protected)/actions";
import { INITIAL_ACTION_STATE } from "@/lib/admin/action-state";
import type { AdminAction } from "@/lib/admin/view";

const primaryBtn =
  "tap inline-flex w-full items-center justify-center bg-accent px-6 font-medium text-paper hover:opacity-90 disabled:opacity-60";
const secondaryBtn =
  "tap inline-flex w-full items-center justify-center border border-ink px-6 font-medium text-ink hover:bg-ink hover:text-paper disabled:opacity-60";
const fieldCls = "mt-1 block w-full border border-ink bg-paper px-3 py-2 text-ink";

/**
 * ปุ่มดำเนินการของออเดอร์ — แสดงเฉพาะ action ที่ server ระบุมาว่าทำได้ในสถานะปัจจุบัน
 * (ตัวชี้ขาดจริงอยู่ที่ server action + compare-and-set; ที่นี่เป็นแค่ UI)
 */
export function OrderActions({ orderId, actions }: { orderId: string; actions: AdminAction[] }) {
  const [state, formAction, pending] = useActionState(transitionOrderAction, INITIAL_ACTION_STATE);

  const hidden = (intent: AdminAction) => (
    <>
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="intent" value={intent} />
    </>
  );

  return (
    <section aria-labelledby="actions-heading" className="mt-10 border-t border-rule pt-6">
      <h2 id="actions-heading" className="meta meta-th text-ink">
        ดำเนินการ
      </h2>

      {state.error ? (
        <p role="alert" className="mt-4 border-l-4 border-l-accent pl-3 text-accent" data-testid="action-error">
          {state.error}
        </p>
      ) : null}
      {state.ok && state.message ? (
        <p role="status" className="mt-4 border-l-4 border-l-ink pl-3" data-testid="action-success">
          {state.message}
        </p>
      ) : null}

      {actions.length === 0 ? (
        <p className="mt-4 text-muted">ไม่มีการดำเนินการที่ทำได้ในสถานะนี้</p>
      ) : (
        <div className="mt-4 space-y-8">
          {actions.includes("confirm") ? (
            <form action={formAction}>
              {hidden("confirm")}
              <button type="submit" disabled={pending} className={primaryBtn}>
                ยืนยันการชำระเงิน
              </button>
            </form>
          ) : null}

          {actions.includes("reject") ? (
            <form action={formAction} className="space-y-3">
              {hidden("reject")}
              <div>
                <label htmlFor="reject-reason" className="block text-sm text-muted">
                  เหตุผลที่ปฏิเสธ (ลูกค้าจะเห็นข้อความนี้)
                </label>
                <textarea
                  id="reject-reason"
                  name="reason"
                  required
                  maxLength={300}
                  rows={3}
                  className={fieldCls}
                />
              </div>
              <button type="submit" disabled={pending} className={secondaryBtn}>
                ปฏิเสธสลิป
              </button>
            </form>
          ) : null}

          {actions.includes("ship") ? (
            <form action={formAction} className="space-y-3">
              {hidden("ship")}
              <div>
                <label htmlFor="tracking-no" className="block text-sm text-muted">
                  เลขพัสดุ
                </label>
                <input
                  id="tracking-no"
                  name="trackingNo"
                  required
                  maxLength={40}
                  autoComplete="off"
                  className={fieldCls}
                />
              </div>
              <button type="submit" disabled={pending} className={primaryBtn}>
                จัดส่งแล้ว
              </button>
            </form>
          ) : null}

          {actions.includes("complete") ? (
            <form action={formAction}>
              {hidden("complete")}
              <button type="submit" disabled={pending} className={secondaryBtn}>
                ปิดงาน
              </button>
            </form>
          ) : null}

          {actions.includes("return") ? (
            <form action={formAction} className="space-y-3 border-t border-rule pt-6" data-testid="return-form">
              {hidden("return")}
              <div>
                <label htmlFor="return-reason" className="block text-sm text-muted">
                  คืนสินค้าเข้าร้าน / ยกเลิกออเดอร์ — เหตุผล (ลูกค้าจะเห็นข้อความนี้ สินค้าจะกลับมาว่างทันที)
                </label>
                <textarea
                  id="return-reason"
                  name="reason"
                  required
                  maxLength={300}
                  rows={3}
                  className={fieldCls}
                />
              </div>
              <button type="submit" disabled={pending} className={secondaryBtn}>
                คืนสินค้าเข้าร้าน
              </button>
            </form>
          ) : null}
        </div>
      )}
    </section>
  );
}
