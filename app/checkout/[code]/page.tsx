import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CheckoutForm } from "@/components/checkout/CheckoutForm";
import { SafeImage } from "@/components/ui/SafeImage";
import { isDemoMode } from "@/lib/demo";
import { getItemByCode } from "@/lib/items";
import { codeNumber, formatPrice } from "@/lib/labels";
import { itemCodeSchema } from "@/lib/validation";

// เหมือนหน้าสินค้า: ต้องอ่านสถานะสดก่อนเริ่ม stream (ตัดสินว่าแสดงฟอร์มหรือข้อความ "ไม่ว่าง")
export const instant = false;

export const metadata: Metadata = {
  title: "กรอกข้อมูลสั่งซื้อ",
  robots: { index: false, follow: false },
};

export default async function CheckoutPage({ params }: PageProps<"/checkout/[code]">) {
  const { code: rawCode } = await params;
  const parsed = itemCodeSchema.safeParse(rawCode);
  const item = parsed.success ? await getItemByCode(parsed.data) : null;
  if (!item) notFound();

  const available = item.status === "available";

  return (
    <main className="mx-auto max-w-7xl px-4 pt-4 pb-16 md:px-8">
      <Link
        href={`/item/${item.code}`}
        className="tap meta meta-th inline-flex items-center text-ink underline underline-offset-4"
      >
        ← กลับไปดูสินค้า
      </Link>

      <div className="mt-2 grid gap-8 lg:grid-cols-12 lg:gap-12">
        {/* สรุปสินค้า */}
        <aside aria-label="สินค้าที่จอง" className="lg:col-span-5 lg:order-2 lg:sticky lg:top-6 lg:self-start">
          <div className="flex gap-4 border border-rule p-3">
            <div className="relative aspect-[4/5] w-24 shrink-0 border border-rule bg-rule/40 sm:w-32">
              {item.images[0] ? (
                <SafeImage src={item.images[0].url} alt={item.images[0].alt} sizes="128px" />
              ) : null}
            </div>
            <div className="min-w-0">
              <p className="meta">№ {codeNumber(item.code)}</p>
              <h2 className="mt-1 text-base font-medium leading-snug">{item.title}</h2>
              <p className="display mt-2 text-3xl">{formatPrice(item.price)}</p>
            </div>
          </div>
        </aside>

        <section aria-labelledby="checkout-title" className="lg:col-span-7 lg:order-1">
          <p className="meta">Checkout</p>
          <h1 id="checkout-title" className="display mt-2 text-display">
            {available ? "กรอกข้อมูลสั่งซื้อ" : "ชิ้นนี้จองไม่ได้ตอนนี้"}
          </h1>

          {available ? (
            <div className="mt-6">
              <CheckoutForm code={item.code} price={item.price} demoMode={isDemoMode()} />
            </div>
          ) : (
            <div className="mt-6 border border-ink p-5" role="status">
              <p className="leading-8">
                {item.status === "sold"
                  ? "ชิ้นนี้ขายไปแล้ว"
                  : "ตอนนี้มีคนจองชิ้นนี้อยู่ ถ้าเขาไม่ชำระเงินภายในเวลาที่กำหนด สินค้าจะกลับมาว่างอีกครั้ง"}
              </p>
              <div className="mt-4 flex flex-wrap gap-3">
                <Link
                  href={`/item/${item.code}`}
                  className="tap inline-flex items-center border border-ink px-5 text-ink hover:bg-ink hover:text-paper"
                >
                  กลับไปดูสินค้า
                </Link>
                <Link
                  href="/"
                  className="tap inline-flex items-center bg-accent px-5 font-medium text-paper hover:opacity-90"
                >
                  เลือกชิ้นอื่น
                </Link>
              </div>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
