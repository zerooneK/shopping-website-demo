import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ItemView } from "@/components/shop/ItemView";
import { getItemByCode, getPublicItem } from "@/lib/items";
import { CATEGORY_LABEL, CONDITION_LABEL, formatPrice } from "@/lib/labels";
import { itemCodeSchema } from "@/lib/validation";

// หน้านี้ตั้งใจให้ blocking (ไม่มี static shell): ต้องอ่านสถานะสดและตัดสิน 404 ก่อนเริ่ม stream
// ข้อมูลหนักๆ (ชื่อ/รูป/ตำหนิ) ยังมาจาก cache; ที่ไม่ cache มีแค่ query สถานะ 1 ครั้ง
export const instant = false;

async function readCode(params: PageProps<"/item/[code]">["params"]) {
  const { code } = await params;
  const parsed = itemCodeSchema.safeParse(code);
  return parsed.success ? parsed.data : null;
}

export async function generateMetadata({
  params,
}: PageProps<"/item/[code]">): Promise<Metadata> {
  const code = await readCode(params);
  const item = code ? await getPublicItem(code) : null;
  if (!item) return { title: "ไม่พบสินค้า" };

  const description = `${item.description.slice(0, 120)} · ${CONDITION_LABEL[item.condition]} · ${CATEGORY_LABEL[item.category]} · ${formatPrice(item.price)}`;
  const cover = item.images[0];
  return {
    title: `№ ${item.code.slice(1)} ${item.title}`,
    description,
    openGraph: {
      title: `${item.title} — Second Room`,
      description,
      type: "website",
      locale: "th_TH",
      images: cover ? [{ url: cover.url, alt: cover.alt }] : undefined,
    },
  };
}

export default async function ItemPage({ params }: PageProps<"/item/[code]">) {
  // ตรวจรหัสและอ่านสถานะสดก่อนเริ่ม stream เพื่อให้รหัสที่ไม่มีได้ HTTP 404 จริง
  // (ถ้าห่อ Suspense ไว้ shell จะถูกส่งก่อนและสถานะ HTTP ล็อกเป็น 200)
  const code = await readCode(params);
  const item = code ? await getItemByCode(code) : null;
  if (!item) notFound();

  const { status, reservedUntil, ...base } = item;
  return <ItemView item={base} live={{ status, reservedUntil }} />;
}
