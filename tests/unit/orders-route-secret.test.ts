import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/orders เมื่อไม่มี SESSION_SECRET (ขั้น 3b-2-fix2): production ต้อง fail-closed (503)
 * ไม่ใช้กุญแจสำรองที่อยู่ใน repo สาธารณะ; dev/test ยังใช้กุญแจสำรองได้
 * mock ฟังก์ชันจอง/DB — ไม่ต่อ DB จริง
 */

const mocks = vi.hoisted(() => ({
  reserveItem: vi.fn(),
  getDb: vi.fn(() => ({ fake: "db" })),
}));

vi.mock("@/db/client", () => ({ getDb: mocks.getDb }));
vi.mock("@/lib/reserve", async (orig) => ({
  ...(await orig<typeof import("@/lib/reserve")>()),
  reserveItem: mocks.reserveItem,
  createDrizzleReserveStore: () => ({ fake: "store" }),
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/orders/route";

function orderRequest(): NextRequest {
  return new NextRequest("http://localhost/api/orders", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
    body: JSON.stringify({
      code: "A001",
      customerName: "ทดสอบ",
      phone: "0812345678",
      deliveryMethod: "pickup",
    }),
  });
}

describe("POST /api/orders: SESSION_SECRET", () => {
  beforeEach(() => {
    mocks.reserveItem.mockReset();
    mocks.getDb.mockClear();
    mocks.reserveItem.mockResolvedValue({ ok: true, order: { token: "tok-123" } });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("production ไม่มี SESSION_SECRET → 503 ข้อความทั่วไป ไม่แตะ DB/ไม่จอง และ log เฉพาะชื่อ env", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_SECRET", "");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(orderRequest());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error.length).toBeGreaterThan(5);
    // ไม่เปิดเผยรายละเอียดภายในให้ผู้เรียก
    expect(JSON.stringify(body)).not.toMatch(/SESSION_SECRET|secret|env/i);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("set-cookie")).toBeNull();

    expect(mocks.reserveItem).not.toHaveBeenCalled();
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0][0])).toContain("SESSION_SECRET");
    expect(err.mock.calls[0]).toHaveLength(1); // ไม่มี argument อื่น (เช่น headers/IP/ค่า env)
  });

  it("production ที่มี SESSION_SECRET → จองตามปกติ (201) ด้วย hash ของ IP", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_SECRET", "unit-test-secret-unit-test-secret-xx");
    const res = await POST(orderRequest());
    expect(res.status).toBe(201);
    expect(mocks.reserveItem).toHaveBeenCalledTimes(1);
    const opts = mocks.reserveItem.mock.calls[0][3] as { clientIpHash: string };
    expect(opts.clientIpHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(opts)).not.toContain("203.0.113.9");
  });

  it("development/test ไม่มี SESSION_SECRET → ใช้กุญแจสำรองได้ (201)", async () => {
    for (const env of ["development", "test"]) {
      mocks.reserveItem.mockClear();
      vi.stubEnv("NODE_ENV", env);
      vi.stubEnv("SESSION_SECRET", "");
      const res = await POST(orderRequest());
      expect(res.status, env).toBe(201);
      expect(mocks.reserveItem).toHaveBeenCalledTimes(1);
    }
  });
});
