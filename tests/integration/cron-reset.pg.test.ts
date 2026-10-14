import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { Pool, type PoolClient } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import seedData from "@/db/seed-data.json";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";
import { items, orderEvents, orders } from "@/db/schema";
import { parseSeedItems } from "@/db/seed-schema";
import { RESET_LOCK_KEY, resetDemoData } from "@/lib/cron/reset";
import { createDrizzleReserveStore, reserveItem, type ReserveStore } from "@/lib/reserve";
import { sql } from "drizzle-orm";

/**
 * Integration test ของ cron รีเซ็ตรายวัน กับ Postgres (Neon) จริง — โดยไม่แตะตารางจริง
 *
 * เหตุผล: resetDemoData ล้างทั้งตาราง orders/order_events และลบสินค้านอก seed (นั่นคือพฤติกรรมที่ต้องการของ cron จริง)
 * ถ้ารันกับตาราง public จะลบข้อมูลที่ไม่ใช่ของเทสต์ → เทสต์นี้จึงสร้าง "schema ชั่วคราว" (cron_it_<สุ่ม>) ใน DB เดียวกัน
 * สร้างตารางด้วย migration จริงของโปรเจกต์ (แทนที่ "public". ด้วยชื่อ schema ชั่วคราว) ตั้ง search_path ของ connection ทุกตัว
 * ให้ชี้ schema นั้น แล้วส่ง Db ที่ผูกกับ schema นั้นให้ resetDemoData — คำสั่ง SQL จริงทุกบรรทัดรันบน Neon จริง
 * แต่ข้อมูลอยู่ในตารางชั่วคราว แล้ว DROP SCHEMA ทิ้งตอนจบ
 *
 * ยืนยันความปลอดภัย: นับ/เช็คข้อมูลตาราง public.items และ public.orders ก่อน-หลังรัน ต้องเท่าเดิมทุกประการ
 * (advisory lock เป็นระดับ database จึงใช้ร่วมกับ cron จริงได้ — ล็อกอยู่เพียงเสี้ยววินาที)
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);
if (!HAS_DB) {
  console.warn("[integration] ข้ามเทสต์: ไม่พบ DATABASE_URL (รันผ่าน `npm run test:integration`)");
}

const SCHEMA = `cron_it_${randomBytes(5).toString("hex")}`;
const seed = parseSeedItems(seedData);
const SEED_CODES = seed.map((s) => s.code).sort();

describe.skipIf(!HAS_DB)("cron reset บน Postgres จริง (schema ชั่วคราวแยกจากตารางจริง)", () => {
  let adminPool: Pool;
  let pool: Pool;
  let db: Db;
  let publicSnapshot: string;

  /** ลายนิ้วมือของตารางจริง (public) ไว้พิสูจน์ว่าเทสต์ไม่แตะ */
  async function snapshotPublic() {
    const r = await adminPool.query(
      `SELECT
         (SELECT count(*) FROM public.items)::text AS items,
         (SELECT count(*) FROM public.orders)::text AS orders,
         (SELECT count(*) FROM public.order_events)::text AS events,
         (SELECT coalesce(max(updated_at)::text, '') FROM public.items) AS items_updated,
         (SELECT coalesce(max(updated_at)::text, '') FROM public.orders) AS orders_updated,
         (SELECT string_agg(code || ':' || status || ':' || price, ',' ORDER BY code) FROM public.items) AS item_state`,
    );
    return JSON.stringify(r.rows[0]);
  }

  async function createSchema() {
    await adminPool.query(`CREATE SCHEMA "${SCHEMA}"`);
    const dir = resolve(process.cwd(), "db", "migrations");
    const journal = JSON.parse(readFileSync(resolve(dir, "meta", "_journal.json"), "utf8")) as {
      entries: { tag: string }[];
    };
    const files = journal.entries.map((e) => `${e.tag}.sql`);
    // กันกรณีมีไฟล์ migration ที่ไม่อยู่ใน journal
    expect(readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()).toEqual([...files].sort());
    for (const f of files) {
      const text = readFileSync(resolve(dir, f), "utf8").replaceAll('"public".', `"${SCHEMA}".`);
      for (const stmt of text.split("--> statement-breakpoint")) {
        if (stmt.trim()) await pool.query(stmt);
      }
    }
  }

  const count = async (table: string) =>
    Number((await pool.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n);

  /** วางข้อมูล "สกปรก" หลังใช้งานทั้งวัน: seed ถูกแก้ + สินค้าเพิ่มเอง + ออเดอร์หลายสถานะที่มี IP hash/sid + event */
  async function dirty() {
    await db.delete(orderEvents);
    await db.delete(orders);
    await db.delete(items);
    await db.insert(items).values(seed.map((s) => ({ ...s, status: "available" as const })));
    await db.execute(sql`UPDATE items SET price = 1, title = 'ถูกแก้โดยผู้ใช้', status = 'hidden' WHERE code = ${seed[0].code}`);
    await db.execute(sql`UPDATE items SET status = 'sold' WHERE code = ${seed[1].code}`);
    await db.execute(
      sql`UPDATE items SET status = 'reserved', reserved_until = now() + interval '10 minutes' WHERE code = ${seed[2].code}`,
    );
    await db.execute(sql`UPDATE items SET images = '[]'::jsonb WHERE code = ${seed[3].code}`);
    const [manual] = await db
      .insert(items)
      .values({
        code: "A990",
        title: "สินค้าที่เจ้าของเพิ่มเอง",
        description: "x",
        flaws: "ไม่มีตำหนิที่สังเกตเห็น",
        condition: "good",
        category: "other",
        price: 50,
        images: [{ url: "/api/item-images/up-1.jpg", alt: "x" }],
      })
      .returning({ id: items.id });
    const statuses = ["pending_payment", "awaiting_review", "confirmed", "shipped", "completed", "rejected", "expired", "cancelled"] as const;
    const itemRows = await db.select({ id: items.id }).from(items);
    let n = 0;
    for (const status of statuses) {
      const itemId = n === 0 ? manual.id : itemRows[n % itemRows.length].id;
      const [o] = await db
        .insert(orders)
        .values({
          token: `tok-${SCHEMA}-${n}`,
          itemId,
          amount: 100,
          customerName: "ชื่อลูกค้า",
          phone: "0812345678",
          deliveryMethod: "pickup",
          status,
          expiresAt: new Date(Date.now() + 600_000),
          slipPath: `slips/x/${n}.jpg`,
          clientIpHash: `hash-${n}`,
          demoSessionId: `sid-${n}`.padEnd(40, "x"),
        })
        .returning({ id: orders.id });
      await db.insert(orderEvents).values([
        { orderId: o.id, type: "created", actor: "customer" },
        { orderId: o.id, type: "slip_token_issued", actor: "customer" },
      ]);
      n++;
    }
  }

  async function assertSeedState(opts: { soldMin?: number; soldMax?: number } = {}) {
    expect(await count("orders")).toBe(0);
    expect(await count("order_events")).toBe(0);
    expect(Number((await pool.query(`SELECT count(*)::int AS n FROM orders WHERE client_ip_hash IS NOT NULL`)).rows[0].n)).toBe(0);
    const rows = await db.select().from(items);
    expect(rows.map((r) => r.code).sort()).toEqual(SEED_CODES);
    for (const r of rows) {
      const s = seed.find((x) => x.code === r.code)!;
      expect(r.title, r.code).toBe(s.title);
      expect(r.description).toBe(s.description);
      expect(r.flaws).toBe(s.flaws);
      expect(r.price).toBe(s.price);
      expect(r.condition).toBe(s.condition);
      expect(r.category).toBe(s.category);
      expect(r.sortOrder).toBe(s.sortOrder);
      expect(r.images).toEqual(s.images);
      expect(r.reservedUntil).toBeNull();
      expect(["available", "sold"]).toContain(r.status);
    }
    const sold = rows.filter((r) => r.status === "sold").length;
    expect(sold).toBeGreaterThanOrEqual(opts.soldMin ?? 2);
    expect(sold).toBeLessThanOrEqual(opts.soldMax ?? 3);
    return rows;
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: process.env.DATABASE_URL });
    // เก็บกวาด schema ชั่วคราวที่ค้างจากการรันที่ล้มกลางคัน (ชื่อ cron_it_* เท่านั้น)
    const stale = await adminPool.query(`SELECT nspname FROM pg_namespace WHERE nspname LIKE 'cron\\_it\\_%'`);
    for (const r of stale.rows as { nspname: string }[]) {
      await adminPool.query(`DROP SCHEMA "${r.nspname}" CASCADE`);
    }
    publicSnapshot = await snapshotPublic();

    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    // ทุก connection ของ pool นี้ใช้ search_path = schema ชั่วคราวเท่านั้น (ไม่มี public) → ตารางจริงมองไม่เห็นจึงแตะไม่ได้
    pool.on("connect", (client: PoolClient) => {
      void client.query(`SET search_path TO "${SCHEMA}"`);
    });
    db = drizzle(pool, { schema }) as unknown as Db;
    await createSchema();
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await adminPool.end();
    }
  });

  it("เตรียมสภาพแวดล้อมถูกต้อง: ตารางอยู่ใน schema ชั่วคราว ไม่ใช่ public", async () => {
    const r = await pool.query(`SELECT current_schema() AS s`);
    expect(r.rows[0].s).toBe(SCHEMA);
    const t = await adminPool.query(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1 AND table_name IN ('items','orders','order_events')`,
      [SCHEMA],
    );
    expect(t.rows[0].n).toBe(3);
    expect(seed).toHaveLength(12);
  });

  it("รีเซ็ต: ล้างออเดอร์/event/IP hash, คืนสินค้าเป็น seed ทั้งหมด (ลบสินค้าที่เพิ่มเอง), สุ่ม sold 2–3 ชิ้น", async () => {
    await dirty();
    expect(await count("orders")).toBe(8);
    expect(await count("order_events")).toBe(16);
    expect(await count("items")).toBe(13);

    const res = await resetDemoData(db, { seedItems: seed, random: () => 0 });
    expect(res.status).toBe("ran");
    if (res.status !== "ran") return;
    expect(res).toMatchObject({ ordersDeleted: 8, eventsDeleted: 16, itemsUpserted: 12, itemsRemoved: 1 });
    expect(res.soldCodes).toHaveLength(2);
    expect(res.dbNow).toBeInstanceOf(Date);

    const rows = await assertSeedState({ soldMin: 2, soldMax: 2 });
    expect(rows.filter((r) => r.status === "sold").map((r) => r.code).sort()).toEqual([...res.soldCodes].sort());
    expect(rows.find((r) => r.code === "A990")).toBeUndefined(); // สินค้าที่เพิ่มเองถูกลบ (นโยบาย: รีเซ็ตทั้งร้าน)
    expect(rows.find((r) => r.code === seed[0].code)?.price).toBe(seed[0].price); // แก้ราคา/ชื่อ/hidden ถูกคืน
    expect(rows.find((r) => r.code === seed[3].code)?.images).toEqual(seed[3].images); // รูปที่ถูกลบถูกคืน
  });

  it("สุ่มได้ 3 ชิ้นเมื่อ random สูง และผลลัพธ์ยังเป็นสถานะ seed", async () => {
    await dirty();
    const res = await resetDemoData(db, { seedItems: seed, random: () => 0.999 });
    expect(res.status === "ran" && res.soldCodes).toHaveLength(3);
    await assertSeedState({ soldMin: 3, soldMax: 3 });
  });

  it("id ของสินค้า seed คงเดิมหลังรีเซ็ต (upsert ไม่ลบแล้วสร้างใหม่)", async () => {
    await resetDemoData(db, { seedItems: seed });
    const before = new Map((await db.select({ id: items.id, code: items.code }).from(items)).map((r) => [r.code, r.id]));
    await resetDemoData(db, { seedItems: seed });
    const after = new Map((await db.select({ id: items.id, code: items.code }).from(items)).map((r) => [r.code, r.id]));
    expect(after).toEqual(before);
  });

  it("รันซ้ำหลายครั้งติดกัน (idempotent): ได้สถานะ seed เสมอ ไม่มีแถวซ้ำ/ไม่ error", async () => {
    await dirty();
    for (let i = 0; i < 4; i++) {
      const res = await resetDemoData(db, { seedItems: seed });
      expect(res.status).toBe("ran");
      await assertSeedState();
    }
    expect(await count("items")).toBe(12);
  });

  it("รันพร้อมกัน 6 รอบ: ไม่มี error/deadlock, มีอย่างน้อย 1 รอบที่ทำงาน, รอบที่เหลือ ran หรือ skipped_locked, ผลสุดท้ายเป็น seed", async () => {
    await dirty();
    const results = await Promise.all(Array.from({ length: 6 }, () => resetDemoData(db, { seedItems: seed })));
    const ran = results.filter((r) => r.status === "ran").length;
    const skipped = results.filter((r) => r.status === "skipped_locked").length;
    expect(ran).toBeGreaterThanOrEqual(1);
    expect(ran + skipped).toBe(6);
    await assertSeedState();
  });

  it("มีรอบอื่นถือ advisory lock อยู่ → ข้าม (skipped_locked) และ 'ไม่แตะข้อมูล'; ปล่อยล็อกแล้วรันได้", async () => {
    await dirty();
    const holder = await adminPool.connect();
    try {
      await holder.query(`SELECT pg_advisory_lock($1::bigint)`, [RESET_LOCK_KEY]);
      const res = await resetDemoData(db, { seedItems: seed });
      expect(res).toEqual({ status: "skipped_locked" });
      expect(await count("orders")).toBe(8);
      expect(await count("items")).toBe(13);
      await holder.query(`SELECT pg_advisory_unlock($1::bigint)`, [RESET_LOCK_KEY]);
    } finally {
      holder.release();
    }
    const after = await resetDemoData(db, { seedItems: seed });
    expect(after.status).toBe("ran");
    await assertSeedState();
  });

  it("ล้มกลางคัน (เช่น ข้อมูล seed ผิด) → rollback ทั้งหมด: ออเดอร์/สินค้าที่เพิ่มเองยังอยู่ครบ และ lock ถูกปล่อย", async () => {
    await dirty();
    const bad = [...seed.slice(0, 11), { ...seed[11], flaws: "" }]; // ผิด CHECK items_flaws_not_empty
    await expect(resetDemoData(db, { seedItems: bad })).rejects.toThrow();
    expect(await count("orders")).toBe(8);
    expect(await count("order_events")).toBe(16);
    expect(await count("items")).toBe(13); // A990 ยังอยู่
    const ok = await resetDemoData(db, { seedItems: seed }); // lock ไม่ค้าง
    expect(ok.status).toBe("ran");
    await assertSeedState();
  });

  it("seed ว่าง → ปฏิเสธก่อนลบอะไร", async () => {
    await dirty();
    await expect(resetDemoData(db, { seedItems: [] })).rejects.toThrow(/empty/);
    expect(await count("orders")).toBe(8);
    expect(await count("items")).toBe(13);
  });

  /** รอจนมี session อื่นรอล็อกอยู่ (ล็อกตาราง/ล็อกแถวใน schema ชั่วคราว) — เพดาน 5 วินาที แล้วไปต่อ (ให้เทสต์ล้มด้วย assert แทนแขวน) */
  async function waitUntilSomeoneBlocked(): Promise<boolean> {
    for (let i = 0; i < 50; i++) {
      const r = await adminPool.query(
        `SELECT count(*)::int AS n
           FROM pg_locks l
           LEFT JOIN pg_class c ON c.oid = l.relation
           LEFT JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE NOT l.granted AND l.pid <> pg_backend_pid()
            AND (n.nspname = $1 OR l.locktype = 'transactionid')`,
        [SCHEMA],
      );
      if (r.rows[0].n > 0) return true;
      await new Promise((res) => setTimeout(res, 100));
    }
    return false;
  }

  /**
   * จำลอง reserve ที่ "insert ออเดอร์แล้วแต่ยังไม่ commit" โดยใช้ reserveItem + store จริง
   * (หน่วง commit ด้วย gate) แล้วรัน reset ระหว่างนั้น → ปล่อย gate ให้ reserve commit
   */
  async function resetWhileReserveInFlight(code: string) {
    const base = createDrizzleReserveStore(db);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reached!: () => void;
    const reachedP = new Promise<void>((r) => (reached = r));
    const holdingStore: ReserveStore = {
      transaction: (fn) =>
        base.transaction(async (tx) => {
          const out = await fn(tx);
          reached(); // ออเดอร์ + event ถูก insert แล้ว แต่ tx ยังไม่ commit
          await gate;
          return out;
        }),
    };
    const reserveP = reserveItem(holdingStore, { code, customerName: "คนกำลังจอง", phone: "0812345678", deliveryMethod: "pickup" });
    await reachedP;
    const resetP = resetDemoData(db, { seedItems: seed, random: () => 0 });
    const blocked = await waitUntilSomeoneBlocked();
    release();
    const [reserved, reset] = await Promise.all([reserveP, resetP]);
    return { reserved, reset, blocked };
  }

  it.each([
    ["สินค้าอยู่ใน seed", "seed"],
    ["สินค้านอก seed (ที่เจ้าของเพิ่มเอง)", "manual"],
  ])(
    "reserve ที่ยังไม่ commit ระหว่างรีเซ็ต (%s): reset ต้องรอ reserve แล้วลบออเดอร์นั้นด้วย — ไม่เหลือออเดอร์/ไม่มีสินค้าถูกถือ",
    async (_label, kind) => {
      await dirty();
      let code: string;
      if (kind === "seed") {
        code = seed[5].code; // available หลัง dirty()
      } else {
        code = "A991";
        await db.insert(items).values({
          code,
          title: "สินค้าเพิ่มเองที่กำลังถูกจอง",
          description: "x",
          flaws: "ไม่มีตำหนิที่สังเกตเห็น",
          condition: "good",
          category: "other",
          price: 50,
          images: [{ url: "/api/item-images/up-2.jpg", alt: "x" }],
        });
      }

      const { reserved, reset, blocked } = await resetWhileReserveInFlight(code);
      expect(blocked).toBe(true); // reset ต้องไปรอ reserve จริง (ไม่ใช่ไหลผ่านไปโดยไม่รอ)
      expect(reserved.ok).toBe(true);
      expect(reset.status).toBe("ran");
      // ผลต้องเป็นสถานะ seed ล้วน: ไม่มีออเดอร์/event เหลือ จึงไม่มีสินค้าไหนถูกออเดอร์ถือ (ไม่มีสินค้าว่างที่มีออเดอร์ซ้อน)
      await assertSeedState();
      expect((await db.select().from(items)).find((r) => r.code === "A991")).toBeUndefined();
      expect(await count("orders")).toBe(0);
    },
  );

  it("reserve ค้างนานเกิน lock_timeout → reset ล้ม (ไม่แขวน) ข้อมูลเดิมไม่ถูกแตะ; พอ reserve จบรอบใหม่รันได้", async () => {
    await dirty();
    const base = createDrizzleReserveStore(db);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reached!: () => void;
    const reachedP = new Promise<void>((r) => (reached = r));
    const holdingStore: ReserveStore = {
      transaction: (fn) =>
        base.transaction(async (tx) => {
          const out = await fn(tx);
          reached();
          await gate;
          return out;
        }),
    };
    const reserveP = reserveItem(holdingStore, { code: seed[5].code, customerName: "คนกำลังจอง", phone: "0812345678", deliveryMethod: "pickup" });
    await reachedP;
    const started = Date.now();
    await expect(resetDemoData(db, { seedItems: seed, lockTimeoutMs: 600 })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(10_000);
    release();
    expect((await reserveP).ok).toBe(true);
    // reset ที่ล้ม rollback หมด: ออเดอร์เดิม 8 + ออเดอร์ที่เพิ่งจอง 1, สินค้าที่เพิ่มเอง A990 ยังอยู่
    expect(await count("orders")).toBe(9);
    expect(await count("items")).toBe(13);
    const ok = await resetDemoData(db, { seedItems: seed });
    expect(ok.status).toBe("ran");
    await assertSeedState();
  });

  it("ตารางจริง (public.items / orders / order_events) ไม่ถูกแตะเลย", async () => {
    expect(await snapshotPublic()).toBe(publicSnapshot);
  });
});
