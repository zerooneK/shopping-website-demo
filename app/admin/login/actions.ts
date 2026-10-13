"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { loginLimiter } from "@/lib/admin/login-limit";
import type { ActionState } from "@/lib/admin/action-state";
import {
  getSessionKey,
  isDemoLoginAvailable,
  isOwnerLoginConfigured,
  verifyOwnerPassword,
} from "@/lib/auth";
import { endSession, requestHasSameOrigin, startSession } from "@/lib/auth-server";
import { getClientIp, normalizeIpForRateLimit } from "@/lib/client-ip";
import {
  DEMO_SID_COOKIE,
  demoSidCookieOptions,
  generateDemoSid,
  parseDemoSid,
} from "@/lib/demo";

/**
 * Server Actions ของหน้า login — ทุกตัวตรวจ Origin เอง (นอกเหนือจากการตรวจ Origin/Host ของ Next)
 * ข้อความที่ตอบกลับเป็นข้อความทั่วไป ไม่บอกรายละเอียดภายใน (ไม่เผยชื่อ env/ค่าใดๆ)
 */

const BAD_REQUEST: ActionState = { error: "คำขอไม่ถูกต้อง กรุณาโหลดหน้านี้ใหม่แล้วลองอีกครั้ง" };
const NOT_READY: ActionState = { error: "หลังบ้านยังไม่พร้อมใช้งาน (ยังไม่ได้ตั้งค่าการเข้าสู่ระบบ)" };

const passwordSchema = z.object({ password: z.string().min(1, "กรุณากรอกรหัสผ่าน").max(200) });

export async function loginOwnerAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  if (!(await requestHasSameOrigin())) return BAD_REQUEST;

  if (!isOwnerLoginConfigured()) {
    // log เฉพาะชื่อ env ที่ขาด (ห้ามพิมพ์ค่า)
    console.error("[admin] owner login unavailable: missing/short SESSION_SECRET or ADMIN_PASSWORD");
    return NOT_READY;
  }

  const parsed = passwordSchema.safeParse({ password: formData.get("password") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "ข้อมูลไม่ถูกต้อง" };

  const ipKey = normalizeIpForRateLimit(getClientIp(await headers()));
  const gate = loginLimiter.check(ipKey);
  if (!gate.allowed) {
    const minutes = Math.max(1, Math.ceil(gate.retryAfterSeconds / 60));
    return { error: `ลองรหัสผิดหลายครั้งเกินไป กรุณารอประมาณ ${minutes} นาทีแล้วลองใหม่` };
  }

  // ชะลอรวมทั้งระบบเมื่อมีการเดารหัสหนาแน่น (ไม่ปฏิเสธ — เจ้าของร้านรอไม่เกินเพดานแล้วเข้าได้ตามปกติ)
  const wait = loginLimiter.globalDelayMs();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));

  if (!verifyOwnerPassword(parsed.data.password, process.env.ADMIN_PASSWORD)) {
    loginLimiter.recordFailure(ipKey);
    return { error: "รหัสผ่านไม่ถูกต้อง" };
  }

  loginLimiter.reset(ipKey);
  if (!(await startSession({ role: "owner" }))) return NOT_READY;
  redirect("/admin");
}

export async function loginDemoAction(): Promise<ActionState> {
  if (!(await requestHasSameOrigin())) return BAD_REQUEST;
  if (!isDemoLoginAvailable() || !getSessionKey()) {
    return { error: "โหมดเดโมปิดอยู่ ใช้งานได้เฉพาะเจ้าของร้านที่มีรหัสผ่าน" };
  }

  // ผูก session เดโมกับ demo_sid ของ browser นี้ (ถ้ายังไม่มีก็สร้างใหม่ ให้ออเดอร์ที่จะสร้างทีหลังจับคู่กันได้)
  const jar = await cookies();
  let sid = parseDemoSid(jar.get(DEMO_SID_COOKIE)?.value);
  if (!sid) {
    sid = generateDemoSid();
    jar.set(DEMO_SID_COOKIE, sid, demoSidCookieOptions());
  }

  if (!(await startSession({ role: "demo", sid }))) return NOT_READY;
  redirect("/admin");
}

export async function logoutAction(): Promise<void> {
  // logout ที่ถูกเรียกข้ามเว็บไม่ทำอะไร (กัน logout CSRF) — ผู้ใช้จริงมี Origin ตรงเสมอ
  if (!(await requestHasSameOrigin())) return;
  await endSession();
  redirect("/admin/login");
}
