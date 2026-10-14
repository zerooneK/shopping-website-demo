# SPEC — ร้านขายของมือสอง (Showcase Demo)

> สถานะ: **ร่าง รออนุมัติ** · ผู้เขียน: Opus 5.5 (Reviewer/Architect) · 2026-10-12
> แผนต้นทาง: Notion "แผนสร้างร้านขายของมือสอง ด้วย AI Team"

---

## 1. เป้าหมาย

เว็บร้านขายของมือสองแบบ **เดโม** สำหรับใช้เป็นผลงาน (portfolio showcase) ต้องรันได้จริงบน Vercel แผน Hobby และแสดงให้เห็นว่าทำงาน e-commerce ได้ครบวงจร ได้แก่:

- หน้าร้านที่ออกแบบสำหรับมือถือก่อน และหน้าตาโดดเด่น
- จองสินค้าชิ้นเดียวโดยไม่ขายซ้ำ แม้มีคนกดพร้อมกัน
- จ่ายเงินด้วย QR PromptPay แล้วแนบสลิป
- หลังบ้านสำหรับตรวจสลิป จัดการออเดอร์ และจัดการสินค้า
- หน้า case study เล่าว่าเว็บนี้สร้างด้วยทีม AI อย่างไร

### สิ่งที่อยู่นอกขอบเขต (Non-goals)

- รับเงินจริง (ถ้าทำ จะกลายเป็นเชิงพาณิชย์ และขัดเงื่อนไขของ Vercel Hobby)
- ระบบสมาชิกของลูกค้า
- ตะกร้าที่ใส่สินค้าหลายชิ้น (ใช้การสั่งทีละชิ้น ตรงกับ flow "เห็นในคลิปแล้วกดซื้อ" จาก TikTok)
- เชื่อมต่อกับระบบขนส่ง หรือ TikTok API
- ตรวจสลิปอัตโนมัติผ่าน API ภายนอก (ใช้การตรวจด้วยคนที่หลังบ้าน)

---

## 2. Tech Stack

| ส่วน | เลือก | เหตุผล |
|---|---|---|
| Framework | Next.js (App Router, เวอร์ชัน stable ล่าสุด) + TypeScript | ทั้งหน้าเว็บและ API อยู่ในโปรเจกต์เดียว deploy บน Vercel ได้ทันที |
| Styling | Tailwind CSS | |
| Database | Neon Postgres (ผ่าน Vercel Marketplace) | แผนฟรีตื่นจากโหมดหลับเร็ว ไม่ถูกพักโปรเจกต์แบบ Supabase |
| ORM | Drizzle ORM + `@neondatabase/serverless` | เบา และเขียน type-safe ได้ |
| Validation | Zod | ใช้ schema เดียวกันทั้งฝั่ง client และ server |
| File storage | Vercel Blob (store แบบ **private**) | เก็บสลิป (`slips/`) และรูปสินค้าที่อัปโหลดจากหลังบ้าน (`items/`) — access เป็นคุณสมบัติของ store ไม่ใช่รายไฟล์ รูปสินค้าจึงเสิร์ฟสาธารณะผ่าน proxy `/api/item-images/<ไฟล์>` (อ่านได้เฉพาะ `items/`) |
| QR | `promptpay-qr` + `qrcode` | สร้าง QR ฝั่งเซิร์ฟเวอร์ |
| Admin session | Cookie ที่เซ็นด้วย `jose` (HS256), httpOnly | ไม่ต้องใช้ระบบ auth เต็มรูปแบบ |
| รูปสินค้าเดโม | Unsplash (`images.unsplash.com`) พร้อมเครดิตช่างภาพ | |
| Deploy | Vercel Hobby | |
| Test | Vitest (logic) + Playwright (e2e ขั้นต่ำ) | |

### Environment variables

```
DATABASE_URL=            # Neon
BLOB_READ_WRITE_TOKEN=   # Vercel Blob
ADMIN_PASSWORD=          # รหัสหลังบ้านของเจ้าของ
SESSION_SECRET=          # อย่างน้อย 32 ตัวอักษร
CRON_SECRET=             # ป้องกัน endpoint ของ cron
DEMO_MODE=true
```

---

## 3. หน้าเว็บ

### หน้าบ้าน (public)

| Route | หน้า | รายละเอียด |
|---|---|---|
| `/` | หน้าแรก / รวมสินค้า | Hero แบบนิตยสาร, ตัวกรองหมวด, ช่องค้นหาด้วยรหัส, grid สินค้า สินค้าที่ขายแล้วยังแสดงอยู่พร้อมป้าย SOLD |
| `/item/[code]` | รายละเอียดสินค้า | Gallery 3–5 รูปที่ปัดได้, ราคา, สภาพ, **ตำหนิ (บังคับแสดง)**, ปุ่ม "จองชิ้นนี้" ที่เปลี่ยนตามสถานะ: ว่าง / มีคนจองอยู่ (นับถอยหลัง) / ขายแล้ว |
| `/checkout/[code]` | ฟอร์มสั่งซื้อ | ชื่อ, เบอร์, วิธีรับของ (นัดรับ / ส่งไปรษณีย์ +50฿), ที่อยู่ (แสดงเมื่อเลือกส่ง), หมายเหตุ, ปุ่ม "กรอกข้อมูลตัวอย่าง" |
| `/order/[token]` | ติดตามออเดอร์ | QR PromptPay + ยอดเงิน + เวลานับถอยหลัง → อัปโหลดสลิป → timeline สถานะ ลิงก์นี้เป็นลิงก์ลับของลูกค้าเท่านั้น |
| `/about` | Case study | ทีม AI แต่ละตัวทำอะไร, stack, ค่าใช้จ่าย/เวลาที่ใช้ (ดึงจาก `docs/BUILD_LOG.md`), ลิงก์ GitHub |
| `not-found` | 404 | ทำให้เข้ากับสไตล์ของเว็บ |

ค้นหาด้วยรหัส: พิมพ์ `012`, `A012` หรือ `#12` แล้วระบบจะ normalize และพาไปที่ `/item/A012` ทันที

### หลังบ้าน (`/admin/*`, ต้องมี session)

| Route | หน้า | รายละเอียด |
|---|---|---|
| `/admin/login` | เข้าสู่ระบบ | ช่องรหัสผ่าน + ปุ่ม **"ลองหลังบ้านแบบเดโม"** |
| `/admin` | Dashboard ออเดอร์ | แท็บตามสถานะ เรียงจากออเดอร์ที่ต้องจัดการก่อน (มีสลิปรอตรวจขึ้นบนสุด) |
| `/admin/orders/[id]` | รายละเอียดออเดอร์ | ดูสลิปผ่าน proxy, ปุ่ม ยืนยัน / ปฏิเสธ (ใส่เหตุผล) / จัดส่งแล้ว (ใส่เลขพัสดุ) / ปิดงาน / คืนสินค้าเข้าร้าน (owner เท่านั้น ใส่เหตุผล; สำหรับออเดอร์ที่ยืนยันแล้ว) — ออเดอร์เดโมที่ครบ 20 นาทีแสดงเป็น "เดโมสิ้นสุดแล้ว" (แท็บ ปิดแล้ว) |
| `/admin/items` | รายการสินค้า | ตาราง + เปลี่ยนสถานะเร็ว (ว่าง/ซ่อน/ขายแล้ว) — สินค้าที่ **มีออเดอร์ถืออยู่** เปลี่ยนสถานะไม่ได้ (ต้องยืนยัน/ปฏิเสธออเดอร์ก่อน) |
| `/admin/items/new`, `/admin/items/[id]` | เพิ่ม/แก้สินค้า | ฟอร์มสินค้า (รหัส A###, ราคาเป็นจำนวนเต็ม > 0, ตำหนิห้ามว่าง), อัปโหลดรูป (owner เท่านั้น), เรียงลำดับรูป + alt, ลบสินค้า (owner เท่านั้น และลบไม่ได้ถ้ามีประวัติออเดอร์) |

---

## 4. Data Model

```ts
// items
id            serial PK
code          text UNIQUE        // "A012" — แสดงในคลิปและใช้ใน URL
title         text
description   text
flaws         text NOT NULL      // ตำหนิ — ห้ามเป็นค่าว่าง ถ้าไม่มีตำหนิให้ใส่ "ไม่มีตำหนิที่สังเกตเห็น"
condition     enum('like_new','good','fair')
category      enum('fashion','books','home','tech','other')
price         integer            // บาท จำนวนเต็ม
images        jsonb              // [{url, alt, credit?: {name, url}}]
status        enum('available','reserved','sold','hidden')
reservedUntil timestamptz NULL
sortOrder     integer DEFAULT 0
createdAt, updatedAt

// orders
id            uuid PK
token         text UNIQUE        // 32 bytes random base64url — ลิงก์ติดตามออเดอร์
itemId        FK items
amount        integer            // ราคาสินค้า + ค่าส่ง ณ เวลาสั่ง (snapshot)
shippingFee   integer
customerName  text
phone         text
deliveryMethod enum('pickup','post')
address       text NULL
note          text NULL
status        enum (ดูหัวข้อ 5)
expiresAt     timestamptz        // หมดเวลาจ่าย
slipPath      text NULL          // pathname ใน Blob ห้ามส่งให้ client โดยตรง
slipUploadedAt, confirmedAt, shippedAt, completedAt  timestamptz NULL
trackingNo    text NULL
rejectReason  text NULL
demoSessionId text NULL          // ระบุ browser ที่สร้างออเดอร์ (ใช้ในโหมดเดโม)
confirmedByRole text NULL        // 'owner' | 'demo' — role ของผู้กดยืนยัน (migration 0002); NULL = ถือเป็นขายถาวร
createdAt, updatedAt

// order_events  (audit log + timeline ที่แสดงให้ลูกค้า)
id, orderId FK, type text, actor enum('customer','admin','system'), meta jsonb, createdAt
```

Index: `items(status)`, `orders(status, createdAt)`, `orders(itemId)`

---

## 5. สถานะสินค้าและออเดอร์

### ออเดอร์

```
            ┌──────────── หมดเวลา (15 นาที) ─────────────┐
            │                                              ▼
pending_payment ──อัปสลิป──▶ awaiting_review ──ยืนยัน──▶ confirmed ──▶ shipped ──▶ completed
            │                      │                          (ถ้านัดรับ ข้ามจาก confirmed ไป completed ได้)
            │                      └──ปฏิเสธ──▶ rejected
            └──ลูกค้ายกเลิก──▶ cancelled                                      expired
```

| สถานะออเดอร์ | สถานะสินค้า | หมายเหตุ |
|---|---|---|
| `pending_payment` | `reserved` (`reservedUntil = expiresAt`) | |
| `awaiting_review` | `reserved` (เลิกนับเวลาหมดอายุ) | ส่งสลิปแล้ว จึงไม่ปล่อยของคืนอัตโนมัติ |
| `confirmed` / `shipped` / `completed` ที่ **owner** ยืนยัน | `sold` | ขายถาวร (`orders.confirmed_by_role = 'owner'`) — owner คืนสินค้าเข้าร้านได้ด้วยคำสั่ง `return` |
| `confirmed` / `shipped` / `completed` ที่ **role demo** ยืนยัน (`confirmed_by_role = 'demo'`) | `reserved` (`reservedUntil = confirmedAt + 20 นาที`) | ไม่ใช่การขายจริง: ครบ 20 นาที (`DEMO_ORDER_RETURN_MINUTES` ใน `lib/availability.ts`) ออเดอร์ไม่ถือสินค้าอีกต่อไปและสินค้ากลับเป็น `available` เองด้วย lazy expiry (ตัดสินด้วย `now()` ของ DB ไม่มี cron/งานเขียนตามเวลา) — ค่าที่เก็บของออเดอร์ยังเป็น `confirmed`/… แต่ที่แสดงผล (หน้าออเดอร์ลูกค้า + หลังบ้าน) เป็น "เดโมสิ้นสุดแล้ว" (`demo_ended`) และไม่นับในแท็บ ยืนยันแล้ว/จัดส่งแล้ว/เสร็จสิ้น (นับในแท็บ "ปิดแล้ว") |
| `expired` / `rejected` / `cancelled` | กลับเป็น `available` | `cancelled` มาจากลูกค้ายกเลิกตอนรอชำระ หรือ owner สั่ง `return` (มี `rejectReason` เป็นเหตุผล) |

### กฎสำคัญ

1. **จองแบบ atomic:** ใช้คำสั่งเดียวดังนี้ แล้วสร้างออเดอร์ใน transaction เดียวกัน ถ้าไม่มีแถวคืนมา ให้ตอบ 409 "มีคนจองตัดหน้าไปแล้ว"
   ```sql
   UPDATE items SET status='reserved', reserved_until=now()+'15 min'
   WHERE code=$1 AND (status='available' OR (status='reserved' AND reserved_until < now()))
   RETURNING id
   ```
2. **หมดอายุแบบ lazy:** ไม่ใช้ cron มาคอยปลดล็อก ทุกครั้งที่อ่านหรือจองสินค้า ให้ถือว่า `reserved` ที่ `reservedUntil < now()` เป็น `available` และ mark ออเดอร์ `pending_payment` ที่เลยเวลาให้เป็น `expired` (ทำแบบ opportunistic ตอนอ่าน + ตอน cron รายวัน)
3. **อัปสลิปได้เฉพาะ** ออเดอร์ที่เป็น `pending_payment` และยังไม่หมดเวลา
4. ทุกครั้งที่เปลี่ยนสถานะ ต้องเขียน `order_events` และเช็กว่า transition นั้นถูกต้อง (ใช้ฟังก์ชัน `transition(order, event)` ฟังก์ชันเดียว และต้องมี unit test)
5. **นิยาม "ออเดอร์ที่ถือสินค้า" มีที่เดียว** (`lib/availability.ts`: `holdingOrderExistsSql`) และทุกจุดใช้ร่วมกัน — claimItem, หน้าร้าน, คำสั่งสินค้าหลังบ้าน, หน้ารายการสินค้า, dashboard ถือสินค้า = `awaiting_review` | `pending_payment` ที่ `expires_at >= now()` | `confirmed`/`shipped`/`completed` ที่ไม่ใช่ออเดอร์เดโมที่เลย 20 นาที
6. **คืนสินค้าเข้าร้าน (`return`, owner เท่านั้น):** `confirmed`/`shipped`/`completed` → `cancelled` + สินค้าเป็น `available` (ถ้าไม่มีออเดอร์อื่นถือ) พร้อมเหตุผล (ลูกค้าเห็น) และ `order_events` — compare-and-set ใน transaction เดียวกับ confirm/reject; role demo ทำไม่ได้ และออเดอร์เดโมที่สิ้นสุดแล้วเปลี่ยนสถานะต่อไม่ได้ (กันทับสินค้าที่คนอื่นจองไปแล้ว)

---

## 6. Flow การจ่ายเงิน (เดโม)

1. ลูกค้ากด "จองชิ้นนี้" → กรอกฟอร์ม → `POST /api/orders` → ได้ `token` → redirect ไป `/order/[token]`
2. หน้าออเดอร์แสดง **QR PromptPay ที่มีลายน้ำ "DEMO"** ซึ่ง encode เลขที่ใช้ไม่ได้จริง (`0000000000`) + ยอดเงิน + นาฬิกานับถอยหลัง
3. อัปโหลดสลิป:
   - ใช้ **Vercel Blob client upload** (`handleUpload`) ไม่ให้ไฟล์วิ่งผ่าน function เพราะ function มีขีดจำกัด body 4.5MB
   - route ที่ออก token ตรวจว่า order token ถูกต้องและสถานะเป็น `pending_payment`
   - รับเฉพาะ `image/jpeg|png|webp|heic` ขนาดไม่เกิน 8MB และย่อรูปฝั่ง client ก่อนส่ง (ยาวสุด 1600px)
   - pathname เป็นแบบสุ่ม (`slips/<uuid>.<ext>`) และให้ admin ดูผ่าน `/api/admin/slips/[orderId]` (proxy ที่ต้องมี session) เท่านั้น ห้ามส่ง URL ของ Blob ให้ client
   - ⚠️ Builder ต้องเช็กว่า Vercel Blob รองรับ private access หรือยัง ถ้ารองรับให้ใช้ ถ้ายังไม่รองรับ ให้พึ่ง pathname สุ่ม + proxy ไปก่อน
4. Upload เสร็จ → `onUploadCompleted` / `POST /api/orders/[token]/slip` → สถานะเป็น `awaiting_review`
5. หลังบ้านกดยืนยัน → `confirmed` → สินค้าเป็น `sold` และหน้า `/order/[token]` อัปเดต timeline (polling ทุก 10 วินาทีขณะเปิดหน้าอยู่ ไม่ใช้ websocket)

ทดสอบเรื่องเบราว์เซอร์ในแอป TikTok: `<input type="file" accept="image/*">` ต้องเลือกรูปจากคลังภาพได้ ถ้าอัปไม่ได้ ให้มีข้อความแนะนำ "เปิดในเบราว์เซอร์" พร้อมปุ่มคัดลอกลิงก์

---

## 7. โหมดเดโม (`DEMO_MODE=true`)

| เรื่อง | การทำงาน |
|---|---|
| แถบแจ้งเตือน | แถบบนสุดทุกหน้า: "Demo store — ไม่มีการเรียกเก็บเงินจริง ข้อมูลรีเซ็ตทุกวัน" |
| QR | ลายน้ำ DEMO และ encode เลขที่ใช้ไม่ได้จริงเสมอ |
| ฟอร์มลูกค้า | มีปุ่ม "กรอกข้อมูลตัวอย่าง" และ hint "อย่าใส่ข้อมูลจริง" |
| สลิปตัวอย่าง | มีปุ่ม "ใช้สลิปตัวอย่าง" ที่ใช้รูปสลิปปลอมซึ่งอยู่ใน repo อยู่แล้ว เพื่อให้ลองครบ flow ได้โดยไม่ต้องอัปไฟล์ |
| เวลาจอง | 15 นาที |
| ลองหลังบ้าน | ปุ่ม "ลองหลังบ้านแบบเดโม" ให้ session role `demo` |
| สิทธิ์ของ role `demo` | ยืนยัน/ปฏิเสธ/จัดส่งออเดอร์ได้ (เฉพาะออเดอร์ที่สร้างจาก browser ของตัวเอง; **ออเดอร์ที่ demo ยืนยันเป็นการทดลอง คืนสินค้าเข้าร้านเองหลัง 20 นาที** และนับรวมในเพดาน "ถือสินค้าต่อ IP" (≤ 3) ระหว่างช่วงนั้น; demo คืนสินค้า/ยกเลิกออเดอร์ที่ยืนยันแล้วเองไม่ได้) และ **ดูสินค้าได้อย่างเดียว** — แก้ข้อความ/ราคา/สถานะ เพิ่มสินค้า อัปโหลด/ลบรูป และลบสินค้าไม่ได้ (ตรวจที่ server ทุก action และ token ของ Blob upload) · *ปรับจากร่างแรกที่ให้ demo แก้ข้อความ/ราคาได้: สินค้าเป็นเนื้อหาสาธารณะที่ใครก็กดปุ่มเดโมได้ การให้คนแปลกหน้าแก้ชื่อ/ราคา/ซ่อนสินค้าทำลายหน้าร้านได้จนกว่าจะรีเซ็ต* |
| ความเป็นส่วนตัวใน role `demo` | ชื่อ/เบอร์/ที่อยู่ถูก mask (`ส*** 08x-xxx-xx12`) และ **สลิปถูกซ่อน** ยกเว้นออเดอร์ที่ `demoSessionId` ตรงกับ browser ของตัวเอง เพื่อกันไม่ให้คนแปลกหน้าเห็นข้อมูลหรือไฟล์ของกันและกัน |
| สิทธิ์ของ role `owner` | เห็นทุกอย่าง · ออเดอร์ที่ owner ยืนยันเป็นการขายถาวร (ไม่คืนเอง) · มีคำสั่ง **"คืนสินค้าเข้าร้าน/ยกเลิกออเดอร์"** สำหรับ `confirmed`/`shipped`/`completed` (รวมออเดอร์ที่ demo ยืนยันและยังอยู่ในช่วง 20 นาที) |
| Rate limit | 1 browser มีออเดอร์ `pending_payment` ได้ไม่เกิน 2 รายการ และสร้างได้ไม่เกิน 5 ออเดอร์/ชม.; 1 IP (hash) ถือสินค้าได้ไม่เกิน 3 ชิ้น (pending ที่ยังไม่หมดเวลา + awaiting_review + ออเดอร์ที่ demo ยืนยันและยังไม่ครบ 20 นาที) และสร้างได้ไม่เกิน 8 ออเดอร์/ชม. (เช็กจาก DB) |
| Daily reset | Vercel Cron วันละครั้ง เวลา `0 20 * * *` UTC (= 03:00 เวลาไทย; แผน Hobby รันได้วันละครั้งเท่านั้น และ Vercel อาจเรียกที่นาทีใดก็ได้ภายในชั่วโมงนั้น) → `GET /api/cron/reset` (ตรวจ `Authorization: Bearer ${CRON_SECRET}` แบบ timing-safe, ไม่ตั้ง/สั้นกว่า 16 ตัวอักษร = ปฏิเสธทุกคำขอ) → ใน DB (transaction เดียว + advisory lock รอบซ้อนจะข้าม): ลบ `orders` + `order_events` ทั้งหมด (รวม `client_ip_hash`), คืนสินค้าทุกชิ้นเป็นข้อมูลใน `db/seed-data.json` (status available) และ **ลบสินค้านอก seed** (รวมที่เจ้าของเพิ่มเอง) แล้วสุ่ม 2–3 ชิ้นเป็น SOLD → ลบไฟล์ Blob ใต้ `slips/` ทั้งหมด (list+del เป็นหน้าๆ เฉพาะไฟล์ที่อัปโหลดก่อนเริ่มรีเซ็ต; **ไม่ลบ `items/`**) → `revalidateTag("items", { expire: 0 })` · ไม่มี Blob token (dev) = ข้ามส่วน Blob พร้อม log |

---

## 8. Design — Editorial Minimal

**แนวคิด:** "นิตยสารของสะสมจากห้องหนึ่งห้อง" ให้แต่ละชิ้นดูเหมือนหน้าหนึ่งในแคตตาล็อกนิทรรศการ

### Typography

| ใช้กับ | ฟอนต์ | หมายเหตุ |
|---|---|---|
| Display (หัวเรื่อง, ราคา, รหัส) | **Instrument Serif** สำหรับละติน + **Noto Serif Thai** สำหรับไทย | ตัวใหญ่มาก (clamp 48–120px) ระยะบรรทัดแน่น |
| Body / UI | **IBM Plex Sans Thai** | |
| Meta (รหัส, สภาพ, หมวด) | **IBM Plex Mono** ตัวพิมพ์ใหญ่ | letter-spacing กว้าง |

รหัสสินค้าใช้เป็นองค์ประกอบกราฟิกในรูปแบบ `№ 012` ตัวใหญ่ข้างรูปสินค้า

### สี (CSS variables, มี dark mode)

| Token | Light | Dark |
|---|---|---|
| `--paper` | `#F4F1EA` | `#121110` |
| `--ink` | `#151413` | `#EDE9E1` |
| `--muted` | `#6E6A63` | `#9A958C` |
| `--rule` | `#D9D4C9` | `#2C2A27` |
| `--accent` | `#B4441F` | `#E0703F` |

`--accent` ใช้แค่กับ SOLD, ปุ่มหลัก และเวลานับถอยหลัง

### Layout และ motion

- Mobile (375px): รูปเต็มความกว้าง, ข้อความชิดซ้าย, padding ด้านข้าง 16px, ปุ่ม "จอง" ติดล่างจอ (sticky bottom bar)
- Desktop: grid 12 คอลัมน์แบบไม่สมมาตร (รูป 7 / ข้อความ 5) และ grid หน้าแรกสลับขนาดการ์ดแบบนิตยสาร
- เส้นคั่นบาง 1px (`--rule`) แทนการใช้กล่องหรือเงา และไม่มีมุมโค้ง
- รูปเป็น aspect 4:5 ทั้งหมด, hover (desktop) สลับไปรูปที่ 2
- Motion เบา: fade/slide 200ms และ view transition ระหว่าง grid กับหน้าสินค้า ต้องเคารพ `prefers-reduced-motion`
- ป้าย SOLD: ตัวอักษร serif ตัวใหญ่สี accent เอียงทับรูป + รูปเป็น grayscale

### Accessibility

- Contrast ต้องผ่าน AA
- มี focus ring ชัดเจน
- รูปทุกรูปมี alt
- Touch target ไม่ต่ำกว่า 44px

---

## 9. ความปลอดภัย (ส่วนที่ Reviewer จะตรวจ)

- Input ทุกตัวผ่าน Zod ฝั่ง server และราคาคำนวณที่ server เท่านั้น ห้ามเชื่อค่าที่ส่งมาจาก client
- Order token เป็น random 32 bytes และไม่ใช้ id ที่เดาได้ใน URL ของลูกค้า
- Admin cookie เป็น `httpOnly; Secure; SameSite=Lax` อายุ 7 วัน, Server Actions/API ฝั่ง admin ตรวจ session **ทุกครั้งที่ฝั่ง server** (ไม่พึ่ง middleware อย่างเดียว) และเทียบรหัสแบบ constant-time + จำกัดการลองรหัส
- สลิปไม่มี URL สาธารณะ และ endpoint ที่ออก Blob upload token ตรวจ content-type, ขนาด และสถานะออเดอร์
- ไม่ log PII (ชื่อ เบอร์ ที่อยู่)
- `/api/cron/reset` ตรวจ `Authorization: Bearer ${CRON_SECRET}` แบบ timing-safe และ fail-closed (ไม่มี `CRON_SECRET` = ปฏิเสธทั้งหมด)
- รูปสินค้า: endpoint ออก Blob token (`/api/admin/item-images/upload`) ตรวจ Origin + session + สิทธิ์ `image.upload` (owner) ก่อนทุกครั้ง, pathname ต้องเป็น `items/<ไฟล์รูป>` เท่านั้น, ชนิด jpeg/png/webp ≤ 5MB; proxy สาธารณะ `/api/item-images/<ไฟล์>` อ่านได้เฉพาะ `items/` และตัดสินชนิดจากเนื้อไฟล์
- ตั้ง security headers พื้นฐาน (CSP แบบที่อนุญาต unsplash และ blob, `X-Content-Type-Options`, `Referrer-Policy`)
- มีหน้าแจ้งความเป็นส่วนตัวสั้น ๆ (PDPA-style) แม้จะเป็นเดโม

---

## 10. โครงสร้างโปรเจกต์

```
shop-website/
  app/
    (shop)/page.tsx, item/[code]/, checkout/[code]/, order/[token]/, about/
    admin/login/, admin/(protected)/...
    api/orders/, api/orders/[token]/slip/, api/blob/upload/, api/admin/slips/[orderId]/, api/cron/reset/,
    api/admin/item-images/upload/ (token อัปโหลดรูปสินค้า), api/item-images/[name]/ (proxy รูปสินค้า)
  components/      ui/, shop/, admin/
  db/              schema.ts, client.ts, seed.ts, seed-data.json
  lib/             orders/transition.ts, reserve.ts, auth.ts, promptpay.ts, demo.ts, validation.ts
  public/demo/     sample-slip.png
  tests/           unit/, e2e/
  docs/            BUILD_LOG.md
  SPEC.md, README.md, vercel.json (cron `0 20 * * *` UTC)
```

---

## 11. การแบ่งงานให้ทีม AI

| ขั้น | ผู้ทำ | งาน |
|---|---|---|
| 2 | **Opus · Medium** | SPEC นี้ ✅ |
| 3a | **Sonnet · Medium** | Scaffold, schema, seed, logic การจอง + transition + unit tests |
| 3b | **Sonnet · Medium** | หน้าบ้านทั้งหมดตามหัวข้อ 8 |
| 3c | **Sonnet · Medium** | หลังบ้าน + auth + โหมดเดโม + cron |
| 4 | **Haiku · Low** | ข้อมูลสินค้า 12 ชิ้น (ชื่อ คำบรรยาย ตำหนิ แท็ก) ใน `seed-data.json` ส่วนการเลือกรูป Unsplash และเครดิต ให้ Opus/Sonnet ตรวจว่า URL ใช้ได้จริง |
| 5 | **Opus · Medium** | Review ความปลอดภัยและ flow + ทดสอบบน mobile viewport + แก้ปัญหาที่พบ |
| 5 | ผู้ใช้ + Opus | Deploy ขึ้น Vercel (ผู้ใช้เชื่อมบัญชีและ Neon/Blob เอง) |

กฎ Effort ตาม Notion: ถ้าไม่ผ่านเทสต์ ให้ขยับขึ้นทีละขั้น ถ้า Sonnet ที่ Xhigh ยังทำไม่ได้ ให้ส่งงานให้ Opus

ทุกขั้นต้องบันทึกลง `docs/BUILD_LOG.md`: ใช้โมเดลไหน, effort เท่าไร, ทำอะไร, ปัญหาที่เจอ ข้อมูลนี้จะนำไปแสดงในหน้า `/about`

---

## 12. Acceptance Checklist

### Functional
- [ ] หน้าแรกแสดงสินค้า 12 ชิ้น กรองตามหมวดได้ ค้นหาด้วยรหัสแล้วพาไปหน้าสินค้าได้
- [ ] หน้าสินค้าแสดงตำหนิทุกชิ้น และปุ่มเปลี่ยนตามสถานะ
- [ ] จองแล้วสินค้าถูกล็อก และเมื่อเปิดสองแท็บกดพร้อมกัน **สำเร็จได้แค่ 1 แท็บ** (มี test)
- [ ] จองไว้แล้วปล่อยเลย 15 นาที สินค้ากลับมาว่างเอง
- [ ] อัปสลิปได้ (ทั้งไฟล์จริงและสลิปตัวอย่าง) และสถานะเปลี่ยนเป็น `awaiting_review`
- [ ] หลังบ้านยืนยันแล้ว สินค้าเป็น SOLD และ timeline ของลูกค้าอัปเดต
- [ ] ปฏิเสธสลิปแล้ว สินค้ากลับมาว่าง และลูกค้าเห็นเหตุผล
- [ ] ลองหลังบ้านแบบเดโมได้ โดยข้อมูลของคนอื่นถูก mask และสลิปของคนอื่นถูกซ่อน
- [ ] Cron reset คืนร้านกลับสู่สถานะ seed
- [ ] หน้า `/about` แสดง case study

### Quality
- [ ] `npm run build` ผ่าน และ `npm run lint` + `tsc --noEmit` ไม่มี error
- [ ] Unit test ของ `transition` และ `reserve` ผ่าน
- [ ] E2E: สั่งซื้อ → อัปสลิป → admin ยืนยัน ผ่านบน viewport 375px
- [ ] Lighthouse mobile หน้าแรก: Performance ≥ 85, Accessibility ≥ 95
- [ ] ไม่มี horizontal scroll ที่ 375px และ dark mode ใช้งานได้

### Deploy
- [ ] Deploy บน Vercel Hobby ใช้งานได้จริง และตั้ง env ครบ
- [ ] เปิดลิงก์จากเบราว์เซอร์ในแอป TikTok แล้วสั่งซื้อจนจบได้ (ผู้ใช้ทดสอบบนมือถือจริง)
- [ ] README มีวิธีรัน local, วิธี deploy, screenshot และลิงก์เดโม

---

## 13. รอการตัดสินใจ (ค่า default ที่เสนอไว้)

1. **ชื่อร้าน:** ชั่วคราวใช้ "**Second Room**" (ใช้ได้กับคำโปรย "ของจากอีกห้องหนึ่ง")
2. **สั่งทีละชิ้น** ไม่มีตะกร้า
3. **เวลาจอง** 15 นาที
4. **ค่าส่ง** เหมา 50฿, นัดรับฟรี
5. **Package manager:** npm (ผู้ใช้เลือกแทน pnpm เมื่อ 2026-10-12)
6. **Git:** เริ่ม `git init` ในโฟลเดอร์นี้ และ push ขึ้น GitHub ภายหลังเมื่อผู้ใช้สั่ง
