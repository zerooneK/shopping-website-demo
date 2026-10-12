import { describe, expect, it } from "vitest";
import type { NewOrder, Order } from "@/db/schema";
import { transition } from "@/lib/orders/transition";
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
 *  - นาฬิกาอยู่ในตัว store (`clock`) จำลอง now() ของ DB — reserveItem ไม่รับเวลาจากแอป
 *  - claimItem เป็น check-and-set แบบ synchronous (เหมือน UPDATE ... WHERE ... RETURNING ที่ row lock)
 *    และมีเงื่อนไข NOT EXISTS เดียวกับ SQL ใน lib/reserve.ts
 *  - rollback ย้อนเฉพาะ write log ของ transaction นั้น (ไม่ restore snapshot ทั้งก้อน)
 * ข้อจำกัด: ไม่ได้พิสูจน์ความ atomic/ความถูกต้องของ SQL บน Postgres จริง
 */
type FakeItem = {
  id: number;
  code: string;
  price: number;
  status: "available" | "reserved" | "sold" | "hidden";
  reservedUntil: Date | null;
};
type FakeState = { items: FakeItem[]; orders: Order[]; events: NewOrderEvent[] };

const HOLDING = ["awaiting_review", "confirmed", "shipped", "completed"];

function makeStore(
  initial: FakeState,
  opts: { failInsertOrder?: boolean; now?: Date } = {},
) {
  const data: FakeState = structuredClone(initial);
  let nowMs = (opts.now ?? NOW).getTime();
  let seq = 0;
  const store: ReserveStore = {
    async transaction<T>(fn: (tx: ReserveTx) => Promise<T>) {
      // write log ของ tx นี้: undo ต่อรายการ — rollback ย้อนเฉพาะสิ่งที่ tx นี้เขียน
      const undo: Array<() => void> = [];
      const tx: ReserveTx = {
        async expireStaleOrders(code) {
          await Promise.resolve();
          const item = data.items.find((i) => i.code === code);
          const ids: string[] = [];
          for (const o of data.orders) {
            // เทียบเท่า SQL: expires_at < now()
            if (
              item &&
              o.itemId === item.id &&
              o.status === "pending_payment" &&
              o.expiresAt.getTime() < nowMs
            ) {
              const prev = o.status;
              o.status = "expired";
              undo.push(() => {
                o.status = prev;
              });
              ids.push(o.id);
            }
          }
          return ids;
        },
        async claimItem(code): Promise<ClaimedItem | null> {
          await Promise.resolve(); // ให้ transaction อื่นสลับเข้ามาได้ก่อนถึงจุด CAS
          const item = data.items.find((i) => i.code === code);
          // ---- CAS แบบ synchronous จากตรงนี้ถึง return (เหมือน row lock ของ UPDATE) ----
          if (!item) return null;
          const held = data.orders.some(
            (o) =>
              o.itemId === item.id &&
              (HOLDING.includes(o.status) ||
                (o.status === "pending_payment" && o.expiresAt.getTime() >= nowMs)),
          );
          const claimable =
            item.status === "available" ||
            (item.status === "reserved" &&
              item.reservedUntil !== null &&
              item.reservedUntil.getTime() < nowMs &&
              !held);
          if (!claimable) return null;
          const prev = { status: item.status, reservedUntil: item.reservedUntil };
          // now() + 15 นาที คำนวณใน "DB" (store) ไม่ใช่ในแอป
          const until = new Date(nowMs + RESERVE_MINUTES * 60_000);
          item.status = "reserved";
          item.reservedUntil = until;
          undo.push(() => Object.assign(item, prev));
          return { id: item.id, price: item.price, reservedUntil: until };
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
          data.orders.push(order);
          undo.push(() => {
            data.orders.splice(data.orders.indexOf(order), 1);
          });
          return order;
        },
        async insertEvents(events) {
          data.events.push(...events);
          undo.push(() => {
            for (const e of events) data.events.splice(data.events.indexOf(e), 1);
          });
        },
      };
      try {
        return await fn(tx);
      } catch (e) {
        for (const u of undo.reverse()) u(); // rollback เฉพาะ write ของ tx นี้
        throw e;
      }
    },
  };
  return {
    store,
    state: () => data,
    /** เลื่อนนาฬิกาของ "DB" */
    setNow: (d: Date) => {
      nowMs = d.getTime();
    },
  };
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
const minutes = (base: Date, m: number) => new Date(base.getTime() + m * 60_000);

describe("reserveItem", () => {
  it("reserves an available item and creates the order in the same transaction", async () => {
    const { store, state } = makeStore(fresh([item()]));
    let n = 0;
    const r = await reserveItem(store, input(), "sess-1", {
      generateToken: () => `tok-${++n}`,
    });
    expect(r.ok).toBe(true);
    const s = state();
    expect(s.items[0].status).toBe("reserved");
    expect(s.items[0].reservedUntil).toEqual(minutes(NOW, RESERVE_MINUTES));
    expect(s.orders).toHaveLength(1);
    expect(s.orders[0]).toMatchObject({
      token: "tok-1",
      status: "pending_payment",
      itemId: 1,
      demoSessionId: "sess-1",
    });
    // expiresAt ของออเดอร์ต้องเป็นค่า reserved_until ที่ DB คืนมา ไม่ใช่เวลาที่แอปคำนวณเอง
    expect(s.orders[0].expiresAt).toEqual(s.items[0].reservedUntil);
    expect(s.events.map((e) => e.type)).toEqual(["created"]);
  });

  it("computes amount on the server: price + shipping, ignoring client-supplied price", async () => {
    const parsed = createOrderSchema.parse({ ...input(), price: 1, amount: 1 });
    expect("price" in parsed).toBe(false);
    const { store, state } = makeStore(fresh([item({ price: 450 })]));
    await reserveItem(store, parsed, null);
    expect(state().orders[0]).toMatchObject({ amount: 500, shippingFee: 50 });

    const pickup = makeStore(fresh([item({ price: 450 })]));
    await reserveItem(pickup.store, input({ deliveryMethod: "pickup", address: "x" }), null);
    expect(pickup.state().orders[0]).toMatchObject({ amount: 450, shippingFee: 0, address: null });
  });

  it("two concurrent reservations of the same item: exactly one succeeds", async () => {
    const { store, state } = makeStore(fresh([item()]));
    const results = await Promise.all([
      reserveItem(store, input({ customerName: "A" }), null),
      reserveItem(store, input({ customerName: "B" }), null),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: "unavailable" }]);
    expect(state().orders).toHaveLength(1);
  });

  it("many concurrent reservations: exactly one winner", async () => {
    const { store, state } = makeStore(fresh([item()]));
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) => reserveItem(store, input({ customerName: `u${i}` }), null)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(state().orders).toHaveLength(1);
  });

  it("reserving a different item is unaffected", async () => {
    const { store } = makeStore(fresh([item(), item({ id: 2, code: "A013" })]));
    const [a, b] = await Promise.all([
      reserveItem(store, input({ code: "A012" }), null),
      reserveItem(store, input({ code: "A013" }), null),
    ]);
    expect(a.ok && b.ok).toBe(true);
  });

  it.each(["sold", "hidden"] as const)("cannot reserve a %s item", async (status) => {
    const { store, state } = makeStore(fresh([item({ status })]));
    const r = await reserveItem(store, input(), null);
    expect(r).toEqual({ ok: false, reason: "unavailable" });
    expect(state().orders).toHaveLength(0);
  });

  it("cannot reserve an unknown code", async () => {
    const { store } = makeStore(fresh([item()]));
    const r = await reserveItem(store, input({ code: "Z999" }), null);
    expect(r).toEqual({ ok: false, reason: "unavailable" });
  });

  it("cannot reserve while another reservation is still within its window", async () => {
    const until = minutes(NOW, 1);
    const { store } = makeStore(fresh([item({ status: "reserved", reservedUntil: until })]));
    const r = await reserveItem(store, input(), null);
    expect(r).toEqual({ ok: false, reason: "unavailable" });
  });

  it("boundary: at now == reserved_until the item is still held; 1ms later it can be taken", async () => {
    const until = minutes(NOW, 15);
    const s0 = fresh([item({ status: "reserved", reservedUntil: until })]);
    s0.orders.push({ id: "o1", token: "t", itemId: 1, status: "pending_payment", expiresAt: until } as Order);
    const at = makeStore(s0, { now: until });
    expect(await reserveItem(at.store, input(), null)).toEqual({ ok: false, reason: "unavailable" });
    expect(at.state().orders.find((o) => o.id === "o1")?.status).toBe("pending_payment");

    const after = makeStore(s0, { now: new Date(until.getTime() + 1) });
    expect((await reserveItem(after.store, input(), null)).ok).toBe(true);
    expect(after.state().orders.find((o) => o.id === "o1")?.status).toBe("expired");
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

    const r = await reserveItem(store, input(), null);
    expect(r.ok).toBe(true);
    const s = state();
    expect(s.orders.find((o) => o.id === "old-order")?.status).toBe("expired");
    expect(s.events).toContainEqual({ orderId: "old-order", type: "expire", actor: "system" });
    expect(s.orders.filter((o) => o.status === "pending_payment")).toHaveLength(1);
  });

  it("bulk expire matches transition(expire) before, on and after the boundary", async () => {
    const expiresAt = minutes(NOW, 15);
    for (const delta of [-1, 0, 1]) {
      const now = new Date(expiresAt.getTime() + delta);
      const s0 = fresh([item({ status: "reserved", reservedUntil: expiresAt })]);
      s0.orders.push({ id: "o", token: "t", itemId: 1, status: "pending_payment", expiresAt } as Order);
      const { store, state } = makeStore(s0, { now });
      await reserveItem(store, input(), null);
      const bulkExpired = state().orders.find((o) => o.id === "o")?.status === "expired";
      const t = transition(
        { status: "pending_payment", deliveryMethod: "post", expiresAt },
        { type: "expire", now },
      );
      expect(bulkExpired).toBe(t.ok);
    }
  });

  describe("awaiting_review order must keep the item (no double sale)", () => {
    // X จอง 10:00 (หมด 10:15) อัปสลิป 10:10 → awaiting_review, Y พยายามจอง 10:20
    const T_RESERVE = new Date("2026-10-12T10:00:00Z");
    const T_Y = new Date("2026-10-12T10:20:00Z");
    const paid = (): Order =>
      ({
        id: "paid",
        token: "p",
        itemId: 1,
        status: "awaiting_review",
        expiresAt: minutes(T_RESERVE, 15),
      }) as Order;

    it("claimItem refuses even when reserved_until was NOT cleared (self-protecting)", async () => {
      const s0 = fresh([item({ status: "reserved", reservedUntil: minutes(T_RESERVE, 15) })]);
      s0.orders.push(paid());
      const { store, state } = makeStore(s0, { now: T_Y });
      const r = await reserveItem(store, input(), null);
      expect(r).toEqual({ ok: false, reason: "unavailable" });
      expect(state().orders).toHaveLength(1);
      expect(state().orders[0].status).toBe("awaiting_review");
      expect(state().items[0].status).toBe("reserved");
    });

    it("also refuses when reserved_until was cleared to NULL (handler contract)", async () => {
      const s0 = fresh([item({ status: "reserved", reservedUntil: null })]);
      s0.orders.push(paid());
      const { store, state } = makeStore(s0, { now: T_Y });
      expect(await reserveItem(store, input(), null)).toEqual({ ok: false, reason: "unavailable" });
      expect(state().orders).toHaveLength(1);
    });

    it.each(["confirmed", "shipped", "completed"] as const)(
      "refuses when a %s order holds the item with a stale reserved_until",
      async (status) => {
        const s0 = fresh([item({ status: "reserved", reservedUntil: minutes(T_RESERVE, 15) })]);
        s0.orders.push({ ...paid(), status } as Order);
        const { store, state } = makeStore(s0, { now: T_Y });
        expect(await reserveItem(store, input(), null)).toEqual({ ok: false, reason: "unavailable" });
        expect(state().orders).toHaveLength(1);
      },
    );

    it("the old order is not expired by the lazy expiry", async () => {
      const s0 = fresh([item({ status: "reserved", reservedUntil: minutes(T_RESERVE, 15) })]);
      s0.orders.push(paid());
      const { store, state } = makeStore(s0, { now: T_Y });
      await reserveItem(store, input(), null);
      expect(state().orders.find((o) => o.id === "paid")?.status).toBe("awaiting_review");
      expect(state().events).toHaveLength(0);
    });

    it("transition(upload_slip) tells the handler to clear reserved_until", () => {
      const t = transition(
        { status: "pending_payment", deliveryMethod: "post", expiresAt: minutes(T_RESERVE, 15) },
        { type: "upload_slip", now: minutes(T_RESERVE, 10) },
      );
      expect(t).toMatchObject({ ok: true, to: "awaiting_review", clearReservedUntil: true });
    });
  });

  it("rolls back the claim when order creation fails", async () => {
    const { store, state } = makeStore(fresh([item()]), { failInsertOrder: true });
    await expect(reserveItem(store, input(), null)).rejects.toThrow("db down");
    expect(state().items[0]).toMatchObject({ status: "available", reservedUntil: null });
    expect(state().orders).toHaveLength(0);
  });

  it("rollback undoes only the failing transaction, not other committed work", async () => {
    const past = new Date(NOW.getTime() - 60_000);
    const s0 = fresh([item({ status: "reserved", reservedUntil: past }), item({ id: 2, code: "A013" })]);
    s0.orders.push({ id: "old", token: "o", itemId: 1, status: "pending_payment", expiresAt: past } as Order);
    const { store, state } = makeStore(s0, { failInsertOrder: false });
    // tx ของสินค้าอื่นสำเร็จ แล้วจึงมี tx ที่ล้ม — งานที่ commit แล้วต้องไม่ถูกย้อน
    await reserveItem(store, input({ code: "A013" }), null);
    const failing = makeStore(state(), { failInsertOrder: true });
    await expect(reserveItem(failing.store, input(), null)).rejects.toThrow("db down");
    // expire ที่ทำใน tx ที่ล้มถูกย้อนกลับ และ event ของ tx นั้นถูกทิ้ง
    expect(failing.state().orders.find((o) => o.id === "old")?.status).toBe("pending_payment");
    expect(failing.state().events.filter((e) => e.type === "expire")).toHaveLength(0);
    // งานที่ commit ไปก่อนหน้า (ออเดอร์ของ A013) ยังอยู่
    expect(failing.state().orders.filter((o) => o.itemId === 2)).toHaveLength(1);
  });
});
