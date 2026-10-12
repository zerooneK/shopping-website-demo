import { describe, expect, it } from "vitest";
import { parseBuildLog, splitInlineCode } from "@/lib/build-log";
import { buildTimeline, describeOrder, isValidOrderToken } from "@/lib/orders/view";

const T0 = Date.parse("2026-10-13T10:00:00Z");
const base = {
  deliveryMethod: "post" as const,
  expiresAtMs: T0 + 15 * 60_000,
  nowMs: T0,
};

describe("describeOrder", () => {
  it("pending_payment shows the payment panel and keeps polling", () => {
    const v = describeOrder({ ...base, status: "pending_payment" });
    expect(v).toMatchObject({
      effectiveStatus: "pending_payment",
      showPayment: true,
      keepPolling: true,
    });
  });

  it("treats a lapsed pending_payment as expired using the supplied (DB) clock", () => {
    const v = describeOrder({ ...base, status: "pending_payment", nowMs: base.expiresAtMs + 1 });
    expect(v).toMatchObject({
      effectiveStatus: "expired",
      showPayment: false,
      keepPolling: false,
      showBackToShop: true,
    });
    // ที่ขอบพอดี (now == expiresAt) ยังจ่ายได้ — ตรงกับ transition()/SQL ที่ใช้ strict
    expect(
      describeOrder({ ...base, status: "pending_payment", nowMs: base.expiresAtMs }).effectiveStatus,
    ).toBe("pending_payment");
  });

  it("awaiting_review says the shop is checking the slip, no payment panel", () => {
    const v = describeOrder({ ...base, status: "awaiting_review" });
    expect(v.headline).toBe("รอร้านตรวจสอบสลิป");
    expect(v.showPayment).toBe(false);
    expect(v.keepPolling).toBe(true);
  });

  it("rejected shows the reason and a link back to the shop", () => {
    const v = describeOrder({ ...base, status: "rejected", rejectReason: "ยอดไม่ตรง" });
    expect(v.body).toContain("ยอดไม่ตรง");
    expect(v.showBackToShop).toBe(true);
    expect(v.keepPolling).toBe(false);
  });

  it("shipped shows the tracking number; pickup confirmed differs from post", () => {
    expect(describeOrder({ ...base, status: "shipped", trackingNo: "TH123" }).body).toContain(
      "TH123",
    );
    expect(describeOrder({ ...base, status: "confirmed" }).headline).toContain("จัดส่ง");
    expect(
      describeOrder({ ...base, status: "confirmed", deliveryMethod: "pickup" }).headline,
    ).toContain("นัดรับ");
  });

  it("terminal states stop polling; confirmed/shipped keep polling", () => {
    for (const s of ["completed", "rejected", "expired", "cancelled"] as const) {
      expect(describeOrder({ ...base, status: s }).keepPolling).toBe(false);
    }
    for (const s of ["confirmed", "shipped"] as const) {
      expect(describeOrder({ ...base, status: s }).keepPolling).toBe(true);
    }
  });
});

describe("buildTimeline", () => {
  it("sorts oldest first and translates event types to Thai", () => {
    const t = buildTimeline([
      { type: "upload_slip", meta: null, createdAtMs: 2000 },
      { type: "created", meta: null, createdAtMs: 1000 },
      { type: "reject", meta: { reason: "ยอดไม่ตรง" }, createdAtMs: 3000 },
    ]);
    expect(t.map((e) => e.label)).toEqual([
      "สร้างออเดอร์และจองสินค้าไว้ให้",
      "ส่งสลิปแล้ว รอร้านตรวจสอบ",
      "ร้านไม่รับสลิป",
    ]);
    expect(t[2].detail).toBe("ยอดไม่ตรง");
  });

  it("shows tracking numbers and ignores unrelated meta", () => {
    const t = buildTimeline([
      { type: "ship", meta: { trackingNo: "TH999", secret: "x" }, createdAtMs: 1 },
      { type: "upload_slip", meta: { sample: true }, createdAtMs: 2 },
    ]);
    expect(t[0].detail).toBe("เลขพัสดุ TH999");
    expect(t[1].detail).toBeNull();
  });

  it("falls back to a generic label for unknown event types", () => {
    expect(buildTimeline([{ type: "weird", meta: null, createdAtMs: 1 }])[0].label).toBe(
      "อัปเดตสถานะ",
    );
  });
});

describe("isValidOrderToken", () => {
  it("accepts 43-char base64url tokens only", () => {
    expect(isValidOrderToken("A".repeat(43))).toBe(true);
    expect(isValidOrderToken("a-_".repeat(14) + "a")).toBe(true);
    expect(isValidOrderToken("short")).toBe(false);
    expect(isValidOrderToken("A".repeat(42) + "/")).toBe(false);
    expect(isValidOrderToken("")).toBe(false);
  });
});

describe("parseBuildLog", () => {
  const md = [
    "# Build Log",
    "",
    "intro text",
    "",
    "## 2026-10-12 · ขั้น 3a · shop-builder (sonnet · medium)",
    "- งาน: scaffold Next.js และ `lib/reserve.ts`",
    "- ผล: ผ่าน (105 tests)",
    "  ต่อบรรทัดที่สอง",
    "- ปัญหาที่เจอ / การ escalate: ไม่มี",
    "",
    "## 2026-10-12 · ขั้น 3a-review · shop-reviewer (opus · medium → low)",
    "- งาน: รีวิว",
    "",
    "## 2026-10-12 · ขั้น 4 · orchestrator (sonnet) + shop-writer (haiku · low)",
    "- ผล: ผ่าน",
    "",
    "## 2026-10-13 · ขั้น 3b-1 · orchestrator ตรวจรับ",
    "- bullet ไม่มีหัวข้อ",
    "",
    "## อย่างอื่นที่ไม่ใช่รายการ",
    "- ไม่ควรถูกนับ",
    "",
  ].join("\n");
  const log = parseBuildLog(md);

  it("parses headings into date/step/agent/model/effort", () => {
    expect(log).toHaveLength(4);
    expect(log[0]).toMatchObject({
      date: "2026-10-12",
      step: "3a",
      agentName: "shop-builder",
      model: "sonnet",
      effort: "medium",
    });
    expect(log[1]).toMatchObject({ step: "3a-review", model: "opus", effort: "medium → low" });
  });

  it("handles multi-agent and parenthesis-less headings without model/effort", () => {
    expect(log[2].agent).toBe("orchestrator (sonnet) + shop-writer (haiku · low)");
    expect(log[2].model).toBeNull();
    expect(log[3]).toMatchObject({ agent: "orchestrator ตรวจรับ", model: null, effort: null });
  });

  it("parses labelled bullets, continuation lines and unlabelled bullets", () => {
    expect(log[0].bullets).toHaveLength(3);
    expect(log[0].bullets[0]).toEqual({
      label: "งาน",
      text: "scaffold Next.js และ `lib/reserve.ts`",
    });
    expect(log[0].bullets[1]).toEqual({ label: "ผล", text: "ผ่าน (105 tests) ต่อบรรทัดที่สอง" });
    expect(log[3].bullets[0]).toEqual({ label: null, text: "bullet ไม่มีหัวข้อ" });
  });

  it("ignores other sections and tolerates CRLF / empty input", () => {
    expect(parseBuildLog("")).toEqual([]);
    expect(parseBuildLog(md.replace(/\n/g, "\r\n"))).toHaveLength(4);
  });

  it("parses the real docs/BUILD_LOG.md (every entry has date, step, agent and bullets)", async () => {
    const { readFile } = await import("node:fs/promises");
    const real = parseBuildLog(await readFile("docs/BUILD_LOG.md", "utf8"));
    expect(real.length).toBeGreaterThan(5);
    for (const e of real) {
      expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.step).toBeTruthy();
      expect(e.agent).toBeTruthy();
      expect(e.bullets.length).toBeGreaterThan(0);
    }
  });
});

describe("splitInlineCode", () => {
  it("splits backtick spans without losing text", () => {
    expect(splitInlineCode("ใช้ `a.ts` และ `b`")).toEqual([
      { code: false, text: "ใช้ " },
      { code: true, text: "a.ts" },
      { code: false, text: " และ " },
      { code: true, text: "b" },
    ]);
    expect(splitInlineCode("ไม่มีโค้ด")).toEqual([{ code: false, text: "ไม่มีโค้ด" }]);
  });
});
