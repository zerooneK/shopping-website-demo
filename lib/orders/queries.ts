import "server-only";
import { asc, eq, sql } from "drizzle-orm";
import { getDb } from "../../db/client";
import type { DeliveryMethod, OrderStatus } from "../../db/schema";
import { items, orderEvents, orders } from "../../db/schema";
import { demoEndedSql, demoReturnAtSql } from "../availability";
import { expireOrderIfStale } from "./commands";
import { isValidOrderToken } from "./view";

/**
 * อ่านออเดอร์สำหรับหน้าลูกค้า — ค้นด้วย token เท่านั้น (ไม่รับ id)
 * ทุก query ผ่าน expireOrderIfStale ก่อน เพื่อให้สถานะ "หมดเวลา" ถูกบันทึกจริง (SPEC §5 ข้อ 2)
 * และคืน dbNow (now() ของ DB) เพื่อให้ client คำนวณนับถอยหลังโดยไม่พึ่งนาฬิกาเครื่องตัวเอง
 *
 * สิ่งที่ "ไม่" ส่งออกไป: slipPath, demoSessionId, phone, customerName
 */

export type CustomerOrder = {
  id: string;
  status: OrderStatus;
  amount: number;
  shippingFee: number;
  deliveryMethod: DeliveryMethod;
  address: string | null;
  trackingNo: string | null;
  rejectReason: string | null;
  expiresAt: Date;
  dbNow: Date;
  /** ออเดอร์ที่ role demo ยืนยัน: เวลาที่คืนสินค้าเข้าร้าน (ตาม DB) — null ถ้าไม่ใช่ */
  demoReturnAt: Date | null;
  /** ออเดอร์เดโมที่เลยเวลาแล้ว (คืนสินค้าเข้าร้านเองแล้ว) */
  demoEnded: boolean;
  item: {
    code: string;
    title: string;
    image: { url: string; alt: string } | null;
  };
  events: { type: string; meta: Record<string, unknown> | null; createdAt: Date }[];
};

export async function getCustomerOrder(token: string): Promise<CustomerOrder | null> {
  if (!isValidOrderToken(token)) return null;
  const db = getDb();
  await expireOrderIfStale(db, token);

  const [row] = await db
    .select({
      id: orders.id,
      status: orders.status,
      amount: orders.amount,
      shippingFee: orders.shippingFee,
      deliveryMethod: orders.deliveryMethod,
      address: orders.address,
      trackingNo: orders.trackingNo,
      rejectReason: orders.rejectReason,
      expiresAt: orders.expiresAt,
      dbNow: sql<Date | string>`now()`,
      demoReturnAt: sql<Date | string | null>`${demoReturnAtSql("orders")}`,
      demoEnded: sql<boolean>`${demoEndedSql("orders")}`,
      itemCode: items.code,
      itemTitle: items.title,
      itemImages: items.images,
    })
    .from(orders)
    .innerJoin(items, eq(items.id, orders.itemId))
    .where(eq(orders.token, token));
  if (!row) return null;

  const events = await db
    .select({ type: orderEvents.type, meta: orderEvents.meta, createdAt: orderEvents.createdAt })
    .from(orderEvents)
    .where(eq(orderEvents.orderId, row.id))
    .orderBy(asc(orderEvents.createdAt), asc(orderEvents.id));

  const first = row.itemImages[0];
  return {
    id: row.id,
    status: row.status,
    amount: row.amount,
    shippingFee: row.shippingFee,
    deliveryMethod: row.deliveryMethod,
    address: row.address,
    trackingNo: row.trackingNo,
    rejectReason: row.rejectReason,
    expiresAt: row.expiresAt,
    dbNow: new Date(row.dbNow),
    demoReturnAt: row.demoReturnAt ? new Date(row.demoReturnAt) : null,
    demoEnded: row.demoEnded,
    item: {
      code: row.itemCode,
      title: row.itemTitle,
      image: first ? { url: first.url, alt: first.alt } : null,
    },
    events,
  };
}

export type OrderStatusSnapshot = {
  /** สถานะที่มีผลจริงสำหรับ poll: ออเดอร์เดโมที่เลยเวลา = "demo_ended" (ค่าที่เก็บใน DB ยังเป็น confirmed/...) */
  status: OrderStatus | "demo_ended";
  expiresAt: Date;
  dbNow: Date;
};

/** ข้อมูลน้อยที่สุดที่ใช้ poll: สถานะ + เวลาหมดอายุ + เวลาของ DB (ไม่มี PII/สลิป/ราคา) */
export async function getOrderStatusSnapshot(token: string): Promise<OrderStatusSnapshot | null> {
  if (!isValidOrderToken(token)) return null;
  const db = getDb();
  await expireOrderIfStale(db, token);
  const [row] = await db
    .select({
      status: orders.status,
      expiresAt: orders.expiresAt,
      dbNow: sql<Date | string>`now()`,
      demoEnded: sql<boolean>`${demoEndedSql("orders")}`,
    })
    .from(orders)
    .where(eq(orders.token, token));
  if (!row) return null;
  const ended = row.demoEnded && (row.status === "confirmed" || row.status === "shipped" || row.status === "completed");
  return {
    status: ended ? "demo_ended" : row.status,
    expiresAt: row.expiresAt,
    dbNow: new Date(row.dbNow),
  };
}

/** ข้อมูลที่ API ต้องใช้ตอนตรวจ token ก่อนออก Blob token / รับ pathname สลิป (ไม่ส่งออกไปที่ client) */
export type OrderForSlip = {
  id: string;
  status: OrderStatus;
  /** expires_at >= now() ตามเวลาของ DB */
  inWindow: boolean;
};

export async function getOrderForSlip(token: string): Promise<OrderForSlip | null> {
  if (!isValidOrderToken(token)) return null;
  const [row] = await getDb()
    .select({
      id: orders.id,
      status: orders.status,
      inWindow: sql<boolean>`${orders.expiresAt} >= now()`,
    })
    .from(orders)
    .where(eq(orders.token, token));
  return row ?? null;
}
