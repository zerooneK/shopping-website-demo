# Build Log

บันทึกการทำงานของทีม AI ทีละขั้น (ใช้เป็นข้อมูลหน้า `/about`) — รูปแบบดู `CLAUDE.md`

## 2026-10-12 · ขั้น 2 · orchestrator (Opus 5.5 · medium)
- งาน: อ่านแผนใน Notion, วิเคราะห์ช่องว่าง, ตรวจเงื่อนไข Vercel Hobby (ต้องเป็น non-commercial → ปรับเป็นเว็บเดโม), เขียน `SPEC.md`, ตั้งทีม sub-agent (`shop-builder`, `shop-reviewer`, `shop-writer`)
- ผล: ผู้ใช้อนุมัติ SPEC
- ปัญหาที่เจอ / การ escalate: เลือก Neon แทน Supabase เพราะ Supabase แผนฟรีพักโปรเจกต์เมื่อไม่มีการใช้งาน

## 2026-10-12 · ขั้น 3a · shop-builder (sonnet · medium)
- งาน: scaffold Next.js 16 (App Router) + TS strict + Tailwind 4 ลง shop-website, ติดตั้ง deps ตาม SPEC §2 (drizzle-orm, @neondatabase/serverless, drizzle-kit, zod, jose, @vercel/blob, promptpay-qr, qrcode, vitest, tsx), `db/schema.ts` + `db/client.ts` + `drizzle.config.ts` + migration แรก + `db/seed.ts`/`seed-data.json` (2 รายการชั่วคราว), `lib/orders/transition.ts`, `lib/reserve.ts` (logic แยกจาก DB ผ่าน interface ReserveStore + ตัว Drizzle จริง), `lib/validation.ts`, `lib/promptpay.ts`, scripts lint/typecheck/test/build, `.env.example`, `git init` (ไม่ push)
- ผล: ผ่าน (npm run lint, typecheck, test = 95 tests, build) · ส่วน SQL จริงของ reserve (UPDATE ... RETURNING บน Neon), seed และ migration ยังไม่ได้ทดสอบกับ DB จริง
- ปัญหาที่เจอ / การ escalate: ไม่มีการ escalate · ต้องยก @types/node เป็น ^24 เพราะ vitest 5 ขัด peer dep กับ ^20 · .gitignore ของ scaffold ซ่อน .env* จึงเพิ่ม !.env.example

## 2026-10-12 · ขั้น 3a-fix · shop-builder (sonnet · medium)
- งาน: แก้ผลรีวิว 3a — [High] claimItem เพิ่ม AND NOT EXISTS (ออเดอร์ awaiting_review/confirmed/shipped/completed หรือ pending_payment ที่ expires_at >= now()) กันแย่งสินค้าที่จ่ายแล้ว + transition() คืน `clearReservedUntil: true` สำหรับ upload_slip (สัญญา: handler 3c ต้องล้าง items.reserved_until เป็น NULL ใน tx เดียวกับการอัปเดตออเดอร์ บันทึกใน ReserveTx) · [Medium] SQL ใช้ now() ของ DB ทั้งหมด (reserved_until = now()+make_interval(mins), reserved_until < now(), expires_at < now(), updated_at = now()), RETURNING id, price, reserved_until แล้วใช้เป็น expiresAt; ตัด now/until ออกจาก ReserveTx/ReserveOptions, in-memory store มีนาฬิกาในตัว · [Low] ขอบเวลา: ใช้ strict ตาม SPEC (หมดอายุเมื่อ now > expiresAt) ทั้ง transition() และ SQL + เทสต์เทียบ bulk expire กับ transition(expire) ที่ -1/0/+1ms · [Low] rollback ของ in-memory store ย้อนเฉพาะ write log ของ tx นั้น
- ผล: ผ่าน (npm run lint, typecheck, test = 105 tests, build) · SQL จริง (NOT EXISTS, make_interval, RETURNING reserved_until, การแปลงชนิดของ reserved_until จาก driver) ยังไม่ได้ทดสอบกับ DB จริง
- ปัญหาที่เจอ / การ escalate: ไม่มี · เปลี่ยนขอบเวลา upload_slip ที่ now == expiresAt จาก "ปิดแล้ว" เป็น "ยังอัปได้" เพื่อให้ตรง SPEC (< now())

## 2026-10-12 · ขั้น 3a-review · shop-reviewer (opus · medium → low)
- งาน: รีวิวระบบจอง/state machine ของขั้น 3a แล้วตรวจซ้ำหลังแก้
- ผล: รอบแรก FAIL (1 High, 1 Medium, 2 Low) → รอบสอง (low) PASS · 105 tests
- ปัญหาที่เจอ: High = `claimItem` จองทับสินค้าที่ออเดอร์ `awaiting_review` ถืออยู่ได้ (ขายซ้ำ) เพราะเทสต์เดิม assert หลวม · แก้ด้วย `NOT EXISTS` + ล้าง `reserved_until` ตอนอัปสลิป + ใช้ `now()` ของ DB
- ข้อจำกัด: SQL จริงยังไม่ได้ทดสอบกับ Postgres/Neon ต้องทำ integration test ก่อน deploy · handler อัปสลิป (3c) ต้องล้าง `reserved_until` ตามสัญญา

## 2026-10-12 · ขั้น 3a-integration · shop-builder (sonnet · medium)
- งาน: เพิ่ม integration test กับ Postgres (Neon) จริง `tests/integration/reserve.pg.test.ts` + `vitest.integration.config.mts` + script `npm run test:integration` (โหลด .env.local ผ่าน `node --env-file`, ไม่รวมใน `npm test`, skip พร้อมข้อความถ้าไม่มี DATABASE_URL) · ใช้ createDrizzleReserveStore + getDb ตัวจริง · ข้อมูลทดสอบใช้รหัส T901-T999 ลบเฉพาะของตัวเองก่อน/หลังรัน · ครอบคลุม: (a) จองพร้อมกัน 20 ราย สำเร็จ 1 (b) สถานการณ์ X/Y หลังอัปสลิป ทั้ง reserved_until อดีตและ NULL (c) lazy expiry + event (d) confirmed/shipped/completed ไม่ถูกจองทับ (e) now()+15 นาที และ expires_at == reserved_until (f) rollback เมื่อ UNIQUE token ล้ม รวม lazy expiry ถูกย้อน
- ผล: ผ่าน (test:integration = 9 tests บน Neon จริง, lint, typecheck, test = 105, build) · ตรวจแล้วไม่มีแถว T9xx ค้าง และ seed เดิมยังอยู่
- ปัญหาที่เจอ / การ escalate: ไม่พบบั๊กใน lib/reserve.ts · ข้อจำกัด: ยังไม่ได้ทดสอบ handler อัปสลิป (3c) และ cron

## 2026-10-12 · ขั้น 4b · shop-builder (sonnet · medium)
- งาน: ใส่รูปจริงจาก Unsplash (free ไม่ใช่ Unsplash+) ให้สินค้าเดโม A001-A012 ชิ้นละ 3 รูปใน `db/seed-data.json` พร้อม alt ภาษาไทยและ credit ช่างภาพ · ลบ field `_imageQuery` · ไม่มี URL ซ้ำ (36 รูป) · ตรวจทุก URL ด้วย curl ได้ 200 image/* ครบ 36/36
- ผล: ผ่าน (`npm run db:seed` = seeded 12 items, `npm test` = 105 tests)
- ปัญหาที่เจอ / การ escalate: A002 ไม่พบรูปเสื้อลินินลายทางแบบไม่มีคนที่ตรงเป๊ะ ใช้เสื้อเชิ้ต/เสื้อลายทางใกล้เคียง · A005 รูปที่ 3 เป็นตะเกียงทองเหลือง (ไม่ใช่โคมตั้งโต๊ะ) · A003 รูปกล้องเป็นกล้องฟิล์มวินเทจทั่วไป ไม่ใช่คอมแพกต์โดยเฉพาะ · A004 รูปที่ 3 เป็นกองหนังสือ/ห้องสมุดทั่วไป

## 2026-10-12 · ขั้น 4b-fix2 · shop-builder (sonnet · medium)
- งาน: แทนที่รูปเดโมไม่ตรงปก 6 รูปใน `db/seed-data.json` (เฉพาะ field images) — A002 รูปที่ 2-3, A004 รูปที่ 3, A005 รูปที่ 3, A010 รูปที่ 2-3 · คราวนี้ค้นผู้สมัครจาก Unsplash แล้วดาวน์โหลดภาพตัวอย่างมาดูจริงทุกรูป (contact sheet + ภาพขยาย) ก่อนเลือก · alt/credit ตรงกับภาพที่เห็น
- ผล: ผ่าน (JSON parse ได้ 12 ชิ้น × 3 รูป, URL ไม่ซ้ำ 36/36, curl 200 image/jpeg ครบ 6 รูปใหม่, `npm run db:seed` = seeded 12 items, `npm test` = 105 tests)
- ปัญหาที่เจอ: ไม่พบเสื้อเชิ้ตลายทางแบบวางพับ/แขวนที่ไม่มีคน จึงใช้เสื้อลินินสีเรียบแทน (A002) · A004 รูปใหม่มีกล้องฟิล์มเป็นส่วนประกอบฉาก

## 2026-10-12 · ขั้น 4 · orchestrator (sonnet) + shop-writer (haiku · low) + shop-builder (sonnet · medium)
- งาน: Writer เขียนข้อมูลสินค้า 12 ชิ้น · Builder หารูป Unsplash 36 รูป (ตรวจ URL ด้วย curl 200) · orchestrator ดูรูปจริงทั้งหมด
- ผล: ผ่าน · seed 12 ชิ้นขึ้น Neon · 105 unit tests
- ปัญหาที่เจอ: รอบแรก Builder เลือกรูปจากชื่อ/แท็กโดยไม่ได้ดูภาพ → 6 รูปไม่ตรงปก (ยีนส์แทนเสื้อ, ห้องสมุดแทนหนังสือ, แก้วมีสโลแกน ฯลฯ) → ส่งกลับให้ดูภาพจริงก่อนเลือก · หารูปเสื้อลายทางไม่ได้ จึงแก้ชื่อ/คำบรรยาย A002 ให้ตรงกับรูป และปรับ A003 เป็น "กล้องฟิล์มวินเทจ" เพราะรูปเป็น Rolleiflex
- บทเรียน: งานเลือกรูปต้องมี step ดูภาพจริง ไม่เชื่อชื่อ/แท็ก

## 2026-10-13 · ขั้น 3b-1 · shop-builder (sonnet · medium)
- งาน: ระบบดีไซน์ (tokens light/dark ผูก Tailwind 4, ฟอนต์ 4 ตัวผ่าน next/font, focus ring, reduced-motion, ไม่มีมุมโค้ง/เงา) · layout หลัก (แถบเดโม, header+ค้นหารหัส, footer, not-found, metadata ไทย) · `lib/items.ts` (server-only) + `lib/availability.ts` (นิยาม "ออเดอร์ถือสินค้า" ร่วมกับ claimItem ใน reserve.ts) · หน้าแรก (hero, กรองหมวด, grid แบบนิตยสาร, การ์ด, SOLD/จองอยู่) · `/item/[code]` (gallery scroll-snap, ตำหนิแยกบล็อก, เครดิตภาพ, CTA sticky + นับถอยหลัง, generateMetadata/OG) · `/search` route handler (normalize รหัส → 307) · `proxy.ts` ตอบ 404 จริงให้รหัสที่ไม่มี · SafeImage (onError → รูปสำรอง) · เพิ่ม unit test 8 ข้อ (availability + labels)
- caching: เนื้อหาสินค้า `'use cache'` + tag "items" (revalidate 5 นาที); สถานะ available/reserved/sold อ่านสดทุก request (connection() + now() ของ DB) · หน้า `/item/[code]` ตั้ง `instant = false` (blocking) เพราะต้อง await params ก่อน stream
- ผล: ผ่าน (lint, typecheck, test, test:integration, build) · ตรวจ curl บน `next start`: `/` และ `/item/A001` = 200 มีข้อมูลจริง, `/item/Z999` = 404, ค้นหา `#12` → 307 /item/A012 · ปรับสถานะใน Neon ชั่วคราว (sold/reserved+นับถอยหลัง/reserved หมดเวลาไม่มีออเดอร์=ว่าง/reserved หมดเวลามีออเดอร์รอสลิป=ยังจอง/hidden=404) แล้วคืนด้วย db:seed · ดูด้วยตาที่ 375px/1280px ทั้ง dark/light ไม่มี horizontal scroll
- ปัญหาที่เจอ / การ escalate: ภายใต้ Cache Components `notFound()` ในหน้าคืน status 200 (+noindex) เพราะ shell ถูกส่งก่อน จึงเพิ่ม proxy.ts ตรวจรหัสก่อน render · ต้องเพิ่ม `.env.local` ให้มี DEMO_MODE=true เพื่อแสดงแถบเดโม · หลังบ้าน (3c) ต้องเรียก revalidateTag("items") หลังแก้สินค้า

## 2026-10-13 · ขั้น 3b-1 · orchestrator ตรวจรับ
- ตรวจเอง: unit 113 · integration 9/9 (Neon จริง) · lint · typecheck · ดูหน้าในเบราว์เซอร์ที่ 1280px และ 375px (ไม่มี horizontal scroll)
- ข้อสังเกตที่ต้องแก้ใน 3b-2: บนมือถือมีช่องค้นหารหัสซ้อน 2 ช่อง (header + hero) ดันสินค้าตกจอแรก · ลิงก์เครดิตช่างภาพสูง 23px (< 44px) · Next dev indicator ซ้อนปุ่ม CTA (เฉพาะ dev)
- หมายเหตุ: Builder ดึง NOT EXISTS ของ claimItem ไปเป็น `holdingOrderExistsSql` ให้หน้าเว็บกับระบบจองใช้นิยามเดียวกัน (SQL เท่าเดิม integration ผ่าน) · proxy.ts ทำหน้าที่คืน 404 จริงให้ /item/[code] ภายใต้ Cache Components — 3c ถ้าจะทำ auth ด้วย proxy ต้องรวมไฟล์เดียวกัน
