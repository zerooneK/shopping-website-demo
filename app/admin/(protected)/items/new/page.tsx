import type { Metadata } from "next";
import Link from "next/link";
import { ItemForm } from "@/components/admin/ItemForm";
import { ItemResetNotice } from "@/components/admin/ItemResetNotice";
import { can } from "@/lib/auth";
import { requireSession } from "@/lib/auth-server";

export const instant = false;

export const metadata: Metadata = { title: "เพิ่มสินค้า" };

export default async function NewItemPage() {
  const session = await requireSession();

  return (
    <main className="mx-auto max-w-3xl px-4 pt-4 pb-16 md:px-8">
      <Link
        href="/admin/items"
        className="tap meta meta-th inline-flex items-center text-ink underline underline-offset-4"
      >
        ← สินค้าทั้งหมด
      </Link>
      <h1 className="display mt-2 text-display">เพิ่มสินค้า</h1>
      <ItemResetNotice />
      <ItemForm
        mode="create"
        canEdit={can(session, "item.edit")}
        canUpload={can(session, "image.upload")}
        blobEnabled={!!process.env.BLOB_READ_WRITE_TOKEN}
      />
    </main>
  );
}
