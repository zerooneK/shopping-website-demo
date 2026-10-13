import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LoginForms } from "@/components/admin/LoginForms";
import { isDemoLoginAvailable, isOwnerLoginConfigured } from "@/lib/auth";
import { getSession } from "@/lib/auth-server";

// อ่าน cookie ของผู้เข้าชมทุกครั้ง — ไม่มี static shell
export const instant = false;

export const metadata: Metadata = {
  title: "เข้าสู่ระบบหลังบ้าน",
  robots: { index: false, follow: false, nocache: true },
};

export default async function AdminLoginPage() {
  // เข้าสู่ระบบอยู่แล้วไม่ต้องเห็นฟอร์มอีก
  if (await getSession()) redirect("/admin");

  return (
    <main className="mx-auto max-w-md px-4 pt-10 pb-16 md:px-8 md:pt-16">
      <p className="meta">Back office</p>
      <h1 className="display mt-2 text-display">หลังบ้าน</h1>
      <p className="mt-3 text-muted">ตรวจสลิปและจัดการออเดอร์ของ Second Room</p>
      <div className="mt-10">
        <LoginForms ownerEnabled={isOwnerLoginConfigured()} demoEnabled={isDemoLoginAvailable()} />
      </div>
    </main>
  );
}
