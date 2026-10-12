import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * unit test ของ route handler ที่แตะไฟล์สลิป (mock Blob SDK + ฟังก์ชัน DB — ไม่ต่อเครือข่าย/DB จริง):
 *  - POST /api/blob/upload        (onBeforeGenerateToken: เจ้าของ pathname, สถานะ, หมดเวลา, เพดาน token)
 *  - POST /api/orders/[token]/slip (head(): ชนิด/ขนาด/ชื่อ, สลิปตัวอย่างเฉพาะ DEMO_MODE)
 *
 * ข้อจำกัด: ไม่ได้ยืนยันพฤติกรรมของ Vercel Blob จริง (token ที่ออกถูกบังคับ content-type/ขนาดโดย SDK/ฝั่ง Blob)
 * — เทสต์นี้ยืนยันเฉพาะว่าเราส่งเงื่อนไขที่ถูกต้องให้ SDK และปฏิเสธก่อนถึง SDK เมื่อไม่ผ่าน
 */

const mocks = vi.hoisted(() => ({
  handleUpload: vi.fn(),
  head: vi.fn(),
  getOrderForSlip: vi.fn(),
  reserveSlipTokenSlot: vi.fn(),
  uploadSlip: vi.fn(),
}));

vi.mock("@vercel/blob/client", () => ({ handleUpload: mocks.handleUpload }));
vi.mock("@vercel/blob", async (orig) => ({
  ...(await orig<typeof import("@vercel/blob")>()),
  head: mocks.head,
}));
vi.mock("@/db/client", () => ({ getDb: () => ({ fake: "db" }) }));
vi.mock("@/lib/orders/queries", () => ({ getOrderForSlip: mocks.getOrderForSlip }));
vi.mock("@/lib/orders/commands", async (orig) => ({
  ...(await orig<typeof import("@/lib/orders/commands")>()),
  reserveSlipTokenSlot: mocks.reserveSlipTokenSlot,
  uploadSlip: mocks.uploadSlip,
}));

import { BlobNotFoundError } from "@vercel/blob";
import { POST as uploadPOST } from "@/app/api/blob/upload/route";
import { POST as slipPOST } from "@/app/api/orders/[token]/slip/route";
import { MAX_SLIP_TOKENS_PER_ORDER } from "@/lib/orders/commands";
import { DEMO_SLIP_PATH, SLIP_ALLOWED_TYPES, SLIP_MAX_BYTES } from "@/lib/slip";

const TOKEN = "T".repeat(43);
const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ORDER_ID = "22222222-2222-4222-8222-222222222222";
const pendingOrder = { id: ORDER_ID, status: "pending_payment", inWindow: true };

function jsonRequest(url: string, body: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------- /api/blob/upload

function uploadBody(pathname: string, over: { multipart?: boolean; clientPayload?: string | null } = {}) {
  return {
    type: "blob.generate-client-token",
    payload: {
      pathname,
      multipart: over.multipart ?? false,
      clientPayload: over.clientPayload === undefined ? JSON.stringify({ token: TOKEN }) : over.clientPayload,
    },
  };
}

/** handleUpload จำลอง: เรียก onBeforeGenerateToken ตามที่ SDK จริงทำ แล้วคืนผลของมัน */
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

describe("POST /api/blob/upload", () => {
  beforeEach(() => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-token-not-real");
    installHandleUploadMock();
    mocks.getOrderForSlip.mockResolvedValue(pendingOrder);
    mocks.reserveSlipTokenSlot.mockResolvedValue({ ok: true, used: 1 });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetAllMocks();
  });

  it("503 เมื่อไม่ได้ตั้ง BLOB_READ_WRITE_TOKEN (ไม่เรียก SDK)", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    const res = await uploadPOST(jsonRequest("/api/blob/upload", uploadBody(`slips/${ORDER_ID}/a.jpg`)));
    expect(res.status).toBe(503);
    expect(mocks.handleUpload).not.toHaveBeenCalled();
  });

  it("ไม่ใช่ application/json → 415", async () => {
    const res = await uploadPOST(
      new Request("http://localhost/api/blob/upload", { method: "POST", body: "x=1" }),
    );
    expect(res.status).toBe(415);
  });

  it("ออก token เมื่อทุกอย่างผ่าน พร้อมเงื่อนไขบังคับ (ชนิด/ขนาด/สุ่มชื่อ/ห้ามเขียนทับ/อายุสั้น/ผูกกับ order id)", async () => {
    const before = Date.now();
    const res = await uploadPOST(jsonRequest("/api/blob/upload", uploadBody(`slips/${ORDER_ID}/slip.jpg`)));
    expect(res.status).toBe(200);
    const { options } = (await res.json()) as { options: Record<string, unknown> };
    expect(options.allowedContentTypes).toEqual([...SLIP_ALLOWED_TYPES]);
    expect(options.allowedContentTypes).not.toContain("image/gif");
    expect(options.allowedContentTypes).not.toContain("image/svg+xml");
    expect(options.maximumSizeInBytes).toBe(SLIP_MAX_BYTES);
    expect(options.addRandomSuffix).toBe(true);
    expect(options.allowOverwrite).toBe(false);
    expect(options.tokenPayload).toBe(ORDER_ID);
    const validUntil = options.validUntil as number;
    expect(validUntil).toBeGreaterThan(before);
    expect(validUntil - before).toBeLessThanOrEqual(10 * 60 * 1000 + 1000);
    expect(mocks.reserveSlipTokenSlot).toHaveBeenCalledTimes(1);
    expect(mocks.reserveSlipTokenSlot).toHaveBeenCalledWith({ fake: "db" }, TOKEN);
  });

  it.each([
    ["pathname ของออเดอร์อื่น", `slips/${OTHER_ORDER_ID}/x.jpg`],
    ["path traversal ต่อท้าย prefix", `slips/${ORDER_ID}/../x.jpg`],
    ["path traversal ขึ้นไปเหนือ prefix", `slips/${ORDER_ID}/../../${OTHER_ORDER_ID}/x.jpg`],
    ["ขึ้นต้นด้วย ../", `../slips/${ORDER_ID}/x.jpg`],
    ["ไม่มี prefix slips/", `${ORDER_ID}/x.jpg`],
    ["มีโฟลเดอร์ย่อยเพิ่ม", `slips/${ORDER_ID}/sub/x.jpg`],
    ["นามสกุลไม่อนุญาต", `slips/${ORDER_ID}/x.svg`],
    ["ไม่มีชื่อไฟล์", `slips/${ORDER_ID}/`],
  ])("400: %s และไม่กินโควตา token", async (_label, pathname) => {
    const res = await uploadPOST(jsonRequest("/api/blob/upload", uploadBody(pathname)));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("ชื่อไฟล์สลิปไม่ถูกต้อง");
    expect(mocks.reserveSlipTokenSlot).not.toHaveBeenCalled();
  });

  it("400: multipart ไม่รองรับ", async () => {
    const res = await uploadPOST(
      jsonRequest("/api/blob/upload", uploadBody(`slips/${ORDER_ID}/a.jpg`, { multipart: true })),
    );
    expect(res.status).toBe(400);
    expect(mocks.reserveSlipTokenSlot).not.toHaveBeenCalled();
  });

  it.each([
    ["clientPayload ว่าง", null],
    ["clientPayload ไม่ใช่ JSON", "not-json"],
    ["clientPayload ไม่มี token", JSON.stringify({})],
  ])("400: %s", async (_l, clientPayload) => {
    const res = await uploadPOST(
      jsonRequest("/api/blob/upload", uploadBody(`slips/${ORDER_ID}/a.jpg`, { clientPayload })),
    );
    expect(res.status).toBe(400);
    expect(mocks.getOrderForSlip).not.toHaveBeenCalled();
  });

  it("400: ไม่พบออเดอร์", async () => {
    mocks.getOrderForSlip.mockResolvedValue(null);
    const res = await uploadPOST(jsonRequest("/api/blob/upload", uploadBody(`slips/${ORDER_ID}/a.jpg`)));
    expect(res.status).toBe(400);
    expect(mocks.reserveSlipTokenSlot).not.toHaveBeenCalled();
  });

  it.each(["awaiting_review", "confirmed", "cancelled", "expired", "rejected"])(
    "400: สถานะ %s ไม่ใช่ pending_payment",
    async (status) => {
      mocks.getOrderForSlip.mockResolvedValue({ id: ORDER_ID, status, inWindow: true });
      const res = await uploadPOST(jsonRequest("/api/blob/upload", uploadBody(`slips/${ORDER_ID}/a.jpg`)));
      expect(res.status).toBe(400);
      expect(mocks.reserveSlipTokenSlot).not.toHaveBeenCalled();
    },
  );

  it("400: pending_payment แต่หมดเวลาแล้ว (ตามนาฬิกา DB)", async () => {
    mocks.getOrderForSlip.mockResolvedValue({ id: ORDER_ID, status: "pending_payment", inWindow: false });
    const res = await uploadPOST(jsonRequest("/api/blob/upload", uploadBody(`slips/${ORDER_ID}/a.jpg`)));
    expect(res.status).toBe(400);
    expect(mocks.reserveSlipTokenSlot).not.toHaveBeenCalled();
  });

  it(`400: เกินเพดาน token ${MAX_SLIP_TOKENS_PER_ORDER} ครั้งต่อออเดอร์ (ข้อความระบุจำนวน)`, async () => {
    mocks.reserveSlipTokenSlot.mockResolvedValue({ ok: false, error: "token_limit" });
    const res = await uploadPOST(jsonRequest("/api/blob/upload", uploadBody(`slips/${ORDER_ID}/a.jpg`)));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(String(MAX_SLIP_TOKENS_PER_ORDER));
  });

  it("400: สถานะเปลี่ยน/หมดเวลาระหว่างตรวจกับล็อกแถว (race) ไม่ออก token", async () => {
    mocks.reserveSlipTokenSlot.mockResolvedValue({ ok: false, error: "window_closed" });
    const res = await uploadPOST(jsonRequest("/api/blob/upload", uploadBody(`slips/${ORDER_ID}/a.jpg`)));
    expect(res.status).toBe(400);
    mocks.reserveSlipTokenSlot.mockResolvedValue({ ok: false, error: "invalid_state" });
    const res2 = await uploadPOST(jsonRequest("/api/blob/upload", uploadBody(`slips/${ORDER_ID}/a.jpg`)));
    expect(res2.status).toBe(400);
  });

  it("ข้อผิดพลาดภายในของ SDK ไม่รั่วรายละเอียดกลับไปที่ client", async () => {
    mocks.handleUpload.mockRejectedValue(new Error("secret internal detail xyz"));
    const res = await uploadPOST(jsonRequest("/api/blob/upload", uploadBody(`slips/${ORDER_ID}/a.jpg`)));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).not.toContain("secret internal detail");
  });
});

// ---------------------------------------------------------------- /api/orders/[token]/slip

const ctx = { params: Promise.resolve({ token: TOKEN }) };
const callSlip = (body: unknown) =>
  slipPOST(
    jsonRequest(`/api/orders/${TOKEN}/slip`, body) as never,
    ctx as never,
  );

describe("POST /api/orders/[token]/slip", () => {
  beforeEach(() => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-token-not-real");
    vi.stubEnv("DEMO_MODE", "true");
    mocks.getOrderForSlip.mockResolvedValue(pendingOrder);
    mocks.uploadSlip.mockResolvedValue({ ok: true });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetAllMocks();
  });

  it("body ผิดรูปแบบ → 400", async () => {
    expect((await callSlip({})).status).toBe(400);
    expect((await callSlip({ sample: false })).status).toBe(400);
    expect((await callSlip({ pathname: "" })).status).toBe(400);
  });

  it("404 เมื่อไม่พบออเดอร์; 409 เมื่อสถานะไม่ใช่ pending_payment; 409 เมื่อหมดเวลา", async () => {
    mocks.getOrderForSlip.mockResolvedValue(null);
    expect((await callSlip({ sample: true })).status).toBe(404);
    mocks.getOrderForSlip.mockResolvedValue({ id: ORDER_ID, status: "cancelled", inWindow: true });
    expect((await callSlip({ sample: true })).status).toBe(409);
    mocks.getOrderForSlip.mockResolvedValue({ id: ORDER_ID, status: "pending_payment", inWindow: false });
    expect((await callSlip({ sample: true })).status).toBe(409);
    expect(mocks.uploadSlip).not.toHaveBeenCalled();
  });

  describe("สลิปตัวอย่าง", () => {
    it("DEMO_MODE=true → บันทึกด้วย DEMO_SLIP_PATH และไม่แตะ Blob", async () => {
      const res = await callSlip({ sample: true });
      expect(res.status).toBe(200);
      expect(mocks.uploadSlip).toHaveBeenCalledWith(
        { fake: "db" },
        { token: TOKEN, slipPath: DEMO_SLIP_PATH, sample: true },
      );
      expect(mocks.head).not.toHaveBeenCalled();
    });

    it.each([undefined, "", "false", "TRUE", "1", "yes"])(
      "DEMO_MODE=%j (ไม่ใช่ \"true\" เป๊ะ) → 403 และไม่เปลี่ยนสถานะ",
      async (value) => {
        if (value === undefined) vi.stubEnv("DEMO_MODE", undefined as unknown as string);
        else vi.stubEnv("DEMO_MODE", value);
        const res = await callSlip({ sample: true });
        expect(res.status).toBe(403);
        expect(mocks.uploadSlip).not.toHaveBeenCalled();
      },
    );
  });

  describe("สลิปที่อัปโหลดเอง (pathname)", () => {
    const good = () => `slips/${ORDER_ID}/slip-abc.jpg`;
    const meta = (over: Record<string, unknown> = {}) => ({
      pathname: good(),
      contentType: "image/jpeg",
      size: 1234,
      ...over,
    });

    it("503 เมื่อไม่มี BLOB_READ_WRITE_TOKEN", async () => {
      vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
      expect((await callSlip({ pathname: good() })).status).toBe(503);
      expect(mocks.uploadSlip).not.toHaveBeenCalled();
    });

    it.each([
      `slips/${OTHER_ORDER_ID}/x.jpg`,
      `slips/${ORDER_ID}/../x.jpg`,
      `slips/${ORDER_ID}/../../${OTHER_ORDER_ID}/x.jpg`,
      `../slips/${ORDER_ID}/x.jpg`,
      `slips/${ORDER_ID}/sub/x.jpg`,
      "demo/sample-slip.png",
    ])("400 โดยไม่เรียก head(): %s", async (pathname) => {
      const res = await callSlip({ pathname });
      expect(res.status).toBe(400);
      expect(mocks.head).not.toHaveBeenCalled();
      expect(mocks.uploadSlip).not.toHaveBeenCalled();
    });

    it("สำเร็จเมื่อไฟล์มีจริงและชนิด/ขนาดผ่าน → uploadSlip ด้วย pathname (ไม่ใช่ URL)", async () => {
      mocks.head.mockResolvedValue(meta({ contentType: "image/png; charset=binary" }));
      const res = await callSlip({ pathname: good() });
      expect(res.status).toBe(200);
      expect(mocks.head).toHaveBeenCalledWith(good());
      expect(mocks.uploadSlip).toHaveBeenCalledWith(
        { fake: "db" },
        { token: TOKEN, slipPath: good(), sample: false },
      );
    });

    it.each([
      ["ชนิดไม่อนุญาต (gif)", { contentType: "image/gif" }],
      ["ชนิดไม่อนุญาต (svg)", { contentType: "image/svg+xml" }],
      ["ชนิดไม่อนุญาต (html)", { contentType: "text/html" }],
      ["ใหญ่เกินกำหนด", { size: SLIP_MAX_BYTES + 1 }],
      ["ขนาด 0", { size: 0 }],
      ["pathname ที่ Blob รายงานไม่ตรงกับที่ขอ", { pathname: `slips/${ORDER_ID}/other.jpg` }],
    ])("400: %s", async (_l, over) => {
      mocks.head.mockResolvedValue(meta(over));
      const res = await callSlip({ pathname: good() });
      expect(res.status).toBe(400);
      expect(mocks.uploadSlip).not.toHaveBeenCalled();
    });

    it("ขนาดเท่าเพดานพอดีผ่าน", async () => {
      mocks.head.mockResolvedValue(meta({ size: SLIP_MAX_BYTES }));
      expect((await callSlip({ pathname: good() })).status).toBe(200);
    });

    it("400 เมื่อไม่พบไฟล์ใน Blob; 502 เมื่อ head() ล้มด้วยเหตุอื่น", async () => {
      mocks.head.mockRejectedValue(new BlobNotFoundError());
      expect((await callSlip({ pathname: good() })).status).toBe(400);
      mocks.head.mockRejectedValue(new Error("network down"));
      expect((await callSlip({ pathname: good() })).status).toBe(502);
      expect(mocks.uploadSlip).not.toHaveBeenCalled();
    });
  });

  it("แปลงผลของ uploadSlip: window_closed/invalid_state → 409, not_found → 404, ข้อผิดพลาด → 500", async () => {
    mocks.uploadSlip.mockResolvedValue({ ok: false, error: "window_closed" });
    expect((await callSlip({ sample: true })).status).toBe(409);
    mocks.uploadSlip.mockResolvedValue({ ok: false, error: "invalid_state", status: "cancelled" });
    expect((await callSlip({ sample: true })).status).toBe(409);
    mocks.uploadSlip.mockResolvedValue({ ok: false, error: "not_found" });
    expect((await callSlip({ sample: true })).status).toBe(404);
    mocks.uploadSlip.mockRejectedValue(new Error("db down"));
    expect((await callSlip({ sample: true })).status).toBe(500);
  });
});
