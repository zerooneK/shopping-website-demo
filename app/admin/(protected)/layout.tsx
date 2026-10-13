import type { Metadata } from "next";
import Link from "next/link";
import { logoutAction } from "@/app/admin/login/actions";
import { requireSession } from "@/lib/auth-server";

export const instant = false;

export const metadata: Metadata = {
  title: { default: "หลังบ้าน", template: "%s · หลังบ้าน" },
  robots: { index: false, follow: false, nocache: true },
};

/**
 * เฟรมหลังบ้าน + ตรวจ session ซ้ำฝั่ง server (ชั้นที่ 2 ต่อจาก proxy.ts)
 * layout ไม่ render ซ้ำเมื่อนำทางในเซกเมนต์เดียวกัน จึงต้องให้ทุกหน้าใต้นี้เรียก requireSession() เองด้วย
 */
export default async function AdminProtectedLayout({ children }: LayoutProps<"/admin">) {
  const session = await requireSession();
  return (
    <>
      <nav
        aria-label="เมนูหลังบ้าน"
        className="border-b border-rule bg-paper"
      >
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-4 px-4 md:px-8">
          <div className="flex items-center gap-4">
            <Link href="/admin" className="tap meta meta-th inline-flex items-center text-ink">
              หลังบ้าน · ออเดอร์
            </Link>
            <span
              className={`meta meta-th border px-2 py-0.5 ${
                session.role === "owner" ? "border-ink text-ink" : "border-accent text-accent"
              }`}
              data-testid="admin-role"
              data-role={session.role}
            >
              {session.role === "owner" ? "เจ้าของร้าน" : "โหมดเดโม"}
            </span>
          </div>
          <form action={logoutAction}>
            <button
              type="submit"
              className="tap meta meta-th text-ink underline underline-offset-4"
            >
              ออกจากระบบ
            </button>
          </form>
        </div>
      </nav>
      {children}
    </>
  );
}
