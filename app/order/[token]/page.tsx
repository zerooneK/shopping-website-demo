import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { OrderPoller } from "@/components/order/OrderPoller";
import { OrderTimeline } from "@/components/order/OrderTimeline";
import { PaymentPanel } from "@/components/order/PaymentPanel";
import { SafeImage } from "@/components/ui/SafeImage";
import { isDemoMode } from "@/lib/demo";
import { codeNumber, DELIVERY_LABEL, formatPrice } from "@/lib/labels";
import { getCustomerOrder } from "@/lib/orders/queries";
import { buildTimeline, describeOrder, type OrderTone } from "@/lib/orders/view";

// ต้องอ่านสถานะสดจาก DB ทุกครั้งและตัดสิน 404 ก่อนเริ่ม stream — ไม่มี static shell ที่มีข้อมูลออเดอร์
export const instant = false;

// token อยู่ใน URL: ห้ามให้ search engine เก็บ และห้ามส่ง referrer ออกไป
// (header Cache-Control/Referrer-Policy/X-Robots-Tag ตั้งใน next.config.ts ด้วย)
export const metadata: Metadata = {
  title: "ติดตามออเดอร์",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

const TONE_BORDER: Record<OrderTone, string> = {
  pending: "border-l-accent",
  waiting: "border-l-ink",
  good: "border-l-ink",
  bad: "border-l-accent",
  neutral: "border-l-rule",
};

export default async function OrderPage({ params }: PageProps<"/order/[token]">) {
  const { token } = await params;
  const order = await getCustomerOrder(token);
  if (!order) notFound();

  const view = describeOrder({
    status: order.status,
    deliveryMethod: order.deliveryMethod,
    expiresAtMs: order.expiresAt.getTime(),
    nowMs: order.dbNow.getTime(),
    trackingNo: order.trackingNo,
    rejectReason: order.rejectReason,
  });
  const timeline = buildTimeline(
    order.events.map((e) => ({ type: e.type, meta: e.meta, createdAtMs: e.createdAt.getTime() })),
  );
  const itemPrice = order.amount - order.shippingFee;

  return (
    <main className="mx-auto max-w-3xl px-4 pt-4 pb-16 md:px-8">
      <Link
        href="/"
        className="tap meta meta-th inline-flex items-center text-ink underline underline-offset-4"
      >
        ← กลับไปหน้าร้าน
      </Link>

      <p className="meta mt-2">ติดตามออเดอร์</p>
      <h1
        className={`display mt-2 border-l-4 pl-4 text-display ${TONE_BORDER[view.tone]}`}
        data-testid="order-headline"
        data-status={view.effectiveStatus}
      >
        {view.headline}
      </h1>
      <p className="mt-3 max-w-xl leading-8 text-muted" data-testid="order-body">
        {view.body}
      </p>
      {view.effectiveStatus === "shipped" && view.trackingNo ? (
        <p className="meta meta-th mt-2 text-ink">เลขพัสดุ: {view.trackingNo}</p>
      ) : null}
      {view.showBackToShop ? (
        <Link
          href="/"
          className="tap mt-4 inline-flex items-center bg-accent px-6 font-medium text-paper hover:opacity-90"
        >
          กลับไปเลือกของในร้าน
        </Link>
      ) : null}

      {view.showPayment ? (
        <div className="mt-10">
          <PaymentPanel
            token={token}
            orderId={order.id}
            amount={order.amount}
            expiresAt={order.expiresAt}
            dbNow={order.dbNow}
            blobEnabled={Boolean(process.env.BLOB_READ_WRITE_TOKEN)}
            demoMode={isDemoMode()}
          />
        </div>
      ) : null}

      {/* สินค้า + ยอด */}
      <section aria-labelledby="summary-heading" className="mt-10 border-t border-rule pt-6">
        <h2 id="summary-heading" className="meta meta-th text-ink">
          รายการสั่งซื้อ
        </h2>
        <div className="mt-4 flex gap-4">
          <div className="relative aspect-[4/5] w-20 shrink-0 border border-rule bg-rule/40">
            {order.item.image ? (
              <SafeImage src={order.item.image.url} alt={order.item.image.alt} sizes="96px" />
            ) : null}
          </div>
          <div className="min-w-0">
            <p className="meta">№ {codeNumber(order.item.code)}</p>
            <p className="mt-1 font-medium leading-snug">{order.item.title}</p>
          </div>
        </div>
        <dl className="mt-4 space-y-1">
          <div className="flex justify-between">
            <dt className="text-muted">ราคาสินค้า</dt>
            <dd>{formatPrice(itemPrice)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted">ค่าส่ง</dt>
            <dd>{order.shippingFee === 0 ? "ฟรี" : formatPrice(order.shippingFee)}</dd>
          </div>
          <div className="flex items-baseline justify-between border-t border-rule pt-2">
            <dt className="meta meta-th text-ink">ยอดรวม</dt>
            <dd className="display text-3xl">{formatPrice(order.amount)}</dd>
          </div>
          <div className="flex justify-between pt-2">
            <dt className="text-muted">วิธีรับของ</dt>
            <dd>{DELIVERY_LABEL[order.deliveryMethod]}</dd>
          </div>
        </dl>
      </section>


      <div className="mt-10 border-t border-rule pt-6">
        <OrderTimeline entries={timeline} />
      </div>

      <OrderPoller token={token} initialStatus={view.effectiveStatus} keepPolling={view.keepPolling} />
    </main>
  );
}
