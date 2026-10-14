import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DeleteItemForm } from "@/components/admin/DeleteItemForm";
import { ItemForm } from "@/components/admin/ItemForm";
import { getAdminItem } from "@/lib/admin/item-queries";
import { itemIdSchema } from "@/lib/admin/item-validation";
import { can } from "@/lib/auth";
import { requireSession } from "@/lib/auth-server";
import { codeNumber } from "@/lib/labels";

export const instant = false;

export const metadata: Metadata = { title: "แก้ไขสินค้า" };

export default async function EditItemPage({ params }: PageProps<"/admin/items/[id]">) {
  const session = await requireSession();
  const parsed = itemIdSchema.safeParse((await params).id);
  if (!parsed.success) notFound();

  const item = await getAdminItem(parsed.data);
  if (!item) notFound();

  return (
    <main className="mx-auto max-w-3xl px-4 pt-4 pb-16 md:px-8">
      <Link
        href="/admin/items"
        className="tap meta meta-th inline-flex items-center text-ink underline underline-offset-4"
      >
        ← สินค้าทั้งหมด
      </Link>
      <p className="meta mt-2">№ {codeNumber(item.code)}</p>
      <h1 className="display mt-1 text-display">{item.title}</h1>
      <p className="mt-2 text-sm">
        <Link href={`/item/${item.code}`} className="underline underline-offset-4" data-testid="view-on-shop">
          ดูบนหน้าร้าน
        </Link>
      </p>
      <ItemForm
        mode="edit"
        initial={{
          id: item.id,
          code: item.code,
          title: item.title,
          description: item.description,
          flaws: item.flaws,
          condition: item.condition,
          category: item.category,
          price: item.price,
          sortOrder: item.sortOrder,
          status: item.status,
          held: item.held,
          images: item.images.map((i) => ({ url: i.url, alt: i.alt })),
        }}
        canEdit={can(session, "item.edit")}
        canUpload={can(session, "image.upload")}
        blobEnabled={!!process.env.BLOB_READ_WRITE_TOKEN}
      />
      {can(session, "item.delete") ? <DeleteItemForm id={item.id} orderCount={item.orderCount} /> : null}
    </main>
  );
}
