import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";

/**
 * Integration test กับ Postgres (Neon) จริง สำหรับจัดการสินค้าหลังบ้าน (ขั้น 3c-2):
 *  - คำสั่ง lib/admin/item-commands.ts (create/update/changeStatus/delete) บน DB จริง
 *  - เปลี่ยนสถานะสินค้าที่ "มีออเดอร์ถืออยู่" ไม่ได้ (pending ที่ยังไม่หมดเวลา / awaiting_review / confirmed) แต่ออเดอร์ที่ปิดแล้วไม่ถือ
 *  - race: ลูกค้าจองพร้อมกับที่แอดมินซ่อนสินค้า → ผลสอดคล้องเสมอ (ไม่มีออเดอร์ถือสินค้าที่ถูกซ่อน)
 *  - Server Actions จริง (mock เฉพาะ next/* และ Blob SDK): owner แก้ราคาได้, price <= 0 ถูกปฏิเสธ DB ไม่เปลี่ยน,
 *    demo แก้/เปลี่ยนสถานะ/ลบไม่ได้ DB ไม่เปลี่ยน
 *
 * ใช้รหัสสินค้า W701-W760 เท่านั้น ลบเฉพาะแถวของตัวเองก่อน/หลังรัน — ห้ามแตะ seed
 * รัน: npm run test:integration
 */

const mocks = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  headers: new Headers(),
  updateTag: vi.fn(),
  revalidatePath: vi.fn(),
  head: vi.fn(),
  del: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: async () => mocks.headers,
  cookies: async () => ({
    get: (name: string) => (mocks.jar.has(name) ? { name, value: mocks.jar.get(name) } : undefined),
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("next/cache", () => ({ updateTag: mocks.updateTag, revalidatePath: mocks.revalidatePath }));
vi.mock("@vercel/blob", async (orig) => ({
  ...(await orig<typeof import("@vercel/blob")>()),
  head: mocks.head,
  del: mocks.del,
}));

import { getDb } from "@/db/client";
import { items, orderEvents, orders } from "@/db/schema";
import {
  changeItemStatusAction,
  deleteItemAction,
  updateItemAction,
} from "@/app/admin/(protected)/items/actions";
import { changeItemStatus, createItem, deleteItem, updateItem, type ItemFields } from "@/lib/admin/item-commands";
import { getAdminItem, listAdminItems } from "@/lib/admin/item-queries";
import { SESSION_COOKIE, getSessionKey, signSession } from "@/lib/auth";
import { isItemImageReferenced, unreferencedUploadPathnames } from "@/lib/item-image-ref";
import { adminTransition } from "@/lib/orders/admin-commands";
import { createDrizzleReserveStore, reserveItem } from "@/lib/reserve";
import { uploadSlip } from "@/lib/orders/commands";
import type { CreateOrderInput } from "@/lib/validation";


const HAS_DB = Boolean(process.env.DATABASE_URL);
if (!HAS_DB) {
  console.warn("[integration] ข้ามเทสต์: ไม่พบ DATABASE_URL (รันผ่าน `npm run test:integration`)");
}

const CODES = Array.from({ length: 60 }, (_, i) => `W${701 + i}`);
let seq = 0;
const nextCode = () => CODES[seq++];

let sidSeq = 0;
const newSid = () => `item-${Date.now().toString(36)}-${++sidSeq}-`.padEnd(40, "x");

const IMG = { url: "https://images.unsplash.com/photo-1?w=1", alt: "รูปทดสอบ" };
const FIELDS: ItemFields = {
  title: "ของทดสอบ",
  description: "integration test",
  flaws: "ไม่มีตำหนิที่สังเกตเห็น",
  condition: "good",
  category: "other",
  price: 100,
  sortOrder: 0,
};

const orderInput = (code: string): CreateOrderInput => ({
  code,
  customerName: "ตัวอย่าง ทดสอบ",
  phone: "0812345678",
  deliveryMethod: "pickup",
});

describe.skipIf(!HAS_DB)("จัดการสินค้าหลังบ้านบน Postgres จริง", () => {
  const db = HAS_DB ? getDb() : (undefined as never);
  const store = HAS_DB ? createDrizzleReserveStore(db) : (undefined as never);

  async function cleanup() {
    const ids = (await db.select({ id: items.id }).from(items).where(inArray(items.code, CODES))).map((r) => r.id);
    if (ids.length === 0) return;
    const orderIds = (await db.select({ id: orders.id }).from(orders).where(inArray(orders.itemId, ids))).map(
      (r) => r.id,
    );
    if (orderIds.length > 0) {
      await db.delete(orderEvents).where(inArray(orderEvents.orderId, orderIds));
      await db.delete(orders).where(inArray(orders.id, orderIds));
    }
    await db.delete(items).where(inArray(items.id, ids));
  }

  async function makeItem(over: Partial<typeof items.$inferInsert> = {}) {
    const code = nextCode();
    const [row] = await db
      .insert(items)
      .values({ code, ...FIELDS, images: [IMG], status: "available", ...over })
      .returning();
    return row;
  }
  const getItem = async (id: number) => (await db.select().from(items).where(eq(items.id, id)))[0];

  /** จองจริง (ออเดอร์ pending_payment ถือสินค้า) */
  async function reserve(code: string) {
    const r = await reserveItem(store, orderInput(code), newSid());
    if (!r.ok) throw new Error("reserve failed in test setup");
    return r.order;
  }

  beforeAll(cleanup);
  afterAll(cleanup);

  // ---------------------------------------------------------------- คำสั่ง

  describe("createItem", () => {
    it("สร้างได้ และรหัสซ้ำคืน code_taken (มีแถวเดียว ไม่ throw)", async () => {
      const code = nextCode();
      const a = await createItem(db, { code, fields: FIELDS, images: [IMG], status: "available" });
      expect(a.ok).toBe(true);
      const b = await createItem(db, { code, fields: { ...FIELDS, title: "ซ้ำ" }, images: [IMG], status: "available" });
      expect(b).toEqual({ ok: false, error: "code_taken" });
      const rows = await db.select().from(items).where(eq(items.code, code));
      expect(rows).toHaveLength(1);
      expect(rows[0].title).toBe("ของทดสอบ");
    });

    it("สินค้าที่แสดงบนหน้าร้านต้องมีรูป; ฉบับร่าง (hidden) ไม่มีรูปได้", async () => {
      const c1 = nextCode();
      expect(await createItem(db, { code: c1, fields: FIELDS, images: [], status: "available" })).toEqual({
        ok: false,
        error: "images_required",
      });
      expect(await db.select().from(items).where(eq(items.code, c1))).toHaveLength(0);
      const c2 = nextCode();
      expect((await createItem(db, { code: c2, fields: FIELDS, images: [], status: "hidden" })).ok).toBe(true);
      const [row] = await db.select().from(items).where(eq(items.code, c2));
      expect(row.status).toBe("hidden");
    });

    it("ตำหนิว่างถูกปฏิเสธโดย CHECK ของ DB ด้วย (ชั้นสุดท้าย)", async () => {
      await expect(
        createItem(db, { code: nextCode(), fields: { ...FIELDS, flaws: "   " }, images: [IMG], status: "available" }),
      ).rejects.toThrow();
    });
  });

  describe("updateItem", () => {
    it("แก้ข้อความ/ราคา/รูป/ลำดับ และคืนรูปที่ถูกเอาออก; updated_at เปลี่ยน", async () => {
      const it0 = await makeItem({ images: [IMG, { url: "/api/item-images/a.jpg", alt: "เก่า" }] });
      const r = await updateItem(db, {
        id: it0.id,
        fields: { ...FIELDS, title: "ชื่อใหม่", price: 777, sortOrder: 5 },
        images: [{ url: "/api/item-images/b.jpg", alt: "ใหม่" }, IMG],
      });
      expect(r).toMatchObject({ ok: true, statusChanged: false });
      expect(r.ok && r.removedImages).toEqual([{ url: "/api/item-images/a.jpg", alt: "เก่า" }]);
      const row = await getItem(it0.id);
      expect(row.title).toBe("ชื่อใหม่");
      expect(row.price).toBe(777);
      expect(row.sortOrder).toBe(5);
      expect(row.images.map((i) => i.url)).toEqual(["/api/item-images/b.jpg", IMG.url]);
      expect(row.status).toBe("available");
      expect(row.updatedAt.getTime()).toBeGreaterThan(it0.updatedAt.getTime() - 1);
    });

    it("ไม่พบสินค้า → not_found; ล้างรูปทั้งหมดของสินค้า available ไม่ได้ (images_required) และ DB ไม่เปลี่ยน", async () => {
      expect(await updateItem(db, { id: 2_000_000_000, fields: FIELDS, images: [IMG] })).toEqual({
        ok: false,
        error: "not_found",
      });
      const it0 = await makeItem();
      expect(await updateItem(db, { id: it0.id, fields: { ...FIELDS, title: "ควรไม่เปลี่ยน" }, images: [] })).toEqual({
        ok: false,
        error: "images_required",
      });
      expect((await getItem(it0.id)).title).toBe("ของทดสอบ");
      // แต่ถ้าตั้งเป็น hidden ในคำสั่งเดียวกัน ล้างรูปได้
      expect((await updateItem(db, { id: it0.id, fields: FIELDS, images: [], status: "hidden" })).ok).toBe(true);
    });
  });

  describe("เปลี่ยนสถานะสินค้าที่มีออเดอร์ถืออยู่ไม่ได้", () => {
    it("pending_payment ที่ยังไม่หมดเวลา: hidden/sold/available ถูกปฏิเสธ item_held และ DB ไม่เปลี่ยน; แก้ราคาได้", async () => {
      const it0 = await makeItem();
      const order = await reserve(it0.code);
      const before = await getItem(it0.id);
      expect(before.status).toBe("reserved");

      for (const status of ["hidden", "sold", "available"] as const) {
        expect(await changeItemStatus(db, { id: it0.id, status })).toEqual({ ok: false, error: "item_held" });
        expect(await updateItem(db, { id: it0.id, fields: FIELDS, images: [IMG], status })).toEqual({
          ok: false,
          error: "item_held",
        });
      }
      const after = await getItem(it0.id);
      expect(after.status).toBe("reserved");
      expect(after.reservedUntil?.getTime()).toBe(before.reservedUntil?.getTime());

      // แก้ราคา (ไม่แตะสถานะ) ได้ และออเดอร์เก็บยอด snapshot เดิม
      const r = await updateItem(db, { id: it0.id, fields: { ...FIELDS, price: 999 }, images: [IMG] });
      expect(r.ok).toBe(true);
      expect((await getItem(it0.id)).price).toBe(999);
      expect((await getItem(it0.id)).status).toBe("reserved");
      const [o] = await db.select().from(orders).where(eq(orders.id, order.id));
      expect(o.amount).toBe(100);

      const row = (await listAdminItems()).find((x) => x.id === it0.id)!;
      expect(row).toMatchObject({ status: "reserved", held: true, orderCount: 1 });
    });

    it("awaiting_review (reserved_until เป็น NULL) และ confirmed (sold) ก็ถือสินค้า; sold→sold ไม่ error (no-op)", async () => {
      const a = await makeItem();
      const oa = await reserve(a.code);
      expect((await uploadSlip(db, { token: oa.token, slipPath: `slips/${oa.id}/t.jpg` })).ok).toBe(true);
      expect((await getItem(a.id)).reservedUntil).toBeNull();
      expect(await changeItemStatus(db, { id: a.id, status: "hidden" })).toEqual({ ok: false, error: "item_held" });
      expect((await getItem(a.id)).status).toBe("reserved");

      // ยืนยัน → sold; ยังมีออเดอร์ confirmed ถืออยู่ จึงเปิดขายใหม่/ซ่อนไม่ได้
      const c = await adminTransition(db, { orderId: oa.id, intent: { type: "confirm" }, actor: { role: "owner" } });
      expect(c.ok).toBe(true);
      expect((await getItem(a.id)).status).toBe("sold");
      expect(await changeItemStatus(db, { id: a.id, status: "available" })).toEqual({ ok: false, error: "item_held" });
      expect(await changeItemStatus(db, { id: a.id, status: "hidden" })).toEqual({ ok: false, error: "item_held" });
      expect(await changeItemStatus(db, { id: a.id, status: "sold" })).toEqual({ ok: true, changed: false });
      expect((await getItem(a.id)).status).toBe("sold");
    });

    it("ออเดอร์หมดเวลา (pending_payment ที่ expires_at ผ่านแล้ว) ไม่ถือสินค้า → ซ่อนได้; ออเดอร์ที่ปฏิเสธแล้วก็ไม่ถือ", async () => {
      const a = await makeItem();
      const oa = await reserve(a.code);
      // ทำให้ออเดอร์หมดเวลาตามเวลาของ DB
      await db.execute(sql`UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id = ${oa.id}`);
      await db.execute(sql`UPDATE items SET reserved_until = now() - interval '1 minute' WHERE id = ${a.id}`);
      expect(await changeItemStatus(db, { id: a.id, status: "hidden" })).toEqual({ ok: true, changed: true });
      const row = await getItem(a.id);
      expect(row.status).toBe("hidden");
      expect(row.reservedUntil).toBeNull();

      const b = await makeItem();
      const ob = await reserve(b.code);
      expect((await uploadSlip(db, { token: ob.token, slipPath: `slips/${ob.id}/t.jpg` })).ok).toBe(true);
      const rj = await adminTransition(db, {
        orderId: ob.id,
        intent: { type: "reject", reason: "สลิปไม่ชัด" },
        actor: { role: "owner" },
      });
      expect(rj.ok).toBe(true);
      expect(await changeItemStatus(db, { id: b.id, status: "sold" })).toEqual({ ok: true, changed: true });
      expect((await getItem(b.id)).status).toBe("sold");
    });

    it("สินค้าว่างทั่วไป: available ↔ hidden ↔ sold สลับได้ และ reserved_until ถูกล้าง", async () => {
      const a = await makeItem();
      expect(await changeItemStatus(db, { id: a.id, status: "hidden" })).toEqual({ ok: true, changed: true });
      expect(await changeItemStatus(db, { id: a.id, status: "hidden" })).toEqual({ ok: true, changed: false });
      expect(await changeItemStatus(db, { id: a.id, status: "sold" })).toEqual({ ok: true, changed: true });
      expect(await changeItemStatus(db, { id: a.id, status: "available" })).toEqual({ ok: true, changed: true });
      expect((await getItem(a.id)).status).toBe("available");
      expect(await changeItemStatus(db, { id: 2_000_000_000, status: "hidden" })).toEqual({ ok: false, error: "not_found" });
    });

    it("สินค้าไม่มีรูปเปิดเป็น available/sold ไม่ได้ (images_required) แต่ซ่อนได้", async () => {
      const a = await makeItem({ images: [], status: "hidden" });
      expect(await changeItemStatus(db, { id: a.id, status: "available" })).toEqual({ ok: false, error: "images_required" });
      expect((await getItem(a.id)).status).toBe("hidden");
    });

    it("race: จองพร้อมกับซ่อน (ซ้ำ 15 รอบ) → ได้ผลอย่างใดอย่างหนึ่งเสมอ ไม่มีออเดอร์ถือสินค้าที่ถูกซ่อน", async () => {
      let reservedWins = 0;
      let hideWins = 0;
      for (let i = 0; i < 15; i++) {
        const it0 = await makeItem();
        const [res, chg] = await Promise.all([
          reserveItem(store, orderInput(it0.code), newSid()),
          changeItemStatus(db, { id: it0.id, status: "hidden" }),
        ]);
        const row = await getItem(it0.id);
        const orderRows = await db.select().from(orders).where(eq(orders.itemId, it0.id));

        if (res.ok) {
          // จองสำเร็จ: ต้องเป็น reserved มีออเดอร์ และการซ่อนต้องถูกปฏิเสธ
          reservedWins++;
          expect(chg).toEqual({ ok: false, error: "item_held" });
          expect(row.status).toBe("reserved");
          expect(orderRows).toHaveLength(1);
        } else {
          // ซ่อนชนะ: ไม่มีออเดอร์เลย และจองได้ unavailable
          hideWins++;
          expect(res.reason).toBe("unavailable");
          expect(chg).toEqual({ ok: true, changed: true });
          expect(row.status).toBe("hidden");
          expect(orderRows).toHaveLength(0);
        }
      }
      expect(reservedWins + hideWins).toBe(15);
    }, 120_000);
  });

  describe("deleteItem", () => {
    it("มีออเดอร์ (แม้ปิดแล้ว) → has_orders และสินค้ายังอยู่; ไม่มีออเดอร์ → ลบได้และคืนรูป", async () => {
      const a = await makeItem();
      const oa = await reserve(a.code);
      expect(await deleteItem(db, { id: a.id })).toEqual({ ok: false, error: "has_orders" });
      expect(await getItem(a.id)).toBeTruthy();

      // ออเดอร์ที่ปิดแล้ว (ยกเลิก) ก็ยังนับเป็นประวัติ → ลบไม่ได้
      await db.update(orders).set({ status: "cancelled" }).where(eq(orders.id, oa.id));
      expect(await deleteItem(db, { id: a.id })).toEqual({ ok: false, error: "has_orders" });

      const b = await makeItem({ images: [IMG, { url: "/api/item-images/x.jpg", alt: "x" }] });
      const r = await deleteItem(db, { id: b.id });
      expect(r.ok && r.images).toHaveLength(2);
      expect(await db.select().from(items).where(eq(items.id, b.id))).toHaveLength(0);
      expect(await deleteItem(db, { id: b.id })).toEqual({ ok: false, error: "not_found" });
    });
  });

  describe("getAdminItem / listAdminItems", () => {
    it("คืนสถานะที่มีผลจริง: reserved ที่ไม่มีผู้ถือ = available; นับออเดอร์", async () => {
      const a = await makeItem({ status: "reserved", reservedUntil: new Date(Date.now() - 60_000) });
      const d = await getAdminItem(a.id);
      expect(d).toMatchObject({ status: "available", held: false, orderCount: 0, code: a.code });
      expect(await getAdminItem(2_000_000_000)).toBeNull();
    });
  });

  // ---------------------------------------------------------------- Server Actions จริง

  describe("Server Actions บน DB จริง (owner/demo)", () => {
    const SECRET = "i".repeat(40);

    async function login(role: "owner" | "demo") {
      mocks.jar.clear();
      mocks.jar.set(
        SESSION_COOKIE,
        await signSession(role === "owner" ? { role: "owner" } : { role: "demo", sid: "S".repeat(40) }, getSessionKey()!),
      );
    }
    function form(fields: Record<string, string>) {
      const f = new FormData();
      for (const [k, v] of Object.entries(fields)) f.set(k, v);
      return f;
    }
    const editForm = (id: number, over: Record<string, string> = {}) =>
      form({
        itemId: String(id),
        title: "ชื่อจากฟอร์ม",
        description: "คำบรรยายจากฟอร์ม",
        flaws: "รอยเล็กน้อย",
        condition: "good",
        category: "other",
        price: "555",
        sortOrder: "0",
        images: JSON.stringify([IMG]),
        ...over,
      });

    beforeEach(() => {
      mocks.updateTag.mockReset();
      mocks.revalidatePath.mockReset();
      mocks.head.mockReset();
      mocks.del.mockReset();
      vi.stubEnv("SESSION_SECRET", SECRET);
      vi.stubEnv("DEMO_MODE", "true");
      mocks.headers = new Headers({ origin: "https://shop.test", host: "shop.test" });
    });
    afterEach(() => vi.unstubAllEnvs());

    it("owner แก้ราคาได้ → DB เปลี่ยนจริง + updateTag('items')", async () => {
      const a = await makeItem();
      await login("owner");
      const r = await updateItemAction({}, editForm(a.id, { price: "620" }));
      expect(r).toMatchObject({ ok: true });
      const row = await getItem(a.id);
      expect(row.price).toBe(620);
      expect(row.title).toBe("ชื่อจากฟอร์ม");
      expect(mocks.updateTag).toHaveBeenCalledWith("items");
    });

    it.each(["0", "-1", "12.5", "abc", ""])("owner ส่ง price=%j → ถูกปฏิเสธและ DB ไม่เปลี่ยน", async (price) => {
      const a = await makeItem();
      await login("owner");
      const r = await updateItemAction({}, editForm(a.id, { price }));
      expect(r.ok).toBeUndefined();
      expect(r.fieldErrors?.price).toBeTruthy();
      const row = await getItem(a.id);
      expect(row.price).toBe(100);
      expect(row.title).toBe("ของทดสอบ");
      expect(mocks.updateTag).not.toHaveBeenCalled();
    });

    it("owner เปลี่ยนสถานะสินค้าที่มีออเดอร์ถือผ่าน action → ถูกปฏิเสธ DB ไม่เปลี่ยน", async () => {
      const a = await makeItem();
      await reserve(a.code);
      await login("owner");
      const r = await changeItemStatusAction({}, form({ itemId: String(a.id), status: "hidden" }));
      expect(r.error).toContain("มีออเดอร์ถืออยู่");
      expect((await getItem(a.id)).status).toBe("reserved");
      const r2 = await updateItemAction({}, editForm(a.id, { status: "sold" }));
      expect(r2.error).toContain("มีออเดอร์ถืออยู่");
      expect(mocks.updateTag).not.toHaveBeenCalled();
    });

    it("demo: แก้/เปลี่ยนสถานะ/ลบไม่ได้ แม้ส่งฟอร์มถูกต้อง — DB ไม่เปลี่ยน ไม่แตะ Blob", async () => {
      const a = await makeItem();
      await login("demo");
      expect((await updateItemAction({}, editForm(a.id, { price: "1" }))).error).toContain("ไม่มีสิทธิ์");
      expect(
        (await changeItemStatusAction({}, form({ itemId: String(a.id), status: "hidden" }))).error,
      ).toContain("ไม่มีสิทธิ์");
      expect((await deleteItemAction({}, form({ itemId: String(a.id), confirm: "yes" }))).error).toContain("ไม่มีสิทธิ์");
      const row = await getItem(a.id);
      expect(row).toMatchObject({ price: 100, title: "ของทดสอบ", status: "available" });
      expect(mocks.updateTag).not.toHaveBeenCalled();
      expect(mocks.head).not.toHaveBeenCalled();
      expect(mocks.del).not.toHaveBeenCalled();
    });

    it("owner ลบสินค้าที่ไม่มีออเดอร์ได้ (redirect) + ลบเฉพาะไฟล์ items/ ของสินค้านั้น; มีออเดอร์ → ลบไม่ได้", async () => {
      const a = await makeItem({ images: [IMG, { url: "/api/item-images/del-1.jpg", alt: "x" }] });
      await login("owner");
      await expect(deleteItemAction({}, form({ itemId: String(a.id), confirm: "yes" }))).rejects.toThrow(
        "NEXT_REDIRECT:/admin/items",
      );
      expect(await db.select().from(items).where(eq(items.id, a.id))).toHaveLength(0);
      vi.stubEnv("BLOB_READ_WRITE_TOKEN", "x");
      // (ตัวลบไฟล์เรียกเฉพาะเมื่อมี token — ที่นี่ตรวจแค่ว่าไม่มีการลบ URL ภายนอก)
      for (const call of mocks.del.mock.calls) {
        expect((call[0] as string[]).every((p) => p.startsWith("items/"))).toBe(true);
      }

      const b = await makeItem();
      await reserve(b.code);
      const r = await deleteItemAction({}, form({ itemId: String(b.id), confirm: "yes" }));
      expect(r.error).toContain("ลบไม่ได้");
      expect(await getItem(b.id)).toBeTruthy();
    });

    it("updateItemAction จริง: เอารูปที่ใช้ร่วมกับสินค้าอื่นออก → ไม่ลบไฟล์ใน Blob; รูปที่ไม่มีใครใช้ → ลบ (ใช้ removedImages จากแถวที่ล็อกแล้ว)", async () => {
      vi.stubEnv("BLOB_READ_WRITE_TOKEN", "x");
      const U = () => `ref-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const shared = `${U()}.jpg`;
      const solo = `${U()}.jpg`;
      const sharedImg = { url: `/api/item-images/${shared}`, alt: "ใช้ร่วม" };
      const soloImg = { url: `/api/item-images/${solo}`, alt: "ของฉันคนเดียว" };
      const a = await makeItem({ images: [IMG, sharedImg, soloImg] });
      await makeItem({ images: [sharedImg] });
      await login("owner");
      mocks.del.mockReset();
      mocks.del.mockResolvedValue(undefined);
      const r = await updateItemAction(
        {},
        form({
          itemId: String(a.id),
          title: "ของทดสอบ",
          description: "integration test",
          flaws: "ไม่มีตำหนิที่สังเกตเห็น",
          condition: "good",
          category: "other",
          price: "100",
          sortOrder: "0",
          images: JSON.stringify([{ url: IMG.url, alt: IMG.alt }]),
        }),
      );
      expect(r).toMatchObject({ ok: true });
      expect(mocks.del).toHaveBeenCalledTimes(1);
      expect(mocks.del).toHaveBeenCalledWith([`items/${solo}`]);
    });
  describe("อ้างอิงรูปอัปโหลด (SQL @> บน jsonb จริง)", () => {
    const U = () => `ref-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    it("isItemImageReferenced: พบเมื่อมีสินค้า (รวมที่ซ่อน) อ้างไฟล์นั้นใน images; ไม่พบชื่ออื่น/ชื่อที่เป็นแค่ส่วนหนึ่ง", async () => {
      const f = `${U()}.jpg`;
      const a = await makeItem({ status: "hidden", images: [IMG, { url: `/api/item-images/${f}`, alt: "x" }] });
      expect(await isItemImageReferenced(db, f)).toBe(true);
      expect(await isItemImageReferenced(db, `${U()}.jpg`)).toBe(false);
      expect(await isItemImageReferenced(db, f.replace(".jpg", ""))).toBe(false);
      expect(await isItemImageReferenced(db, `x${f}`)).toBe(false);
      // ชื่อที่มีอักขระพิเศษของ JSON/SQL ไม่ทำให้ query พัง (ส่งเป็น parameter)
      expect(await isItemImageReferenced(db, `a"b'c\d.jpg`)).toBe(false);
      await db.delete(items).where(eq(items.id, a.id));
      expect(await isItemImageReferenced(db, f)).toBe(false);
    });

    it("unreferencedUploadPathnames: ข้ามไฟล์ที่สินค้าอื่นยังอ้างอยู่ / ไม่ใช่รูปอัปโหลดของเรา; ที่ไม่มีใครอ้างได้เข้ารายการลบ", async () => {
      const shared = `${U()}.jpg`;
      const orphan = `${U()}.png`;
      await makeItem({ images: [IMG, { url: `/api/item-images/${shared}`, alt: "ใช้ร่วม" }] });
      const removed = [
        { url: `/api/item-images/${shared}`, alt: "ใช้ร่วม" },
        { url: `/api/item-images/${orphan}`, alt: "กำพร้า" },
        { url: `/api/item-images/${orphan}`, alt: "ซ้ำ" },
        { url: "https://images.unsplash.com/photo-9", alt: "ภายนอก" },
        { url: "/api/item-images/../slips/x.jpg", alt: "พาธแปลก" },
      ];
      expect(await unreferencedUploadPathnames(db, removed)).toEqual([`items/${orphan}`]);
    });
  });
  });
});
