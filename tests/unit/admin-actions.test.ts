import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * unit test ของ Server Actions หลังบ้าน (mock next/headers, next/navigation, DB และคำสั่ง transition)
 * เน้นลำดับตรวจ: Origin → session → สิทธิ์ → Zod → คำสั่ง, และ login (ไม่มี fallback, rate limit, DEMO_MODE)
 */

const mocks = vi.hoisted(() => {
  const jar = new Map<string, string>();
  const setCalls: { name: string; value: string; options: Record<string, unknown> }[] = [];
  return {
    jar,
    setCalls,
    headers: new Headers(),
    adminTransition: vi.fn(),
    revalidatePath: vi.fn(),
  };
});

class RedirectSignal extends Error {
  constructor(public url: string) {
    super("NEXT_REDIRECT");
  }
}

vi.mock("next/headers", () => ({
  headers: async () => mocks.headers,
  cookies: async () => ({
    get: (name: string) => (mocks.jar.has(name) ? { name, value: mocks.jar.get(name) } : undefined),
    set: (name: string, value: string, options: Record<string, unknown> = {}) => {
      mocks.jar.set(name, value);
      mocks.setCalls.push({ name, value, options });
    },
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/db/client", () => ({ getDb: () => ({ fake: "db" }) }));
vi.mock("@/lib/orders/admin-commands", () => ({ adminTransition: mocks.adminTransition }));

import { transitionOrderAction } from "@/app/admin/(protected)/actions";
import { loginDemoAction, loginOwnerAction, logoutAction } from "@/app/admin/login/actions";
import { loginLimiter } from "@/lib/admin/login-limit";
import { SESSION_COOKIE, verifySession, getSessionKey } from "@/lib/auth";

const SECRET = "t".repeat(40);
const PASSWORD = "owner-password-for-tests";
const ORDER_ID = "11111111-1111-4111-8111-111111111111";

function form(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

function sameOrigin(extra: Record<string, string> = {}) {
  mocks.headers = new Headers({ origin: "https://shop.test", host: "shop.test", ...extra });
}

async function sessionFromJar() {
  return verifySession(mocks.jar.get(SESSION_COOKIE), getSessionKey());
}

async function redirectTarget(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RedirectSignal) return e.url;
    throw e;
  }
  throw new Error("expected redirect");
}

beforeEach(() => {
  mocks.jar.clear();
  mocks.setCalls.length = 0;
  mocks.adminTransition.mockReset();
  mocks.revalidatePath.mockReset();
  sameOrigin();
  vi.stubEnv("SESSION_SECRET", SECRET);
  vi.stubEnv("ADMIN_PASSWORD", PASSWORD);
  vi.stubEnv("DEMO_MODE", "true");
  vi.stubEnv("NODE_ENV", "production");
  // รีเซ็ตตัวนับของ IP ที่ใช้ในเทสต์
  loginLimiter.resetAll();
});
afterEach(() => vi.unstubAllEnvs());

describe("loginOwnerAction", () => {
  it("รหัสถูก → ตั้ง cookie session (httpOnly, lax, secure ใน production, 7 วัน) แล้ว redirect /admin", async () => {
    const target = await redirectTarget(loginOwnerAction({}, form({ password: PASSWORD })));
    expect(target).toBe("/admin");
    const c = mocks.setCalls.find((x) => x.name === SESSION_COOKIE)!;
    expect(c.options).toMatchObject({ httpOnly: true, sameSite: "lax", secure: true, path: "/", maxAge: 7 * 24 * 3600 });
    expect(await sessionFromJar()).toEqual({ role: "owner" });
  });

  it("รหัสผิด → ข้อความผิดพลาด ไม่ตั้ง cookie", async () => {
    const r = await loginOwnerAction({}, form({ password: "wrong-password-xx" }));
    expect(r.error).toBe("รหัสผ่านไม่ถูกต้อง");
    expect(mocks.jar.has(SESSION_COOKIE)).toBe(false);
  });

  it("ผิดเกินกำหนด → ล็อก แม้ครั้งถัดไปพิมพ์รหัสถูกก็เข้าไม่ได้จนกว่าจะพ้นเวลา", async () => {
    sameOrigin({ "x-forwarded-for": "203.0.113.9" });
    for (let i = 0; i < 5; i++) {
      expect((await loginOwnerAction({}, form({ password: "wrong-password-xx" }))).error).toBe("รหัสผ่านไม่ถูกต้อง");
    }
    const locked = await loginOwnerAction({}, form({ password: PASSWORD }));
    expect(locked.error).toContain("ลองรหัสผิดหลายครั้ง");
    expect(mocks.jar.has(SESSION_COOKIE)).toBe(false);
  });

  it("ไม่ได้ตั้ง SESSION_SECRET หรือ ADMIN_PASSWORD = fail-closed (แม้ส่งรหัสว่างหรือเดา)", async () => {
    vi.stubEnv("SESSION_SECRET", "");
    expect((await loginOwnerAction({}, form({ password: PASSWORD }))).error).toContain("ยังไม่พร้อม");
    vi.stubEnv("SESSION_SECRET", SECRET);
    vi.stubEnv("ADMIN_PASSWORD", "");
    expect((await loginOwnerAction({}, form({ password: "" }))).error).toBeTruthy();
    expect((await loginOwnerAction({}, form({ password: "undefined" }))).error).toContain("ยังไม่พร้อม");
    expect(mocks.jar.has(SESSION_COOKIE)).toBe(false);
  });

  it("SESSION_SECRET สั้นกว่า 32 = ไม่ยอมออก session", async () => {
    vi.stubEnv("SESSION_SECRET", "short-secret");
    expect((await loginOwnerAction({}, form({ password: PASSWORD }))).error).toContain("ยังไม่พร้อม");
    expect(mocks.jar.has(SESSION_COOKIE)).toBe(false);
  });

  it("Origin ไม่ตรง / ไม่มี → ปฏิเสธก่อนตรวจรหัส", async () => {
    sameOrigin({ origin: "https://evil.example" });
    expect((await loginOwnerAction({}, form({ password: PASSWORD }))).error).toContain("คำขอไม่ถูกต้อง");
    mocks.headers = new Headers({ host: "shop.test" });
    expect((await loginOwnerAction({}, form({ password: PASSWORD }))).error).toContain("คำขอไม่ถูกต้อง");
    expect(mocks.jar.has(SESSION_COOKIE)).toBe(false);
  });
});

describe("loginDemoAction", () => {
  it("DEMO_MODE=true → ออก session demo ผูกกับ demo_sid ที่มีอยู่ของ browser", async () => {
    const sid = "E".repeat(32);
    mocks.jar.set("demo_sid", sid);
    expect(await redirectTarget(loginDemoAction())).toBe("/admin");
    expect(await sessionFromJar()).toEqual({ role: "demo", sid });
    const c = mocks.setCalls.find((x) => x.name === SESSION_COOKIE)!;
    expect(c.options).toMatchObject({ httpOnly: true, sameSite: "lax", secure: true, maxAge: 24 * 3600 });
  });

  it("ยังไม่มี demo_sid → สร้างใหม่แล้วตั้ง cookie demo_sid ให้ตรงกับใน session", async () => {
    await redirectTarget(loginDemoAction());
    const sid = mocks.jar.get("demo_sid");
    expect(sid).toMatch(/^[A-Za-z0-9_-]{32,64}$/);
    expect(await sessionFromJar()).toEqual({ role: "demo", sid });
    expect(mocks.setCalls.find((x) => x.name === "demo_sid")!.options).toMatchObject({ httpOnly: true, sameSite: "lax" });
  });

  it("demo_sid ที่รูปแบบแปลก ไม่ถูกนำมาใช้", async () => {
    mocks.jar.set("demo_sid", "../../bad");
    await redirectTarget(loginDemoAction());
    expect(mocks.jar.get("demo_sid")).not.toBe("../../bad");
  });

  it("DEMO_MODE ไม่ใช่ true = ปฏิเสธ ไม่ออก session", async () => {
    vi.stubEnv("DEMO_MODE", "false");
    expect((await loginDemoAction()).error).toContain("โหมดเดโมปิดอยู่");
    vi.stubEnv("DEMO_MODE", "");
    expect((await loginDemoAction()).error).toContain("โหมดเดโมปิดอยู่");
    expect(mocks.jar.has(SESSION_COOKIE)).toBe(false);
  });

  it("ไม่มี SESSION_SECRET = ปฏิเสธแม้ DEMO_MODE=true", async () => {
    vi.stubEnv("SESSION_SECRET", "");
    expect((await loginDemoAction()).error).toBeTruthy();
    expect(mocks.jar.has(SESSION_COOKIE)).toBe(false);
  });

  it("Origin ไม่ตรง = ปฏิเสธ", async () => {
    sameOrigin({ origin: "https://evil.example" });
    expect((await loginDemoAction()).error).toContain("คำขอไม่ถูกต้อง");
    expect(mocks.jar.has(SESSION_COOKIE)).toBe(false);
  });
});

describe("logoutAction", () => {
  it("ล้าง cookie แล้ว redirect /admin/login", async () => {
    mocks.jar.set(SESSION_COOKIE, "something");
    expect(await redirectTarget(logoutAction())).toBe("/admin/login");
    expect(mocks.jar.get(SESSION_COOKIE)).toBe("");
    expect(mocks.setCalls.at(-1)!.options).toMatchObject({ maxAge: 0 });
  });

  it("ข้ามเว็บ (Origin ไม่ตรง) ไม่ทำอะไร", async () => {
    sameOrigin({ origin: "https://evil.example" });
    mocks.jar.set(SESSION_COOKIE, "something");
    await logoutAction();
    expect(mocks.jar.get(SESSION_COOKIE)).toBe("something");
  });
});

describe("transitionOrderAction", () => {
  async function loginAs(role: "owner" | "demo") {
    if (role === "owner") await redirectTarget(loginOwnerAction({}, form({ password: PASSWORD })));
    else await redirectTarget(loginDemoAction());
    mocks.adminTransition.mockReset();
  }

  it("Origin ไม่ตรง = ไม่แตะ DB/คำสั่ง", async () => {
    await loginAs("owner");
    sameOrigin({ origin: "https://evil.example" });
    const r = await transitionOrderAction({}, form({ orderId: ORDER_ID, intent: "confirm" }));
    expect(r.error).toContain("คำขอไม่ถูกต้อง");
    expect(mocks.adminTransition).not.toHaveBeenCalled();
  });

  it("ไม่มี session / token ปลอม = ปฏิเสธ ไม่เรียกคำสั่ง", async () => {
    const none = await transitionOrderAction({}, form({ orderId: ORDER_ID, intent: "confirm" }));
    expect(none.error).toContain("เซสชันหมดอายุ");
    mocks.jar.set(SESSION_COOKIE, "forged.token.value");
    const forged = await transitionOrderAction({}, form({ orderId: ORDER_ID, intent: "confirm" }));
    expect(forged.error).toContain("เซสชันหมดอายุ");
    expect(mocks.adminTransition).not.toHaveBeenCalled();
  });

  it("session เดโมที่ DEMO_MODE ถูกปิดแล้ว = ใช้ไม่ได้ทันที", async () => {
    await loginAs("demo");
    vi.stubEnv("DEMO_MODE", "false");
    const r = await transitionOrderAction({}, form({ orderId: ORDER_ID, intent: "confirm" }));
    expect(r.error).toContain("เซสชันหมดอายุ");
    expect(mocks.adminTransition).not.toHaveBeenCalled();
  });

  it("owner ยืนยันได้: เรียกคำสั่งด้วย role owner และ revalidate หลังบ้าน", async () => {
    await loginAs("owner");
    mocks.adminTransition.mockResolvedValue({ ok: true, from: "awaiting_review", to: "confirmed" });
    const r = await transitionOrderAction({}, form({ orderId: ORDER_ID, intent: "confirm" }));
    expect(r).toEqual({ ok: true, message: "ยืนยันการชำระเงินแล้ว" });
    expect(mocks.adminTransition).toHaveBeenCalledWith(
      { fake: "db" },
      { orderId: ORDER_ID, actor: { role: "owner" }, intent: { type: "confirm" } },
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/admin", "layout");
  });

  it("demo: ส่ง session (role + sid) เข้าคำสั่งเพื่อให้คำสั่งบังคับขอบเขตออเดอร์ของตัวเอง", async () => {
    await loginAs("demo");
    const session = await sessionFromJar();
    expect(session).toMatchObject({ role: "demo" });
    mocks.adminTransition.mockResolvedValue({ ok: true, from: "awaiting_review", to: "rejected" });
    const r = await transitionOrderAction({}, form({ orderId: ORDER_ID, intent: "reject", reason: "ยอดไม่ตรง" }));
    expect(r.ok).toBe(true);
    expect(mocks.adminTransition).toHaveBeenCalledWith(
      { fake: "db" },
      { orderId: ORDER_ID, actor: session, intent: { type: "reject", reason: "ยอดไม่ตรง" } },
    );
    // actor ต้องมี sid ที่ตรงกับ demo_sid ของ browser (ไม่ใช่ค่าที่ client ส่งมาเอง)
    const call = mocks.adminTransition.mock.calls[0][1] as { actor: { sid: string } };
    expect(call.actor.sid).toBe(mocks.jar.get("demo_sid"));
  });

  it("demo เปลี่ยนสถานะออเดอร์ของคนอื่น → ข้อความอธิบายเหตุผล ไม่ revalidate", async () => {
    await loginAs("demo");
    mocks.adminTransition.mockResolvedValue({ ok: false, error: "not_your_order" });
    const r = await transitionOrderAction({}, form({ orderId: ORDER_ID, intent: "confirm" }));
    expect(r.ok).toBeUndefined();
    expect(r.error).toContain("เฉพาะออเดอร์ที่สร้างจากเบราว์เซอร์นี้");
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("ค่า sid/role ที่ client แนบมาในฟอร์มถูกเมิน (ใช้เฉพาะ session จาก cookie)", async () => {
    await loginAs("demo");
    const session = await sessionFromJar();
    mocks.adminTransition.mockResolvedValue({ ok: true, from: "awaiting_review", to: "confirmed" });
    await transitionOrderAction(
      {},
      form({ orderId: ORDER_ID, intent: "confirm", role: "owner", sid: "X".repeat(40), demoSessionId: "X".repeat(40) }),
    );
    expect(mocks.adminTransition).toHaveBeenCalledWith(
      { fake: "db" },
      { orderId: ORDER_ID, actor: session, intent: { type: "confirm" } },
    );
  });

  it("reject ไม่มีเหตุผล / ship ไม่มีเลขพัสดุ / intent แปลก / orderId ไม่ใช่ uuid → Zod ปฏิเสธก่อนถึงคำสั่ง", async () => {
    await loginAs("owner");
    expect((await transitionOrderAction({}, form({ orderId: ORDER_ID, intent: "reject" }))).error).toBe("กรุณาระบุเหตุผล");
    expect(
      (await transitionOrderAction({}, form({ orderId: ORDER_ID, intent: "reject", reason: "   " }))).error,
    ).toBe("กรุณาระบุเหตุผล");
    expect((await transitionOrderAction({}, form({ orderId: ORDER_ID, intent: "ship", trackingNo: "<b>" }))).error).toContain(
      "เลขพัสดุ",
    );
    expect((await transitionOrderAction({}, form({ orderId: ORDER_ID, intent: "delete" }))).error).toBe("ข้อมูลไม่ถูกต้อง");
    expect((await transitionOrderAction({}, form({ orderId: "1 OR 1=1", intent: "confirm" }))).error).toBe("ข้อมูลไม่ถูกต้อง");
    expect(mocks.adminTransition).not.toHaveBeenCalled();
  });

  it("return (คืนสินค้าเข้าร้าน): owner ส่งเหตุผลเข้าคำสั่ง; demo ถูกปฏิเสธที่ action โดยไม่เรียกคำสั่ง", async () => {
    await loginAs("owner");
    mocks.adminTransition.mockResolvedValue({ ok: true, from: "confirmed", to: "cancelled" });
    const ok = await transitionOrderAction({}, form({ orderId: ORDER_ID, intent: "return", reason: "ลูกค้าขอคืน" }));
    expect(ok).toEqual({ ok: true, message: "คืนสินค้าเข้าร้านและยกเลิกออเดอร์แล้ว" });
    expect(mocks.adminTransition).toHaveBeenCalledWith(
      { fake: "db" },
      { orderId: ORDER_ID, actor: { role: "owner" }, intent: { type: "return", reason: "ลูกค้าขอคืน" } },
    );
    // ไม่มีเหตุผล = Zod ปฏิเสธ
    mocks.adminTransition.mockClear();
    expect((await transitionOrderAction({}, form({ orderId: ORDER_ID, intent: "return" }))).error).toBe("กรุณาระบุเหตุผล");
    expect(mocks.adminTransition).not.toHaveBeenCalled();

    await loginAs("demo");
    const denied = await transitionOrderAction({}, form({ orderId: ORDER_ID, intent: "return", reason: "x" }));
    expect(denied.error).toContain("เฉพาะเจ้าของร้าน");
    expect(mocks.adminTransition).not.toHaveBeenCalled();
  });

  it("เดโมสิ้นสุดแล้วจากคำสั่ง → ข้อความไทยที่อธิบายได้ ไม่ revalidate", async () => {
    await loginAs("owner");
    mocks.adminTransition.mockResolvedValueOnce({ ok: false, error: "demo_ended", status: "confirmed" });
    const r = await transitionOrderAction({}, form({ orderId: ORDER_ID, intent: "complete" }));
    expect(r.error).toContain("สิ้นสุดแล้ว");
    expect(r.error).toContain("คืนสินค้าเข้าร้าน");
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("คำสั่งล้มเหลว (มีคนทำไปก่อน) → ข้อความไทย ไม่ revalidate; exception ภายในไม่รั่ว", async () => {
    await loginAs("owner");
    mocks.adminTransition.mockResolvedValueOnce({ ok: false, error: "invalid_state", status: "confirmed" });
    const r1 = await transitionOrderAction({}, form({ orderId: ORDER_ID, intent: "confirm" }));
    expect(r1.error).toContain("สถานะออเดอร์เปลี่ยนไปแล้ว");
    expect(mocks.revalidatePath).not.toHaveBeenCalled();

    mocks.adminTransition.mockRejectedValueOnce(new Error("connection string postgres://secret"));
    const r2 = await transitionOrderAction({}, form({ orderId: ORDER_ID, intent: "confirm" }));
    expect(r2.error).toContain("ระบบขัดข้อง");
    expect(JSON.stringify(r2)).not.toContain("postgres://");
  });
});
