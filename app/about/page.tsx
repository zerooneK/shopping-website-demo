import type { Metadata } from "next";
import Link from "next/link";
import { splitInlineCode, type BuildLogBullet, type BuildLogEntry } from "@/lib/build-log";
import { DEMO_ORDER_RETURN_MINUTES } from "@/lib/availability";
import { getBuildLog } from "@/lib/build-log-file";
import { isDemoMode } from "@/lib/demo";

export const metadata: Metadata = {
  title: "เกี่ยวกับโปรเจกต์",
  description:
    "Case study: ร้านขายของมือสองแบบเดโมที่สร้างโดยทีม AI (Opus วางสเปคและรีวิว, Sonnet เขียนโค้ด, Haiku เขียนคอนเทนต์) พร้อมไทม์ไลน์จริงจากบันทึกการสร้าง",
};

const GITHUB_URL = "https://github.com/zerooneK/shopping-website-demo";

const TEAM = [
  {
    role: "Orchestrator",
    agent: "session หลัก",
    model: "Opus",
    effort: "medium",
    job: "อ่านแผน วางสเปค แบ่งงาน ตัดสินใจ และคุยกับผู้ใช้",
  },
  {
    role: "Builder",
    agent: "shop-builder",
    model: "Sonnet",
    effort: "medium",
    job: "เขียนโค้ดทั้งหมด: หน้าร้าน ระบบจอง หลังบ้าน ระบบรีเซ็ตรายวัน และเทสต์",
  },
  {
    role: "Reviewer",
    agent: "shop-reviewer",
    model: "Opus",
    effort: "medium (ตรวจซ้ำ: low)",
    job: "ตรวจระบบสั่งซื้อ สลิป ความปลอดภัย อ่านอย่างเดียว ไม่แก้โค้ดเอง",
  },
  {
    role: "Writer",
    agent: "shop-writer",
    model: "Haiku",
    effort: "low",
    job: "เขียนข้อมูลสินค้า ตำหนิ และคอนเทนต์สั้น",
  },
] as const;

const STACK = [
  ["Framework", "Next.js 16 (App Router, Cache Components) + TypeScript strict"],
  ["Styling", "Tailwind CSS 4 + design tokens (CSS variables) รองรับ dark mode"],
  ["Database", "Neon Postgres + Drizzle ORM (driver แบบ WebSocket สำหรับ transaction)"],
  ["Validation", "Zod ใช้ schema เดียวกันทั้ง client และ server"],
  ["ไฟล์สลิป", "Vercel Blob (client upload, ชื่อไฟล์สุ่ม และระบบไม่เก็บหรือแสดง URL ของไฟล์)"],
  ["QR", "promptpay-qr + qrcode สร้างฝั่ง server (เลขปลายทางที่ใช้จ่ายจริงไม่ได้)"],
  ["Test", "Vitest (logic + ฐานข้อมูลจริง) และ Playwright ที่ viewport 375px"],
  ["Deploy", "Vercel Hobby"],
] as const;

const LESSONS = [
  {
    title: "Reviewer จับบั๊กขายซ้ำที่เทสต์ผ่านหมดแล้ว",
    body: "ระบบจองเขียนเทสต์ผ่านครบ แต่ Reviewer อ่านแล้วเห็นว่าสินค้าที่ลูกค้าส่งสลิปแล้วอาจถูกคนอื่นจองทับได้ เพราะเทสต์เดิมตรวจหลวมเกินไป จึงเพิ่มเงื่อนไขในคำสั่ง SQL และเขียนเทสต์ที่ต่อฐานข้อมูลจริงกันซ้ำ",
  },
  {
    title: "การเลือกรูปต้องดูภาพจริง",
    body: "รอบแรก Builder เลือกรูปสินค้าจากชื่อและแท็ก ผลคือหกรูปไม่ตรงปก (เช่น ยีนส์แทนเสื้อ) แก้โดยดาวน์โหลดภาพมาดูทีละรูปก่อนเลือก และปรับชื่อสินค้าให้ตรงกับรูปที่หาได้จริง",
  },
  {
    title: "เวลาต้องใช้นาฬิกาของฐานข้อมูล",
    body: "การหมดเวลาจองตัดสินด้วย now() ของฐานข้อมูลทั้งหมด ไม่ใช้เวลาของเซิร์ฟเวอร์เว็บซึ่งเหลื่อมกันได้ ทั้งตอนจอง อัปสลิป และแสดงนับถอยหลัง",
  },
  {
    title: "อ่านเอกสารของเวอร์ชันที่ติดตั้งจริง",
    body: "Next.js เวอร์ชันนี้มีพฤติกรรมที่ต่างจากที่เคยรู้ (เช่น หน้า 404 ภายใต้ Cache Components ตอบ status 200 ถ้าไม่จัดการ) ทีมจึงอ่านเอกสารใน node_modules ก่อนเขียนและทดสอบด้วย curl กับ build จริง",
  },
] as const;

function Inline({ text }: { text: string }) {
  return (
    <>
      {splitInlineCode(text).map((part, i) =>
        part.code ? (
          <code key={i} className="font-mono text-[0.9em] break-words">
            {part.text}
          </code>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

function Bullet({ b }: { b: BuildLogBullet }) {
  return (
    <li className="leading-7">
      {b.label ? <span className="meta meta-th mr-2 text-ink">{b.label}</span> : null}
      <Inline text={b.text} />
    </li>
  );
}

function LogEntry({ entry }: { entry: BuildLogEntry }) {
  const result = entry.bullets.find((b) => b.label === "ผล");
  const rest = entry.bullets.filter((b) => b !== result);
  return (
    <li className="border-t border-rule py-6">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <time className="meta">{entry.date}</time>
        <span className="meta meta-th text-ink">ขั้น {entry.step}</span>
        <span className="text-sm text-muted">{entry.agent}</span>
      </div>
      {result ? (
        <p className="mt-3 leading-7 text-ink">
          <Inline text={result.text} />
        </p>
      ) : null}
      {rest.length > 0 ? (
        <details className="mt-2">
          <summary className="tap meta meta-th flex cursor-pointer items-center text-ink">
            รายละเอียดของขั้นนี้
          </summary>
          <ul className="mt-2 space-y-3 text-sm text-muted">
            {rest.map((b, i) => (
              <Bullet key={i} b={b} />
            ))}
          </ul>
        </details>
      ) : null}
    </li>
  );
}

export default async function AboutPage() {
  const log = await getBuildLog();
  // ข้อความ "ลองหลังบ้านได้" ต้องตรงกับค่า DEMO_MODE จริง (ปิดโหมดเดโม = ไม่มีปุ่มเดโมให้ลอง)
  const demo = isDemoMode();

  return (
    <main className="mx-auto max-w-4xl px-4 pt-10 pb-16 md:px-8 md:pt-16">
      <p className="meta">Case study</p>
      <h1 className="display text-hero mt-4">
        ร้านเดโม
        <br />
        <em className="italic">ที่ทีม AI สร้าง</em>
      </h1>
      <p className="mt-6 max-w-2xl leading-8 text-muted">
        Second Room เป็นร้านขายของมือสองแบบ <strong className="text-ink">เดโม</strong> ทำขึ้นเป็นผลงาน
        ให้เห็นว่างาน e-commerce ครบวงจรทำได้จริง ตั้งแต่หน้าร้านที่ออกแบบสำหรับมือถือ
        การจองสินค้าชิ้นเดียวโดยไม่ขายซ้ำ ไปจนถึงการแนบสลิป
        {demo
          ? " หลังบ้านสำหรับตรวจสลิปและจัดการออเดอร์ลองได้แบบเดโมที่หน้าเข้าสู่ระบบหลังบ้าน"
          : " และหลังบ้านสำหรับให้เจ้าของร้านตรวจสลิปและจัดการออเดอร์ (ตอนนี้ไม่เปิดให้ลองแบบเดโม)"}{" "}
        {" "}ส่วนจัดการสินค้า (เพิ่ม/แก้ไข/อัปโหลดรูป) ทำได้เฉพาะเจ้าของร้าน{demo ? " บัญชีเดโมดูรายการสินค้าได้อย่างเดียว" : ""}
      </p>

      <section aria-labelledby="why-demo" className="mt-14 border-t border-rule pt-8">
        <h2 id="why-demo" className="display text-4xl">
          ทำไมต้องเป็นเดโม
        </h2>
        <div className="mt-4 max-w-2xl space-y-4 leading-8">
          <p>
            ร้านนี้ <strong>ไม่รับเงินจริง</strong> QR ที่เห็นในหน้าชำระเงินมีลายน้ำ DEMO และเข้ารหัสเลขที่โอนจริงไม่ได้
            ข้อมูลที่กรอกควรเป็นข้อมูลสมมติเท่านั้น ข้อมูลรีเซ็ตทุกวัน: วันละครั้งในช่วงตี 3 เวลาไทย (บน Vercel Hobby อาจเลื่อนได้ภายในชั่วโมงนั้น) ระบบจะลบออเดอร์ทั้งหมดแล้วคืนสินค้ากลับเป็นข้อมูลตั้งต้น (ไฟล์สลิปจะถูกลบภายใน 1–2 วัน) แต่ระหว่างวันข้อมูลที่กรอกยังคงอยู่ จึงไม่ควรกรอกข้อมูลจริง
          </p>
          {demo ? (
            <p data-testid="about-demo-return">
              ออเดอร์ที่ลองกดยืนยัน (หรือจัดส่ง/ปิดงาน) ในหลังบ้านแบบเดโมไม่ใช่การขายจริง: สินค้าชิ้นนั้นจะถูกกันไว้ {DEMO_ORDER_RETURN_MINUTES} นาทีหลังกดยืนยัน แล้วระบบคืนเข้าร้านให้เองและหน้าออเดอร์จะแสดงว่า “เดโมสิ้นสุดแล้ว” ส่วนออเดอร์ที่เจ้าของร้านยืนยันเป็นการขายถาวร (เจ้าของคืนสินค้าเข้าร้านเองได้จากหลังบ้าน) ออเดอร์ที่ค้างรอตรวจสลิปจะยังกันสินค้าไว้จนกว่าจะถูกยืนยัน/ปฏิเสธ หรือถึงรอบรีเซ็ตรายวัน
            </p>
          ) : null}
          <p>
            เหตุผลหลักคือเว็บถูกวางไว้บน Vercel แผน Hobby ซึ่งอนุญาตเฉพาะการใช้งานที่ไม่ใช่เชิงพาณิชย์
            การรับเงินจริงจะทำให้ขัดเงื่อนไขนั้น จึงออกแบบให้เป็นร้านจำลองที่ลองได้ตั้งแต่เลือกสินค้า จอง จนถึงแนบสลิป{demo ? " และลองฝั่งหลังบ้านแบบเดโมได้" : ""}
            แต่ไม่มีเงินจริงไหลผ่าน
          </p>
        </div>
      </section>

      <section aria-labelledby="team" className="mt-14 border-t border-rule pt-8">
        <h2 id="team" className="display text-4xl">
          ทีม AI
        </h2>
        <p className="mt-3 max-w-2xl text-muted">
          แต่ละบทบาทใช้โมเดลและระดับความพยายาม (effort) ต่างกันตามงาน เริ่มที่ระดับกลางเสมอ
          ถ้าไม่ผ่านเทสต์หรือรีวิวจึงขยับขึ้นทีละขั้น
        </p>
        <table className="mt-6 w-full border-collapse text-left max-md:block">
          <caption className="sr-only">ตารางทีม AI พร้อมโมเดลและ effort</caption>
          <thead className="max-md:sr-only">
            <tr className="border-y border-ink">
              {["บทบาท", "Agent", "โมเดล", "Effort", "หน้าที่"].map((h) => (
                <th key={h} scope="col" className="meta meta-th py-2 pr-4 font-normal text-ink">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="max-md:block">
            {TEAM.map((m) => (
              <tr key={m.role} className="border-b border-rule align-top max-md:block max-md:py-4">
                <th scope="row" className="py-3 pr-4 font-medium max-md:block max-md:py-0 md:whitespace-nowrap">
                  {m.role}
                </th>
                <td className="py-3 pr-4 text-sm text-muted max-md:block max-md:py-0">{m.agent}</td>
                <td className="py-3 pr-4 max-md:block max-md:py-0">
                  <span className="max-md:meta max-md:meta-th md:hidden">โมเดล: </span>
                  {m.model}
                </td>
                <td className="py-3 pr-4 max-md:block max-md:py-0">
                  <span className="max-md:meta max-md:meta-th md:hidden">effort: </span>
                  {m.effort}
                </td>
                <td className="py-3 text-sm leading-7 max-md:block max-md:py-0">{m.job}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="stack" className="mt-14 border-t border-rule pt-8">
        <h2 id="stack" className="display text-4xl">
          Stack
        </h2>
        <dl className="mt-4 divide-y divide-rule border-y border-rule">
          {STACK.map(([k, v]) => (
            <div key={k} className="grid gap-1 py-3 sm:grid-cols-[10rem_1fr]">
              <dt className="meta meta-th text-ink">{k}</dt>
              <dd className="leading-7">{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="timeline" className="mt-14 border-t border-rule pt-8">
        <h2 id="timeline" className="display text-4xl">
          ไทม์ไลน์การสร้าง
        </h2>
        <p className="mt-3 max-w-2xl text-muted">
          ดึงมาจากบันทึกการสร้างจริง (<code className="font-mono text-[0.9em]">docs/BUILD_LOG.md</code>)
          ที่ทุก agent เขียนต่อท้ายหลังจบแต่ละขั้น
          {log.length > 0 ? ` ตอนนี้มี ${log.length} รายการ` : ""}
        </p>
        {log.length > 0 ? (
          <ol className="mt-6 border-b border-rule">
            {log.map((entry, i) => (
              <LogEntry key={`${entry.date}-${entry.step}-${i}`} entry={entry} />
            ))}
          </ol>
        ) : (
          <p className="mt-6 border border-rule p-4 text-muted">ยังไม่พบบันทึกการสร้างในตอน build</p>
        )}
      </section>

      <section aria-labelledby="lessons" className="mt-14 border-t border-rule pt-8">
        <h2 id="lessons" className="display text-4xl">
          บทเรียน
        </h2>
        <ul className="mt-4 grid gap-6 md:grid-cols-2">
          {LESSONS.map((l) => (
            <li key={l.title} className="border border-rule p-5">
              <h3 className="font-medium leading-snug">{l.title}</h3>
              <p className="mt-2 text-sm leading-7 text-muted">{l.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="source" className="mt-14 border-t border-rule pt-8">
        <h2 id="source" className="display text-4xl">
          ซอร์สโค้ด
        </h2>
        <p className="mt-3 max-w-2xl leading-8">
          โค้ดทั้งหมดเปิดให้ดูบน GitHub รวมถึงสเปคและบันทึกการสร้างที่ใช้ทำหน้านี้
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="tap inline-flex items-center bg-accent px-6 font-medium text-paper hover:opacity-90"
          >
            ดูโค้ดบน GitHub
          </a>
          <Link
            href="/"
            className="tap inline-flex items-center border border-ink px-6 text-ink hover:bg-ink hover:text-paper"
          >
            เดินดูร้าน
          </Link>
        </div>
      </section>
    </main>
  );
}
