"use client";

import { useActionState } from "react";
import { loginDemoAction, loginOwnerAction } from "@/app/admin/login/actions";
import { INITIAL_ACTION_STATE } from "@/lib/admin/action-state";

const primaryBtn =
  "tap inline-flex w-full items-center justify-center bg-accent px-6 font-medium text-paper hover:opacity-90 disabled:opacity-60";
const secondaryBtn =
  "tap inline-flex w-full items-center justify-center border border-ink px-6 font-medium text-ink hover:bg-ink hover:text-paper disabled:opacity-60";

export function LoginForms({
  ownerEnabled,
  demoEnabled,
}: {
  ownerEnabled: boolean;
  demoEnabled: boolean;
}) {
  const [ownerState, ownerAction, ownerPending] = useActionState(loginOwnerAction, INITIAL_ACTION_STATE);
  const [demoState, demoAction, demoPending] = useActionState(loginDemoAction, INITIAL_ACTION_STATE);

  if (!ownerEnabled && !demoEnabled) {
    return (
      <p role="status" className="border border-rule p-4 text-muted" data-testid="login-unavailable">
        หลังบ้านยังไม่พร้อมใช้งานในสภาพแวดล้อมนี้ (ยังไม่ได้ตั้งค่าการเข้าสู่ระบบ)
      </p>
    );
  }

  return (
    <div className="space-y-10">
      {ownerEnabled ? (
        <form action={ownerAction} className="space-y-4" aria-labelledby="owner-login-heading">
          <h2 id="owner-login-heading" className="meta meta-th text-ink">
            เจ้าของร้าน
          </h2>
          <div>
            <label htmlFor="admin-password" className="block text-sm text-muted">
              รหัสผ่าน
            </label>
            <input
              id="admin-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={200}
              className="tap mt-1 block w-full border border-ink bg-paper px-3 text-ink"
            />
          </div>
          {ownerState.error ? (
            <p role="alert" className="border-l-4 border-l-accent pl-3 text-accent" data-testid="login-error">
              {ownerState.error}
            </p>
          ) : null}
          <button type="submit" disabled={ownerPending} className={primaryBtn}>
            {ownerPending ? "กำลังเข้าสู่ระบบ…" : "เข้าสู่ระบบ"}
          </button>
        </form>
      ) : null}

      {demoEnabled ? (
        <form
          action={demoAction}
          className={`space-y-3 ${ownerEnabled ? "border-t border-rule pt-8" : ""}`}
          aria-labelledby="demo-login-heading"
        >
          <h2 id="demo-login-heading" className="meta meta-th text-ink">
            ลองหลังบ้านแบบเดโม
          </h2>
          <p className="text-sm leading-7 text-muted">
            เข้าดูหลังบ้านโดยไม่ต้องมีรหัสผ่าน: ยืนยัน ปฏิเสธ และจัดส่งออเดอร์ได้ แต่ชื่อ เบอร์ และที่อยู่ของลูกค้าจะถูกปิดบัง
            และดูสลิปได้เฉพาะออเดอร์ที่คุณสร้างจากเบราว์เซอร์นี้ ลบข้อมูลไม่ได้
          </p>
          {demoState.error ? (
            <p role="alert" className="border-l-4 border-l-accent pl-3 text-accent">
              {demoState.error}
            </p>
          ) : null}
          <button type="submit" disabled={demoPending} className={secondaryBtn}>
            {demoPending ? "กำลังเข้าสู่ระบบ…" : "ลองหลังบ้านแบบเดโม"}
          </button>
        </form>
      ) : null}
    </div>
  );
}
