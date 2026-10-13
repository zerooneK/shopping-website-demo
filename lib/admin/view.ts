import type { DeliveryMethod, OrderStatus } from "@/db/schema";
import { canViewSlip, can, type AdminSession } from "@/lib/auth";
import {
  resolveDisplayStatus,
  type DisplayStatus,
  type StoredItemStatus,
} from "@/lib/availability";
import { isInternalEventType } from "@/lib/orders/view";
import { transition } from "@/lib/orders/transition";
import { z } from "zod";
import { maskAddress, maskName, maskNote, maskPhone } from "./mask";

/**
 * ชั้น view ของหลังบ้าน (pure — ไม่แตะ DB/เวลาของแอป)
 *  - แปลงแถว DB ดิบ → DTO ที่ส่งให้ UI ได้ (ไม่มี slipPath/demoSessionId/token/clientIpHash เด็ดขาด)
 *  - role demo: mask ชื่อ/เบอร์/ที่อยู่/หมายเหตุที่นี่ (ฝั่ง server) ก่อนสร้าง DTO
 *  - สถานะที่แสดง = สถานะ "ที่มีผลจริง" (pending_payment ที่เลยเวลา = expired) ไม่ใช่ค่าดิบ
 */

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  pending_payment: "รอชำระเงิน",
  awaiting_review: "รอตรวจสลิป",
  confirmed: "ยืนยันแล้ว",
  shipped: "จัดส่งแล้ว",
  completed: "เสร็จสิ้น",
  rejected: "ปฏิเสธแล้ว",
  expired: "หมดเวลา",
  cancelled: "ยกเลิก",
};

/** ลำดับความสำคัญใน dashboard: เลขน้อย = ต้องจัดการก่อน (awaiting_review ขึ้นบนสุด) */
export const STATUS_PRIORITY: Record<OrderStatus, number> = {
  awaiting_review: 0,
  confirmed: 1,
  shipped: 2,
  pending_payment: 3,
  completed: 4,
  rejected: 5,
  expired: 5,
  cancelled: 5,
};

/** สถานะที่มีผลจริง: pending_payment ที่ expires_at < now() (ตามเวลา DB) ถือเป็น expired */
export function effectiveOrderStatus(status: OrderStatus, expiredByClock: boolean): OrderStatus {
  return status === "pending_payment" && expiredByClock ? "expired" : status;
}

// ---------------------------------------------------------------- แท็บ

export type AdminTabKey = "all" | "review" | "confirmed" | "shipped" | "pending" | "completed" | "closed";

export const ADMIN_TABS: readonly {
  key: AdminTabKey;
  label: string;
  /** null = ทุกสถานะ */
  statuses: readonly OrderStatus[] | null;
}[] = [
  { key: "all", label: "ทั้งหมด", statuses: null },
  { key: "review", label: "รอตรวจสลิป", statuses: ["awaiting_review"] },
  { key: "confirmed", label: "ยืนยันแล้ว", statuses: ["confirmed"] },
  { key: "shipped", label: "จัดส่งแล้ว", statuses: ["shipped"] },
  { key: "pending", label: "รอชำระ", statuses: ["pending_payment"] },
  { key: "completed", label: "เสร็จสิ้น", statuses: ["completed"] },
  { key: "closed", label: "ปิดแล้ว", statuses: ["rejected", "expired", "cancelled"] },
];

export function parseTab(raw: string | string[] | undefined): AdminTabKey {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return ADMIN_TABS.find((t) => t.key === v)?.key ?? "all";
}

// ---------------------------------------------------------------- action ที่ทำได้

export type AdminAction = "confirm" | "reject" | "ship" | "complete";
const ACTION_ORDER: readonly AdminAction[] = ["confirm", "reject", "ship", "complete"];

/** ใช้ transition() เป็นแหล่งความจริงเดียว: action ไหนผ่านได้ในสถานะ/วิธีรับของนี้ (ไม่เช็กเวลา: action ฝั่งแอดมินไม่ผูกกับ expiresAt) */
export function availableActions(status: OrderStatus, deliveryMethod: DeliveryMethod): AdminAction[] {
  return ACTION_ORDER.filter(
    (type) =>
      transition(
        { status, deliveryMethod, expiresAt: new Date(0) },
        { type, now: new Date(0), reason: "x", trackingNo: "x" },
        "admin",
      ).ok,
  );
}

// ---------------------------------------------------------------- DTO

/** แถวดิบจาก DB (อยู่ฝั่ง server เท่านั้น) */
export type AdminOrderRow = {
  id: string;
  status: OrderStatus;
  /** expires_at < now() ตามเวลา DB */
  expiredByClock: boolean;
  amount: number;
  shippingFee: number;
  deliveryMethod: DeliveryMethod;
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
  item: {
    code: string;
    title: string;
    status: StoredItemStatus;
    /** reserved_until < now() ตามเวลา DB */
    lapsed: boolean;
    /** มีออเดอร์ถือสินค้าอยู่ (holdingOrderExistsSql) */
    held: boolean;
  };
};

/** DTO ที่ปลอดภัยต่อการส่งให้ client: ไม่มี path สลิป, demo session id, token, ip hash */
export type AdminOrderView = {
  id: string;
  /** สถานะที่มีผลจริง */
  status: OrderStatus;
  statusLabel: string;
  deliveryMethod: DeliveryMethod;
  amount: number;
  shippingFee: number;
  customerName: string;
  phone: string;
  address: string | null;
  note: string | null;
  /** true = ข้อมูลส่วนตัวถูก mask (role demo) */
  masked: boolean;
  trackingNo: string | null;
  rejectReason: string | null;
  createdAtMs: number;
  slipUploadedAtMs: number | null;
  hasSlip: boolean;
  /** เห็นรูปสลิปได้ (มีสลิป และ role/เจ้าของออเดอร์อนุญาต) */
  slipVisible: boolean;
  /** สลิปเป็นไฟล์ HEIC/HEIF (ตามนามสกุลที่เก็บไว้) — browser ส่วนใหญ่แสดงในหน้าเว็บไม่ได้ ให้ดาวน์โหลดแทน */
  slipIsHeic: boolean;
  item: { code: string; title: string; display: DisplayStatus | null };
  actions: AdminAction[];
  /** ไม่ว่าง = เปลี่ยนสถานะไม่ได้เพราะไม่ใช่ออเดอร์ของ session เดโมนี้ (ดูได้อย่างเดียว) — ข้อความอธิบายเหตุผล */
  readOnlyReason: string | null;
};

export const DEMO_READ_ONLY_REASON =
  "ออเดอร์นี้ไม่ได้สร้างจากเบราว์เซอร์นี้ โหมดเดโมจึงดูได้อย่างเดียว เปลี่ยนสถานะได้เฉพาะออเดอร์ที่คุณสร้างเอง (ไปสั่งซื้อสินค้าจากหน้าร้านด้วยเบราว์เซอร์เดียวกันแล้วกลับมาที่นี่)";

/** owner ทำได้ทุกออเดอร์; demo ทำได้เฉพาะออเดอร์ที่ demo_session_id ตรงกับ sid (ตรรกะเดียวกับ adminTransition) */
export function canTransitionOrder(session: AdminSession, orderDemoSessionId: string | null): boolean {
  if (!can(session, "order.transition")) return false;
  if (session.role === "owner") return true;
  return !!orderDemoSessionId && orderDemoSessionId === session.sid;
}

export function toAdminOrderView(row: AdminOrderRow, session: AdminSession): AdminOrderView {
  const status = effectiveOrderStatus(row.status, row.expiredByClock);
  const seePii = can(session, "pii.read");
  const hasSlip = row.slipPath !== null;
  const mayTransition = canTransitionOrder(session, row.demoSessionId);
  return {
    id: row.id,
    status,
    statusLabel: ORDER_STATUS_LABEL[status],
    deliveryMethod: row.deliveryMethod,
    amount: row.amount,
    shippingFee: row.shippingFee,
    customerName: seePii ? row.customerName : maskName(row.customerName),
    phone: seePii ? row.phone : maskPhone(row.phone),
    address: seePii ? row.address : maskAddress(row.address),
    note: seePii ? row.note : maskNote(row.note),
    masked: !seePii,
    trackingNo: row.trackingNo,
    rejectReason: row.rejectReason,
    createdAtMs: row.createdAt.getTime(),
    slipUploadedAtMs: row.slipUploadedAt ? row.slipUploadedAt.getTime() : null,
    hasSlip,
    slipVisible: hasSlip && canViewSlip(session, row.demoSessionId),
    slipIsHeic: hasSlip && /\.hei[cf]$/i.test(row.slipPath ?? ""),
    item: {
      code: row.item.code,
      title: row.item.title,
      // ใช้ตรรกะเดียวกับหน้าร้าน: reserved ที่หมดเวลาและไม่มีออเดอร์ถือ = ว่าง
      display: resolveDisplayStatus({
        status: row.item.status,
        lapsed: row.item.lapsed,
        held: row.item.held,
      }),
    },
    // action เฉพาะสถานะที่มีผลจริงตรงกับค่าที่เก็บ (pending ที่หมดเวลาแล้วไม่มี action)
    actions:
      mayTransition && status === row.status ? availableActions(row.status, row.deliveryMethod) : [],
    readOnlyReason: mayTransition ? null : DEMO_READ_ONLY_REASON,
  };
}

// ---------------------------------------------------------------- timeline ฝั่งแอดมิน

export type AdminTimelineInput = {
  type: string;
  actor: "customer" | "admin" | "system";
  meta: Record<string, unknown> | null;
  createdAtMs: number;
};

export type AdminTimelineEntry = {
  key: string;
  label: string;
  detail: string | null;
  atMs: number;
};

const ADMIN_LABEL: Record<string, string> = {
  created: "ลูกค้าจองสินค้า",
  upload_slip: "ลูกค้าส่งสลิป",
  cancel: "ลูกค้ายกเลิกออเดอร์",
  expire: "หมดเวลาชำระเงิน (ระบบ)",
  confirm: "ยืนยันการชำระเงิน",
  reject: "ปฏิเสธสลิป",
  ship: "จัดส่งแล้ว",
  complete: "ปิดงาน",
};

const ADMIN_ROLE_LABEL: Record<string, string> = { owner: "เจ้าของร้าน", demo: "ผู้ลองเดโม" };

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** timeline สำหรับหลังบ้าน: กรอง event ภายใน (slip_token_issued) ออก เรียงเก่า → ใหม่ */
export function buildAdminTimeline(events: AdminTimelineInput[]): AdminTimelineEntry[] {
  return [...events]
    .filter((e) => !isInternalEventType(e.type))
    .sort((a, b) => a.createdAtMs - b.createdAtMs)
    .map((e, i) => {
      const parts: string[] = [];
      if (e.type === "reject") {
        const r = str(e.meta?.reason);
        if (r) parts.push(`เหตุผล: ${r}`);
      }
      if (e.type === "ship") {
        const t = str(e.meta?.trackingNo);
        if (t) parts.push(`เลขพัสดุ ${t}`);
      }
      if (e.type === "upload_slip" && e.meta?.sample === true) parts.push("สลิปตัวอย่าง");
      if (e.actor === "admin") {
        const role = ADMIN_ROLE_LABEL[str(e.meta?.adminRole) ?? ""];
        if (role) parts.push(`โดย ${role}`);
      }
      return {
        key: `${e.type}-${i}`,
        label: ADMIN_LABEL[e.type] ?? "อัปเดตสถานะ",
        detail: parts.length > 0 ? parts.join(" · ") : null,
        atMs: e.createdAtMs,
      };
    });
}

// ---------------------------------------------------------------- input ของ action (Zod)

export const orderIdSchema = z.uuid();

const reasonSchema = z
  .string({ error: "กรุณาระบุเหตุผล" })
  .trim().min(1, "กรุณาระบุเหตุผล").max(300, "เหตุผลยาวเกินไป (ไม่เกิน 300 ตัวอักษร)");
const trackingSchema = z
  .string({ error: "กรุณาระบุเลขพัสดุ" })
  .trim()
  .regex(/^[A-Za-z0-9-]{5,40}$/, "เลขพัสดุใช้ได้เฉพาะตัวอักษรอังกฤษ ตัวเลข และ - (5-40 ตัว)");

export const adminTransitionSchema = z.discriminatedUnion("intent", [
  z.object({ orderId: orderIdSchema, intent: z.literal("confirm") }),
  z.object({ orderId: orderIdSchema, intent: z.literal("reject"), reason: reasonSchema }),
  z.object({ orderId: orderIdSchema, intent: z.literal("ship"), trackingNo: trackingSchema }),
  z.object({ orderId: orderIdSchema, intent: z.literal("complete") }),
]);

export type AdminTransitionInput = z.infer<typeof adminTransitionSchema>;
