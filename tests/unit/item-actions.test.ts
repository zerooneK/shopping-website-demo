import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

/**
 * unit test ของ Server Actions จัดการสินค้า (mock next/*, DB, คำสั่ง, Blob SDK)
 * เน้น: ลำดับตรวจ Origin → session → สิทธิ์ → Zod → รูป → คำสั่ง, สิทธิ์ owner/demo ที่ฝั่ง server (ไม่พึ่ง UI),
 * demo ไม่มีทางไปถึงคำสั่ง DB / Blob (อัปโหลด ลบรูป ลบสินค้า), และ updateTag("items") หลังบันทึก
 */

const mocks = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  headers: new Headers(),
  updateTag: vi.fn(),
  revalidatePath: vi.fn(),
  createItem: vi.fn(),
  updateItem: vi.fn(),
  changeItemStatus: vi.fn(),
  deleteItem: vi.fn(),
  head: vi.fn(),
  del: vi.fn(),
  existingImages: [] as { url: string; alt: string }[],
  existingRowMissing: false,
  /** ไฟล์ (items/<ชื่อ>) ที่ "ยังมีสินค้าอื่นอ้างอยู่" ตาม DB จำลอง */
  stillReferenced: new Set<string>(),
  unref: vi.fn(),
}));

class RedirectSignal extends Error {
  constructor(public url: string) {
    super("NEXT_REDIRECT");
  }
}

vi.mock("next/headers", () => ({
  headers: async () => mocks.headers,
  cookies: async () => ({
    get: (name: string) => (mocks.jar.has(name) ? { name, value: mocks.jar.get(name) } : undefined),
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("next/cache", () => ({ updateTag: mocks.updateTag, revalidatePath: mocks.revalidatePath }));
vi.mock("@/db/client", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: async () => (mocks.existingRowMissing ? [] : [{ images: mocks.existingImages }]),
      }),
    }),
  }),
}));
vi.mock("@/lib/admin/item-commands", () => ({
  createItem: mocks.createItem,
  updateItem: mocks.updateItem,
  changeItemStatus: mocks.changeItemStatus,
  deleteItem: mocks.deleteItem,
}));
vi.mock("@/lib/item-image-ref", () => ({ unreferencedUploadPathnames: mocks.unref }));
vi.mock("@vercel/blob", async (orig) => ({
  ...(await orig<typeof import("@vercel/blob")>()),
  head: mocks.head,
  del: mocks.del,
}));

import { BlobNotFoundError } from "@vercel/blob";
import {
  changeItemStatusAction,
  createItemAction,
  deleteItemAction,
  updateItemAction,
} from "@/app/admin/(protected)/items/actions";
import { SESSION_COOKIE, signSession, getSessionKey } from "@/lib/auth";

const SECRET = "t".repeat(40);
const SID = "D".repeat(32);
const UP = "/api/item-images/up-aaaa1111-BbBb22.jpg";

function form(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

function valid(over: Record<string, string> = {}) {
  return {
    itemId: "5",
    title: "เสื้อ",
    description: "รายละเอียด",
    flaws: "ไม่มีตำหนิที่สังเกตเห็น",
    condition: "good",
    category: "fashion",
    price: "500",
    sortOrder: "0",
    images: JSON.stringify([{ url: UP, alt: "รูป" }]),
    ...over,
  };
}

async function login(role: "owner" | "demo" | null) {
  mocks.jar.clear();
  if (role === null) return;
  const key = getSessionKey()!;
  mocks.jar.set(SESSION_COOKIE, await signSession(role === "owner" ? { role: "owner" } : { role: "demo", sid: SID }, key));
}

function sameOrigin(extra: Record<string, string> = {}) {
  mocks.headers = new Headers({ origin: "https://shop.test", host: "shop.test", ...extra });
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

function expectNothingTouched() {
  expect(mocks.createItem).not.toHaveBeenCalled();
  expect(mocks.updateItem).not.toHaveBeenCalled();
  expect(mocks.changeItemStatus).not.toHaveBeenCalled();
  expect(mocks.deleteItem).not.toHaveBeenCalled();
  expect(mocks.head).not.toHaveBeenCalled();
  expect(mocks.del).not.toHaveBeenCalled();
  expect(mocks.updateTag).not.toHaveBeenCalled();
  expect(mocks.revalidatePath).not.toHaveBeenCalled();
}

beforeEach(async () => {
  for (const k of ["createItem", "updateItem", "changeItemStatus", "deleteItem", "head", "del", "updateTag", "revalidatePath"] as const) {
    mocks[k].mockReset();
  }
  mocks.existingImages = [];
  mocks.existingRowMissing = false;
  mocks.stillReferenced = new Set();
  mocks.unref.mockReset();
  mocks.unref.mockImplementation(async (_db: unknown, removed: { url: string }[]) =>
    removed
      .map((r) => r.url.replace("/api/item-images/", "items/"))
      .filter((p) => p.startsWith("items/") && !mocks.stillReferenced.has(p)),
  );
  vi.stubEnv("SESSION_SECRET", SECRET);
  vi.stubEnv("DEMO_MODE", "true");
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-blob-token");
  sameOrigin();
  await login("owner");
  mocks.head.mockImplementation(async (p: string) => ({ pathname: p, contentType: "image/jpeg", size: 1234 }));
});
afterEach(() => vi.unstubAllEnvs());

const ALL_ACTIONS = [
  ["createItemAction", (f: FormData) => createItemAction({}, f), () => valid({ code: "A013", status: "available" })],
  ["updateItemAction", (f: FormData) => updateItemAction({}, f), () => valid({ status: "available" })],
  ["changeItemStatusAction", (f: FormData) => changeItemStatusAction({}, f), () => ({ itemId: "5", status: "hidden" })],
  ["deleteItemAction", (f: FormData) => deleteItemAction({}, f), () => ({ itemId: "5", confirm: "yes" })],
] as const;

describe.each(ALL_ACTIONS)("%s: ด่านป้องกัน", (_name, run, fields) => {
  it("Origin ไม่ตรง / ไม่มี → ปฏิเสธ ไม่แตะ DB/Blob/cache", async () => {
    sameOrigin({ origin: "https://evil.example" });
    expect((await run(form(fields()))).error).toContain("คำขอไม่ถูกต้อง");
    mocks.headers = new Headers({ host: "shop.test" });
    expect((await run(form(fields()))).error).toContain("คำขอไม่ถูกต้อง");
    expectNothingTouched();
  });

  it("ไม่มี session / cookie ปลอม / SESSION_SECRET ไม่ตั้ง → ปฏิเสธ", async () => {
    await login(null);
    expect((await run(form(fields()))).error).toContain("เซสชันหมดอายุ");
    mocks.jar.set(SESSION_COOKIE, "not-a-jwt");
    expect((await run(form(fields()))).error).toContain("เซสชันหมดอายุ");
    await login("owner");
    vi.stubEnv("SESSION_SECRET", "");
    expect((await run(form(fields()))).error).toContain("เซสชันหมดอายุ");
    expectNothingTouched();
  });

  it("role demo → ไม่มีสิทธิ์ แม้ส่งฟอร์มที่ถูกต้องทุกช่อง (ปฏิเสธที่ server ก่อน Zod/DB/Blob)", async () => {
    await login("demo");
    const r = await run(form(fields()));
    expect(r.error).toContain("ไม่มีสิทธิ์");
    expect(r.ok).toBeUndefined();
    expectNothingTouched();
  });

  it("demo ที่ DEMO_MODE ถูกปิดภายหลัง → session ใช้ไม่ได้", async () => {
    await login("demo");
    vi.stubEnv("DEMO_MODE", "false");
    expect((await run(form(fields()))).error).toContain("เซสชันหมดอายุ");
    expectNothingTouched();
  });
});

describe("createItemAction (owner)", () => {
  const fields = (over: Record<string, string> = {}) => form(valid({ code: "A013", status: "available", ...over }));

  it("สำเร็จ → ตรวจรูปด้วย head, สร้างสินค้า, updateTag('items') (อาร์กิวเมนต์เดียว), redirect ไปหน้าแก้", async () => {
    mocks.createItem.mockResolvedValue({ ok: true, id: 42 });
    expect(await redirectTarget(createItemAction({}, fields()))).toBe("/admin/items/42");
    expect(mocks.head).toHaveBeenCalledWith("items/up-aaaa1111-BbBb22.jpg");
    expect(mocks.createItem).toHaveBeenCalledTimes(1);
    const arg = mocks.createItem.mock.calls[0][1];
    expect(arg).toMatchObject({
      code: "A013",
      status: "available",
      fields: { title: "เสื้อ", price: 500, sortOrder: 0, condition: "good", category: "fashion" },
      images: [{ url: UP, alt: "รูป" }],
    });
    expect(mocks.updateTag).toHaveBeenCalledWith("items");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/admin", "layout"); // ถอดแล้วหลังบ้านค้างข้อมูลเก่า
    expect(mocks.revalidatePath).toHaveBeenCalledTimes(1);
  });

  it("ราคา <= 0 หรือไม่ใช่จำนวนเต็ม → fieldErrors.price และไม่เรียกคำสั่ง", async () => {
    for (const price of ["0", "-1", "9.5", "abc", ""]) {
      const r = await createItemAction({}, fields({ price }));
      expect(r.fieldErrors?.price, price).toBeTruthy();
    }
    expect(mocks.createItem).not.toHaveBeenCalled();
    expect(mocks.updateTag).not.toHaveBeenCalled();
  });

  it("ตำหนิว่าง / รหัสผิดรูปแบบ → fieldErrors", async () => {
    expect((await createItemAction({}, fields({ flaws: "  " }))).fieldErrors?.flaws).toBeTruthy();
    expect((await createItemAction({}, fields({ code: "B1" }))).fieldErrors?.code).toBeTruthy();
    expect(mocks.createItem).not.toHaveBeenCalled();
  });

  it("รหัสซ้ำ → ข้อความไทยที่ช่องรหัส ไม่ revalidate", async () => {
    mocks.createItem.mockResolvedValue({ ok: false, error: "code_taken" });
    const r = await createItemAction({}, fields());
    expect(r.fieldErrors?.code).toContain("ถูกใช้แล้ว");
    expect(mocks.updateTag).not.toHaveBeenCalled();
  });

  it("รูปที่ไม่ใช่ของเรา (URL ภายนอก) ถูกปฏิเสธก่อนถึง DB", async () => {
    const r = await createItemAction({}, fields({ images: JSON.stringify([{ url: "https://evil.example/x.jpg", alt: "x" }]) }));
    expect(r.fieldErrors?.images).toBeTruthy();
    expect(mocks.createItem).not.toHaveBeenCalled();
  });

  it("ไม่มี BLOB_READ_WRITE_TOKEN → เพิ่มรูปใหม่ไม่ได้", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    const r = await createItemAction({}, fields());
    expect(r.error).toContain("Vercel Blob");
    expect(mocks.head).not.toHaveBeenCalled();
    expect(mocks.createItem).not.toHaveBeenCalled();
  });

  it("DB ล้ม → ข้อความทั่วไป ไม่รั่วรายละเอียด", async () => {
    mocks.createItem.mockRejectedValue(new Error("connection string postgres://secret"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await createItemAction({}, fields());
    expect(r.error).toBe("ระบบขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้ง");
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
    log.mockRestore();
  });
});

describe("updateItemAction (owner)", () => {
  it("สำเร็จ → updateItem รับ id/fields/status แล้ว updateTag('items') + คืนข้อความสำเร็จ", async () => {
    mocks.existingImages = [{ url: UP, alt: "เดิม" }];
    mocks.updateItem.mockResolvedValue({ ok: true, statusChanged: false, removedImages: [] });
    const r = await updateItemAction({}, form(valid({ price: "650", status: "hidden" })));
    expect(r).toMatchObject({ ok: true });
    expect(mocks.updateItem.mock.calls[0][1]).toMatchObject({ id: 5, fields: { price: 650 }, status: "hidden" });
    expect(mocks.updateTag).toHaveBeenCalledWith("items");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/admin", "layout"); // ถอดแล้วหลังบ้านค้างข้อมูลเก่า
    expect(mocks.revalidatePath).toHaveBeenCalledTimes(1);
    expect(mocks.head).not.toHaveBeenCalled(); // รูปเดิมไม่ต้องตรวจ Blob
  });

  it("ไม่ส่ง status (สินค้าที่ออเดอร์ถือ) → ส่ง undefined ให้คำสั่ง", async () => {
    mocks.existingImages = [{ url: UP, alt: "เดิม" }];
    mocks.updateItem.mockResolvedValue({ ok: true, statusChanged: false, removedImages: [] });
    await updateItemAction({}, form(valid()));
    expect(mocks.updateItem.mock.calls[0][1].status).toBeUndefined();
  });

  it("price <= 0 → ปฏิเสธก่อนอ่าน DB/เรียกคำสั่ง", async () => {
    const r = await updateItemAction({}, form(valid({ price: "0" })));
    expect(r.fieldErrors?.price).toBeTruthy();
    expect(mocks.updateItem).not.toHaveBeenCalled();
  });

  it("สินค้าถูกออเดอร์ถือ (item_held) → ข้อความไทย ไม่ revalidate", async () => {
    mocks.existingImages = [{ url: UP, alt: "เดิม" }];
    mocks.updateItem.mockResolvedValue({ ok: false, error: "item_held" });
    const r = await updateItemAction({}, form(valid({ status: "hidden" })));
    expect(r.error).toContain("มีออเดอร์ถืออยู่");
    expect(mocks.updateTag).not.toHaveBeenCalled();
  });

  it("ไม่พบสินค้า (id ไม่มีใน DB / id ผิดรูปแบบ)", async () => {
    mocks.existingRowMissing = true;
    expect((await updateItemAction({}, form(valid()))).error).toContain("ไม่พบสินค้า");
    mocks.existingRowMissing = false;
    expect((await updateItemAction({}, form(valid({ itemId: "abc" })))).error).toContain("ไม่พบสินค้า");
    expect(mocks.updateItem).not.toHaveBeenCalled();
  });

  it("เอารูปอัปโหลดออกจากสินค้า → ลบไฟล์ใน Blob หลังบันทึก โดยใช้ removedImages ที่คำสั่งคืน (ไม่ใช่ existing ที่อ่านนอก tx)", async () => {
    const KEEP = "/api/item-images/keep-0000.jpg";
    const STALE = "/api/item-images/stale-1111.jpg"; // existing (อ่านนอก tx) เห็นแต่แถวที่ล็อกแล้วไม่มีรูปนี้ → ห้ามลบ
    mocks.existingImages = [
      { url: UP, alt: "เก่า" },
      { url: STALE, alt: "ล้าสมัย" },
      { url: KEEP, alt: "คงไว้" },
      { url: "https://images.unsplash.com/photo-1", alt: "unsplash" },
    ];
    mocks.updateItem.mockResolvedValue({
      ok: true,
      statusChanged: false,
      removedImages: [{ url: UP, alt: "เก่า" }],
    });
    const r = await updateItemAction(
      {},
      form(valid({ images: JSON.stringify([{ url: KEEP, alt: "คงไว้" }]) })),
    );
    expect(r.ok).toBe(true);
    expect(mocks.del).toHaveBeenCalledTimes(1);
    expect(mocks.del).toHaveBeenCalledWith(["items/up-aaaa1111-BbBb22.jpg"]);
    expect(mocks.updateTag.mock.invocationCallOrder[0]).toBeLessThan(mocks.del.mock.invocationCallOrder[0]);
  });

  it("ไฟล์ที่ถูกเอาออกแต่ยังมีสินค้าอื่นอ้างอยู่ → ไม่ลบไฟล์; ไฟล์ที่ไม่มีใครอ้างลบตามปกติ", async () => {
    const OTHER = "/api/item-images/shared-2222.jpg";
    const KEEP = "/api/item-images/keep-0000.jpg";
    mocks.existingImages = [
      { url: UP, alt: "เก่า" },
      { url: OTHER, alt: "ใช้ร่วม" },
      { url: KEEP, alt: "คงไว้" },
    ];
    mocks.stillReferenced = new Set(["items/shared-2222.jpg"]);
    mocks.updateItem.mockResolvedValue({
      ok: true,
      statusChanged: false,
      removedImages: [
        { url: UP, alt: "เก่า" },
        { url: OTHER, alt: "ใช้ร่วม" },
      ],
    });
    const r = await updateItemAction({}, form(valid({ images: JSON.stringify([{ url: KEEP, alt: "คงไว้" }]) })));
    expect(r.ok).toBe(true);
    expect(mocks.unref).toHaveBeenCalledTimes(1);
    expect(mocks.del).toHaveBeenCalledTimes(1);
    expect(mocks.del).toHaveBeenCalledWith(["items/up-aaaa1111-BbBb22.jpg"]);
  });

  it("เช็กการอ้างอิงใน DB ล้มเหลว → ไม่ลบไฟล์เลย แต่ผลบันทึกยังสำเร็จ", async () => {
    mocks.existingImages = [{ url: UP, alt: "เก่า" }];
    mocks.updateItem.mockResolvedValue({ ok: true, statusChanged: false, removedImages: [{ url: UP, alt: "เก่า" }] });
    mocks.unref.mockRejectedValue(new Error("db down"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await updateItemAction({}, form(valid({ images: "[]", status: "hidden" })));
    expect(r.ok).toBe(true);
    expect(mocks.del).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("ลบไฟล์ Blob ล้มเหลว → ผลบันทึกยังสำเร็จ (best-effort)", async () => {
    mocks.existingImages = [{ url: UP, alt: "เก่า" }];
    mocks.updateItem.mockResolvedValue({ ok: true, statusChanged: false, removedImages: [{ url: UP, alt: "เก่า" }] });
    mocks.del.mockRejectedValue(new Error("blob down"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await updateItemAction({}, form(valid({ images: "[]", status: "hidden" })));
    expect(r.ok).toBe(true);
    log.mockRestore();
  });

  it("รูปใหม่ที่ไม่พบใน Blob → ปฏิเสธ ไม่บันทึก", async () => {
    mocks.head.mockRejectedValue(new BlobNotFoundError());
    const r = await updateItemAction({}, form(valid()));
    expect(r.fieldErrors?.images).toContain("ไม่พบไฟล์");
    expect(mocks.updateItem).not.toHaveBeenCalled();
  });
});

describe("changeItemStatusAction (owner)", () => {
  it("สำเร็จ → updateTag; สถานะเดิม (changed=false) → ไม่ revalidate", async () => {
    mocks.changeItemStatus.mockResolvedValue({ ok: true, changed: true });
    expect(await changeItemStatusAction({}, form({ itemId: "5", status: "hidden" }))).toMatchObject({ ok: true });
    expect(mocks.changeItemStatus.mock.calls[0][1]).toEqual({ id: 5, status: "hidden" });
    expect(mocks.updateTag).toHaveBeenCalledWith("items");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/admin", "layout"); // ถอดแล้วหลังบ้านค้างข้อมูลเก่า
    expect(mocks.revalidatePath).toHaveBeenCalledTimes(1);

    mocks.updateTag.mockReset();
    mocks.revalidatePath.mockReset();
    mocks.changeItemStatus.mockResolvedValue({ ok: true, changed: false });
    await changeItemStatusAction({}, form({ itemId: "5", status: "hidden" }));
    expect(mocks.updateTag).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("สินค้าถูกถือ → ข้อความไทย; status แปลก (reserved) → ปฏิเสธก่อนคำสั่ง", async () => {
    mocks.changeItemStatus.mockResolvedValue({ ok: false, error: "item_held" });
    expect((await changeItemStatusAction({}, form({ itemId: "5", status: "available" }))).error).toContain("มีออเดอร์ถืออยู่");
    mocks.changeItemStatus.mockClear();
    expect((await changeItemStatusAction({}, form({ itemId: "5", status: "reserved" }))).error).toBe("ข้อมูลไม่ถูกต้อง");
    expect(mocks.changeItemStatus).not.toHaveBeenCalled();
  });
});

describe("deleteItemAction (owner)", () => {
  it("ต้องติ๊กยืนยัน; สำเร็จ → ลบไฟล์รูปของเรา แล้ว redirect /admin/items", async () => {
    expect((await deleteItemAction({}, form({ itemId: "5" }))).error).toContain("ยืนยัน");
    expect(mocks.deleteItem).not.toHaveBeenCalled();

    mocks.deleteItem.mockResolvedValue({
      ok: true,
      images: [
        { url: UP, alt: "x" },
        { url: "https://images.unsplash.com/photo-1", alt: "u" },
      ],
    });
    expect(await redirectTarget(deleteItemAction({}, form({ itemId: "5", confirm: "yes" })))).toBe("/admin/items");
    expect(mocks.updateTag).toHaveBeenCalledWith("items");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/admin", "layout"); // ถอดแล้วหลังบ้านค้างข้อมูลเก่า
    expect(mocks.revalidatePath).toHaveBeenCalledTimes(1);
    expect(mocks.del).toHaveBeenCalledWith(["items/up-aaaa1111-BbBb22.jpg"]);
  });

  it("ลบสินค้า: ไฟล์ที่ยังมีสินค้าอื่นอ้างอยู่ไม่ถูกลบ", async () => {
    mocks.stillReferenced = new Set(["items/up-aaaa1111-BbBb22.jpg"]);
    mocks.deleteItem.mockResolvedValue({ ok: true, images: [{ url: UP, alt: "x" }] });
    await redirectTarget(deleteItemAction({}, form({ itemId: "5", confirm: "yes" })));
    expect(mocks.del).not.toHaveBeenCalled();
  });

  it("มีออเดอร์ → ลบไม่ได้ ไม่ลบไฟล์ ไม่ revalidate", async () => {
    mocks.deleteItem.mockResolvedValue({ ok: false, error: "has_orders" });
    const r = await deleteItemAction({}, form({ itemId: "5", confirm: "yes" }));
    expect(r.error).toContain("ลบไม่ได้");
    expect(mocks.del).not.toHaveBeenCalled();
    expect(mocks.updateTag).not.toHaveBeenCalled();
  });
});
