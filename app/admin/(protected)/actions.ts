"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/db/client";
import type { ActionState } from "@/lib/admin/action-state";
import { adminTransitionSchema } from "@/lib/admin/view";
import { can } from "@/lib/auth";
import { getSession, requestHasSameOrigin } from "@/lib/auth-server";
import { adminTransition, type AdminCommandError } from "@/lib/orders/admin-commands";

/**
 * Server Action: ยืนยัน / ปฏิเสธ / จัดส่ง / ปิดงาน
 *
 * ลำดับตรวจ: Origin → session (ตรวจใหม่ทุกครั้ง ไม่เชื่อว่าหน้าเพจผ่านมาแล้ว) → สิทธิ์ role → Zod → คำสั่งใน
 * lib/orders/admin-commands.ts (compare-and-set ใน transaction เดียว; role demo ถูกจำกัดให้เปลี่ยนสถานะได้เฉพาะ
 * ออเดอร์ที่ demo_session_id ตรงกับ sid ของ session — บังคับในคำสั่งนั้นเอง ไม่ใช่แค่ซ่อนปุ่มใน UI)
 * ห้าม log ข้อมูลลูกค้า (log เฉพาะชื่อชนิดของ error)
 */

const MESSAGE: Record<AdminCommandError, string> = {
  not_found: "ไม่พบออเดอร์นี้",
  not_your_order: "บัญชีเดโมเปลี่ยนสถานะได้เฉพาะออเดอร์ที่สร้างจากเบราว์เซอร์นี้เท่านั้น (ออเดอร์อื่นดูได้อย่างเดียว)",
  invalid_state: "สถานะออเดอร์เปลี่ยนไปแล้ว (อาจมีคนดำเนินการไปก่อน) กรุณารีเฟรชดูสถานะล่าสุด",
  demo_ended: "ออเดอร์เดโมนี้สิ้นสุดแล้ว ระบบคืนสินค้าเข้าร้านให้เองแล้ว จึงเปลี่ยนสถานะต่อไม่ได้",
  owner_only: "การคืนสินค้าเข้าร้านทำได้เฉพาะเจ้าของร้าน",
  reason_required: "กรุณาระบุเหตุผล",
  tracking_required: "กรุณาระบุเลขพัสดุ",
  pickup_cannot_ship: "ออเดอร์นัดรับไม่ต้องจัดส่ง ใช้ปุ่มปิดงานแทน",
};

const SUCCESS: Record<string, string> = {
  confirm: "ยืนยันการชำระเงินแล้ว",
  reject: "ปฏิเสธสลิปแล้ว ปล่อยสินค้ากลับเข้าร้านแล้ว",
  ship: "บันทึกการจัดส่งแล้ว",
  complete: "ปิดงานแล้ว",
  return: "คืนสินค้าเข้าร้านและยกเลิกออเดอร์แล้ว",
};

export async function transitionOrderAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  if (!(await requestHasSameOrigin())) {
    return { error: "คำขอไม่ถูกต้อง กรุณาโหลดหน้านี้ใหม่แล้วลองอีกครั้ง" };
  }

  const session = await getSession();
  if (!session) return { error: "เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่" };
  if (!can(session, "order.transition")) return { error: "บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้" };

  const parsed = adminTransitionSchema.safeParse({
    orderId: formData.get("orderId"),
    intent: formData.get("intent"),
    reason: formData.get("reason") ?? undefined,
    trackingNo: formData.get("trackingNo") ?? undefined,
  });
  if (!parsed.success) {
    // แสดงข้อความของ Zod เฉพาะช่องที่ผู้ใช้กรอกเอง (เหตุผล/เลขพัสดุ); ที่เหลือเป็นข้อความทั่วไป
    const issue = parsed.error.issues[0];
    const userField = issue?.path[0] === "reason" || issue?.path[0] === "trackingNo";
    return { error: userField ? issue.message : "ข้อมูลไม่ถูกต้อง" };
  }
  const input = parsed.data;
  // คืนสินค้าเข้าร้านเป็นของ owner เท่านั้น (ตรวจที่นี่และซ้ำใน adminTransition)
  if (input.intent === "return" && !can(session, "order.return")) {
    return { error: MESSAGE.owner_only };
  }

  let result;
  try {
    result = await adminTransition(getDb(), {
      orderId: input.orderId,
      actor: session,
      intent:
        input.intent === "reject" || input.intent === "return"
          ? { type: input.intent, reason: input.reason }
          : input.intent === "ship"
            ? { type: "ship", trackingNo: input.trackingNo }
            : { type: input.intent },
    });
  } catch (e) {
    console.error("[admin] transition failed:", e instanceof Error ? e.name : "unknown");
    return { error: "ระบบขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้ง" };
  }

  if (!result.ok) return { error: MESSAGE[result.error] };

  // สถานะสินค้าบนหน้าร้านอ่านสดจาก DB ทุก request จึงไม่ต้อง revalidate แท็กสินค้า — รีเฟรชเฉพาะหน้าหลังบ้าน
  revalidatePath("/admin", "layout");
  return { ok: true, message: SUCCESS[input.intent] };
}
