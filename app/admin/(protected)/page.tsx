import type { Metadata } from "next";
import Link from "next/link";
import { getAdminDashboard } from "@/lib/admin/queries";
import { ADMIN_TABS, parseTab, type AdminOrderView } from "@/lib/admin/view";
import { requireSession } from "@/lib/auth-server";
import { codeNumber, DELIVERY_LABEL, formatPrice, formatThaiDateTime } from "@/lib/labels";

export const instant = false;

export const metadata: Metadata = { title: "ออเดอร์" };

function statusClass(status: AdminOrderView["status"]): string {
  if (status === "awaiting_review") return "border-accent text-accent";
  if (status === "confirmed" || status === "shipped") return "border-ink text-ink";
  return "border-rule text-muted";
}

export default async function AdminDashboardPage({ searchParams }: PageProps<"/admin">) {
  // ตรวจ session ซ้ำในหน้าเอง (layout ไม่ render ซ้ำเวลานำทาง)
  const session = await requireSession();
  const tab = parseTab((await searchParams).tab);
  const data = await getAdminDashboard(session, tab);

  return (
    <main className="mx-auto max-w-5xl px-4 pt-8 pb-16 md:px-8">
      <p className="meta">Back office</p>
      <h1 className="display mt-2 text-display">ออเดอร์</h1>

      <nav aria-label="กรองตามสถานะ" className="-mx-4 mt-6 overflow-x-auto border-b border-rule md:mx-0">
        <ul className="flex min-w-max px-4 md:px-0">
          {ADMIN_TABS.map((t) => {
            const active = t.key === data.tab;
            return (
              <li key={t.key}>
                <Link
                  href={t.key === "all" ? "/admin" : `/admin?tab=${t.key}`}
                  aria-current={active ? "page" : undefined}
                  className={`tap meta meta-th inline-flex items-center gap-2 whitespace-nowrap border-b-2 px-3 ${
                    active ? "border-ink text-ink" : "border-transparent text-muted hover:text-ink"
                  }`}
                  data-testid={`tab-${t.key}`}
                >
                  {t.label}
                  <span className="text-ink">{data.counts[t.key]}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {session.role === "demo" ? (
        <p className="mt-4 border-l-4 border-l-ink pl-3 text-sm leading-7 text-muted" data-testid="demo-note">
          โหมดเดโม: ชื่อ เบอร์ และที่อยู่ของลูกค้าถูกปิดบังบางส่วน ดูสลิปและเปลี่ยนสถานะได้เฉพาะออเดอร์ที่สร้างจากเบราว์เซอร์นี้ ออเดอร์อื่นดูได้อย่างเดียว
        </p>
      ) : null}

      {data.orders.length === 0 ? (
        <p className="mt-10 text-muted" data-testid="admin-empty">
          ยังไม่มีออเดอร์ในหมวดนี้
        </p>
      ) : (
        <ul className="mt-2 border-b border-rule" data-testid="admin-order-list">
          {data.orders.map((o) => (
            <li
              key={o.id}
              className="border-t border-rule"
              data-testid="admin-order-row"
              data-status={o.status}
              data-order-id={o.id}
            >
              <Link
                href={`/admin/orders/${o.id}`}
                className={`tap block border-l-4 py-4 pr-2 pl-3 hover:bg-rule/30 ${
                  o.status === "awaiting_review" ? "border-l-accent" : "border-l-transparent"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="meta">№ {codeNumber(o.item.code)}</p>
                  <span className={`meta meta-th shrink-0 border px-2 py-0.5 ${statusClass(o.status)}`}>
                    {o.statusLabel}
                  </span>
                </div>
                <p className="mt-1 font-medium leading-snug">{o.item.title}</p>
                <p className="mt-1 text-sm text-muted">
                  <span data-testid="row-customer">{o.customerName}</span> · {formatPrice(o.amount)} ·{" "}
                  {DELIVERY_LABEL[o.deliveryMethod]}
                </p>
                <p className="meta meta-th mt-1">
                  {o.status === "awaiting_review" && o.slipUploadedAtMs
                    ? `ส่งสลิป ${formatThaiDateTime(o.slipUploadedAtMs)}`
                    : `สร้าง ${formatThaiDateTime(o.createdAtMs)}`}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {data.truncated ? (
        <p className="mt-4 text-sm text-muted">แสดง 100 รายการล่าสุดของหมวดนี้</p>
      ) : null}
    </main>
  );
}
