import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { OrderActions } from "@/components/admin/OrderActions";
import { SlipImage } from "@/components/admin/SlipImage";
import { OrderTimeline } from "@/components/order/OrderTimeline";
import { getAdminOrderDetail } from "@/lib/admin/queries";
import { orderIdSchema } from "@/lib/admin/view";
import { requireSession } from "@/lib/auth-server";
import { codeNumber, DELIVERY_LABEL, formatPrice, formatThaiDateTime } from "@/lib/labels";

export const instant = false;

export const metadata: Metadata = { title: "รายละเอียดออเดอร์" };

const ITEM_DISPLAY_LABEL = {
  available: "ว่าง",
  reserved: "มีคนจองอยู่",
  sold: "ขายแล้ว",
} as const;

export default async function AdminOrderPage({ params }: PageProps<"/admin/orders/[id]">) {
  const session = await requireSession();
  const parsed = orderIdSchema.safeParse((await params).id);
  if (!parsed.success) notFound();

  const detail = await getAdminOrderDetail(session, parsed.data);
  if (!detail) notFound();
  const { order, timeline } = detail;
  const itemPrice = order.amount - order.shippingFee;

  return (
    <main className="mx-auto max-w-3xl px-4 pt-4 pb-16 md:px-8">
      <Link
        href="/admin"
        className="tap meta meta-th inline-flex items-center text-ink underline underline-offset-4"
      >
        ← ออเดอร์ทั้งหมด
      </Link>

      <p className="meta mt-2">№ {codeNumber(order.item.code)}</p>
      <h1 className="display mt-1 text-display">{order.item.title}</h1>
      <p
        className={`mt-4 inline-block border px-3 py-1 meta meta-th ${
          order.status === "awaiting_review" ? "border-accent text-accent" : "border-ink text-ink"
        }`}
        data-testid="admin-order-status"
        data-status={order.status}
      >
        {order.statusLabel}
      </p>
      {order.demoReturnAtMs !== null ? (
        <p
          className="mt-4 border-l-4 border-l-ink pl-3 text-sm leading-7 text-muted"
          data-testid="demo-return-note"
        >
          {order.status === "demo_ended"
            ? `ออเดอร์นี้ถูกยืนยันโดยผู้ลองเดโม และสิ้นสุดแล้ว: ระบบคืนสินค้าเข้าร้านให้เองเมื่อ ${formatThaiDateTime(order.demoReturnAtMs)} (ไม่ใช่การขายจริง)`
            : `ออเดอร์นี้ถูกยืนยันโดยผู้ลองเดโม: ระบบจะคืนสินค้าเข้าร้านให้เองประมาณ ${formatThaiDateTime(order.demoReturnAtMs)} (ไม่ใช่การขายจริง)`}
        </p>
      ) : null}

      <section aria-labelledby="summary-heading" className="mt-8 border-t border-rule pt-6">
        <h2 id="summary-heading" className="meta meta-th text-ink">
          รายการ
        </h2>
        <dl className="mt-4 space-y-1">
          <div className="flex justify-between gap-4">
            <dt className="text-muted">ราคาสินค้า</dt>
            <dd>{formatPrice(itemPrice)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted">ค่าส่ง</dt>
            <dd>{order.shippingFee === 0 ? "ฟรี" : formatPrice(order.shippingFee)}</dd>
          </div>
          <div className="flex justify-between gap-4 border-t border-rule pt-2 font-medium">
            <dt>ยอดรวม</dt>
            <dd data-testid="admin-order-amount">{formatPrice(order.amount)}</dd>
          </div>
          <div className="flex justify-between gap-4 pt-2">
            <dt className="text-muted">สถานะสินค้าตอนนี้</dt>
            <dd data-testid="admin-item-status">
              {order.item.display ? ITEM_DISPLAY_LABEL[order.item.display] : "ซ่อนอยู่"}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted">สร้างเมื่อ</dt>
            <dd>{formatThaiDateTime(order.createdAtMs)}</dd>
          </div>
          {order.trackingNo ? (
            <div className="flex justify-between gap-4">
              <dt className="text-muted">เลขพัสดุ</dt>
              <dd data-testid="admin-tracking">{order.trackingNo}</dd>
            </div>
          ) : null}
          {order.rejectReason ? (
            <div className="flex justify-between gap-4">
              <dt className="text-muted">เหตุผลที่ปฏิเสธ</dt>
              <dd className="text-right">{order.rejectReason}</dd>
            </div>
          ) : null}
        </dl>
      </section>

      <section aria-labelledby="customer-heading" className="mt-8 border-t border-rule pt-6">
        <h2 id="customer-heading" className="meta meta-th text-ink">
          ลูกค้า
        </h2>
        {order.masked ? (
          <p className="mt-2 text-sm text-muted" data-testid="masked-note">
            ข้อมูลลูกค้าถูกปิดบังในโหมดเดโม
          </p>
        ) : null}
        <dl className="mt-4 space-y-1">
          <div className="flex justify-between gap-4">
            <dt className="text-muted">ชื่อ</dt>
            <dd data-testid="customer-name">{order.customerName}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted">เบอร์โทร</dt>
            <dd data-testid="customer-phone">{order.phone}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted">วิธีรับของ</dt>
            <dd>{DELIVERY_LABEL[order.deliveryMethod]}</dd>
          </div>
          {order.address ? (
            <div className="flex justify-between gap-4">
              <dt className="shrink-0 text-muted">ที่อยู่</dt>
              <dd className="text-right break-words" data-testid="customer-address">
                {order.address}
              </dd>
            </div>
          ) : null}
          {order.note ? (
            <div className="flex justify-between gap-4">
              <dt className="shrink-0 text-muted">หมายเหตุ</dt>
              <dd className="text-right break-words" data-testid="customer-note">
                {order.note}
              </dd>
            </div>
          ) : null}
        </dl>
      </section>

      <section aria-labelledby="slip-heading" className="mt-8 border-t border-rule pt-6">
        <h2 id="slip-heading" className="meta meta-th text-ink">
          สลิป
        </h2>
        {!order.hasSlip ? (
          <p className="mt-4 text-muted" data-testid="slip-none">
            ลูกค้ายังไม่ได้ส่งสลิป
          </p>
        ) : order.slipVisible ? (
          <div className="mt-4">
            {order.slipUploadedAtMs ? (
              <p className="meta meta-th mb-3">ส่งเมื่อ {formatThaiDateTime(order.slipUploadedAtMs)}</p>
            ) : null}
            {/* รูปมาจาก proxy ที่ตรวจ session ซ้ำ (ไม่ใช่ URL ของ Blob); HEIC แสดงเป็นลิงก์ดาวน์โหลด */}
            <SlipImage orderId={order.id} isHeic={order.slipIsHeic} />
          </div>
        ) : (
          <p className="mt-4 border border-rule p-4 text-muted" data-testid="slip-hidden">
            สลิปถูกซ่อน: ในโหมดเดโมคุณดูได้เฉพาะสลิปของออเดอร์ที่สร้างจากเบราว์เซอร์นี้
          </p>
        )}
      </section>

      {order.readOnlyReason ? (
        <section aria-labelledby="actions-heading" className="mt-10 border-t border-rule pt-6">
          <h2 id="actions-heading" className="meta meta-th text-ink">
            ดำเนินการ
          </h2>
          <p
            className="mt-4 border-l-4 border-l-ink pl-3 leading-7 text-muted"
            data-testid="read-only-note"
          >
            {order.readOnlyReason}
          </p>
        </section>
      ) : (
        <OrderActions orderId={order.id} actions={order.actions} />
      )}

      <div className="mt-10 border-t border-rule pt-6">
        <OrderTimeline entries={timeline} />
      </div>
    </main>
  );
}
