import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * unit test ของ GET /api/admin/slips/[orderId] (mock Blob SDK, session, DB)
 *
 * ข้อจำกัด: ไม่ได้ยืนยันพฤติกรรมของ Vercel Blob private store จริง (ไม่มี BLOB_READ_WRITE_TOKEN) —
 * เทสต์นี้ยืนยันว่าเราเรียก get(pathname, { access: "private" }) ถูกต้อง และผลที่ส่งกลับ client ปลอดภัย
 */

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  getSession: vi.fn(),
  getSlipRecord: vi.fn(),
}));

vi.mock("@vercel/blob", async (orig) => ({
  ...(await orig<typeof import("@vercel/blob")>()),
  get: mocks.get,
}));
vi.mock("@/lib/auth-server", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/admin/queries", () => ({ getSlipRecord: mocks.getSlipRecord }));

import { GET } from "@/app/api/admin/slips/[orderId]/route";
import {
  isInlineSlipType,
  readStreamCapped,
  SlipTooLargeError,
  sniffImageType,
} from "@/lib/admin/slip-proxy";
import { DEMO_SLIP_PATH, SLIP_MAX_BYTES } from "@/lib/slip";

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const SLIP_PATH = `slips/${ORDER_ID}/abc123.jpg`;
const SID = "D".repeat(32);
const BLOB_HOST_URL = "https://abcdef.private.blob.vercel-storage.com/slips/x/abc123.jpg";

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 9]);
const HTML = new TextEncoder().encode("<html><script>alert(1)</script></html>");

/** ISO-BMFF: [size:4]["ftyp"][major brand:4][...] */
function isobmff(brand: string, tail = 8): Uint8Array {
  const enc = new TextEncoder();
  const out = new Uint8Array(12 + tail);
  out.set([0, 0, 0, 0x18], 0);
  out.set(enc.encode("ftyp"), 4);
  out.set(enc.encode(brand), 8);
  out.fill(7, 12);
  return out;
}
const HEIC = isobmff("heic");

function streamOf(bytes: Uint8Array, chunk = 4): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(i, i + chunk));
      i += chunk;
    },
  });
}

function blobResult(bytes: Uint8Array, contentType = "image/jpeg") {
  return {
    statusCode: 200 as const,
    stream: streamOf(bytes),
    headers: new Headers({ "content-type": contentType }),
    blob: {
      url: BLOB_HOST_URL,
      downloadUrl: BLOB_HOST_URL + "?download=1",
      pathname: SLIP_PATH,
      contentDisposition: "inline",
      cacheControl: "",
      uploadedAt: new Date(),
      etag: "x",
      contentType,
      size: bytes.length,
    },
  };
}

function call(orderId = ORDER_ID, headers: Record<string, string> = {}) {
  return GET(
    new Request(`http://localhost/api/admin/slips/${orderId}`, { headers }) as never,
    { params: Promise.resolve({ orderId }) } as never,
  );
}

const OWNER = { role: "owner" } as const;
const DEMO = { role: "demo", sid: SID } as const;

beforeEach(() => {
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-token-not-real");
  mocks.get.mockReset();
  mocks.getSession.mockReset();
  mocks.getSlipRecord.mockReset();
  mocks.getSession.mockResolvedValue(OWNER);
  mocks.getSlipRecord.mockResolvedValue({ slipPath: SLIP_PATH, demoSessionId: "other-session" });
});
afterEach(() => vi.unstubAllEnvs());

describe("sniffImageType", () => {
  it("jpeg/png/webp ตามลายเซ็นไฟล์", () => {
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(WEBP)).toBe("image/webp");
  });
  it("HEIC: ftyp + brand heic/heix/mif1/heim/hevc = image/heic", () => {
    for (const brand of ["heic", "heix", "mif1", "heim", "hevc"]) {
      expect(sniffImageType(isobmff(brand)), brand).toBe("image/heic");
    }
    expect(isInlineSlipType("image/heic")).toBe(false);
    expect(isInlineSlipType("image/jpeg")).toBe(true);
  });

  it("ISO-BMFF นอก allowlist (mp4/mov/avif/3gp/m4a ฯลฯ) หรือรูปแบบเพี้ยน = null", () => {
    for (const brand of ["mp42", "isom", "qt  ", "avif", "avis", "3gp5", "M4A ", "heis", "hevm"]) {
      expect(sniffImageType(isobmff(brand)), brand).toBeNull();
    }
    // สั้นเกินไป / ไม่มี ftyp ที่ offset 4 / brand ไม่อยู่ที่ offset 8
    expect(sniffImageType(isobmff("heic").slice(0, 11))).toBeNull();
    const noFtyp = isobmff("heic");
    noFtyp.set(new TextEncoder().encode("moov"), 4);
    expect(sniffImageType(noFtyp)).toBeNull();
    const shifted = new Uint8Array([0, 0, 0, 0, 0, ...new TextEncoder().encode("ftypheic"), 0, 0, 0]);
    expect(sniffImageType(shifted)).toBeNull();
    // ข้อความที่แค่มีคำว่า heic ไม่ผ่าน
    expect(sniffImageType(new TextEncoder().encode("....ftyp<html>heic"))).toBeNull();
  });

  it("html/svg/gif/ว่าง/สั้นเกิน = null", () => {
    expect(sniffImageType(HTML)).toBeNull();
    expect(sniffImageType(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffImageType(new TextEncoder().encode("GIF89a"))).toBeNull();
    expect(sniffImageType(new Uint8Array())).toBeNull();
    expect(sniffImageType(Uint8Array.from([0xff, 0xd8]))).toBeNull();
  });
});

describe("readStreamCapped", () => {
  it("อ่านครบเมื่อไม่เกินเพดาน", async () => {
    const out = await readStreamCapped(streamOf(JPEG, 3), 100);
    expect(Array.from(out)).toEqual(Array.from(JPEG));
  });
  it("เกินเพดาน → SlipTooLargeError", async () => {
    await expect(readStreamCapped(streamOf(JPEG, 3), 5)).rejects.toBeInstanceOf(SlipTooLargeError);
  });
});

describe("GET /api/admin/slips/[orderId]", () => {
  it("ไม่มี session = 401 และไม่แตะ DB/Blob", async () => {
    mocks.getSession.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(401);
    expect(mocks.getSlipRecord).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("Sec-Fetch-Site: cross-site = 403 (ก่อนอ่าน session)", async () => {
    const res = await call(ORDER_ID, { "sec-fetch-site": "cross-site" });
    expect(res.status).toBe(403);
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("same-origin / none (เปิดตรงๆ) ผ่าน", async () => {
    mocks.get.mockResolvedValue(blobResult(JPEG));
    expect((await call(ORDER_ID, { "sec-fetch-site": "same-origin" })).status).toBe(200);
    mocks.get.mockResolvedValue(blobResult(JPEG));
    expect((await call(ORDER_ID, { "sec-fetch-site": "none" })).status).toBe(200);
  });

  it("orderId ไม่ใช่ uuid = 404 ไม่แตะ DB", async () => {
    const res = await call("../../etc/passwd");
    expect(res.status).toBe(404);
    expect(mocks.getSlipRecord).not.toHaveBeenCalled();
  });

  it("ไม่พบออเดอร์ / ไม่มีสลิป = 404", async () => {
    mocks.getSlipRecord.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
    mocks.getSlipRecord.mockResolvedValue({ slipPath: null, demoSessionId: null });
    expect((await call()).status).toBe(404);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("owner: อ่านจาก Blob ด้วย access private, ส่งเนื้อไฟล์ + header ความปลอดภัย, ไม่มี URL ของ Blob", async () => {
    mocks.get.mockResolvedValue(blobResult(PNG, "image/png"));
    const res = await call();
    expect(res.status).toBe(200);
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledWith(SLIP_PATH, { access: "private" });
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual(Array.from(PNG));
    // ไม่รั่ว URL/ host ของ Blob ทาง header ใดๆ
    const all = [...res.headers.entries()].map(([k, v]) => `${k}:${v}`).join("\n");
    expect(all).not.toContain("blob.vercel-storage.com");
    expect(res.headers.get("location")).toBeNull();
  });

  it("Content-Type มาจากเนื้อไฟล์ ไม่เชื่อที่ Blob รายงาน (รายงาน text/html แต่เนื้อเป็น jpeg → image/jpeg)", async () => {
    mocks.get.mockResolvedValue(blobResult(JPEG, "text/html"));
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
  });

  it("รูป jpeg: inline + กันฝังใน iframe (frame-ancestors none, X-Frame-Options DENY)", async () => {
    mocks.get.mockResolvedValue(blobResult(JPEG));
    const res = await call();
    expect(res.headers.get("content-disposition")).toBe("inline");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("HEIC: ส่งเป็น attachment ดาวน์โหลด (ไม่ inline) + nosniff + CSP sandbox + content-type จาก allowlist", async () => {
    mocks.get.mockResolvedValue(blobResult(HEIC, "text/html")); // Blob รายงานมั่ว — ไม่เชื่อ
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/heic");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="slip.heic"');
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual(Array.from(HEIC));
  });

  it("ISO-BMFF นอก allowlist (mp4) = 415 ไม่ส่งเนื้อไฟล์ แม้ Blob รายงานว่า image/heic", async () => {
    mocks.get.mockResolvedValue(blobResult(isobmff("mp42"), "image/heic"));
    const res = await call();
    expect(res.status).toBe(415);
    expect(res.headers.get("content-disposition")).toBeNull();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("HEIC ของคนอื่นสำหรับ demo = 403 เหมือนรูปอื่น (ไม่อ่าน Blob)", async () => {
    mocks.getSession.mockResolvedValue(DEMO);
    mocks.getSlipRecord.mockResolvedValue({ slipPath: SLIP_PATH.replace(".jpg", ".heic"), demoSessionId: "another-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" });
    expect((await call()).status).toBe(403);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("ไฟล์ที่ไม่ใช่รูป (HTML) แม้ Blob รายงานว่า image/jpeg = 415 ไม่ส่งเนื้อไฟล์", async () => {
    mocks.get.mockResolvedValue(blobResult(HTML, "image/jpeg"));
    const res = await call();
    expect(res.status).toBe(415);
    expect(await res.text()).not.toContain("<script>");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("webp ผ่าน allowlist", async () => {
    mocks.get.mockResolvedValue(blobResult(WEBP, "image/webp"));
    const res = await call();
    expect(res.headers.get("content-type")).toBe("image/webp");
  });

  it("ไฟล์ใหญ่เกิน 8MB = 502 (ไม่โหลดเข้าหน่วยความจำทั้งก้อน)", async () => {
    const big = new Uint8Array(SLIP_MAX_BYTES + 1);
    big.set(JPEG);
    mocks.get.mockResolvedValue({ ...blobResult(big), stream: streamOf(big, 1024 * 1024) });
    expect((await call()).status).toBe(502);
  });

  it("Blob ไม่พบ (null) = 404; SDK error = 502 ข้อความทั่วไป", async () => {
    mocks.get.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
    mocks.get.mockRejectedValue(new Error("secret internal detail https://x.blob.vercel-storage.com"));
    const res = await call();
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("secret internal detail");
  });

  it("ไม่มี BLOB_READ_WRITE_TOKEN = 503 ไม่เรียก SDK", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    const res = await call();
    expect(res.status).toBe(503);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("pathname ใน DB ที่ไม่ได้อยู่ใต้ slips/<orderId>/ ของออเดอร์นี้ = 404 ไม่เรียก SDK", async () => {
    for (const bad of [
      "slips/22222222-2222-4222-8222-222222222222/a.jpg",
      `slips/${ORDER_ID}/../../secret.jpg`,
      "https://evil.example/a.jpg",
      "other/a.jpg",
    ]) {
      mocks.getSlipRecord.mockResolvedValue({ slipPath: bad, demoSessionId: null });
      expect((await call()).status).toBe(404);
    }
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("demo: สลิปของคนอื่น = 403 (ไม่อ่าน Blob); สลิปของตัวเอง (sid ตรง) = 200", async () => {
    mocks.getSession.mockResolvedValue(DEMO);
    mocks.getSlipRecord.mockResolvedValue({ slipPath: SLIP_PATH, demoSessionId: "someone-else-xxxxxxxxxxxxxxxxxxxxxxxxxxxx" });
    const other = await call();
    expect(other.status).toBe(403);
    expect(mocks.get).not.toHaveBeenCalled();

    mocks.getSlipRecord.mockResolvedValue({ slipPath: SLIP_PATH, demoSessionId: SID });
    mocks.get.mockResolvedValue(blobResult(JPEG));
    const own = await call();
    expect(own.status).toBe(200);
    expect(mocks.get).toHaveBeenCalledWith(SLIP_PATH, { access: "private" });
  });

  it("demo: ออเดอร์ที่ไม่มี demo_session_id = 403", async () => {
    mocks.getSession.mockResolvedValue(DEMO);
    mocks.getSlipRecord.mockResolvedValue({ slipPath: SLIP_PATH, demoSessionId: null });
    expect((await call()).status).toBe(403);
  });

  it("สลิปตัวอย่าง: 307 ไปไฟล์ใน repo (ไม่ผ่าน Blob) แต่ยังต้องผ่านสิทธิ์ก่อน", async () => {
    mocks.getSlipRecord.mockResolvedValue({ slipPath: DEMO_SLIP_PATH, demoSessionId: SID });
    const ok = await call();
    expect(ok.status).toBe(307);
    expect(ok.headers.get("location")).toBe("/demo/sample-slip.png");
    expect(mocks.get).not.toHaveBeenCalled();

    mocks.getSession.mockResolvedValue(DEMO);
    mocks.getSlipRecord.mockResolvedValue({ slipPath: DEMO_SLIP_PATH, demoSessionId: "another-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" });
    expect((await call()).status).toBe(403);
  });
});
