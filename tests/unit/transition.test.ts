import { describe, expect, it } from "vitest";
import type { OrderStatus } from "@/db/schema";
import {
  transition,
  type OrderEventType,
  type TransitionOrder,
} from "@/lib/orders/transition";

const T0 = new Date("2026-10-12T10:00:00Z");
const BEFORE = new Date("2026-10-12T10:05:00Z");
const AFTER = new Date("2026-10-12T10:20:00Z");
const EXPIRES = new Date("2026-10-12T10:15:00Z");

const order = (
  status: OrderStatus,
  deliveryMethod: "pickup" | "post" = "post",
): TransitionOrder => ({ status, deliveryMethod, expiresAt: EXPIRES });

const STATUSES: OrderStatus[] = [
  "pending_payment",
  "awaiting_review",
  "confirmed",
  "shipped",
  "completed",
  "rejected",
  "expired",
  "cancelled",
];

describe("transition: valid paths", () => {
  it("pending_payment --upload_slip--> awaiting_review (item stays reserved)", () => {
    const r = transition(order("pending_payment"), { type: "upload_slip", now: BEFORE });
    expect(r).toMatchObject({ ok: true, to: "awaiting_review", itemStatus: "reserved", actor: "customer" });
  });

  it("pending_payment --cancel--> cancelled (item available)", () => {
    const r = transition(order("pending_payment"), { type: "cancel", now: BEFORE });
    expect(r).toMatchObject({ ok: true, to: "cancelled", itemStatus: "available" });
  });

  it("pending_payment --expire (after expiresAt)--> expired (item available)", () => {
    const r = transition(order("pending_payment"), { type: "expire", now: AFTER });
    expect(r).toMatchObject({ ok: true, to: "expired", itemStatus: "available", actor: "system" });
  });

  it("expire 1ms after expiresAt is allowed; exactly at expiresAt is not (strict, same as SQL)", () => {
    const after = new Date(EXPIRES.getTime() + 1);
    expect(transition(order("pending_payment"), { type: "expire", now: after }).ok).toBe(true);
    expect(transition(order("pending_payment"), { type: "expire", now: EXPIRES })).toEqual({
      ok: false,
      error: "not_yet_expired",
    });
  });

  it("upload_slip tells the caller to clear items.reserved_until; other events do not", () => {
    const up = transition(order("pending_payment"), { type: "upload_slip", now: BEFORE });
    expect(up).toMatchObject({ ok: true, clearReservedUntil: true });
    const cancel = transition(order("pending_payment"), { type: "cancel", now: BEFORE });
    expect(cancel).toMatchObject({ ok: true, clearReservedUntil: false });
  });

  it("awaiting_review --confirm--> confirmed (item sold)", () => {
    const r = transition(order("awaiting_review"), { type: "confirm", now: T0 });
    expect(r).toMatchObject({ ok: true, to: "confirmed", itemStatus: "sold", actor: "admin" });
  });

  it("awaiting_review --reject(reason)--> rejected (item available, reason in meta)", () => {
    const r = transition(order("awaiting_review"), { type: "reject", now: T0, reason: " สลิปไม่ตรง " });
    expect(r).toMatchObject({ ok: true, to: "rejected", itemStatus: "available", meta: { reason: "สลิปไม่ตรง" } });
  });

  it("confirmed --ship(tracking)--> shipped for post orders", () => {
    const r = transition(order("confirmed", "post"), { type: "ship", now: T0, trackingNo: "TH123" });
    expect(r).toMatchObject({ ok: true, to: "shipped", itemStatus: "sold", meta: { trackingNo: "TH123" } });
  });

  it("shipped --complete--> completed", () => {
    const r = transition(order("shipped"), { type: "complete", now: T0 });
    expect(r).toMatchObject({ ok: true, to: "completed", itemStatus: "sold" });
  });

  it("pickup: confirmed --complete--> completed (skips shipped)", () => {
    const r = transition(order("confirmed", "pickup"), { type: "complete", now: T0 });
    expect(r).toMatchObject({ ok: true, to: "completed" });
  });
});

describe("transition: rejected cases", () => {
  it("rejects upload_slip after the payment window closed", () => {
    const r = transition(order("pending_payment"), { type: "upload_slip", now: AFTER });
    expect(r).toEqual({ ok: false, error: "payment_window_closed" });
  });

  it("rejects upload_slip 1ms after expiresAt; exactly at expiresAt still allowed (strict)", () => {
    const after = new Date(EXPIRES.getTime() + 1);
    expect(transition(order("pending_payment"), { type: "upload_slip", now: after })).toEqual({
      ok: false,
      error: "payment_window_closed",
    });
    expect(transition(order("pending_payment"), { type: "upload_slip", now: EXPIRES }).ok).toBe(true);
  });

  it("rejects expire before expiresAt", () => {
    const r = transition(order("pending_payment"), { type: "expire", now: BEFORE });
    expect(r).toEqual({ ok: false, error: "not_yet_expired" });
  });

  it("rejects reject without a reason (empty / whitespace)", () => {
    expect(transition(order("awaiting_review"), { type: "reject", now: T0 })).toEqual({ ok: false, error: "reason_required" });
    expect(transition(order("awaiting_review"), { type: "reject", now: T0, reason: "   " })).toEqual({ ok: false, error: "reason_required" });
  });

  it("rejects ship without tracking number", () => {
    const r = transition(order("confirmed", "post"), { type: "ship", now: T0 });
    expect(r).toEqual({ ok: false, error: "tracking_required" });
  });

  it("rejects ship for pickup orders", () => {
    const r = transition(order("confirmed", "pickup"), { type: "ship", now: T0, trackingNo: "X" });
    expect(r).toEqual({ ok: false, error: "pickup_cannot_ship" });
  });

  it("rejects complete on a post order that is only confirmed (must ship first)", () => {
    const r = transition(order("confirmed", "post"), { type: "complete", now: T0 });
    expect(r).toEqual({ ok: false, error: "invalid_transition" });
  });

  it("rejects an event from the wrong actor", () => {
    expect(transition(order("awaiting_review"), { type: "confirm", now: T0 }, "customer")).toEqual({ ok: false, error: "wrong_actor" });
    expect(transition(order("pending_payment"), { type: "cancel", now: BEFORE }, "admin")).toEqual({ ok: false, error: "wrong_actor" });
    expect(transition(order("pending_payment"), { type: "expire", now: AFTER }, "customer")).toEqual({ ok: false, error: "wrong_actor" });
  });
});

// ตารางที่ถูกต้องทั้งหมด (ตัวแปรอื่นเป็นค่าที่ทำให้เงื่อนไขอื่นผ่าน) — นอกเหนือจากนี้ต้องถูกปฏิเสธ
const VALID: Record<OrderEventType, OrderStatus[]> = {
  upload_slip: ["pending_payment"],
  cancel: ["pending_payment"],
  expire: ["pending_payment"],
  confirm: ["awaiting_review"],
  reject: ["awaiting_review"],
  ship: ["confirmed"],
  complete: ["shipped", "confirmed"], // confirmed เฉพาะ pickup
  return: ["confirmed", "shipped", "completed"], // owner คืนสินค้าเข้าร้าน (ผู้เรียกจำกัด role)
};

describe("transition: exhaustive matrix", () => {
  const events = Object.keys(VALID) as OrderEventType[];
  for (const type of events) {
    for (const status of STATUSES) {
      const shouldPass = VALID[type].includes(status);
      it(`${status} + ${type} => ${shouldPass ? "ok" : "invalid_transition"}`, () => {
        const r = transition(order(status, "pickup"), {
          type,
          now: type === "upload_slip" ? BEFORE : AFTER,
          reason: "r",
          trackingNo: "t",
        });
        // pickup ship ถูกปฏิเสธด้วยเหตุผลอื่น จึงยกเว้นไว้ตรวจแยกด้านบน
        if (type === "ship" && status === "confirmed") {
          expect(r).toEqual({ ok: false, error: "pickup_cannot_ship" });
        } else if (shouldPass) {
          expect(r.ok).toBe(true);
        } else {
          expect(r).toEqual({ ok: false, error: "invalid_transition" });
        }
      });
    }
  }

  it("terminal states accept no events (completed รับได้เฉพาะ return ของ owner)", () => {
    for (const status of ["completed", "rejected", "expired", "cancelled"] as OrderStatus[]) {
      for (const type of events) {
        if (status === "completed" && type === "return") continue;
        const r = transition(order(status, "post"), { type, now: AFTER, reason: "r", trackingNo: "t" });
        expect(r.ok).toBe(false);
      }
    }
  });
});

describe("transition: return (owner คืนสินค้าเข้าร้าน)", () => {
  it.each(["confirmed", "shipped", "completed"] as OrderStatus[])("%s → cancelled, สินค้า available, meta.reason ถูก trim", (status) => {
    const r = transition(order(status, "post"), { type: "return", now: AFTER, reason: "  ลูกค้าขอคืน  " });
    expect(r).toMatchObject({
      ok: true,
      from: status,
      to: "cancelled",
      actor: "admin",
      itemStatus: "available",
      clearReservedUntil: false,
      eventType: "return",
      meta: { reason: "ลูกค้าขอคืน" },
    });
  });

  it("ต้องมีเหตุผล", () => {
    expect(transition(order("confirmed"), { type: "return", now: AFTER })).toEqual({ ok: false, error: "reason_required" });
    expect(transition(order("confirmed"), { type: "return", now: AFTER, reason: "  " })).toEqual({ ok: false, error: "reason_required" });
  });

  it("เป็นคำสั่งของ admin เท่านั้น (ลูกค้า/ระบบสั่งไม่ได้)", () => {
    expect(transition(order("confirmed"), { type: "return", now: AFTER, reason: "x" }, "customer")).toEqual({ ok: false, error: "wrong_actor" });
    expect(transition(order("confirmed"), { type: "return", now: AFTER, reason: "x" }, "system")).toEqual({ ok: false, error: "wrong_actor" });
  });

  it("ก่อนยืนยัน (pending/awaiting) คืนไม่ได้ — ต้องใช้ reject/cancel", () => {
    for (const s of ["pending_payment", "awaiting_review"] as OrderStatus[]) {
      expect(transition(order(s), { type: "return", now: AFTER, reason: "x" })).toEqual({ ok: false, error: "invalid_transition" });
    }
  });
});
