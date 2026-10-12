import Link from "next/link";
import type { LiveStatus, PublicItem } from "@/lib/items";
import { codeNumber, CATEGORY_LABEL, CONDITION_LABEL, formatPrice } from "@/lib/labels";
import { Gallery } from "./Gallery";
import { ItemCta } from "./ItemCta";
import { SoldStamp } from "./SoldStamp";
import { StatusTag } from "./StatusTag";

/**
 * รายละเอียดสินค้า — เนื้อหาทั้งหมดมาจากข้อมูล static; `live` (สถานะสด) เป็น null
 * ระหว่างรอ stream (fallback) แล้วค่อยแทนที่ด้วยสถานะจริง
 */
export function ItemView({ item, live }: { item: PublicItem; live: LiveStatus | null }) {
  const status = live?.status ?? null;
  const sold = status === "sold";
  const credited = item.images.filter((img) => img.credit);

  return (
    <>
      <div className="mx-auto max-w-7xl px-4 pt-4 pb-28 md:px-8 md:pb-0">
        <Link
          href="/"
          className="tap meta meta-th inline-flex items-center text-ink underline underline-offset-4"
        >
          ← กลับไปหน้าร้าน
        </Link>

        <div className="mt-2 grid gap-8 lg:grid-cols-12 lg:gap-12">
          <div className="lg:col-span-7">
            <Gallery images={item.images} code={item.code} grayscale={sold}>
              {sold ? <SoldStamp large /> : null}
            </Gallery>
          </div>

          <div className="lg:col-span-5 lg:sticky lg:top-6 lg:self-start">
            <p className="display text-hero leading-none text-ink">
              <span className="mr-2 align-top text-[0.35em] text-muted">№</span>
              <span aria-label={`รหัส ${item.code}`}>{codeNumber(item.code)}</span>
            </p>

            <h1 className="display mt-4 text-3xl sm:text-4xl">{item.title}</h1>

            <div className="mt-4 flex flex-wrap items-baseline gap-x-5 gap-y-2 border-y border-rule py-4">
              <p className="display text-4xl">{formatPrice(item.price)}</p>
              <p className="meta meta-th">{CONDITION_LABEL[item.condition]}</p>
              <p className="meta meta-th">{CATEGORY_LABEL[item.category]}</p>
              {status ? <StatusTag status={status} /> : null}
            </div>

            <p className="mt-5 leading-8 text-ink">{item.description}</p>

            {/* ตำหนิ: บล็อกของตัวเอง ห้ามซ่อนหรือย่อ (SPEC §3) */}
            <section
              aria-labelledby="flaws-heading"
              className="mt-6 border border-ink border-l-8 p-4"
            >
              <h2 id="flaws-heading" className="meta meta-th text-ink">
                ตำหนิของชิ้นนี้
              </h2>
              <p className="mt-2 leading-8 text-ink">{item.flaws}</p>
            </section>

            <div className="mt-6 hidden md:block">
              <ItemCta
                code={item.code}
                price={item.price}
                status={status}
                reservedUntil={live?.reservedUntil ?? null}
              />
            </div>

            {credited.length > 0 ? (
              <section aria-labelledby="credit-heading" className="mt-8">
                <h2 id="credit-heading" className="meta meta-th">
                  เครดิตภาพ
                </h2>
                <ul className="mt-1 text-sm text-muted">
                  {item.images.map((img, i) =>
                    img.credit ? (
                      <li key={img.url} className="flex min-h-11 flex-wrap items-center gap-x-1">
                        <span>รูปที่ {i + 1} — ภาพโดย</span>
                        {/* hit area สูง >= 44px: ขยายด้วย min-h + padding แนวตั้ง โดยหน้าตายังเป็นลิงก์ขีดเส้นใต้ธรรมดา */}
                        <a
                          href={img.credit.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex min-h-11 items-center text-ink underline underline-offset-4"
                        >
                          {img.credit.name}
                        </a>
                        <span>บน Unsplash</span>
                      </li>
                    ) : null,
                  )}
                </ul>
              </section>
            ) : null}
          </div>
        </div>
      </div>

      {/* sticky bottom bar (mobile) */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-rule bg-paper px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:hidden">
        <ItemCta
          code={item.code}
          price={item.price}
          status={status}
          reservedUntil={live?.reservedUntil ?? null}
        />
      </div>
    </>
  );
}
