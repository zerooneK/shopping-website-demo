import { listItems } from "@/lib/items";
import { CATEGORY_LABEL, parseCategory } from "@/lib/labels";
import { CategoryNav } from "./CategoryNav";
import { ItemCard } from "./ItemCard";

// ลายกริดแบบนิตยสาร (desktop 12 คอลัมน์): ขนาดการ์ดสลับ + เยื้องแนวตั้งต่างกัน
// (ต้องเป็น class เต็มๆ เพื่อให้ Tailwind สแกนเจอ)
const SPANS = [
  "lg:col-span-5",
  "lg:col-span-4",
  "lg:col-span-3",
  "lg:col-span-4",
  "lg:col-span-3",
  "lg:col-span-5",
];
const OFFSETS = ["", "lg:mt-16", "lg:mt-6", "lg:mt-10", "lg:mt-24", ""];

type SP = Promise<{ [key: string]: string | string[] | undefined }>;

/** ส่วนที่ขึ้นกับ searchParams + สถานะสด → dynamic ห่อด้วย Suspense ที่หน้าแรก */
export async function Catalog({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const category = parseCategory(sp.category);
  const notFoundRaw = sp.notfound;
  const missed = (Array.isArray(notFoundRaw) ? notFoundRaw[0] : notFoundRaw)?.slice(0, 40);

  const items = await listItems(category);

  return (
    <>
      {missed ? (
        <p
          role="status"
          className="mt-8 border border-ink p-4 text-ink"
        >
          ยังไม่พบสินค้ารหัส “{missed}” ลองพิมพ์เป็นตัวเลข เช่น 012 หรือ #12 แล้วค้นหาอีกครั้ง
          หรือเลือกดูจากรายการด้านล่างได้เลย
        </p>
      ) : null}

      <div className="mt-2 sm:mt-8">
        <CategoryNav active={category} />
      </div>

      <p className="meta meta-th mt-3 sm:mt-6" aria-live="polite">
        {category ? CATEGORY_LABEL[category] : "ทั้งหมด"} · {items.length} ชิ้น
      </p>

      {items.length === 0 ? (
        <p className="mt-10 text-muted">ตอนนี้ยังไม่มีสินค้าในหมวดนี้ ลองดูหมวดอื่นก่อนนะ</p>
      ) : (
        <ul className="mt-3 grid grid-cols-1 gap-x-8 sm:mt-6 gap-y-12 sm:grid-cols-2 lg:grid-cols-12 lg:items-start">
          {items.map((item, i) => (
            <li key={item.code} className={`${SPANS[i % SPANS.length]} ${OFFSETS[i % OFFSETS.length]}`}>
              <ItemCard item={item} eager={i < 2} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function CatalogSkeleton() {
  return (
    <div aria-busy="true" aria-label="กำลังโหลดรายการสินค้า">
      <div className="mt-8 h-11 border border-rule" />
      <ul className="mt-12 grid grid-cols-1 gap-x-8 gap-y-12 sm:grid-cols-2 lg:grid-cols-12">
        {[0, 1, 2].map((i) => (
          <li key={i} className={SPANS[i]}>
            <div className="aspect-[4/5] border border-rule bg-rule/40" />
          </li>
        ))}
      </ul>
    </div>
  );
}
