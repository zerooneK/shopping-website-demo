import Link from "next/link";
import { SafeImage } from "@/components/ui/SafeImage";
import { codeNumber, CONDITION_LABEL, formatPrice } from "@/lib/labels";
import type { ShopItem } from "@/lib/items";
import { SoldStamp } from "./SoldStamp";
import { StatusTag } from "./StatusTag";

const SIZES = "(min-width: 1024px) 40vw, (min-width: 640px) 50vw, 100vw";

export function ItemCard({ item, eager = false }: { item: ShopItem; eager?: boolean }) {
  const sold = item.status === "sold";
  const first = item.images[0];
  const second = item.images[1];
  const gray = sold ? "grayscale" : "";

  return (
    <article className="group rise">
      <Link
        href={`/item/${item.code}`}
        className="block focus-visible:outline-offset-4"
        aria-label={`${item.title} รหัส ${item.code} ราคา ${formatPrice(item.price)}${
          sold ? " ขายแล้ว" : item.status === "reserved" ? " มีคนจองอยู่" : ""
        }`}
      >
        <div
          className="relative aspect-[4/5] overflow-hidden border border-rule bg-rule/40"
          style={{ viewTransitionName: `item-${item.code}` }}
        >
          {first ? (
            <SafeImage
              src={first.url}
              alt={first.alt}
              sizes={SIZES}
              eager={eager}
              className={gray}
            />
          ) : null}
          {second ? (
            <SafeImage
              src={second.url}
              alt={second.alt}
              sizes={SIZES}
              className={`${gray} opacity-0 transition-opacity duration-200 [@media(hover:hover)]:group-hover:opacity-100`}
            />
          ) : null}
          {sold ? <SoldStamp /> : null}
        </div>

        <div className="mt-3 flex items-baseline justify-between gap-4 border-b border-rule pb-3">
          <p className="display text-4xl text-ink" aria-hidden="true">
            <span className="meta mr-1 align-middle">№</span>
            {codeNumber(item.code)}
          </p>
          <p className="display text-3xl text-ink">{formatPrice(item.price)}</p>
        </div>

        <div className="mt-3 space-y-2">
          <h3 className="text-base font-medium leading-snug text-ink">{item.title}</h3>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="meta meta-th">{CONDITION_LABEL[item.condition]}</span>
            <StatusTag status={item.status} />
          </div>
        </div>
      </Link>
    </article>
  );
}
