import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  DEMO_ORDER_RETURN_MINUTES,
  demoEndedSql,
  demoReturnAtSql,
  holdingOrderExistsSql,
  ipHoldingOrderCondition,
  resolveDisplayStatus,
} from "@/lib/availability";
import { describeOrder } from "@/lib/orders/view";

const dialect = new PgDialect();
const render = (q: ReturnType<typeof sql>) => dialect.sqlToQuery(q);

describe("ออเดอร์เดโมคืนสินค้าเอง: นิยามกลางใน lib/availability.ts", () => {
  it("ค่าเริ่มต้น 20 นาที เป็นค่าคงที่จำนวนเต็มบวก", () => {
    expect(DEMO_ORDER_RETURN_MINUTES).toBe(20);
  });

  it("demoEndedSql: ตัดสินที่ DB ด้วย now() และ confirmed_at + N นาที เฉพาะ role demo (strict <, COALESCE กัน NULL), ไม่มี parameter", () => {
    const q = render(demoEndedSql("o"));
    expect(q.sql).toContain("o.confirmed_by_role = 'demo'");
    expect(q.sql).toContain("o.confirmed_at + make_interval(mins => 20) < now()");
    expect(q.sql).toMatch(/^COALESCE\(/);
    expect(q.params).toEqual([]);
    // ไม่ใช้เวลาจากแอปเด็ดขาด
    expect(q.sql).not.toMatch(/\$\d/);
  });

  it("demoReturnAtSql: เวลาคืน = confirmed_at + N เฉพาะ demo (owner/NULL = NULL)", () => {
    const q = render(demoReturnAtSql("orders"));
    expect(q.sql).toContain("orders.confirmed_by_role = 'demo'");
    expect(q.sql).toContain("orders.confirmed_at + make_interval(mins => 20)");
  });

  it("holdingOrderExistsSql: ออเดอร์ที่ยืนยันแล้วถือสินค้า 'เว้นแต่' เป็นเดโมที่สิ้นสุด; awaiting_review/pending คงเดิม", () => {
    const q = render(holdingOrderExistsSql(sql`items.id`));
    expect(q.sql).toContain("o.status = 'awaiting_review'");
    expect(q.sql).toContain("o.status = 'pending_payment' AND o.expires_at >= now()");
    expect(q.sql).toContain("o.status IN ('confirmed', 'shipped', 'completed') AND NOT COALESCE(");
    expect(q.sql).toContain("o.confirmed_by_role = 'demo'");
    // ไม่มีเงื่อนไข hard-code ที่ถือ confirmed แบบไม่มีข้อยกเว้น
    expect(q.sql).not.toMatch(/o\.status IN \('awaiting_review', 'confirmed'/);
  });

  it("ipHoldingOrderCondition: นับ awaiting_review + pending ที่ยังไม่หมดเวลา + เดโมที่ยืนยันและยังไม่สิ้นสุด; ไม่นับออเดอร์ที่ owner ยืนยัน", () => {
    const q = render(ipHoldingOrderCondition("o"));
    expect(q.sql).toContain("o.status = 'awaiting_review'");
    expect(q.sql).toContain("o.status IN ('confirmed', 'shipped', 'completed')");
    expect(q.sql).toContain("o.confirmed_by_role = 'demo'");
    expect(q.sql).toContain("NOT COALESCE(");
  });

  it("แถวสินค้าของออเดอร์เดโมที่สิ้นสุด (reserved, lapsed, ไม่มีผู้ถือ) แสดงเป็น available; ยังอยู่ในช่วงถือ = reserved", () => {
    expect(resolveDisplayStatus({ status: "reserved", lapsed: true, held: false })).toBe("available");
    expect(resolveDisplayStatus({ status: "reserved", lapsed: false, held: true })).toBe("reserved");
    // owner ยืนยัน = sold ถาวร ไม่ขึ้นกับเวลา
    expect(resolveDisplayStatus({ status: "sold", lapsed: true, held: true })).toBe("sold");
  });

  it("ไม่มีนิยาม confirmed_by_role (snake_case ใน SQL) ซ้ำนอก lib/availability.ts (กันนิยามแยกหลายที่)", () => {
    const root = process.cwd();
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === ".next" || name === "migrations" || name.startsWith(".")) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && readFileSync(p, "utf8").includes("confirmed_by_role")) {
          hits.push(relative(root, p).replaceAll("\\", "/"));
        }
      }
    };
    for (const d of ["lib", "app", "components", "db"]) walk(join(root, d));
    // schema.ts ประกาศชื่อคอลัมน์; availability.ts คือนิยามเดียวของเงื่อนไข
    expect(hits.sort()).toEqual(["db/schema.ts", "lib/availability.ts"]);
  });
});

describe("describeOrder: ออเดอร์เดโม", () => {
  const base = {
    deliveryMethod: "pickup" as const,
    expiresAtMs: 1000,
    nowMs: 500,
  };

  it("เดโมสิ้นสุดแล้ว: สถานะ demo_ended, ข้อความเข้าใจได้ว่าไม่ใช่การขายจริงและคืนของแล้ว, หยุด poll, มีลิงก์กลับร้าน", () => {
    for (const status of ["confirmed", "shipped", "completed"] as const) {
      const v = describeOrder({ ...base, status, demoEnded: true, demoConfirmed: true });
      expect(v.effectiveStatus).toBe("demo_ended");
      expect(v.headline).toBe("เดโมสิ้นสุดแล้ว");
      expect(v.body).toContain("ไม่ใช่การขายจริง");
      expect(v.body).toContain("คืนสินค้าเข้าร้าน");
      expect(v.keepPolling).toBe(false);
      expect(v.showBackToShop).toBe(true);
      expect(v.demoNote).toBeNull();
    }
  });

  it("ยังอยู่ในช่วงถือสินค้า: สถานะเดิม + หมายเหตุว่าจะคืนอัตโนมัติ (บอก 20 นาที) และยัง poll", () => {
    const v = describeOrder({ ...base, status: "confirmed", demoEnded: false, demoConfirmed: true });
    expect(v.effectiveStatus).toBe("confirmed");
    expect(v.demoNote).toContain("20 นาที");
    expect(v.demoNote).toContain("ไม่ใช่การขายจริง");
    expect(v.keepPolling).toBe(true);
  });

  it("ออเดอร์ที่ owner ยืนยัน: ไม่มีหมายเหตุเดโม และไม่ถูกเปลี่ยนเป็น demo_ended", () => {
    const v = describeOrder({ ...base, status: "confirmed", demoEnded: false, demoConfirmed: false });
    expect(v.demoNote).toBeNull();
    expect(v.effectiveStatus).toBe("confirmed");
  });

  it("demoEnded ไม่กระทบสถานะที่ไม่ใช่ confirmed/shipped/completed", () => {
    for (const status of ["awaiting_review", "rejected", "cancelled", "expired"] as const) {
      const v = describeOrder({ ...base, status, demoEnded: true });
      expect(v.effectiveStatus).toBe(status);
    }
  });

  it("cancelled ที่มีเหตุผล = ร้านคืนสินค้า (แสดงเหตุผล); ไม่มีเหตุผล = ลูกค้ายกเลิกเอง", () => {
    const byShop = describeOrder({ ...base, status: "cancelled", rejectReason: "ลูกค้าขอคืน" });
    expect(byShop.headline).toContain("ร้านยกเลิกออเดอร์");
    expect(byShop.body).toBe("เหตุผล: ลูกค้าขอคืน");
    const byCustomer = describeOrder({ ...base, status: "cancelled" });
    expect(byCustomer.headline).toBe("ยกเลิกออเดอร์แล้ว");
  });
});
