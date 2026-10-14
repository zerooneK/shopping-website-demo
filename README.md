This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## รีเซ็ตข้อมูลรายวัน (Vercel Cron)

ร้านนี้เป็นเดโม จึงมี cron ที่คืนร้านกลับสู่ข้อมูลตั้งต้นทุกวัน (`vercel.json` → `GET /api/cron/reset`)

- **เวลา:** `0 20 * * *` (UTC) = **03:00 เวลาไทย** วันละครั้ง
- **ข้อจำกัดของแผน Hobby:** cron รันได้ **วันละครั้งเท่านั้น** (ตั้งถี่กว่านี้ deploy จะไม่ผ่าน) และ Vercel อาจเรียกเมื่อไรก็ได้ภายใน "ชั่วโมง" ที่ระบุ (03:00–03:59 เวลาไทย) ไม่ใช่ตรงนาที และการเรียกเป็นแบบ best-effort อาจซ้ำหรือพลาดบางครั้ง — โค้ดจึงออกแบบให้รันซ้ำได้ปลอดภัย (advisory lock + ผลลัพธ์เดิมทุกครั้ง)
- **ต้องตั้ง `CRON_SECRET`** (สุ่มอย่างน้อย 16 ตัวอักษร) ใน Vercel ทั้ง Production/Preview — Vercel จะส่ง `Authorization: Bearer <CRON_SECRET>` ให้เองตอนเรียก cron ถ้าไม่ตั้งค่า endpoint จะปฏิเสธทุกคำขอ (fail-closed)
- **สิ่งที่ถูกรีเซ็ต:** ลบออเดอร์และประวัติสถานะทั้งหมด (รวมค่า hash ของ IP), ลบไฟล์สลิปใน Vercel Blob ใต้ `slips/` ทั้งหมด (ไม่แตะ `items/`), คืนสินค้าเป็นข้อมูลใน `db/seed-data.json` (**สินค้าที่เจ้าของเพิ่มเองผ่านหลังบ้านจะถูกลบด้วย** — ถ้าอยากให้อยู่ถาวรให้เพิ่มลงใน `db/seed-data.json`) แล้วสุ่ม 2–3 ชิ้นเป็นขายแล้ว
- **ทดลองในเครื่อง:** `curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/reset` — ⚠️ จะล้างออเดอร์ทั้งหมดใน DB ที่ `DATABASE_URL` ชี้อยู่จริง (เทสต์อัตโนมัติใช้ schema ชั่วคราวแยกต่างหาก ไม่เรียกของจริง)
- ถ้าไม่มี `BLOB_READ_WRITE_TOKEN` (dev) จะข้ามขั้นลบไฟล์สลิปพร้อม log และไม่ล้ม

### เช็กก่อน deploy

แถบเดโม/หน้า about/privacy บอกผู้ใช้ว่า "ข้อมูลรีเซ็ตทุกวัน" ตายตัว (ไม่ผูกกับเงื่อนไข) จึงต้องแน่ใจว่า cron ทำงานจริงก่อนเปิดใช้:

1. ตั้ง **`CRON_SECRET`** (สุ่ม >= 16 ตัวอักษร) ใน Vercel ทั้ง Production และ Preview — ไม่ตั้ง = cron ถูกปฏิเสธทุกครั้ง (401) และข้อมูลไม่เคยรีเซ็ต
2. ตั้ง **`BLOB_READ_WRITE_TOKEN`** (เชื่อม Blob store แบบ private) — ไม่ตั้ง = cron ข้ามขั้นลบสลิป (log `no_blob_token`) ไฟล์สลิปจะค้างอยู่ใน Blob
3. หลัง deploy ตรวจ **log ของ cron รอบแรก** (Vercel → Logs / Cron Jobs) ว่าตอบ `status: "ran"` และมี `blob.deleted` (จำนวนไฟล์สลิปที่ลบ; 0 ได้ถ้าไม่มีสลิป) — ถ้าเป็น `skipped_locked` ซ้ำๆ, `db_reset_blob_failed` หรือ 401/500 ให้แก้ก่อน เพราะข้อความบนเว็บอ้างว่ารีเซ็ตทุกวัน

## ออเดอร์เดโมคืนสินค้าเอง และการคืนสินค้าโดยเจ้าของร้าน

ปุ่ม "ลองหลังบ้านแบบเดโม" ทำให้ใครก็กดยืนยันออเดอร์ของตัวเองได้ ถ้าการยืนยันนั้นขายสินค้าถาวร ผู้ชมไม่กี่คนก็ทำให้ทั้งร้านหมดได้ จึงแยกตามว่า **ใครกดยืนยัน** (`orders.confirmed_by_role` = `owner` | `demo`, migration `0002`):

- **owner ยืนยัน** = ขายถาวร (สินค้า `sold`) ไม่คืนเอง — เจ้าของคืนสินค้าเข้าร้านเองได้จากหน้าออเดอร์หลังบ้านด้วยปุ่ม "คืนสินค้าเข้าร้าน" (ต้องใส่เหตุผล; ใช้ได้กับ `confirmed`/`shipped`/`completed`)
- **demo ยืนยัน** = ออเดอร์ทดลอง: สินค้าถูกกัน (`reserved`) ถึง `confirmed_at + 20 นาที` (`DEMO_ORDER_RETURN_MINUTES` ใน `lib/availability.ts`) แล้วคืนเป็นว่างเอง ตัดสินแบบ lazy ด้วย `now()` ของ DB (ไม่มี cron เพิ่ม) หน้าออเดอร์/หลังบ้านจะแสดง "เดโมสิ้นสุดแล้ว" และนับในแท็บ "ปิดแล้ว"
- ระหว่าง 20 นาที ออเดอร์เดโมที่ยืนยันแล้วนับรวมในเพดาน "ถือสินค้าต่อ IP" (≤ 3) ด้วย
- นิยามว่าใครถือสินค้าอยู่มีที่เดียว: `lib/availability.ts` (`holdingOrderExistsSql`)

## ย้ายฐานข้อมูล (migration 0002)

เพิ่มคอลัมน์ `orders.confirmed_by_role` (nullable + CHECK) — additive ไม่ลบ/แก้ข้อมูลเดิม ออเดอร์ที่ยืนยันก่อนมีคอลัมน์ (NULL) ถือเป็นขายถาวร ฐานข้อมูลของโปรเจกต์นี้สร้างด้วย `npm run db:push` (ไม่มีตาราง migration history) จึงใช้ `npm run db:push` กับ Neon เดิมได้ (จะเห็นเพียง `ALTER TABLE ... ADD COLUMN` + `ADD CONSTRAINT`) หรือรันไฟล์ `db/migrations/0002_*.sql` ตรงๆ — ต้องทำก่อนรันแอปเวอร์ชันนี้ ไม่งั้นทุก query ของ orders ล้ม

## รูปสินค้า

เจ้าของร้านอัปโหลดรูปที่ `/admin/items/[id]` (Vercel Blob client upload → `items/`) Blob store ที่ใช้เก็บสลิปเป็นแบบ private (ระดับ access เป็นของ store ไม่ใช่รายไฟล์) รูปสินค้าจึงอยู่ใน store เดียวกันและถูกเสิร์ฟสาธารณะผ่าน `GET /api/item-images/<ชื่อไฟล์>` ซึ่งอ่านได้เฉพาะ `items/` ส่วนบัญชีเดโมอัปโหลด/ลบรูปและแก้สินค้าไม่ได้
