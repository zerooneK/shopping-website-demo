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
