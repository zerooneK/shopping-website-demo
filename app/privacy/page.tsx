import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "ความเป็นส่วนตัว",
  description: "ร้านนี้เป็นเดโม: เก็บข้อมูลอะไร นานแค่ไหน และทำไมไม่ควรกรอกข้อมูลจริง",
};

const SECTIONS = [
  {
    id: "collect",
    title: "เก็บข้อมูลอะไรบ้าง",
    items: [
      "ข้อมูลที่คุณกรอกในฟอร์มสั่งซื้อ: ชื่อ เบอร์โทร วิธีรับของ ที่อยู่ (เมื่อเลือกส่งไปรษณีย์) และหมายเหตุ",
      "รูปสลิปที่คุณอัปโหลด (ถ้าเลือกอัปโหลดเอง) หรือการเลือกใช้สลิปตัวอย่าง",
      "ประวัติสถานะของออเดอร์ เช่น เวลาที่จอง ส่งสลิป ยืนยัน หรือยกเลิก",
      "ค่า hash แบบทางเดียวของที่อยู่ IP (ไม่เก็บ IP ดิบ) ใช้จำกัดจำนวนออเดอร์ต่อการเชื่อมต่อ เพื่อกันการกดจองรัวๆ",
      "คุกกี้ demo_sid ค่าสุ่มที่ใช้แยกว่าเบราว์เซอร์ไหนสร้างออเดอร์ เพื่อจำกัดจำนวนออเดอร์ที่ค้างและกันการกดจองรัวๆ ไม่ได้ใช้ติดตามการเข้าชมหรือโฆษณา",
    ],
  },
  {
    id: "why",
    title: "เก็บไปทำไม",
    items: [
      "เพื่อให้ flow สั่งซื้อทำงานครบให้ดูเป็นตัวอย่างผลงาน: จอง ชำระเงิน (จำลอง) ตรวจสลิป และติดตามสถานะ",
      "ไม่มีการเรียกเก็บเงินจริง ไม่ส่งข้อมูลไปขายหรือใช้การตลาด",
    ],
  },
  {
    id: "keep",
    title: "เก็บนานแค่ไหน",
    items: [
      "ร้านนี้เป็นเดโม และออกแบบให้ล้างข้อมูลทดลองเป็นระยะ แต่ตอนนี้ยังไม่มีระบบล้างอัตโนมัติ — ข้อมูลที่กรอกอาจคงอยู่จนกว่าจะมีการล้างหรือลบ จึงไม่ควรกรอกข้อมูลจริง",
      "คุกกี้ demo_sid มีอายุไม่เกิน 7 วัน และลบได้เองจากการตั้งค่าเบราว์เซอร์",
    ],
  },
  {
    id: "who",
    title: "ใครเห็นข้อมูลของคุณ",
    items: [
      "ลิงก์ติดตามออเดอร์เป็นลิงก์ลับเฉพาะคุณ ใครมีลิงก์นี้จะเห็นสถานะออเดอร์ได้ จึงไม่ควรแชร์ต่อ",
      "ผู้ดูแลร้านเห็นข้อมูลออเดอร์ได้ (ผู้ที่ลองหลังบ้านแบบเดโมจะเห็นแบบปิดบางส่วนในอนาคต แต่ตอนนี้ยังไม่มีหลังบ้านเปิดใช้งาน)",
      "ระบบใช้ผู้ให้บริการภายนอกเพื่อทำงาน ได้แก่ Vercel (โฮสต์และที่เก็บไฟล์สลิป) และ Neon (ฐานข้อมูล) รูปสินค้าเดโมมาจาก Unsplash",
    ],
  },
] as const;

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 pt-10 pb-16 md:px-8 md:pt-16">
      <p className="meta">Privacy</p>
      <h1 className="display text-display mt-4">ความเป็นส่วนตัว</h1>

      <div role="note" className="mt-6 border border-ink border-l-8 p-5">
        <p className="font-medium leading-8">
          นี่คือร้านเดโม <strong>กรุณาอย่าใส่ข้อมูลจริง</strong> ใช้ชื่อ เบอร์โทร และที่อยู่สมมติเท่านั้น
          ในฟอร์มมีปุ่ม “กรอกข้อมูลตัวอย่าง” ให้ใช้ได้เลย และอย่าอัปโหลดสลิปหรือรูปที่มีข้อมูลส่วนตัวจริง
        </p>
      </div>

      {SECTIONS.map((s) => (
        <section key={s.id} aria-labelledby={s.id} className="mt-10 border-t border-rule pt-6">
          <h2 id={s.id} className="display text-3xl">
            {s.title}
          </h2>
          <ul className="mt-3 list-disc space-y-2 pl-5 leading-8">
            {s.items.map((it) => (
              <li key={it}>{it}</li>
            ))}
          </ul>
        </section>
      ))}

      <section aria-labelledby="rights" className="mt-10 border-t border-rule pt-6">
        <h2 id="rights" className="display text-3xl">
          ขอให้ลบข้อมูล
        </h2>
        <p className="mt-3 leading-8">
          ถ้าเผลอกรอกข้อมูลจริง ให้แจ้งผ่านหน้าโปรเจกต์บน GitHub
          ที่ลิงก์ในหน้า{" "}
          <Link href="/about" className="underline underline-offset-4">
            เกี่ยวกับโปรเจกต์
          </Link>{" "}
          เพื่อให้ลบข้อมูลให้
        </p>
        <Link
          href="/"
          className="tap mt-6 inline-flex items-center border border-ink px-6 text-ink hover:bg-ink hover:text-paper"
        >
          กลับหน้าร้าน
        </Link>
      </section>
    </main>
  );
}
