import { Suspense } from "react";
import { Catalog, CatalogSkeleton } from "@/components/shop/Catalog";
import { SearchForm } from "@/components/shop/SearchForm";

export default function Home({ searchParams }: PageProps<"/">) {
  return (
    <main className="mx-auto max-w-7xl px-4 md:px-8">
      {/* Hero (static shell) */}
      <section className="border-b border-rule pt-10 pb-10 md:pt-16 md:pb-14" aria-labelledby="hero-title">
        <p className="meta">Second Room · Vol. 01</p>
        <h1 id="hero-title" className="display text-hero mt-4 text-ink">
          ของจาก
          <br />
          <em className="italic">อีกห้องหนึ่ง</em>
        </h1>
        <div className="mt-8 grid gap-6 md:grid-cols-12">
          <p className="max-w-xl leading-8 text-muted md:col-span-6">
            ของมือสองที่คัดมาทีละชิ้น ถ่ายรูปจริง บอกตำหนิตรงๆ ทุกชิ้น
            เห็นรหัสในคลิปแล้วพิมพ์ค้นหาได้เลย สั่งได้ทีละชิ้น ชิ้นไหนมีคนจองแล้วก็จะบอกให้รู้
          </p>
          <div className="md:col-span-4 md:col-start-9">
            <p className="meta meta-th mb-2">รู้รหัสจากคลิป?</p>
            <SearchForm id="hero-search" />
            <p className="mt-2 text-sm text-muted">พิมพ์ 012, A012 หรือ #12 ก็ได้</p>
          </div>
        </div>
      </section>

      <section id="shop" className="scroll-mt-4 pt-10" aria-label="รายการสินค้า">
        <Suspense fallback={<CatalogSkeleton />}>
          <Catalog searchParams={searchParams} />
        </Suspense>
      </section>
    </main>
  );
}
