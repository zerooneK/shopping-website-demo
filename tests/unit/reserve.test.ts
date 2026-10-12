import { describe, expect, it } from "vitest";
import type { NewOrder, Order } from "@/db/schema";
import {
  RESERVE_MINUTES,
  reserveItem,
  type ClaimedItem,
  type NewOrderEvent,
  type ReserveStore,
  type ReserveTx,
} from "@/lib/reserve";
import { createOrderSchema, type CreateOrderInput } from "@/lib/validation";

/**
 * In-memory store จำลองพฤติกรรมของ Postgres เท่าที่ logic ต้องพึ่ง:
 *  - claimItem เป็น check-and-set แบบ synchronous (เหมือน UPDATE ... WHERE ... RETURNING ที่ row lock)
 *  - transaction rollback เมื่อ throw
 * ข้อจำกัด: ไม่ได้พิสูจน์ความ atomic ของ Postgres จริง (ดูรายงาน)
 */
type FakeItem = {
  id: number;
  code: string;
  price: number;
  status: "available" | "reserved" | "sold" | "hidden";
  reservedUntil: Date | null;
};
type FakeState = { items: FakeItem[]; orders: Order[]; events: NewOrderEvent[] };

function makeStore(initial: FakeState, opts: { failInsertOrder?: boolean } = {}) {
  let committed: FakeState = structuredClone(initial);
  let seq = 0;
  const store: ReserveStore = {
    async transaction<T>(fn: (tx: ReserveTx) => Promise<T>) {
      // ทำงานบนสำเนา แล้ว commit ตอนจบ (rollback = ทิ้งสำเนา)
      // หมายเหตุ: โมเดลนี้ไม่ซ้อนทับกันข้าม transaction จึงจำลอง row lock ผ่านการ yield ใน tx
      const work = committed;
      const snapshot = structuredClone(work);
      const tx: ReserveTx = {
        async expireStaleOrders(code, now) {
          await Promise.resolve();
          const item = work.items.find((i) => i.code === code);
          const ids: string[] = [];
          for (const o of work.orders) {
            if (
              item &&
              o.itemId === item.id &&
              o.status === "pending_payment" &&
              o.expiresAt < now
            ) {
              o.status = "expired";
              ids.push(o.id);
            }
          }
          return ids;
        },
        async claimItem(code, now, until): Promise<ClaimedItem | null> {
          await Promise.resolve(); // ให้ transaction อื่นสลับเข้ามาได้ก่อนถึงจุด CAS
          const item = work.items.find((i) => i.code === code);
          // ---- CAS แบบ synchronous จากตรงนี้ถึง return (เหมือน row lock ของ UPDATE) ----
          if (
            item &&
            (item.status === "available" ||
              (item.status === "reserved" && item.reservedUntil! < now))
          ) {
            item.status = "reserved";
            item.reservedUntil = until;
            return { id: item.id, price: item.price };
          }
          return null;
        },
        async insertOrder(values: NewOrder) {
          await Promise.resolve();
          if (opts.failInsertOrder) throw new Error("db down");
          const order = {
            id: `order-${++seq}`,
            slipPath: null,
            slipUploadedAt: null,
            confirmedAt: null,
            shippedAt: null,
            completedAt: null,
            trackingNo: null,
            rejectReason: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            shippingFee: 0,
            address: null,
            note: null,
            demoSessionId: null,
            status: "pending_payment",
            ...values,
          } as Order;
          work.orders.push(order);
          return order;
        },
        async insertEvents(events) {
          work.events.push(...events);
        },
      };
      try {
        return await fn(tx);
      } catch (e) {
        committed = snapshot; // rollback
        throw e;
      }
    },
  };
  return { store, state: () => committed };
}

const NOW = new Date("2026-10-12T10:00:00Z");
const item = (over: Partial<FakeItem> = {}): FakeItem => ({
  id: 1,
  code: "A012",
  price: 450,
  status: "available",
  reservedUntil: null,
  ...over,
});
const input = (over: Partial<CreateOrderInput> = {}): CreateOrderInput => ({
  code: "A012",
  customerName: "สมชาย",
  phone: "0812345678",
  deliveryMethod: "post",
  address: "1 ถ.สุขุมวิท กทม.",
  ...over,
});
const fresh = (items: FakeItem[]): FakeState => ({ items, orders: [], events: [] });

describe("reserveItem", () => {
  it("reserves an available item and creates the order in the same transaction", async () => {
    const { store, state } = makeStore(fresh([item()]));
    let n = 0;
    const r = await reserveItem(store, input(), "sess-1", {
      now: NOW,
      generateToken: () => `tok-${++n}`,
    });
    expect(r.ok).toBe(true);
    const s = state();
    expect(s.items[0].status).toBe("reserved");
    expect(s.items[0].reservedUntil).toEqual(new Date(NOW.getTime() + RESERVE_MINUTES * 60_000));
    expect(s.orders).toHaveLength(1);
    expect(s.orders[0]).toMatchObject({
      token: "tok-1",
      status: "pending_payment",
      itemId: 1,
      demoSessionId: "sess-1",
    });
    expect(s.orders[0].expiresAt).toEqual(s.items[0].reservedUntil);
    expect(s.events.map((e) => e.type)).toEqual(["created"]);
  });

  it("computes amount on the server: price + shipping, ignoring client-supplied price", async () => {
    const parsed = createOrderSchema.parse({ ...input(), price: 1, amount: 1 });
    expect("price" in parsed).toBe(false);
    const { store, state } = makeStore(fresh([item({ price: 450 })]));
    await reserveItem(store, parsed, null, { now: NOW });
    expect(state().orders[0]).toMatchObject({ amount: 500, shippingFee: 50 });

    const pickup = makeStore(fresh([item({ price: 450 })]));
    await reserveItem(pickup.store, input({ deliveryMethod: "pickup", address: "x" }), null, { now: NOW });
    expect(pickup.state().orders[0]).toMatchObject({ amount: 450, shippingFee: 0, address: null });
  });

  it("two concurrent reservations of the same item: exactly one succeeds", async () => {
    const { store, state } = makeStore(fresh([item()]));
    const results = await Promise.all([
      reserveItem(store, input({ customerName: "A" }), null, { now: NOW }),
      reserveItem(store, input({ customerName: "B" }), null, { now: NOW }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: "unavailable" }]);
    expect(state().orders).toHaveLength(1);
  });

  it("many concurrent reservations: exactly one winner", async () => {
    const { store, state } = makeStore(fresh([item()]));
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        reserveItem(store, input({ customerName: `u${i}` }), null, { now: NOW }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(state().orders).toHaveLength(1);
  });

  it("reserving a different item is unaffected", async () => {
    const { store } = makeStore(fresh([item(), item({ id: 2, code: "A013" })]));
    const [a, b] = await Promise.all([
      reserveItem(store, input({ code: "A012" }), null, { now: NOW }),
      reserveItem(store, input({ code: "A013" }), null, { now: NOW }),
    ]);
    expect(a.ok && b.ok).toBe(true);
  });

  it.each(["sold", "hidden"] as const)("cannot reserve a %s item", async (status) => {
    const { store, state } = makeStore(fresh([item({ status })]));
    const r = await reserveItem(store, input(), null, { now: NOW });
    expect(r).toEqual({ ok: false, reason: "unavailable" });
    expect(state().orders).toHaveLength(0);
  });

  it("cannot reserve an unknown code", async () => {
    const { store } = makeStore(fresh([item()]));
    const r = await reserveItem(store, input({ code: "Z999" }), null, { now: NOW });
    expect(r).toEqual({ ok: false, reason: "unavailable" });
  });

  it("cannot reserve while another reservation is still within its window", async () => {
    const until = new Date(NOW.getTime() + 60_000);
    const { store } = makeStore(fresh([item({ status: "reserved", reservedUntil: until })]));
    const r = await reserveItem(store, input(), null, { now: NOW });
    expect(r).toEqual({ ok: false, reason: "unavailable" });
  });

  it("lazy expiry: an expired reservation can be taken, and the stale order is marked expired", async () => {
    const past = new Date(NOW.getTime() - 60_000);
    const state0: FakeState = fresh([item({ status: "reserved", reservedUntil: past })]);
    state0.orders.push({
      id: "old-order",
      token: "old",
      itemId: 1,
      status: "pending_payment",
      expiresAt: past,
    } as Order);
    const { store, state } = makeStore(state0);

    const r = await reserveItem(store, input(), null, { now: NOW });
    expect(r.ok).toBe(true);
    const s = state();
    expect(s.orders.find((o) => o.id === "old-order")?.status).toBe("expired");
    expect(s.events).toContainEqual({ orderId: "old-order", type: "expire", actor: "system" });
    expect(s.orders.filter((o) => o.status === "pending_payment")).toHaveLength(1);
  });

  it("does not expire an awaiting_review order (slip already uploaded)", async () => {
    const past = new Date(NOW.getTime() - 60_000);
    // สินค้ายัง reserved และไม่นับเวลาแล้ว: reservedUntil ในอดีตแต่ order เป็น awaiting_review
    const state0: FakeState = fresh([item({ status: "reserved", reservedUntil: past })]);
    state0.orders.push({
      id: "paid",
      token: "p",
      itemId: 1,
      status: "awaiting_review",
      expiresAt: past,
    } as Order);
    const { store, state } = makeStore(state0);
    await reserveItem(store, input(), null, { now: NOW });
    expect(state().orders.find((o) => o.id === "paid")?.status).toBe("awaiting_review");
  });

  it("rolls back the claim when order creation fails", async () => {
    const { store, state } = makeStore(fresh([item()]), { failInsertOrder: true });
    await expect(reserveItem(store, input(), null, { now: NOW })).rejects.toThrow("db down");
    expect(state().items[0]).toMatchObject({ status: "available", reservedUntil: null });
    expect(state().orders).toHaveLength(0);
  });
});
