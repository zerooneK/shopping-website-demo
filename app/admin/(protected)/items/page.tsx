import type { Metadata } from "next";
import Link from "next/link";
import { ItemResetNotice } from "@/components/admin/ItemResetNotice";
import { ItemStatusForm } from "@/components/admin/ItemStatusForm";
import { SafeImage } from "@/components/ui/SafeImage";
import { listAdminItems } from "@/lib/admin/item-queries";
import { can } from "@/lib/auth";
import { requireSession } from "@/lib/auth-server";
import { codeNumber, formatPrice } from "@/lib/labels";

export const instant = false;

export const metadata: Metadata = { title: "สินค้า" };

export default async function AdminItemsPage() {
  // ตรวจ session ซ้ำในหน้าเอง (layout ไม่ render ซ้ำเวลานำทาง)
  const session = await requireSession();
  const canEdit = can(session, "item.edit");
  const rows = await listAdminItems();

  return (
    <main className="mx-auto max-w-5xl px-4 pt-8 pb-16 md:px-8">
      <p className="meta">Back office</p>
      <h1 className="display mt-2 text-display">สินค้า</h1>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted" data-testid="items-count">
          ทั้งหมด {rows.length} รายการ
        </p>
        {canEdit ? (
          <Link
            href="/admin/items/new"
            className="tap inline-flex items-center justify-center border border-ink px-6 font-medium text-ink hover:bg-ink hover:text-paper"
          >
            เพิ่มสินค้า
          </Link>
        ) : null}
      </div>

      <ItemResetNotice />

      {!canEdit ? (
        <p className="mt-4 border-l-4 border-l-ink pl-3 text-sm leading-7 text-muted" data-testid="items-readonly-note">
          โหมดเดโม: ดูรายการสินค้าได้อย่างเดียว แก้ไข เปลี่ยนสถานะ อัปโหลดรูป และลบสินค้าได้เฉพาะเจ้าของร้าน
        </p>
      ) : null}

      <ul className="mt-6 border-b border-rule" data-testid="admin-item-list">
        {rows.map((r) => (
          <li
            key={r.id}
            className="border-t border-rule py-4"
            data-testid="admin-item-row"
            data-code={r.code}
            data-status={r.status}
          >
            <div className="flex gap-3">
              <div className="relative aspect-[4/5] w-16 shrink-0 overflow-hidden border border-rule bg-rule/40">
                {r.firstImage ? (
                  <SafeImage src={r.firstImage.url} alt={r.firstImage.alt} sizes="64px" />
                ) : null}
              </div>
              <div className="min-w-0 flex-1">
                <p className="meta">№ {codeNumber(r.code)}</p>
                <Link
                  href={`/admin/items/${r.id}`}
                  className="tap mt-1 block font-medium leading-snug underline-offset-4 hover:underline"
                >
                  {r.title}
                </Link>
                <p className="mt-1 text-sm text-muted">
                  <span data-testid="row-price">{formatPrice(r.price)}</span> · รูป {r.imageCount} · ออเดอร์ {r.orderCount}
                </p>
              </div>
            </div>
            <div className="mt-3">
              <ItemStatusForm id={r.id} code={r.code} status={r.status} held={r.held} canEdit={canEdit} />
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
