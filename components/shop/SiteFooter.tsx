import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t border-rule">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 pt-10 pb-28 md:flex-row md:items-end md:justify-between md:px-8 md:pb-10">
        <div>
          <p className="display text-3xl">Second Room</p>
          <p className="mt-1 text-sm text-muted">ของจากอีกห้องหนึ่ง — ร้านเดโมสำหรับผลงาน ไม่มีการขายจริง</p>
        </div>
        <nav aria-label="ลิงก์ท้ายหน้า" className="flex gap-6">
          <Link href="/about" className="tap meta meta-th inline-flex items-center text-ink underline underline-offset-4">
            เกี่ยวกับโปรเจกต์
          </Link>
          <Link href="/privacy" className="tap meta meta-th inline-flex items-center text-ink underline underline-offset-4">
            ความเป็นส่วนตัว
          </Link>
        </nav>
      </div>
    </footer>
  );
}
