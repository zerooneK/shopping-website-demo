import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

/**
 * unit test ของ cron รีเซ็ตรายวัน: ตรวจ Authorization (fail-closed, timing-safe), route (mock DB/Blob/cache),
 * ตัวลบสลิปแบบเป็นหน้าๆ (ลบเฉพาะ slips/), และการสุ่ม sold
 * ส่วน SQL จริง (ล้างออเดอร์/คืนสินค้า/advisory lock) ทดสอบกับ Neon จริงใน tests/integration/cron-reset.pg.test.ts
 */

const mocks = vi.hoisted(() => ({
  resetDemoData: vi.fn(),
  revalidateTag: vi.fn(),
  list: vi.fn(),
  del: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidateTag: mocks.revalidateTag }));
vi.mock("@/db/client", () => ({ getDb: () => ({ fake: "db" }) }));
vi.mock("@/lib/cron/reset", async (orig) => ({
  ...(await orig<typeof import("@/lib/cron/reset")>()),
  resetDemoData: mocks.resetDemoData,
}));
vi.mock("@vercel/blob", async (orig) => ({
  ...(await orig<typeof import("@vercel/blob")>()),
  list: mocks.list,
  del: mocks.del,
}));

import { GET, POST } from "@/app/api/cron/reset/route";
import { checkCronAuth, MIN_CRON_SECRET_LENGTH } from "@/lib/cron/auth";
import { cleanSlipBlobs, DEL_CHUNK, type BlobApi } from "@/lib/cron/blob-cleanup";
import { pickSoldCodes, SOLD_MAX, SOLD_MIN } from "@/lib/cron/reset";

const SECRET = "c".repeat(32);

describe("checkCronAuth (fail-closed, timing-safe)", () => {
  it("Bearer ตรงกับ CRON_SECRET → ok", () => {
    expect(checkCronAuth(`Bearer ${SECRET}`, SECRET)).toBe("ok");
    expect(checkCronAuth(`bearer ${SECRET}`, SECRET)).toBe("ok");
  });

  it("ไม่ได้ตั้ง CRON_SECRET (undefined/ว่าง/สั้นกว่า 16) → not_configured แม้ header ตรงกับค่านั้นพอดี", () => {
    for (const secret of [undefined, "", "short", "x".repeat(MIN_CRON_SECRET_LENGTH - 1)]) {
      expect(checkCronAuth(`Bearer ${secret ?? ""}`, secret)).toBe("not_configured");
      expect(checkCronAuth(undefined, secret)).toBe("not_configured");
      expect(checkCronAuth("Bearer undefined", secret)).toBe("not_configured");
      expect(checkCronAuth("Bearer ", secret)).toBe("not_configured");
    }
  });

  it("ตั้งค่าแล้วแต่ header ผิด/ไม่มี/รูปแบบแปลก → unauthorized", () => {
    for (const h of [
      null,
      undefined,
      "",
      "Bearer",
      "Bearer ",
      `Bearer ${SECRET}x`,
      `Bearer ${SECRET.slice(1)}`,
      `Bearer  ${SECRET}`,
      SECRET,
      `Basic ${SECRET}`,
      `Token ${SECRET}`,
      `Bearer ${"c".repeat(5000)}`,
      "Bearer undefined",
      "Bearer null",
    ]) {
      expect(checkCronAuth(h, SECRET), String(h)).toBe("unauthorized");
    }
  });

  it("ความลับยาวต่างกันไม่ทำให้ throw (เทียบผ่าน hash ความยาวเท่ากัน)", () => {
    expect(() => checkCronAuth("Bearer a", SECRET)).not.toThrow();
    expect(() => checkCronAuth(`Bearer ${"z".repeat(10_000)}`, SECRET)).not.toThrow();
  });
});

function req(method: "GET" | "POST", auth?: string) {
  return new Request("https://shop.test/api/cron/reset", {
    method,
    headers: auth === undefined ? {} : { authorization: auth },
  });
}

const RAN = {
  status: "ran" as const,
  dbNow: new Date("2026-10-14T20:00:00Z"),
  ordersDeleted: 3,
  eventsDeleted: 9,
  itemsUpserted: 12,
  itemsRemoved: 1,
  soldCodes: ["A002", "A009"],
};

describe("route /api/cron/reset", () => {
  beforeEach(() => {
    for (const m of Object.values(mocks)) m.mockReset();
    vi.stubEnv("CRON_SECRET", SECRET);
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "blob-token");
    mocks.resetDemoData.mockResolvedValue(RAN);
    mocks.list.mockResolvedValue({ blobs: [], hasMore: false });
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each(["GET", "POST"] as const)("%s ไม่มี Authorization → 401 และไม่แตะ DB/Blob/cache", async (method) => {
    const res = await (method === "GET" ? GET : POST)(req(method));
    expect(res.status).toBe(401);
    expect(mocks.resetDemoData).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.del).not.toHaveBeenCalled();
    expect(mocks.revalidateTag).not.toHaveBeenCalled();
  });

  it("secret ผิด → 401; ไม่ตั้ง CRON_SECRET → 401 (fail-closed) แม้ส่ง 'Bearer undefined' หรือ 'Bearer ' ", async () => {
    expect((await GET(req("GET", "Bearer wrong-secret-value-xxxxxxxx"))).status).toBe(401);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const secret of ["", "short"]) {
      vi.stubEnv("CRON_SECRET", secret);
      for (const h of ["Bearer undefined", "Bearer ", `Bearer ${secret}`, `Bearer ${SECRET}`]) {
        expect((await GET(req("GET", h))).status, `${secret}|${h}`).toBe(401);
      }
    }
    err.mockRestore();
    expect(mocks.resetDemoData).not.toHaveBeenCalled();
  });

  it("ไม่รั่วข้อมูลใน 401 และไม่ใช้ query string เป็นช่องทางส่ง secret", async () => {
    const res = await GET(new Request(`https://shop.test/api/cron/reset?secret=${SECRET}&authorization=${SECRET}`));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(mocks.resetDemoData).not.toHaveBeenCalled();
  });

  it("ผ่านด่าน → รีเซ็ต DB, revalidateTag('items', { expire: 0 }), ลบสลิปเฉพาะที่อัปโหลดก่อนเวลารีเซ็ต, ตอบสรุปไม่มี PII", async () => {
    mocks.list.mockResolvedValue({
      blobs: [
        { pathname: "slips/o1/slip-a.jpg", uploadedAt: new Date("2026-10-14T10:00:00Z") },
        { pathname: "slips/o2/slip-b.jpg", uploadedAt: new Date("2026-10-14T20:00:01Z") },
      ],
      hasMore: false,
    });
    const res = await GET(req("GET", `Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: "ran",
      db: { ordersDeleted: 3, itemsUpserted: 12, soldCodes: ["A002", "A009"] },
      blob: { deleted: 1, skippedNewer: 1 },
    });
    expect(JSON.stringify(body)).not.toMatch(/slips\/|customer|phone/i);
    expect(mocks.revalidateTag).toHaveBeenCalledWith("items", { expire: 0 });
    expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ prefix: "slips/" }));
    expect(mocks.del).toHaveBeenCalledWith(["slips/o1/slip-a.jpg"]);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("POST ใช้ได้เหมือน GET", async () => {
    expect((await POST(req("POST", `Bearer ${SECRET}`))).status).toBe(200);
    expect(mocks.resetDemoData).toHaveBeenCalledTimes(1);
  });

  it("ส่ง seed ที่ผ่านการตรวจ (12 ชิ้นจาก db/seed-data.json) ให้ resetDemoData", async () => {
    await GET(req("GET", `Bearer ${SECRET}`));
    const opts = mocks.resetDemoData.mock.calls[0][1] as { seedItems: { code: string }[] };
    expect(opts.seedItems).toHaveLength(12);
    expect(opts.seedItems.every((i) => /^A\d{3}$/.test(i.code))).toBe(true);
  });

  it("มีรอบอื่นรันอยู่ (advisory lock) → 200 skipped_locked ไม่ลบ Blob ไม่ revalidate", async () => {
    mocks.resetDemoData.mockResolvedValue({ status: "skipped_locked" });
    const res = await GET(req("GET", `Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "skipped_locked" });
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.revalidateTag).not.toHaveBeenCalled();
  });

  it("ไม่มี BLOB_READ_WRITE_TOKEN (dev) → ข้ามส่วน Blob พร้อม log และไม่ล้ม", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const res = await GET(req("GET", `Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ran", blob: { skipped: "no_blob_token" } });
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.del).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("BLOB_READ_WRITE_TOKEN"));
    expect(mocks.revalidateTag).toHaveBeenCalledTimes(1);
    expect(mocks.revalidateTag).toHaveBeenCalledWith("items", { expire: 0 });
    warn.mockRestore();
  });

  it("DB ล้ม → 500 ไม่รั่วรายละเอียด ไม่แตะ Blob; Blob ล้ม → 500 แต่ DB รีเซ็ตแล้ว (และ revalidate แล้ว)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.resetDemoData.mockRejectedValueOnce(new Error("postgres://user:pw@host/db"));
    const bad = await GET(req("GET", `Bearer ${SECRET}`));
    expect(bad.status).toBe(500);
    expect(JSON.stringify(await bad.json())).not.toContain("postgres");
    expect(JSON.stringify(err.mock.calls)).not.toContain("postgres");
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.revalidateTag).not.toHaveBeenCalled();

    mocks.list.mockRejectedValueOnce(new Error("blob down"));
    const blobBad = await GET(req("GET", `Bearer ${SECRET}`));
    expect(blobBad.status).toBe(500);
    expect(await blobBad.json()).toMatchObject({ status: "db_reset_blob_failed" });
    expect(mocks.revalidateTag).toHaveBeenCalledWith("items", { expire: 0 });
    err.mockRestore();
  });
});

describe("cleanSlipBlobs (list + del เป็นหน้าๆ)", () => {
  const BEFORE = new Date("2026-10-14T20:00:00Z");
  const old = (p: string) => ({ pathname: p, uploadedAt: new Date("2026-10-13T00:00:00Z") });

  function fakeApi(pages: { pathname: string; uploadedAt: Date }[][]) {
    const deleted: string[][] = [];
    const listCalls: { prefix: string; cursor?: string; limit: number }[] = [];
    const api: BlobApi = {
      list: async (o) => {
        listCalls.push(o);
        const i = o.cursor ? Number(o.cursor) : 0;
        return { blobs: pages[i] ?? [], cursor: i + 1 < pages.length ? String(i + 1) : undefined, hasMore: i + 1 < pages.length };
      },
      del: async (p) => {
        deleted.push(p);
      },
    };
    return { api, deleted, listCalls };
  }

  it("วนทุกหน้า ลบทุกไฟล์ใต้ slips/ ที่เก่ากว่าเวลารีเซ็ต แล้วรายงานจำนวน", async () => {
    const { api, deleted, listCalls } = fakeApi([[old("slips/a/1.jpg"), old("slips/a/2.jpg")], [old("slips/b/3.png")]]);
    const r = await cleanSlipBlobs(api, { before: BEFORE });
    expect(r).toMatchObject({ deleted: 3, pages: 2, truncated: false, skippedNewer: 0, skippedOutsidePrefix: 0 });
    expect(deleted.flat()).toEqual(["slips/a/1.jpg", "slips/a/2.jpg", "slips/b/3.png"]);
    expect(listCalls.every((c) => c.prefix === "slips/")).toBe(true);
    expect(listCalls[1].cursor).toBe("1");
  });

  it("ไม่มีทางลบ items/ (รูปสินค้า) หรือ path นอก slips/ แม้ list คืนมา", async () => {
    const { api, deleted } = fakeApi([
      [old("items/up-1.jpg"), old("slips/a/1.jpg"), old("other/x.jpg"), old("slipsX/y.jpg"), old("items/slips/z.jpg")],
    ]);
    const r = await cleanSlipBlobs(api, { before: BEFORE });
    expect(deleted.flat()).toEqual(["slips/a/1.jpg"]);
    expect(r.skippedOutsidePrefix).toBe(4);
  });

  it("ไม่ลบสลิปที่อัปโหลดหลัง/พร้อมเวลาเริ่มรีเซ็ต (ออเดอร์ใหม่)", async () => {
    const { api, deleted } = fakeApi([
      [
        old("slips/a/old.jpg"),
        { pathname: "slips/b/at.jpg", uploadedAt: BEFORE },
        { pathname: "slips/b/new.jpg", uploadedAt: new Date(BEFORE.getTime() + 1) },
      ],
    ]);
    const r = await cleanSlipBlobs(api, { before: BEFORE });
    expect(deleted.flat()).toEqual(["slips/a/old.jpg"]);
    expect(r.skippedNewer).toBe(2);
  });

  it("แบ่งลบเป็นก้อนละ <= DEL_CHUNK", async () => {
    const many = Array.from({ length: DEL_CHUNK * 2 + 5 }, (_, i) => old(`slips/o/${i}.jpg`));
    const { api, deleted } = fakeApi([many]);
    const r = await cleanSlipBlobs(api, { before: BEFORE });
    expect(r.deleted).toBe(many.length);
    expect(deleted.map((c) => c.length)).toEqual([DEL_CHUNK, DEL_CHUNK, 5]);
  });

  it("ถึงเพดานจำนวนหน้า → truncated=true (ที่เหลือลบรอบหน้า) ไม่วนไม่รู้จบ", async () => {
    const { api, listCalls } = fakeApi(Array.from({ length: 10 }, (_, i) => [old(`slips/p${i}/x.jpg`)]));
    const r = await cleanSlipBlobs(api, { before: BEFORE, maxPages: 3 });
    expect(r).toMatchObject({ pages: 3, truncated: true, deleted: 3 });
    expect(listCalls).toHaveLength(3);
  });

  it("ว่างเปล่า → ไม่เรียก del; list ล้ม → โยน error ขึ้นไป", async () => {
    const { api, deleted } = fakeApi([[]]);
    expect(await cleanSlipBlobs(api, { before: BEFORE })).toMatchObject({ deleted: 0, pages: 1 });
    expect(deleted).toHaveLength(0);
    await expect(
      cleanSlipBlobs({ list: async () => Promise.reject(new Error("x")), del: async () => undefined }, { before: BEFORE }),
    ).rejects.toThrow();
  });
});

describe("pickSoldCodes", () => {
  const codes = Array.from({ length: 12 }, (_, i) => `A${String(i + 1).padStart(3, "0")}`);

  it("ได้ 2–3 รหัส ไม่ซ้ำ และมาจาก seed เท่านั้น (ทดสอบ 500 รอบ)", () => {
    const sizes = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const picked = pickSoldCodes(codes);
      sizes.add(picked.length);
      expect(picked.length).toBeGreaterThanOrEqual(SOLD_MIN);
      expect(picked.length).toBeLessThanOrEqual(SOLD_MAX);
      expect(new Set(picked).size).toBe(picked.length);
      expect(picked.every((c) => codes.includes(c))).toBe(true);
    }
    expect([...sizes].sort()).toEqual([2, 3]);
  });

  it("random ที่กำหนดได้ → ผลคงที่ (ใช้ทดสอบ)", () => {
    expect(pickSoldCodes(codes, () => 0)).toHaveLength(2);
    expect(pickSoldCodes(codes, () => 0.999)).toHaveLength(3);
  });

  it("สินค้าน้อย: เหลือว่างอย่างน้อย 1 ชิ้นเสมอ; 0-1 ชิ้น = ไม่ sold", () => {
    expect(pickSoldCodes(["A001"])).toEqual([]);
    expect(pickSoldCodes([])).toEqual([]);
    expect(pickSoldCodes(["A001", "A002"])).toHaveLength(1);
    expect(pickSoldCodes(["A001", "A002", "A003"], () => 0.999)).toHaveLength(2);
  });
});
