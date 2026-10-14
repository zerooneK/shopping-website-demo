import "server-only";
import { asc, desc, eq, sql } from "drizzle-orm";
import { getDb } from "../../db/client";
import { items, orderEvents, orders } from "../../db/schema";
import type { OrderStatus } from "../../db/schema";
import type { AdminSession } from "../auth";
import { demoEndedSql, demoReturnAtSql, holdingOrderExistsSql } from "../availability";
import {
  ADMIN_TABS,
  buildAdminTimeline,
  STATUS_PRIORITY,
  toAdminOrderView,
  type AdminOrderRow,
  type AdminOrderStatus,
  type AdminOrderView,
  type AdminTabKey,
  type AdminTimelineEntry,
} from "./view";

/**
 * Data layer ของหลังบ้าน — ทุกฟังก์ชันรับ `session` (ได้มาจาก requireSession()) แล้วคืน DTO ที่ผ่าน
 * toAdminOrderView() เท่านั้น: slipPath / demoSessionId / token / clientIpHash ไม่ออกจากชั้นนี้
 * เวลาทั้งหมดตัดสินด้วย now() ของ DB
 */

const LIST_LIMIT = 100;

/**
 * สถานะที่มีผลจริงใน SQL (ตรงกับ effectiveOrderStatus): pending_payment ที่ expires_at < now() = expired,
 * confirmed/shipped/completed ที่เดโมสิ้นสุดแล้ว (demoEndedSql — นิยามเดียวใน lib/availability.ts) = demo_ended
 * ต้องเป็นนิพจน์ที่ไม่มี parameter เพื่อใช้ใน GROUP BY ได้ (demoEndedSql ฝังค่าคงที่เป็น literal)
 */
const effectiveStatusSql = sql<AdminOrderStatus>`(CASE
  WHEN ${orders.status} = 'pending_payment' AND ${orders.expiresAt} < now() THEN 'expired'
  WHEN ${orders.status} IN ('confirmed', 'shipped', 'completed') AND ${demoEndedSql("orders")} THEN 'demo_ended'
  ELSE ${orders.status}::text END)`;

/** ลำดับความสำคัญจาก STATUS_PRIORITY (แหล่งเดียวกับ UI/เทสต์) */
const prioritySql = sql`(CASE ${effectiveStatusSql} ${sql.join(
  (Object.keys(STATUS_PRIORITY) as AdminOrderStatus[]).map(
    (s) => sql.raw(`WHEN '${s}' THEN ${STATUS_PRIORITY[s]}`),
  ),
  sql` `,
)} ELSE 9 END)`;

const rowColumns = {
  id: orders.id,
  status: orders.status,
  expiredByClock: sql<boolean>`${orders.expiresAt} < now()`,
  confirmedByRole: orders.confirmedByRole,
  demoEnded: sql<boolean>`${demoEndedSql("orders")}`,
  demoReturnAt: sql<Date | string | null>`${demoReturnAtSql("orders")}`,
  amount: orders.amount,
  shippingFee: orders.shippingFee,
  deliveryMethod: orders.deliveryMethod,
  customerName: orders.customerName,
  phone: orders.phone,
  address: orders.address,
  note: orders.note,
  trackingNo: orders.trackingNo,
  rejectReason: orders.rejectReason,
  createdAt: orders.createdAt,
  slipUploadedAt: orders.slipUploadedAt,
  slipPath: orders.slipPath,
  demoSessionId: orders.demoSessionId,
  itemCode: items.code,
  itemTitle: items.title,
  itemStatus: items.status,
  itemLapsed: sql<boolean>`coalesce(${items.reservedUntil} < now(), false)`,
  itemHeld: sql<boolean>`${holdingOrderExistsSql(sql`${items.id}`)}`,
};

function toRow(x: {
    id: string;
    status: OrderStatus;
    expiredByClock: boolean;
    confirmedByRole: AdminOrderRow["confirmedByRole"];
    demoEnded: boolean;
    demoReturnAt: Date | string | null;
    amount: number;
    shippingFee: number;
    deliveryMethod: AdminOrderRow["deliveryMethod"];
    customerName: string;
    phone: string;
    address: string | null;
    note: string | null;
    trackingNo: string | null;
    rejectReason: string | null;
    createdAt: Date;
    slipUploadedAt: Date | null;
    slipPath: string | null;
    demoSessionId: string | null;
    itemCode: string;
    itemTitle: string;
    itemStatus: AdminOrderRow["item"]["status"];
    itemLapsed: boolean;
    itemHeld: boolean;
  }): AdminOrderRow {
  return {
    id: x.id,
    status: x.status,
    expiredByClock: x.expiredByClock,
    confirmedByRole: x.confirmedByRole,
    demoEnded: x.demoEnded,
    demoReturnAt: x.demoReturnAt ? new Date(x.demoReturnAt) : null,
    amount: x.amount,
    shippingFee: x.shippingFee,
    deliveryMethod: x.deliveryMethod,
    customerName: x.customerName,
    phone: x.phone,
    address: x.address,
    note: x.note,
    trackingNo: x.trackingNo,
    rejectReason: x.rejectReason,
    createdAt: x.createdAt,
    slipUploadedAt: x.slipUploadedAt,
    slipPath: x.slipPath,
    demoSessionId: x.demoSessionId,
    item: {
      code: x.itemCode,
      title: x.itemTitle,
      status: x.itemStatus,
      lapsed: x.itemLapsed,
      held: x.itemHeld,
    },
  };
}
export type AdminDashboard = {
  tab: AdminTabKey;
  counts: Record<AdminTabKey, number>;
  orders: AdminOrderView[];
  /** true = มีออเดอร์มากกว่าที่แสดง (แสดงสูงสุด LIST_LIMIT) */
  truncated: boolean;
};

export async function getAdminDashboard(
  session: AdminSession,
  tab: AdminTabKey,
): Promise<AdminDashboard> {
  const db = getDb();
  const def = ADMIN_TABS.find((t) => t.key === tab) ?? ADMIN_TABS[0];

  const grouped = await db
    .select({ status: effectiveStatusSql, n: sql<number>`count(*)::int` })
    .from(orders)
    .groupBy(effectiveStatusSql);
  const byStatus = new Map<AdminOrderStatus, number>(grouped.map((g) => [g.status, g.n]));
  const counts = Object.fromEntries(
    ADMIN_TABS.map((t) => [
      t.key,
      t.statuses
        ? t.statuses.reduce((sum, s) => sum + (byStatus.get(s) ?? 0), 0)
        : [...byStatus.values()].reduce((a, b) => a + b, 0),
    ]),
  ) as Record<AdminTabKey, number>;

  const where = def.statuses
    ? sql`${effectiveStatusSql} IN (${sql.join(
        def.statuses.map((s) => sql`${s}`),
        sql`, `,
      )})`
    : undefined;

  const rows = await db
    .select(rowColumns)
    .from(orders)
    .innerJoin(items, eq(items.id, orders.itemId))
    .where(where)
    .orderBy(
      asc(prioritySql),
      // สลิปที่รอตรวจ: ส่งมาก่อนขึ้นก่อน (FIFO); สถานะอื่นเรียงใหม่ → เก่า
      asc(sql`(CASE WHEN ${orders.status} = 'awaiting_review' THEN ${orders.slipUploadedAt} END)`),
      desc(orders.createdAt),
    )
    .limit(LIST_LIMIT + 1);

  const truncated = rows.length > LIST_LIMIT;
  return {
    tab: def.key,
    counts,
    orders: rows.slice(0, LIST_LIMIT).map((r) => toAdminOrderView(toRow(r), session)),
    truncated,
  };
}

export type AdminOrderDetail = {
  order: AdminOrderView;
  timeline: AdminTimelineEntry[];
};

/** รายละเอียดออเดอร์ตาม id (uuid ที่ตรวจรูปแบบแล้ว) — ไม่พบ = null */
export async function getAdminOrderDetail(
  session: AdminSession,
  orderId: string,
): Promise<AdminOrderDetail | null> {
  const db = getDb();
  const [row] = await db
    .select(rowColumns)
    .from(orders)
    .innerJoin(items, eq(items.id, orders.itemId))
    .where(eq(orders.id, orderId));
  if (!row) return null;

  const events = await db
    .select({
      type: orderEvents.type,
      actor: orderEvents.actor,
      meta: orderEvents.meta,
      createdAt: orderEvents.createdAt,
    })
    .from(orderEvents)
    .where(eq(orderEvents.orderId, orderId))
    .orderBy(asc(orderEvents.createdAt), asc(orderEvents.id));

  return {
    order: toAdminOrderView(toRow(row), session),
    timeline: buildAdminTimeline(
      events.map((e) => ({
        type: e.type,
        actor: e.actor,
        meta: e.meta,
        createdAtMs: e.createdAt.getTime(),
      })),
    ),
  };
}

/** ข้อมูลที่ proxy สลิปต้องใช้ (ฝั่ง server เท่านั้น — ไม่ส่งออกไป client) */
export async function getSlipRecord(
  orderId: string,
): Promise<{ slipPath: string | null; demoSessionId: string | null } | null> {
  const [row] = await getDb()
    .select({ slipPath: orders.slipPath, demoSessionId: orders.demoSessionId })
    .from(orders)
    .where(eq(orders.id, orderId));
  return row ?? null;
}
