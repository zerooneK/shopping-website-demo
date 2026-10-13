import { describe, expect, it } from "vitest";
import { maskAddress, maskName, maskNote, maskPhone, MASKED_ADDRESS, MASKED_NOTE } from "@/lib/admin/mask";
import {
  ADMIN_TABS,
  adminTransitionSchema,
  availableActions,
  buildAdminTimeline,
  canTransitionOrder,
  DEMO_READ_ONLY_REASON,
  effectiveOrderStatus,
  parseTab,
  STATUS_PRIORITY,
  toAdminOrderView,
  type AdminOrderRow,
} from "@/lib/admin/view";
import type { AdminSession } from "@/lib/auth";
import type { OrderStatus } from "@/db/schema";

const OWNER: AdminSession = { role: "owner" };
const SID = "S".repeat(32);
const DEMO: AdminSession = { role: "demo", sid: SID };

const NAME = "สมชาย ใจดี";
const PHONE = "0812345678";
const ADDRESS = "99/9 ถนนตัวอย่าง แขวงทดสอบ กรุงเทพฯ 10000";
const NOTE = "ฝากไว้กับ รปภ. ได้";
const SLIP_PATH = "slips/11111111-1111-4111-8111-111111111111/abc.jpg";

function row(over: Partial<AdminOrderRow> = {}): AdminOrderRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    status: "awaiting_review",
    expiredByClock: false,
    amount: 500,
    shippingFee: 50,
    deliveryMethod: "post",
    customerName: NAME,
    phone: PHONE,
    address: ADDRESS,
    note: NOTE,
    trackingNo: null,
    rejectReason: null,
    createdAt: new Date("2026-10-13T01:00:00Z"),
    slipUploadedAt: new Date("2026-10-13T01:05:00Z"),
    slipPath: SLIP_PATH,
    demoSessionId: "someone-else-session-id-xxxxxxxxxxxxxxxx",
    item: { code: "A001", title: "เสื้อ", status: "reserved", lapsed: false, held: true },
    ...over,
  };
}

describe("mask (role demo)", () => {
  it("ชื่อ: ตัวแรก + ***", () => {
    expect(maskName(NAME)).toBe("ส***");
    expect(maskName("  Anna ")).toBe("A***");
    expect(maskName("")).toBe("***");
  });

  it("เบอร์: ตามรูปแบบ SPEC (08x-xxx-xx12) ไม่หลุดตัวเลขกลาง", () => {
    expect(maskPhone("0812345678")).toBe("08x-xxx-xx78");
    expect(maskPhone("081-234-5678")).toBe("08x-xxx-xx78");
    expect(maskPhone("12345")).toBe("xxx-xxx-xxxx");
  });

  it("ที่อยู่/หมายเหตุ: ข้อความคงที่ ไม่รั่วเนื้อหาและความยาว; ว่าง = null", () => {
    expect(maskAddress(ADDRESS)).toBe(MASKED_ADDRESS);
    expect(maskAddress("x")).toBe(MASKED_ADDRESS);
    expect(maskAddress(null)).toBeNull();
    expect(maskAddress("   ")).toBeNull();
    expect(maskNote(NOTE)).toBe(MASKED_NOTE);
    expect(maskNote(null)).toBeNull();
  });
});

describe("toAdminOrderView: ความเป็นส่วนตัวตาม role", () => {
  it("owner เห็นข้อมูลจริงทั้งหมด", () => {
    const v = toAdminOrderView(row(), OWNER);
    expect(v.masked).toBe(false);
    expect(v.customerName).toBe(NAME);
    expect(v.phone).toBe(PHONE);
    expect(v.address).toBe(ADDRESS);
    expect(v.note).toBe(NOTE);
  });

  it("demo: ค่าจริงของชื่อ/เบอร์/ที่อยู่/หมายเหตุไม่อยู่ใน DTO เลย (ตรวจจาก JSON ทั้งก้อน)", () => {
    const v = toAdminOrderView(row(), DEMO);
    expect(v.masked).toBe(true);
    expect(v.customerName).toBe("ส***");
    expect(v.phone).toBe("08x-xxx-xx78");
    expect(v.address).toBe(MASKED_ADDRESS);
    expect(v.note).toBe(MASKED_NOTE);
    const json = JSON.stringify(v);
    for (const secret of [NAME, "สมชาย", "ใจดี", PHONE, "12345678", "99/9", "ถนนตัวอย่าง", "รปภ"]) {
      expect(json).not.toContain(secret);
    }
  });

  it("DTO ไม่มี slipPath / demoSessionId / token / clientIpHash ไม่ว่า role ใด", () => {
    for (const s of [OWNER, DEMO]) {
      const v = toAdminOrderView(row({ demoSessionId: SID }), s);
      const json = JSON.stringify(v);
      expect(json).not.toContain(SLIP_PATH);
      expect(json).not.toContain("slips/");
      expect(json).not.toContain(SID);
      expect(Object.keys(v)).not.toContain("slipPath");
      expect(Object.keys(v)).not.toContain("demoSessionId");
      expect(Object.keys(v)).not.toContain("token");
      expect(Object.keys(v)).not.toContain("clientIpHash");
    }
  });

  it("สลิป: owner เห็นทุกใบ; demo เห็นเฉพาะ demo_session_id ตรงกับ sid ของตน", () => {
    expect(toAdminOrderView(row(), OWNER).slipVisible).toBe(true);
    expect(toAdminOrderView(row(), DEMO).slipVisible).toBe(false);
    expect(toAdminOrderView(row({ demoSessionId: SID }), DEMO).slipVisible).toBe(true);
    expect(toAdminOrderView(row({ demoSessionId: null }), DEMO).slipVisible).toBe(false);
    // ไม่มีสลิป = ไม่มีอะไรให้ดู ไม่ว่า role ใด
    expect(toAdminOrderView(row({ slipPath: null, demoSessionId: SID }), DEMO).slipVisible).toBe(false);
    expect(toAdminOrderView(row({ slipPath: null }), OWNER).slipVisible).toBe(false);
    expect(toAdminOrderView(row({ slipPath: null }), OWNER).hasSlip).toBe(false);
  });

  it("demo ที่เป็นเจ้าของออเดอร์ก็ยังเห็น PII แบบ mask (mask เสมอสำหรับ role demo)", () => {
    const v = toAdminOrderView(row({ demoSessionId: SID }), DEMO);
    expect(v.slipVisible).toBe(true);
    expect(v.customerName).toBe("ส***");
    expect(v.phone).toBe("08x-xxx-xx78");
  });
});

describe("สิทธิ์เปลี่ยนสถานะตาม role (demo = เฉพาะออเดอร์ของ sid ตัวเอง)", () => {
  it("canTransitionOrder: owner ทำได้ทุกออเดอร์; demo ทำได้เมื่อ sid ตรงเท่านั้น", () => {
    expect(canTransitionOrder(OWNER, null)).toBe(true);
    expect(canTransitionOrder(OWNER, "anything-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")).toBe(true);
    expect(canTransitionOrder(DEMO, SID)).toBe(true);
    expect(canTransitionOrder(DEMO, "someone-else-session-id-xxxxxxxxxxxxxxxx")).toBe(false);
    expect(canTransitionOrder(DEMO, null)).toBe(false);
  });

  it("DTO ของ demo ที่ไม่ใช่ออเดอร์ตัวเอง: ไม่มี action + มีข้อความเหตุผล; ของตัวเอง/owner มี action และไม่มีข้อความ", () => {
    const other = toAdminOrderView(row(), DEMO);
    expect(other.actions).toEqual([]);
    expect(other.readOnlyReason).toBe(DEMO_READ_ONLY_REASON);
    expect(other.readOnlyReason).toContain("ดูได้อย่างเดียว");

    const noSid = toAdminOrderView(row({ demoSessionId: null }), DEMO);
    expect(noSid.actions).toEqual([]);
    expect(noSid.readOnlyReason).not.toBeNull();

    const own = toAdminOrderView(row({ demoSessionId: SID }), DEMO);
    expect(own.actions).toEqual(["confirm", "reject"]);
    expect(own.readOnlyReason).toBeNull();

    const owner = toAdminOrderView(row(), OWNER);
    expect(owner.actions).toEqual(["confirm", "reject"]);
    expect(owner.readOnlyReason).toBeNull();
  });

  it("ข้อความเหตุผลไม่รั่ว sid / path สลิป", () => {
    expect(DEMO_READ_ONLY_REASON).not.toContain("slips/");
    const json = JSON.stringify(toAdminOrderView(row({ demoSessionId: SID }), DEMO));
    expect(json).not.toContain(SID);
  });
});

describe("slipIsHeic (ตามนามสกุลที่เก็บไว้)", () => {
  it("นามสกุล .heic/.heif (ไม่สนตัวพิมพ์) = true; อื่นๆ/ไม่มีสลิป = false", () => {
    const at = (slipPath: string | null) => toAdminOrderView(row({ slipPath }), OWNER).slipIsHeic;
    expect(at("slips/x/abc.heic")).toBe(true);
    expect(at("slips/x/ABC.HEIC")).toBe(true);
    expect(at("slips/x/abc.heif")).toBe(true);
    expect(at("slips/x/abc.jpg")).toBe(false);
    expect(at("slips/x/abc.heic.png")).toBe(false);
    expect(at(null)).toBe(false);
  });
});

describe("สถานะที่แสดง (ไม่แสดงสถานะดิบที่หมดอายุแล้ว)", () => {
  it("pending_payment ที่เลยเวลา = expired; สถานะอื่นไม่เปลี่ยน", () => {
    expect(effectiveOrderStatus("pending_payment", true)).toBe("expired");
    expect(effectiveOrderStatus("pending_payment", false)).toBe("pending_payment");
    expect(effectiveOrderStatus("awaiting_review", true)).toBe("awaiting_review");
    expect(effectiveOrderStatus("confirmed", true)).toBe("confirmed");
  });

  it("DTO: pending_payment ที่หมดเวลา → status expired, ป้ายหมดเวลา, ไม่มี action", () => {
    const v = toAdminOrderView(row({ status: "pending_payment", expiredByClock: true, slipPath: null }), OWNER);
    expect(v.status).toBe("expired");
    expect(v.statusLabel).toBe("หมดเวลา");
    expect(v.actions).toEqual([]);
  });

  it("สถานะสินค้าใช้ resolveDisplayStatus: reserved หมดเวลาไม่มีผู้ถือ = ว่าง; มีผู้ถือ (รอตรวจสลิป) = จองอยู่", () => {
    const base = row().item;
    const lapsedFree = toAdminOrderView(row({ item: { ...base, lapsed: true, held: false } }), OWNER);
    expect(lapsedFree.item.display).toBe("available");
    const lapsedHeld = toAdminOrderView(row({ item: { ...base, lapsed: true, held: true } }), OWNER);
    expect(lapsedHeld.item.display).toBe("reserved");
    expect(toAdminOrderView(row({ item: { ...base, status: "sold" } }), OWNER).item.display).toBe("sold");
    expect(toAdminOrderView(row({ item: { ...base, status: "hidden" } }), OWNER).item.display).toBeNull();
  });
});

describe("availableActions (อิง transition())", () => {
  const cases: [OrderStatus, "pickup" | "post", string[]][] = [
    ["awaiting_review", "post", ["confirm", "reject"]],
    ["awaiting_review", "pickup", ["confirm", "reject"]],
    ["confirmed", "post", ["ship"]],
    ["confirmed", "pickup", ["complete"]],
    ["shipped", "post", ["complete"]],
    ["pending_payment", "post", []],
    ["completed", "post", []],
    ["rejected", "post", []],
    ["expired", "pickup", []],
    ["cancelled", "pickup", []],
  ];
  it.each(cases)("%s / %s → %j", (status, method, expected) => {
    expect(availableActions(status, method)).toEqual(expected);
  });
});

describe("แท็บและลำดับความสำคัญ", () => {
  it("awaiting_review มีลำดับก่อนทุกสถานะ และสถานะปิดท้ายสุด", () => {
    const all = Object.keys(STATUS_PRIORITY) as OrderStatus[];
    const min = Math.min(...all.map((s) => STATUS_PRIORITY[s]));
    expect(STATUS_PRIORITY.awaiting_review).toBe(min);
    for (const s of all.filter((x) => x !== "awaiting_review")) {
      expect(STATUS_PRIORITY[s]).toBeGreaterThan(STATUS_PRIORITY.awaiting_review);
    }
    expect(STATUS_PRIORITY.confirmed).toBeLessThan(STATUS_PRIORITY.completed);
    expect(STATUS_PRIORITY.pending_payment).toBeLessThan(STATUS_PRIORITY.rejected);
  });

  it("ทุกสถานะอยู่ในแท็บ 'ปิด/ทำงาน' อย่างน้อยหนึ่งแท็บ (ไม่มีออเดอร์หลุดจากการแสดงผล)", () => {
    const all = Object.keys(STATUS_PRIORITY) as OrderStatus[];
    for (const s of all) {
      expect(ADMIN_TABS.some((t) => t.statuses?.includes(s))).toBe(true);
    }
  });

  it("parseTab: ค่าแปลก → all", () => {
    expect(parseTab("review")).toBe("review");
    expect(parseTab(["closed", "x"])).toBe("closed");
    expect(parseTab("nope")).toBe("all");
    expect(parseTab(undefined)).toBe("all");
  });
});

describe("buildAdminTimeline", () => {
  it("กรอง event ภายใน slip_token_issued ออก และเรียงเก่า → ใหม่", () => {
    const t = buildAdminTimeline([
      { type: "confirm", actor: "admin", meta: { adminRole: "owner" }, createdAtMs: 40 },
      { type: "slip_token_issued", actor: "customer", meta: null, createdAtMs: 15 },
      { type: "created", actor: "customer", meta: { code: "A001" }, createdAtMs: 10 },
      { type: "slip_token_issued", actor: "customer", meta: null, createdAtMs: 18 },
      { type: "upload_slip", actor: "customer", meta: { sample: true }, createdAtMs: 20 },
    ]);
    expect(t.map((e) => e.label)).toEqual(["ลูกค้าจองสินค้า", "ลูกค้าส่งสลิป", "ยืนยันการชำระเงิน"]);
    expect(t.some((e) => e.label.includes("slip_token"))).toBe(false);
    expect(t[1].detail).toBe("สลิปตัวอย่าง");
    expect(t[2].detail).toBe("โดย เจ้าของร้าน");
  });

  it("แสดงเหตุผลที่ปฏิเสธและเลขพัสดุ", () => {
    const t = buildAdminTimeline([
      { type: "reject", actor: "admin", meta: { reason: "ยอดไม่ตรง", adminRole: "demo" }, createdAtMs: 1 },
      { type: "ship", actor: "admin", meta: { trackingNo: "TH123456789" }, createdAtMs: 2 },
    ]);
    expect(t[0].detail).toBe("เหตุผล: ยอดไม่ตรง · โดย ผู้ลองเดโม");
    expect(t[1].detail).toBe("เลขพัสดุ TH123456789");
  });
});

describe("adminTransitionSchema (Zod)", () => {
  const id = "11111111-1111-4111-8111-111111111111";

  it("reject ต้องมีเหตุผลไม่ว่าง ≤ 300 ตัวอักษร", () => {
    expect(adminTransitionSchema.safeParse({ orderId: id, intent: "reject" }).success).toBe(false);
    expect(adminTransitionSchema.safeParse({ orderId: id, intent: "reject", reason: "   " }).success).toBe(false);
    expect(adminTransitionSchema.safeParse({ orderId: id, intent: "reject", reason: "x".repeat(301) }).success).toBe(false);
    const ok = adminTransitionSchema.safeParse({ orderId: id, intent: "reject", reason: "  ยอดไม่ตรง " });
    expect(ok.success && ok.data.intent === "reject" && ok.data.reason).toBe("ยอดไม่ตรง");
  });

  it("ship ต้องมีเลขพัสดุรูปแบบถูกต้อง", () => {
    expect(adminTransitionSchema.safeParse({ orderId: id, intent: "ship" }).success).toBe(false);
    expect(adminTransitionSchema.safeParse({ orderId: id, intent: "ship", trackingNo: "<script>" }).success).toBe(false);
    expect(adminTransitionSchema.safeParse({ orderId: id, intent: "ship", trackingNo: "TH1" }).success).toBe(false);
    expect(adminTransitionSchema.safeParse({ orderId: id, intent: "ship", trackingNo: " TH123456789 " }).success).toBe(true);
  });

  it("orderId ต้องเป็น uuid และ intent ต้องอยู่ในรายการ", () => {
    expect(adminTransitionSchema.safeParse({ orderId: "1", intent: "confirm" }).success).toBe(false);
    expect(adminTransitionSchema.safeParse({ orderId: id, intent: "delete" }).success).toBe(false);
    expect(adminTransitionSchema.safeParse({ orderId: id, intent: "confirm" }).success).toBe(true);
    expect(adminTransitionSchema.safeParse({ orderId: id, intent: "complete" }).success).toBe(true);
  });
});
