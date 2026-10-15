import { describe, expect, it } from "vitest";
import { parseBuildLog, splitInlineCode, stageKey, summarizeBuildLog } from "@/lib/build-log";
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

describe("summarizeBuildLog (ตัวเลขหน้า /about นับจากหัวข้อรายการจริง ไม่ประมาณ)", () => {
  const md = [
    "## 2026-10-12 · ขั้น 2 · orchestrator (Opus 5.5 · medium)",
    "- งาน: สเปค",
    "## 2026-10-12 · ขั้น 3a · shop-builder (sonnet · medium)",
    "- งาน: a",
    "## 2026-10-12 · ขั้น 3a-fix · shop-builder (sonnet · medium)",
    "- งาน: b",
    "## 2026-10-12 · ขั้น 3a-review · shop-reviewer (opus · medium → low)",
    "- งาน: c",
    "## 2026-10-13 · ขั้น 3b-2 · orchestrator ตรวจรับ + shop-reviewer (opus · medium → low → low)",
    "- งาน: d",
    "## 2026-10-13 · ขั้น 3b-2-fix2 · shop-builder (sonnet · high)",
    "- งาน: e",
    "## 2026-10-14 · ขั้น 4b-fix2 · shop-builder (sonnet · medium)",
    "- งาน: f",
    "## 2026-10-14 · ขั้น 5-fix (ผลรีวิวรวม High: เดโม) · shop-builder (sonnet · xhigh)",
    "- งาน: g",
    "## 2026-10-14 · ขั้น 5 · shop-builder (opus · medium)",
    "- งาน: h",
  ].join("\n");

  it("นับรายการ ขั้นตาม SPEC §11 วัน รอบแก้ รอบรีวิว รอบขยับ effort และการส่งงาน Builder ให้ Opus", () => {
    expect(summarizeBuildLog(parseBuildLog(md))).toEqual({
      entryCount: 9,
      // 2, 3a, 3b, 4 (จาก 4b), 5
      stageCount: 5,
      firstDate: "2026-10-12",
      lastDate: "2026-10-14",
      daysWithEntries: 3,
      // 3a-fix, 3b-2-fix2, 4b-fix2, 5-fix
      fixEntryCount: 4,
      reviewerEntryCount: 2,
      // medium → low (2) + medium → low → low (3)
      reviewerRounds: 5,
      // sonnet · high, sonnet · xhigh
      effortRaisedCount: 2,
      opusBuilderCount: 1,
    });
  });

  it("บันทึกว่าง: ทุกค่าเป็น 0/null ไม่แต่งตัวเลข", () => {
    expect(summarizeBuildLog([])).toEqual({
      entryCount: 0,
      stageCount: 0,
      firstDate: null,
      lastDate: null,
      daysWithEntries: 0,
      fixEntryCount: 0,
      reviewerEntryCount: 0,
      reviewerRounds: 0,
      effortRaisedCount: 0,
      opusBuilderCount: 0,
    });
  });

  it("stageKey: ขั้นย่อยรวมเข้าขั้นแม่ตาม SPEC", () => {
    expect(
      ["2", "3a", "3b-1", "3b-2-fix2", "3c-1", "4", "4b-fix2", "5-fix (ผลรีวิวรวม)", "x"].map(stageKey),
    ).toEqual(["2", "3a", "3b", "3b", "3c", "4", "4", "5", null]);
  });

  it("กับ docs/BUILD_LOG.md จริง: ตัวเลขสอดคล้องกับที่นับได้ด้วยตา (ไม่ใช่ 0 และไม่มีเงิน/เวลาเป็นชั่วโมง)", async () => {
    const { readFile } = await import("node:fs/promises");
    const entries = parseBuildLog(await readFile("docs/BUILD_LOG.md", "utf8"));
    const s = summarizeBuildLog(entries);
    expect(s.entryCount).toBe(entries.length);
    expect(s.stageCount).toBeGreaterThanOrEqual(6); // 2, 3a, 3b, 3c, 4, 5
    expect(s.fixEntryCount).toBeGreaterThanOrEqual(6);
    expect(s.reviewerRounds).toBeGreaterThanOrEqual(5);
    expect(s.effortRaisedCount).toBeGreaterThanOrEqual(2);
    expect(s.firstDate).toBe("2026-10-12");
    // ไม่มีรายการไหนใน BUILD_LOG ส่งงาน Builder ให้ Opus
    expect(s.opusBuilderCount).toBe(0);
  });
});
