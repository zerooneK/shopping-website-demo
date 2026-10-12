import Link from "next/link";
import { SearchForm } from "@/components/shop/SearchForm";

export default function NotFound() {
  return (
    <main className="mx-auto max-w-7xl px-4 py-16 md:px-8 md:py-24">
      <p className="meta">Error 404</p>
      <h1 className="display text-hero mt-4">
        ห้องนี้ยัง
        <br />
        <em className="italic">ไม่มีอะไร</em>
      </h1>
      <p className="mt-6 max-w-md leading-8 text-muted">
        หน้าที่คุณหาอาจถูกย้าย หรือสินค้าชิ้นนั้นถูกเก็บออกจากร้านไปแล้ว
        ลองค้นหาด้วยรหัสสินค้า หรือกลับไปเดินดูของชิ้นอื่นก่อนก็ได้
      </p>
      <div className="mt-8 max-w-sm">
        <SearchForm id="notfound-search" />
      </div>
      <Link
        href="/"
        className="tap mt-6 inline-flex items-center bg-accent px-6 text-paper font-medium hover:opacity-90"
      >
        กลับหน้าแรก
      </Link>
    </main>
  );
}
