import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

/**
 * unit test ของ route รูปสินค้า (mock Blob SDK + next/headers):
 *  - POST /api/admin/item-images/upload (ออก Blob client token): owner เท่านั้น, ตรวจ Origin, pathname items/ เท่านั้น
 *  - GET  /api/item-images/[name] (proxy สาธารณะจาก store private): อ่านได้เฉพาะ items/<ไฟล์รูป>, sniff ชนิด
 *
 * ข้อจำกัด: ไม่ได้ยืนยันพฤติกรรมของ Vercel Blob จริง — ยืนยันเฉพาะว่าเราส่งเงื่อนไขที่ถูกต้องให้ SDK
 * และปฏิเสธก่อนถึง SDK เมื่อไม่ผ่านสิทธิ์/รูปแบบ
 */

const mocks = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  headers: new Headers(),
  handleUpload: vi.fn(),
  get: vi.fn(),
  referenced: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: async () => mocks.headers,
  cookies: async () => ({
    get: (name: string) => (mocks.jar.has(name) ? { name, value: mocks.jar.get(name) } : undefined),
  }),
}));
vi.mock("next/navigation", () => ({ redirect: () => undefined }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), connection: async () => undefined }));
vi.mock("@/db/client", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/item-image-ref", () => ({ isItemImageReferenced: mocks.referenced }));
vi.mock("@vercel/blob/client", () => ({ handleUpload: mocks.handleUpload }));
vi.mock("@vercel/blob", async (orig) => ({ ...(await orig<typeof import("@vercel/blob")>()), get: mocks.get }));

import { GET as imageGET } from "@/app/api/item-images/[name]/route";
import { POST as uploadPOST } from "@/app/api/admin/item-images/upload/route";
import { SESSION_COOKIE, getSessionKey, signSession } from "@/lib/auth";
import { ITEM_IMAGE_MAX_BYTES, ITEM_IMAGE_TYPES } from "@/lib/item-image";

const SECRET = "t".repeat(40);
const SID = "D".repeat(32);

async function login(role: "owner" | "demo" | null) {
  mocks.jar.clear();
  if (!role) return;
  mocks.jar.set(
    SESSION_COOKIE,
    await signSession(role === "owner" ? { role: "owner" } : { role: "demo", sid: SID }, getSessionKey()!),
  );
}

function sameOrigin(extra: Record<string, string> = {}) {
  mocks.headers = new Headers({ origin: "https://shop.test", host: "shop.test", ...extra });
}

function uploadRequest(pathname: string, over: { type?: string; multipart?: boolean; headers?: Record<string, string> } = {}) {
  const headers = new Headers({
    "content-type": "application/json",
    origin: "https://shop.test",
    host: "shop.test",
    ...over.headers,
  });
  return new Request("https://shop.test/api/admin/item-images/upload", {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: over.type ?? "blob.generate-client-token",
      payload: { pathname, multipart: over.multipart ?? false, clientPayload: null },
    }),
  });
}

function installHandleUploadMock() {
  mocks.handleUpload.mockImplementation(
    async (opts: {
      body: { payload: { pathname: string; clientPayload: string | null; multipart: boolean } };
      onBeforeGenerateToken: (p: string, c: string | null, m: boolean) => Promise<unknown>;
    }) => {
      const { pathname, clientPayload, multipart } = opts.body.payload;
      const options = await opts.onBeforeGenerateToken(pathname, clientPayload, multipart);
      return { type: "blob.generate-client-token", clientToken: "fake-client-token", options };
    },
  );
}

beforeEach(async () => {
  mocks.handleUpload.mockReset();
  mocks.get.mockReset();
  mocks.referenced.mockReset();
  mocks.referenced.mockResolvedValue(true); // ค่าเริ่มต้น: ไฟล์ถูกสินค้าอ้างอยู่
  vi.stubEnv("SESSION_SECRET", SECRET);
  vi.stubEnv("DEMO_MODE", "true");
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-blob-token");
  sameOrigin();
  await login("owner");
  installHandleUploadMock();
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/admin/item-images/upload", () => {
  it("owner + pathname items/<ไฟล์> → ออก token พร้อมเงื่อนไข: ชนิด jpeg/png/webp, <= 5MB, random suffix, ห้ามเขียนทับ, อายุสั้น", async () => {
    const before = Date.now();
    const res = await uploadPOST(uploadRequest("items/up-12345678.jpg"));
    expect(res.status).toBe(200);
    expect(mocks.handleUpload).toHaveBeenCalledTimes(1);
    const body = (await res.json()) as { options: Record<string, unknown> };
    expect(body.options).toMatchObject({
      allowedContentTypes: [...ITEM_IMAGE_TYPES],
      maximumSizeInBytes: ITEM_IMAGE_MAX_BYTES,
      addRandomSuffix: true,
      allowOverwrite: false,
    });
    expect(body.options.allowedContentTypes).not.toContain("image/heic");
    expect(body.options.allowedContentTypes).not.toContain("image/svg+xml");
    const validUntil = body.options.validUntil as number;
    expect(validUntil).toBeGreaterThan(before);
    expect(validUntil - before).toBeLessThanOrEqual(10 * 60 * 1000 + 1000);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("role demo → 403 และไม่เรียก handleUpload (อัปโหลดรูปไม่ได้) แม้ Blob ตั้งค่าแล้ว", async () => {
    await login("demo");
    const res = await uploadPOST(uploadRequest("items/up-12345678.jpg"));
    expect(res.status).toBe(403);
    expect(mocks.handleUpload).not.toHaveBeenCalled();
  });

  it("role demo ได้ 403 ก่อนเช็ก Blob token (ไม่ได้ 503 ที่บอกว่าระบบ Blob ยังไม่พร้อม)", async () => {
    await login("demo");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    expect((await uploadPOST(uploadRequest("items/up-12345678.jpg"))).status).toBe(403);
  });

  it("ไม่มี session / cookie ปลอม / SESSION_SECRET ไม่ตั้ง → 401", async () => {
    await login(null);
    expect((await uploadPOST(uploadRequest("items/a.jpg"))).status).toBe(401);
    mocks.jar.set(SESSION_COOKIE, "garbage");
    expect((await uploadPOST(uploadRequest("items/a.jpg"))).status).toBe(401);
    await login("owner");
    vi.stubEnv("SESSION_SECRET", "");
    expect((await uploadPOST(uploadRequest("items/a.jpg"))).status).toBe(401);
    expect(mocks.handleUpload).not.toHaveBeenCalled();
  });

  it("Origin ไม่ตรง / ไม่มี / Sec-Fetch-Site: cross-site → 403 แม้เป็น owner", async () => {
    expect((await uploadPOST(uploadRequest("items/a.jpg", { headers: { origin: "https://evil.example" } }))).status).toBe(403);
    const noOrigin = uploadRequest("items/a.jpg");
    noOrigin.headers.delete("origin");
    expect((await uploadPOST(noOrigin)).status).toBe(403);
    expect((await uploadPOST(uploadRequest("items/a.jpg", { headers: { "sec-fetch-site": "cross-site" } }))).status).toBe(403);
    expect(mocks.handleUpload).not.toHaveBeenCalled();
  });

  it("ไม่ตั้ง BLOB_READ_WRITE_TOKEN (owner) → 503", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    expect((await uploadPOST(uploadRequest("items/a.jpg"))).status).toBe(503);
    expect(mocks.handleUpload).not.toHaveBeenCalled();
  });

  it.each([
    ["ไปที่ slips/", "slips/11111111-1111-4111-8111-111111111111/slip.jpg"],
    ["sub-folder", "items/sub/a.jpg"],
    ["path traversal", "items/../slips/a.jpg"],
    ["นามสกุล html", "items/a.html"],
    ["นามสกุล svg", "items/a.svg"],
    ["นามสกุล heic", "items/a.heic"],
    ["ไม่มี prefix", "a.jpg"],
    ["ชื่อว่าง", "items/"],
  ])("ปฏิเสธ pathname %s → 400 และไม่ออก token", async (_n, pathname) => {
    const res = await uploadPOST(uploadRequest(pathname));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("ชื่อไฟล์");
  });

  it("multipart ถูกปฏิเสธ; ชนิด event ที่ไม่ใช่ generate-client-token (เช่น upload-completed) → 400 ก่อนถึง SDK", async () => {
    const m = await uploadPOST(uploadRequest("items/a.jpg", { multipart: true }));
    expect(m.status).toBe(400);
    mocks.handleUpload.mockClear();
    const c = await uploadPOST(uploadRequest("items/a.jpg", { type: "blob.upload-completed" }));
    expect(c.status).toBe(400);
    expect(mocks.handleUpload).not.toHaveBeenCalled();
  });

  it("body ไม่ใช่ JSON → 415/400", async () => {
    const res = await uploadPOST(
      new Request("https://shop.test/api/admin/item-images/upload", {
        method: "POST",
        headers: { "content-type": "text/plain", origin: "https://shop.test", host: "shop.test" },
        body: "x",
      }),
    );
    expect(res.status).toBe(415);
  });
});

// ------------------------------------------------------------------------- proxy รูปสาธารณะ

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const HEIC = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);
const HTML = new TextEncoder().encode("<html><script>alert(1)</script></html>");

function streamOf(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}
const ctx = (name: string) => ({ params: Promise.resolve({ name }) }) as unknown as Parameters<typeof imageGET>[1];
const call = (name: string) => imageGET(new Request("https://shop.test/api/item-images/" + name), ctx(name));

describe("GET /api/item-images/[name] (สาธารณะ)", () => {
  it("เสิร์ฟรูปจาก items/<name> ด้วย Content-Type ที่ตรวจจากเนื้อไฟล์ + header ความปลอดภัย + cache ยาว", async () => {
    await login(null); // ไม่ต้องมี session
    mocks.get.mockResolvedValue({ statusCode: 200, stream: streamOf(PNG) });
    const res = await call("up-1.png");
    expect(res.status).toBe(200);
    expect(mocks.get).toHaveBeenCalledWith("items/up-1.png", { access: "private" });
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    // edge cache (Vercel docs: Vercel-CDN-Cache-Control สำคัญสุด แล้ว CDN-Cache-Control) — ตรวจ header ที่ route ตั้ง
    expect(res.headers.get("vercel-cdn-cache-control")).toBe("max-age=86400");
    expect(res.headers.get("cdn-cache-control")).toBe("max-age=86400");
    expect(mocks.referenced).toHaveBeenCalledWith(expect.anything(), "up-1.png");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
  });

  it("ไม่เชื่อนามสกุล: ไฟล์ .jpg ที่เนื้อเป็น PNG ได้ image/png", async () => {
    mocks.get.mockResolvedValue({ statusCode: 200, stream: streamOf(PNG) });
    expect((await call("a.jpg")).headers.get("content-type")).toBe("image/png");
    mocks.get.mockResolvedValue({ statusCode: 200, stream: streamOf(JPEG) });
    expect((await call("a.png")).headers.get("content-type")).toBe("image/jpeg");
  });

  it.each(["..%2Fslips%2Fx.jpg", "../slips/x.jpg", "sub/x.jpg", "x.html", "x.svg", "x.heic", ".x.jpg", "a..b.jpg", "x.jpg%00.html", "slips", ""])(
    "ชื่อ %j ไม่ผ่าน allowlist → 404 และไม่แตะ Blob (อ่าน slips/ ผ่านทางนี้ไม่ได้)",
    async (name) => {
      const res = await call(name);
      expect(res.status).toBe(404);
      expect(mocks.get).not.toHaveBeenCalled();
      expect(mocks.referenced).not.toHaveBeenCalled(); // ไม่แตะ DB ด้วย
      expect(res.headers.get("vercel-cdn-cache-control")).toBe("max-age=60"); // 404 cache สั้นที่ edge
    },
  );

  it("ไม่มีสินค้าอ้างไฟล์นี้ (ชื่อสุ่ม) → 404 โดยไม่แตะ Blob + 404 cache ที่ edge 60 วินาที ไม่ cache ฝั่ง browser", async () => {
    await login(null);
    mocks.referenced.mockResolvedValue(false);
    const res = await call("random-xyz.jpg");
    expect(res.status).toBe(404);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(res.headers.get("vercel-cdn-cache-control")).toBe("max-age=60");
    expect(res.headers.get("cdn-cache-control")).toBe("max-age=60");
    expect(res.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    expect(res.headers.get("cache-control")).not.toContain("no-store"); // no-store ทำให้ Vercel ไม่ cache
  });

  it("ไม่มีสินค้าอ้าง + demo ก็ 404 ไม่แตะ Blob (เฉพาะ owner พรีวิวได้)", async () => {
    await login("demo");
    mocks.referenced.mockResolvedValue(false);
    expect((await call("up-9.jpg")).status).toBe(404);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("owner พรีวิวรูปที่เพิ่งอัปแต่ยังไม่บันทึกกับสินค้าได้ — แต่ตอบ private/no-store ห้ามเข้า cache ของ edge", async () => {
    await login("owner");
    mocks.referenced.mockResolvedValue(false);
    mocks.get.mockResolvedValue({ statusCode: 200, stream: streamOf(JPEG) });
    const res = await call("up-new.jpg");
    expect(res.status).toBe(200);
    expect(mocks.get).toHaveBeenCalledWith("items/up-new.jpg", { access: "private" });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("vercel-cdn-cache-control")).toBeNull();
    expect(res.headers.get("cdn-cache-control")).toBeNull();
  });

  it("owner พรีวิวแต่ไฟล์ไม่มีใน Blob → 404 แบบไม่ cache; DB ล้ม → 502 ไม่แตะ Blob", async () => {
    await login("owner");
    mocks.referenced.mockResolvedValue(false);
    mocks.get.mockResolvedValue(null);
    const res = await call("up-gone.jpg");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("vercel-cdn-cache-control")).toBeNull();

    mocks.get.mockClear();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.referenced.mockRejectedValue(new Error("connection string secret-xyz"));
    const r2 = await call("up-1.jpg");
    expect(r2.status).toBe(502);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret-xyz");
    log.mockRestore();
  });

  it("สินค้าอ้างแต่ไฟล์หายจาก Blob → 404 cache สั้นที่ edge", async () => {
    mocks.get.mockResolvedValue(null);
    const res = await call("x.jpg");
    expect(res.status).toBe(404);
    expect(res.headers.get("vercel-cdn-cache-control")).toBe("max-age=60");
  });

  it("เนื้อไฟล์ไม่ใช่รูปที่ให้เสิร์ฟ (HTML/HEIC) → 415 ไม่ส่งเนื้อไฟล์", async () => {
    for (const bytes of [HTML, HEIC]) {
      mocks.get.mockResolvedValue({ statusCode: 200, stream: streamOf(bytes) });
      expect((await call("x.jpg")).status).toBe(415);
    }
  });

  it("ไม่พบไฟล์ → 404; ไม่มี Blob token → 503; ไฟล์ใหญ่เกินเพดาน → 502; SDK ล้ม → 502 (ไม่รั่ว error)", async () => {
    mocks.get.mockResolvedValue(null);
    expect((await call("x.jpg")).status).toBe(404);
    mocks.get.mockResolvedValue({ statusCode: 304, stream: null });
    expect((await call("x.jpg")).status).toBe(404);

    mocks.get.mockResolvedValue({ statusCode: 200, stream: streamOf(new Uint8Array(ITEM_IMAGE_MAX_BYTES + 1)) });
    expect((await call("x.jpg")).status).toBe(502);

    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.get.mockRejectedValue(new Error("token abc123 invalid"));
    const res = await call("x.jpg");
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain("abc123");
    expect(JSON.stringify(log.mock.calls)).not.toContain("abc123");
    log.mockRestore();

    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    mocks.get.mockClear();
    expect((await call("x.jpg")).status).toBe(503);
    expect(mocks.get).not.toHaveBeenCalled();
  });
});
