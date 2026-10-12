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
