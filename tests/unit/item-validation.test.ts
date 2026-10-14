import { describe, expect, it, vi } from "vitest";
import {
  firstIssuePerField,
  formDataToRecord,
  ITEM_FORM_KEYS,
  itemCreateSchema,
  itemIdSchema,
  itemStatusChangeSchema,
  itemUpdateSchema,
} from "@/lib/admin/item-validation";
import {
  removedUploadedPathnames,
  verifyItemImages,
  type HeadResult,
  type ImageVerifyDeps,
} from "@/lib/admin/item-images";
import {
  isValidItemImageFile,
  isValidItemImagePathname,
  itemImageUrlFromPathname,
  pathnameFromItemImageUrl,
} from "@/lib/item-image";

const UP = "/api/item-images/up-1a2b3c4d-AbCdEf.jpg";

function base(over: Record<string, unknown> = {}) {
  return {
    title: "เสื้อทดสอบ",
    description: "คำบรรยายสินค้า",
    flaws: "ไม่มีตำหนิที่สังเกตเห็น",
    condition: "good",
    category: "fashion",
    price: "450",
    sortOrder: "0",
    images: JSON.stringify([{ url: UP, alt: "รูปด้านหน้า" }]),
    ...over,
  };
}

describe("itemUpdateSchema (ฟอร์มแก้สินค้า)", () => {
  it("ข้อมูลถูกต้อง → แปลงราคา/ลำดับเป็นตัวเลข และ parse images", () => {
    const r = itemUpdateSchema.safeParse(base({ price: " 1200 ", sortOrder: "-3", status: "hidden" }));
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.price).toBe(1200);
      expect(r.data.sortOrder).toBe(-3);
      expect(r.data.status).toBe("hidden");
      expect(r.data.images).toEqual([{ url: UP, alt: "รูปด้านหน้า" }]);
    }
  });

  it.each(["0", "-5", "12.5", "abc", "", "  ", "1e3", "01 2", "99999999", "1000001"])(
    "ราคา %j ถูกปฏิเสธ (ต้องเป็นจำนวนเต็มบาท > 0 และไม่เกินเพดาน)",
    (price) => {
      const r = itemUpdateSchema.safeParse(base({ price }));
      expect(r.success).toBe(false);
      if (!r.success) expect(firstIssuePerField(r.error).price).toBeTruthy();
    },
  );

  it("ราคาเป็น number ก็รับ (เฉพาะจำนวนเต็ม > 0)", () => {
    expect(itemUpdateSchema.safeParse(base({ price: 300 })).success).toBe(true);
    expect(itemUpdateSchema.safeParse(base({ price: 0 })).success).toBe(false);
    expect(itemUpdateSchema.safeParse(base({ price: 1.5 })).success).toBe(false);
    expect(itemUpdateSchema.safeParse(base({ price: -1 })).success).toBe(false);
  });

  it("ตำหนิห้ามว่าง (รวมแค่ช่องว่าง) และข้อความ error เป็นภาษาไทย", () => {
    for (const flaws of ["", "   ", undefined]) {
      const r = itemUpdateSchema.safeParse(base({ flaws }));
      expect(r.success).toBe(false);
      if (!r.success) {
        const msg = firstIssuePerField(r.error).flaws;
        expect(msg).toContain("ตำหนิ");
        expect(msg).not.toMatch(/[A-Za-z]{4,} /); // ไม่มีประโยคอังกฤษของ Zod รั่ว
      }
    }
  });

  it("title/description ว่างหรือยาวเกิน → ปฏิเสธ; enum ผิด → ปฏิเสธ", () => {
    expect(itemUpdateSchema.safeParse(base({ title: " " })).success).toBe(false);
    expect(itemUpdateSchema.safeParse(base({ title: "x".repeat(121) })).success).toBe(false);
    expect(itemUpdateSchema.safeParse(base({ description: "" })).success).toBe(false);
    expect(itemUpdateSchema.safeParse(base({ condition: "new" })).success).toBe(false);
    expect(itemUpdateSchema.safeParse(base({ category: "cars" })).success).toBe(false);
  });

  it("status: reserved/ค่าแปลกถูกปฏิเสธ (reserved ตั้งเองไม่ได้); ไม่ส่ง = ไม่เปลี่ยน", () => {
    expect(itemUpdateSchema.safeParse(base({ status: "reserved" })).success).toBe(false);
    expect(itemUpdateSchema.safeParse(base({ status: "deleted" })).success).toBe(false);
    const r = itemUpdateSchema.safeParse(base());
    expect(r.success && r.data.status).toBeUndefined();
  });

  it("images: JSON เสีย / ไม่ใช่ array / alt ว่าง / เกิน 8 รูป → ปฏิเสธ; ว่าง [] ผ่านชั้นนี้ (กฎ 'ต้องมีรูป' อยู่ที่คำสั่ง)", () => {
    expect(itemUpdateSchema.safeParse(base({ images: "{not json" })).success).toBe(false);
    expect(itemUpdateSchema.safeParse(base({ images: JSON.stringify({ a: 1 }) })).success).toBe(false);
    expect(itemUpdateSchema.safeParse(base({ images: JSON.stringify([{ url: UP, alt: "  " }]) })).success).toBe(false);
    expect(itemUpdateSchema.safeParse(base({ images: JSON.stringify([{ url: UP }]) })).success).toBe(false);
    const nine = Array.from({ length: 9 }, (_, i) => ({ url: `/api/item-images/a${i}.jpg`, alt: "x" }));
    expect(itemUpdateSchema.safeParse(base({ images: JSON.stringify(nine) })).success).toBe(false);
    expect(itemUpdateSchema.safeParse(base({ images: "[]" })).success).toBe(true);
    const r = itemUpdateSchema.safeParse(base({ images: undefined }));
    expect(r.success).toBe(false);
  });

  it("key แปลกปลอม (id, createdAt, reservedUntil) ถูก strip ทิ้ง", () => {
    const r = itemUpdateSchema.safeParse({ ...base(), id: 9, reservedUntil: "2030-01-01", createdAt: "x" });
    expect(r.success).toBe(true);
    if (r.success) expect(Object.keys(r.data)).not.toContain("reservedUntil");
  });
});

describe("itemCreateSchema", () => {
  it("รหัสต้องเป็น A + 3 หลัก (แปลงเป็นตัวพิมพ์ใหญ่ให้)", () => {
    expect(itemCreateSchema.safeParse({ ...base(), code: "a013", status: "available" }).success).toBe(true);
    const ok = itemCreateSchema.safeParse({ ...base(), code: " A013 ", status: "hidden" });
    expect(ok.success && ok.data.code).toBe("A013");
    for (const code of ["", "A13", "A0123", "B013", "013", "A01x", "AAAA", "A 13"]) {
      const r = itemCreateSchema.safeParse({ ...base(), code, status: "available" });
      expect(r.success, code).toBe(false);
      if (!r.success) expect(firstIssuePerField(r.error).code).toContain("A");
    }
  });

  it("สถานะเริ่มต้นเป็น available/hidden เท่านั้น (sold/reserved ไม่ได้)", () => {
    expect(itemCreateSchema.safeParse({ ...base(), code: "A013", status: "sold" }).success).toBe(false);
    expect(itemCreateSchema.safeParse({ ...base(), code: "A013", status: "reserved" }).success).toBe(false);
    expect(itemCreateSchema.safeParse({ ...base(), code: "A013" }).success).toBe(false);
  });
});

describe("itemStatusChangeSchema / itemIdSchema / formDataToRecord", () => {
  it("รับ id เป็นสตริงตัวเลข และสถานะที่ตั้งได้เท่านั้น", () => {
    expect(itemStatusChangeSchema.parse({ itemId: "12", status: "hidden" })).toEqual({ itemId: 12, status: "hidden" });
    expect(itemStatusChangeSchema.safeParse({ itemId: "12", status: "reserved" }).success).toBe(false);
    expect(itemStatusChangeSchema.safeParse({ itemId: "0", status: "sold" }).success).toBe(false);
    expect(itemStatusChangeSchema.safeParse({ itemId: "-1", status: "sold" }).success).toBe(false);
    expect(itemStatusChangeSchema.safeParse({ itemId: "1; DROP", status: "sold" }).success).toBe(false);
    expect(itemIdSchema.safeParse("7").success).toBe(true);
    expect(itemIdSchema.safeParse("abc").success).toBe(false);
    expect(itemIdSchema.safeParse(null).success).toBe(false);
  });

  it("formDataToRecord อ่านเฉพาะ key ที่กำหนด และไฟล์ = ไม่มีค่า", () => {
    const f = new FormData();
    f.set("title", "x");
    f.set("evil", "y");
    f.set("images", new File(["a"], "a.txt"));
    const r = formDataToRecord(f, ITEM_FORM_KEYS);
    expect(r.title).toBe("x");
    expect(r).not.toHaveProperty("evil");
    expect(r.images).toBeUndefined();
  });
});

describe("pathname/URL ของรูปสินค้า (กันหลุดไป slips/)", () => {
  it("รับเฉพาะ items/<ชื่อไฟล์รูป>", () => {
    expect(isValidItemImagePathname("items/up-1a2b3c4d-AbCdEf.jpg")).toBe(true);
    expect(isValidItemImagePathname("items/photo.WEBP")).toBe(true);
    for (const p of [
      "slips/abc/slip.jpg",
      "items/../slips/x.jpg",
      "items/sub/x.jpg",
      "items/x.jpg/../../slips/y.jpg",
      "items/x.html",
      "items/x.svg",
      "items/x.heic",
      "items/.hidden.jpg",
      "items/",
      "items",
      "/items/x.jpg",
      "items/a..b.jpg",
      "items/x.jpg%00.html",
    ]) {
      expect(isValidItemImagePathname(p), p).toBe(false);
    }
  });

  it("แปลง pathname ↔ URL ได้สองทาง และปฏิเสธ URL ภายนอก/พาธแปลก", () => {
    expect(itemImageUrlFromPathname("items/a-1.jpg")).toBe("/api/item-images/a-1.jpg");
    expect(pathnameFromItemImageUrl("/api/item-images/a-1.jpg")).toBe("items/a-1.jpg");
    for (const u of [
      "https://images.unsplash.com/photo-1.jpg",
      "https://evil.example/api/item-images/a.jpg",
      "/api/item-images/../x.jpg",
      "/api/item-images/sub/x.jpg",
      "/api/item-images/x.html",
      "//evil.example/a.jpg",
      "/api/other/a.jpg",
    ]) {
      expect(pathnameFromItemImageUrl(u), u).toBeNull();
    }
    expect(isValidItemImageFile("a b.jpg")).toBe(false);
  });
});

describe("verifyItemImages (ไม่เชื่อ url จาก client)", () => {
  const existing = [
    { url: "https://images.unsplash.com/photo-1?w=1", alt: "เดิม", credit: { name: "ช่างภาพ", url: "https://unsplash.com/@x" } },
  ];
  const okHead = (over: Partial<NonNullable<HeadResult>> = {}) =>
    vi.fn(async (p: string): Promise<HeadResult> => ({ pathname: p, contentType: "image/jpeg", size: 1000, ...over }));
  const deps = (head: ImageVerifyDeps["head"], blobConfigured = true): ImageVerifyDeps => ({ head, blobConfigured });

  it("รูปเดิมผ่านโดยไม่ต้องตรวจ Blob และคง credit เดิม (แก้ alt ได้)", async () => {
    const head = okHead();
    const r = await verifyItemImages([{ url: existing[0].url, alt: "alt ใหม่" }], existing, deps(head));
    expect(r).toEqual({ ok: true, images: [{ ...existing[0], alt: "alt ใหม่" }] });
    expect(head).not.toHaveBeenCalled();
  });

  it("รูปอัปโหลดใหม่: ต้อง head() พบ ชนิด/ขนาดผ่าน → รับ (ลำดับตามที่ส่ง)", async () => {
    const head = okHead();
    const r = await verifyItemImages(
      [
        { url: UP, alt: "ใหม่" },
        { url: existing[0].url, alt: "เดิม" },
      ],
      existing,
      deps(head),
    );
    expect(head).toHaveBeenCalledWith("items/up-1a2b3c4d-AbCdEf.jpg");
    expect(r.ok && r.images.map((i) => i.url)).toEqual([UP, existing[0].url]);
  });

  it.each([
    ["URL ภายนอก", "https://evil.example/x.jpg", "unknown_image"],
    ["พาธไป slips/", "/api/item-images/../slips/x.jpg", "unknown_image"],
    ["พาธแปลก", "/something/else.jpg", "unknown_image"],
  ])("ปฏิเสธ %s", async (_n, url, error) => {
    const head = okHead();
    const r = await verifyItemImages([{ url, alt: "x" }], existing, deps(head));
    expect(r).toEqual({ ok: false, error });
    expect(head).not.toHaveBeenCalled();
  });

  it("ไม่มี Blob token → รูปใหม่ไม่ได้ (blob_unconfigured) แต่รูปเดิมยังบันทึกได้", async () => {
    const head = okHead();
    expect(await verifyItemImages([{ url: UP, alt: "x" }], [], deps(head, false))).toEqual({
      ok: false,
      error: "blob_unconfigured",
    });
    expect((await verifyItemImages([{ url: existing[0].url, alt: "x" }], existing, deps(head, false))).ok).toBe(true);
  });

  it("ไฟล์ไม่พบ / ชนิดผิด / ใหญ่เกิน / ว่าง / pathname ไม่ตรง / head ล้ม", async () => {
    const one = [{ url: UP, alt: "x" }];
    expect(await verifyItemImages(one, [], deps(async () => null))).toEqual({ ok: false, error: "blob_missing" });
    expect(await verifyItemImages(one, [], deps(okHead({ contentType: "text/html" })))).toEqual({ ok: false, error: "blob_invalid" });
    expect(await verifyItemImages(one, [], deps(okHead({ contentType: "image/heic" })))).toEqual({ ok: false, error: "blob_invalid" });
    expect(await verifyItemImages(one, [], deps(okHead({ size: 5 * 1024 * 1024 + 1 })))).toEqual({ ok: false, error: "blob_invalid" });
    expect(await verifyItemImages(one, [], deps(okHead({ size: 0 })))).toEqual({ ok: false, error: "blob_invalid" });
    expect(await verifyItemImages(one, [], deps(okHead({ pathname: "items/other.jpg" })))).toEqual({ ok: false, error: "blob_invalid" });
    expect(
      await verifyItemImages(
        one,
        [],
        deps(async () => {
          throw new Error("network");
        }),
      ),
    ).toEqual({ ok: false, error: "blob_check_failed" });
    // content-type มี parameter ก็ยอมรับ
    expect((await verifyItemImages(one, [], deps(okHead({ contentType: "image/jpeg; charset=binary" })))).ok).toBe(true);
  });

  it("url ซ้ำกันในรายการเดียว → duplicate", async () => {
    const r = await verifyItemImages(
      [
        { url: UP, alt: "a" },
        { url: UP, alt: "b" },
      ],
      [],
      deps(okHead()),
    );
    expect(r).toEqual({ ok: false, error: "duplicate" });
  });

  it("removedUploadedPathnames คืนเฉพาะรูปอัปโหลดของเราที่ถูกเอาออก (ไม่รวมรูป Unsplash)", () => {
    const before = [existing[0], { url: UP, alt: "a" }, { url: "/api/item-images/keep.jpg", alt: "k" }];
    const after = [{ url: "/api/item-images/keep.jpg", alt: "k" }];
    expect(removedUploadedPathnames(before, after)).toEqual(["items/up-1a2b3c4d-AbCdEf.jpg"]);
    expect(removedUploadedPathnames(before, before)).toEqual([]);
  });
});
