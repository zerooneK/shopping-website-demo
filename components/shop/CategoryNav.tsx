import Link from "next/link";
import type { ItemCategory } from "@/lib/items-types";
import { CATEGORIES, CATEGORY_LABEL } from "@/lib/labels";

export function CategoryNav({ active }: { active?: ItemCategory }) {
  const tabs: { key: ItemCategory | "all"; label: string; href: string }[] = [
    { key: "all", label: "ทั้งหมด", href: "/#shop" },
    ...CATEGORIES.map((c) => ({
      key: c,
      label: CATEGORY_LABEL[c],
      href: `/?category=${c}#shop`,
    })),
  ];
  return (
    <nav aria-label="หมวดสินค้า" className="-mx-4 overflow-x-auto px-4 no-scrollbar md:mx-0 md:px-0">
      <ul className="flex min-w-max gap-2">
        {tabs.map((t) => {
          const isActive = (active ?? "all") === t.key;
          return (
            <li key={t.key}>
              <Link
                href={t.href}
                scroll={false}
                aria-current={isActive ? "page" : undefined}
                className={`tap meta meta-th inline-flex items-center border px-4 ${
                  isActive ? "border-ink bg-ink text-paper" : "border-rule text-ink hover:border-ink"
                }`}
              >
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
