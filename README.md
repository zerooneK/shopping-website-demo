# Second Room — ร้านขายของมือสองแบบเดโม

เว็บร้านขายของมือสอง **แบบเดโม (showcase)** ที่สร้างโดยทีม AI เพื่อเป็นผลงาน: จองสินค้าชิ้นเดียวโดยไม่ขายซ้ำ, จ่ายด้วย QR PromptPay จำลอง, แนบสลิป, มีหลังบ้านสำหรับตรวจสลิปและจัดการสินค้า

> **ร้านนี้ไม่รับเงินจริง** QR มีลายน้ำ DEMO และเข้ารหัสเลขปลายทางที่ใช้โอนจริงไม่ได้ สินค้า คำบรรยาย และตำหนิเป็นข้อมูลตัวอย่าง รูปประกอบทั้งหมดมาจาก Unsplash (ไม่ใช่ภาพถ่ายของสินค้าจริง) ที่เป็นเดโมเพราะวางบน Vercel แผน Hobby ซึ่งอนุญาตเฉพาะการใช้งานที่ไม่ใช่เชิงพาณิชย์ — ห้ามเอาไปรับเงินจริงโดยไม่ย้ายแผน

| | |
|---|---|
| ซอร์สโค้ด | [github.com/zerooneK/shopping-website-demo](https://github.com/zerooneK/shopping-website-demo) |
| ลิงก์เดโม | **ยังไม่มี** — จะเติมที่นี่หลัง deploy บน Vercel (ตอนนี้ยังไม่ได้ deploy จึงยังไม่มี URL) |
| Screenshot | **ยังไม่มี** — จะเติมหลัง deploy (วางไฟล์ภาพไว้ที่ `docs/screenshots/` แล้วลิงก์ที่นี่) |

<!-- TODO หลัง deploy: แทนแถว "ลิงก์เดโม" ด้วย URL จริงของ Production และใส่ภาพหน้าแรก / หน้าสินค้า / หน้าชำระเงิน / หลังบ้าน -->

---

## สารบัญ

1. [ฟีเจอร์](#ฟีเจอร์)
2. [Tech stack](#tech-stack)
3. [ทีม AI และ workflow](#ทีม-ai-และ-workflow)
4. [รันในเครื่อง](#รันในเครื่อง)
5. [ทดสอบ](#ทดสอบ)
6. [Deploy บน Vercel](#deploy-บน-vercel)
7. [รีเซ็ตข้อมูลรายวัน (Vercel Cron)](#รีเซ็ตข้อมูลรายวัน-vercel-cron)
8. [ออเดอร์เดโมคืนสินค้าเอง และการคืนสินค้าโดยเจ้าของร้าน](#ออเดอร์เดโมคืนสินค้าเอง-และการคืนสินค้าโดยเจ้าของร้าน)
9. [ย้ายฐานข้อมูล (migration 0002)](#ย้ายฐานข้อมูล-migration-0002)
10. [รูปสินค้า](#รูปสินค้า)
11. [ความปลอดภัยและ security headers](#ความปลอดภัยและ-security-headers)
12. [เครดิตรูปภาพ (Unsplash)](#เครดิตรูปภาพ-unsplash)

---

## ฟีเจอร์

**หน้าบ้าน (มือถือก่อน ที่ 375px, มี dark mode)**

- หน้าแรกสไตล์นิตยสาร: กรองตามหมวด, ค้นหาด้วยรหัส (`012`, `A012`, `#12` ไปที่ `/item/A012`), สินค้าที่ขายแล้วยังแสดงพร้อมป้าย SOLD
- หน้าสินค้า: แกลเลอรีปัดได้, ราคา, สภาพ, **ตำหนิ (แสดงทุกชิ้น)**, ปุ่มจองที่เปลี่ยนตามสถานะ (ว่าง / มีคนจอง พร้อมนับถอยหลัง / ขายแล้ว)
- สั่งซื้อทีละชิ้น (ไม่มีตะกร้า): ชื่อ เบอร์ วิธีรับของ (นัดรับ / ส่งไปรษณีย์ +50฿) ที่อยู่ หมายเหตุ และปุ่ม "กรอกข้อมูลตัวอย่าง"
- หน้าติดตามออเดอร์ที่เป็นลิงก์ลับ (`/order/<token>`): QR จำลอง + ยอดเงิน + นับถอยหลัง 15 นาที, อัปโหลดสลิป (หรือกด "ใช้สลิปตัวอย่าง"), timeline สถานะที่อัปเดตเอง
- `/about` (case study ของทีม AI) และ `/privacy`

**ระบบจอง**

- จองแบบ atomic ด้วย SQL คำสั่งเดียว: เปิดสองแท็บกดพร้อมกัน สำเร็จได้แค่หนึ่งแท็บ
- เวลาทุกอย่างตัดสินด้วย `now()` ของฐานข้อมูล, ปล่อยสินค้าคืนเองเมื่อครบ 15 นาที (lazy expiry ไม่ต้องมี cron คอยปลดล็อก)
- state machine ของออเดอร์อยู่ฟังก์ชันเดียว (`lib/orders/transition.ts`) มี unit test

**หลังบ้าน (`/admin`)**

- ตรวจสลิปผ่าน proxy ที่ต้องมี session (สลิปไม่มี URL สาธารณะ), ยืนยัน / ปฏิเสธ (ใส่เหตุผล) / จัดส่ง (เลขพัสดุ) / ปิดงาน / คืนสินค้าเข้าร้าน (owner เท่านั้น)
- จัดการสินค้า: เพิ่ม/แก้ไข/เรียงรูป/อัปโหลดรูป/เปลี่ยนสถานะเร็ว/ลบ (owner เท่านั้นสำหรับแก้และอัปโหลด)
- ปุ่ม **"ลองหลังบ้านแบบเดโม"** ให้ผู้ชมลองเป็น role `demo`: ข้อมูลลูกค้าของคนอื่นถูกปิดบังบางส่วน เปลี่ยนสถานะได้เฉพาะออเดอร์ที่ตัวเองสร้าง และดูสินค้าได้อย่างเดียว

**โหมดเดโม**

- แถบแจ้งเตือนทุกหน้า, ฟอร์มมีปุ่มกรอกข้อมูลตัวอย่าง, ข้อมูลรีเซ็ตทุกวัน (ดู [Vercel Cron](#รีเซ็ตข้อมูลรายวัน-vercel-cron))
- rate limit ฝั่ง server: ต่อ browser (pending ≤ 2, ≤ 5 ออเดอร์/ชม.) และต่อ IP ที่ hash แล้ว (ถือสินค้า ≤ 3, ≤ 8 ออเดอร์/ชม.)

---

## Tech stack

| ส่วน | เลือก |
|---|---|
| Framework | Next.js 16 (App Router, Cache Components) + TypeScript strict |
| Styling | Tailwind CSS 4 + design tokens (CSS variables) |
| ฐานข้อมูล | Neon Postgres + Drizzle ORM (driver WebSocket สำหรับ interactive transaction) |
| Validation | Zod (schema เดียวกันทั้ง client และ server, ราคาคำนวณที่ server เท่านั้น) |
| ไฟล์ | Vercel Blob แบบ **private** (สลิป `slips/` และรูปสินค้า `items/`, client upload) |
| QR | `promptpay-qr` + `qrcode` (สร้างฝั่ง server) |
| Admin session | cookie ที่เซ็นด้วย `jose` (HS256), httpOnly |
| ทดสอบ | Vitest (unit + integration กับ Neon จริง) และ Playwright (e2e ที่ 375px) |
| Deploy | Vercel Hobby (non-commercial) |

---

## ทีม AI และ workflow

โปรเจกต์นี้เขียนโดยทีมเอเจนต์ AI ที่มีบทบาทแยกกัน (กฎทีมเต็มอยู่ใน [`CLAUDE.md`](./CLAUDE.md), สเปคอยู่ใน [`SPEC.md`](./SPEC.md)):

| บทบาท | Agent | โมเดล · effort เริ่มต้น | หน้าที่ |
|---|---|---|---|
| Orchestrator | session หลัก | Sonnet 5.5 (ขั้นเขียนสเปคเป็น Opus 5.5 · medium ก่อนผู้ใช้สลับโมเดลใน session) | แบ่งงาน ส่งต่อ ตัดสินใจ คุยกับผู้ใช้ |
| Builder | `shop-builder` | Sonnet · medium | เขียนโค้ดทั้งหมด |
| Reviewer | `shop-reviewer` | Opus · medium (ตรวจซ้ำ: low) | ตรวจระบบสั่งซื้อ สลิป ความปลอดภัย — อ่านอย่างเดียว |
| Writer | `shop-writer` | Haiku · low | ข้อมูลสินค้า ตำหนิ คอนเทนต์ |

**Workflow ต่อขั้น:** Builder ทำ → Builder รัน lint / typecheck / test / build → Reviewer ตรวจ (ขั้นที่แตะออเดอร์ สลิป ความปลอดภัย) → Builder แก้ → บันทึก [`docs/BUILD_LOG.md`](./docs/BUILD_LOG.md)

**กฎ effort:** เริ่มที่ระดับกลางเสมอ ถ้าเทสต์หรือรีวิวไม่ผ่านจึงขยับขึ้นทีละขั้น (medium → high → xhigh) ถ้า Builder ที่ xhigh ยังทำไม่ได้จึงส่งให้ Opus ไม่ใช้ระดับสูงสุดเป็นค่าเริ่มต้น

ไทม์ไลน์ของแต่ละขั้น รอบรีวิว และบทเรียน ดูได้ที่หน้า `/about` ของเว็บ (ดึงจาก `docs/BUILD_LOG.md` ตอน build) — ค่าใช้จ่ายและเวลาที่ใช้จริง **ยังไม่ได้บันทึก** จึงไม่มีตัวเลขเหล่านี้

---

## รันในเครื่อง

ต้องมี: Node.js (ทดสอบกับ v24), npm, ฐานข้อมูล Neon Postgres **สำหรับ dev โดยเฉพาะ**, และ Google Chrome ในเครื่อง (e2e ใช้ `channel: "chrome"` ไม่ดาวน์โหลดเบราว์เซอร์ให้)

```powershell
git clone https://github.com/zerooneK/shopping-website-demo.git
cd shopping-website-demo
npm install
Copy-Item .env.example .env.local     # แล้วเปิด .env.local กรอกค่าตามตารางด้านล่าง
npm run db:push                       # สร้างตารางใน DATABASE_URL (drizzle-kit push)
npm run db:seed                       # ใส่สินค้า 12 ชิ้นจาก db/seed-data.json
npm run dev                           # http://localhost:3000
```

> **`npm run db:seed` ลบออเดอร์และสินค้า "ทั้งหมด" ใน `DATABASE_URL` แล้วใส่ข้อมูลตั้งต้นใหม่** และชุดเทสต์ integration/e2e เขียนแถวทดสอบลงฐานข้อมูลเดียวกัน — จึงต้องใช้ฐานข้อมูล dev แยกจาก Production/Preview เสมอ

### ตัวแปรสภาพแวดล้อม

แม่แบบอยู่ที่ [`.env.example`](./.env.example) — ค่าจริงใส่ใน `.env.local` เท่านั้น (อยู่ใน `.gitignore` ห้าม commit)

| ตัวแปร | จำเป็นเมื่อ | คำอธิบาย |
|---|---|---|
| `DATABASE_URL` | เสมอ | connection string ของ Neon |
| `SESSION_SECRET` | เสมอ | สุ่มอย่างน้อย **32** ตัวอักษร ไม่ตั้ง/สั้นกว่า = หลังบ้านปิด และ production รับออเดอร์ไม่ได้ (503) |
| `ADMIN_PASSWORD` | ใช้หลังบ้านของ owner | อย่างน้อย **16** ตัวอักษร แนะนำสุ่มยาว 24+ ตัว |
| `CRON_SECRET` | production (cron) | อย่างน้อย **16** ตัวอักษร ป้องกัน `/api/cron/reset` |
| `DEMO_MODE` | เดโม | `true` = แถบเดโม ปุ่มหลังบ้านเดโม และ **ให้ cron รีเซ็ตทำงาน** (ไม่ใช่ `true` = cron ข้ามตอบ `skipped_not_demo`) |
| `BLOB_READ_WRITE_TOKEN` | อัปโหลดไฟล์จริง | จาก Vercel Blob (store แบบ private) ไม่ตั้งใน dev = ซ่อนช่องเลือกไฟล์ ใช้ "สลิปตัวอย่าง" แทน และ cron ข้ามขั้นลบไฟล์ |

สร้างค่าสุ่ม: `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`

> บน Windows connection string ของ Neon มี `&` — ใช้ `source .env` ใน Git Bash ไม่ได้ ให้โหลดผ่าน `node --env-file=.env.local` (สคริปต์ใน `package.json` ทำให้แล้ว)

---

## ทดสอบ

| คำสั่ง | ทำอะไร |
|---|---|
| `npm run lint` | ESLint |
| `npm run typecheck` | `next typegen` + `tsc --noEmit` |
| `npm test` | unit test (Vitest) ไม่ต้องต่อฐานข้อมูล |
| `npm run test:integration` | SQL จริงกับ Postgres (Neon) ตาม `DATABASE_URL`: จองพร้อมกัน, state machine, หลังบ้าน, cron reset (ใช้ schema ชั่วคราวแยกแล้ว DROP ตอนจบ) — เขียนแถวทดสอบที่มีรหัสเฉพาะแล้วลบเฉพาะของตัวเอง |
| `npm run test:e2e` | Playwright ที่ 375x812 บน Chrome: build + `next start` ที่พอร์ต 3100, สร้างสินค้า fixture (`T98x`, `V0xx`) ใน DB แล้วลบตอนจบ ตั้ง `E2E_SKIP_BUILD=1` เพื่อข้ามขั้น build เมื่อรันซ้ำ |
| `npm run build` | production build |

e2e ไม่ยิง cron ด้วย secret ที่ถูกต้อง (จะล้างตาราง orders จริง) และไม่ทดสอบ Blob upload จริง (ไม่มี token ในเครื่อง) — ใช้ "สลิปตัวอย่าง" แทน

---

## Deploy บน Vercel

> ขั้นตอนนี้ผู้ใช้ทำเอง (เชื่อมบัญชี Vercel / Neon / Blob) — โปรเจกต์ยังไม่ได้ deploy ในตอนที่เขียนเอกสารนี้

### 1) ฐานข้อมูล: แยก Production และ Preview ออกจาก dev

สร้าง Neon database หรือ **branch แยก** อย่างน้อย 2 ชุด: **Production** และ **Preview** (และใช้ชุด dev ของตัวเองในเครื่อง) **ห้ามใช้ `DATABASE_URL` ของ dev ร่วมกับ Production หรือ Preview** เพราะ `npm run db:seed` ลบทุกอย่าง และ e2e/integration เขียนแถวทดสอบลงฐานข้อมูลที่ชี้อยู่ รวมถึง cron รายวันที่ล้างออเดอร์ทั้งหมด

### 2) สร้างตารางใน Production (ครั้งแรก)

ใช้ `DATABASE_URL` ของ **Production** (ตั้งชั่วคราวใน shell เท่านั้น ไม่ใส่ลงไฟล์ ไม่ commit):

```powershell
$env:DATABASE_URL = "<connection string ของ Neon Production>"
npx drizzle-kit push        # สร้างตารางทั้งหมดตาม db/schema.ts (ฐานข้อมูลว่างจึงไม่มีการลบข้อมูล)
Remove-Item Env:DATABASE_URL
```

ทางเลือก: `npx drizzle-kit migrate` จะรันไฟล์ใน `db/migrations/` (0000–0002) ตามลำดับ — โปรเจกต์นี้ใช้ `push` มาตลอดและ **ยังไม่ได้ทดสอบ `migrate` กับ Neon** ทำซ้ำขั้นตอนเดียวกันกับ `DATABASE_URL` ของ Preview

### 3) Vercel Blob

สร้าง Blob store แบบ **private** แล้วเชื่อมกับโปรเจกต์ เพื่อให้ได้ `BLOB_READ_WRITE_TOKEN` (ใช้เก็บสลิปและรูปสินค้า ระดับ access เป็นของ store จึงเสิร์ฟสาธารณะผ่าน proxy ของแอปเท่านั้น)

### 4) ตั้ง environment variables ใน Vercel — ทั้ง Production **และ** Preview

| ตัวแปร | Production | Preview |
|---|---|---|
| `DATABASE_URL` | ของ Production | ของ **Preview (คนละฐานข้อมูลกับ Production และ dev)** |
| `SESSION_SECRET` | สุ่ม >= 32 ตัว | สุ่ม >= 32 ตัว (Preview ก็เป็น `NODE_ENV=production` จึงรับออเดอร์ไม่ได้ถ้าไม่ตั้ง) |
| `ADMIN_PASSWORD` | สุ่ม >= 16 ตัว | สุ่ม >= 16 ตัว |
| `CRON_SECRET` | สุ่ม >= 16 ตัว | สุ่ม >= 16 ตัว |
| `DEMO_MODE` | `true` | `true` |
| `BLOB_READ_WRITE_TOKEN` | จาก Blob store | จาก Blob store |

ใช้ secret คนละค่ากับที่ใช้ในเครื่อง และห้ามวางค่าจริงในแชท/โค้ด/issue

### 5) Deploy

เชื่อม GitHub repo กับโปรเจกต์ใน Vercel แล้ว push ตามปกติ `vercel.json` ตั้ง cron ให้เอง

### 6) ใส่ข้อมูลตั้งต้นใน Production (ครั้งแรก)

หลัง deploy ฐานข้อมูล Production ยังไม่มีสินค้า — ให้ seed ด้วยการยิง endpoint รีเซ็ตหนึ่งครั้ง (เป็นตัวเดียวกับที่ cron เรียกทุกวัน: ล้างออเดอร์ ใส่สินค้า 12 ชิ้นจาก `db/seed-data.json` สุ่มขายแล้ว 2–3 ชิ้น):

```powershell
curl.exe -H "Authorization: Bearer <CRON_SECRET ของ Production>" https://<โดเมน Production>/api/cron/reset
```

ต้องได้ `{"status":"ran", ...}` — ถ้าได้ `skipped_not_demo` แปลว่า `DEMO_MODE` บน Production ไม่ใช่ `true`, ถ้า 401 แปลว่า `CRON_SECRET` ไม่ตรง/ไม่ได้ตั้ง Preview ทำเหมือนกันด้วย secret และโดเมนของ Preview (cron ของ Vercel เรียกเฉพาะ production deployment จึงต้อง seed Preview เอง)

> **401 จาก Deployment Protection ไม่ใช่ `CRON_SECRET` ผิด:** Preview deployment มักเปิด Deployment Protection (Vercel Authentication) ไว้ คำขอที่ไม่ผ่านจะถูก Vercel ตอบ 401 เองก่อนถึงแอป (ตัวแอปตอบ 401 เป็น JSON `{"error":"unauthorized"}`) ให้ใช้ **Protection Bypass for Automation**: สร้าง secret ที่ Project Settings → Deployment Protection แล้วส่งเพิ่มอีก header `x-vercel-protection-bypass: <bypass secret>` (ชื่อ header ตามเอกสาร Vercel "Protection Bypass for Automation") — หรือปิด protection ของ Preview ชั่วคราวระหว่าง seed แล้วเปิดกลับ ห้ามวาง bypass secret ในโค้ดหรือ issue
>
> ```powershell
> curl.exe -H "Authorization: Bearer <CRON_SECRET ของ Preview>" -H "x-vercel-protection-bypass: <bypass secret>" https://<โดเมน Preview>/api/cron/reset
> ```

### 7) เช็กก่อน deploy / หลัง deploy

ดูรายการ "[เช็กก่อน deploy](#เช็กก่อน-deploy)" ด้านล่าง และอย่าลืม: เติมลิงก์เดโมกับ screenshot ในตารางบนสุดของไฟล์นี้, ทดสอบสั่งซื้อจนจบบนมือถือจริง (รวมเปิดจากเบราว์เซอร์ในแอป TikTok), และทดสอบอัปโหลดสลิป/รูปสินค้าจริง 1 ครั้งพร้อมเปิด DevTools Console ดูว่าไม่มี CSP violation

---

## รีเซ็ตข้อมูลรายวัน (Vercel Cron)

ร้านนี้เป็นเดโม จึงมี cron ที่คืนร้านกลับสู่ข้อมูลตั้งต้นทุกวัน (`vercel.json` → `GET /api/cron/reset`)

- **เวลา:** `0 20 * * *` (UTC) = **03:00 เวลาไทย** วันละครั้ง
- **ข้อจำกัดของแผน Hobby:** cron รันได้ **วันละครั้งเท่านั้น** (ตั้งถี่กว่านี้ deploy จะไม่ผ่าน) และ Vercel อาจเรียกเมื่อไรก็ได้ภายใน "ชั่วโมง" ที่ระบุ (03:00–03:59 เวลาไทย) ไม่ใช่ตรงนาที และการเรียกเป็นแบบ best-effort อาจซ้ำหรือพลาดบางครั้ง — โค้ดจึงออกแบบให้รันซ้ำได้ปลอดภัย (advisory lock + ผลลัพธ์เดิมทุกครั้ง) Vercel เรียกเฉพาะ URL ของ production deployment
- **ต้องตั้ง `CRON_SECRET`** (สุ่มอย่างน้อย 16 ตัวอักษร) — Vercel จะส่ง `Authorization: Bearer <CRON_SECRET>` ให้เองตอนเรียก cron ถ้าไม่ตั้งค่า endpoint จะปฏิเสธทุกคำขอ (fail-closed)
- **ต้องตั้ง `DEMO_MODE=true`:** ถ้า `DEMO_MODE` ไม่ใช่ `true` endpoint จะตอบ `200 {"status":"skipped_not_demo"}` โดยไม่แตะฐานข้อมูล/Blob — ร้านจริงที่ปิดโหมดเดโมแล้วจึง **ไม่ถูกล้างออเดอร์และสินค้าทุกวัน** (ตรวจ Bearer ก่อนเสมอ ไม่มี secret = 401)
- **สิ่งที่ถูกรีเซ็ต:** ลบออเดอร์และประวัติสถานะทั้งหมด (รวมค่า hash ของ IP), ลบไฟล์สลิปใน Vercel Blob ใต้ `slips/` ทั้งหมด (ไม่แตะ `items/`), คืนสินค้าเป็นข้อมูลใน `db/seed-data.json` (**สินค้าที่เจ้าของเพิ่มเองผ่านหลังบ้านจะถูกลบด้วย** — ถ้าอยากให้อยู่ถาวรให้เพิ่มลงใน `db/seed-data.json`) แล้วสุ่ม 2–3 ชิ้นเป็นขายแล้ว
- **ทดลองในเครื่อง:** `curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/reset` — จะล้างออเดอร์ทั้งหมดใน DB ที่ `DATABASE_URL` ชี้อยู่จริง (เทสต์อัตโนมัติใช้ schema ชั่วคราวแยกต่างหาก ไม่เรียกของจริง)
- ถ้าไม่มี `BLOB_READ_WRITE_TOKEN` (dev) จะข้ามขั้นลบไฟล์สลิปพร้อม log และไม่ล้ม

### เช็กก่อน deploy

แถบเดโม/หน้า about/privacy บอกผู้ใช้ว่า "ข้อมูลรีเซ็ตทุกวัน" ตายตัว (ไม่ผูกกับเงื่อนไข) จึงต้องแน่ใจว่า cron ทำงานจริงก่อนเปิดใช้:

1. ตั้ง **`CRON_SECRET`** (สุ่ม >= 16 ตัวอักษร) ใน Vercel ทั้ง Production และ Preview — ไม่ตั้ง = cron ถูกปฏิเสธทุกครั้ง (401) และข้อมูลไม่เคยรีเซ็ต
2. ตั้ง **`DEMO_MODE=true`** บน Production — ไม่ตั้ง = cron ข้ามเงียบๆ (`skipped_not_demo`) และข้อมูลไม่เคยรีเซ็ต
3. ตั้ง **`BLOB_READ_WRITE_TOKEN`** (เชื่อม Blob store แบบ private) — ไม่ตั้ง = cron ข้ามขั้นลบสลิป (log `no_blob_token`) ไฟล์สลิปจะค้างอยู่ใน Blob
4. หลัง deploy ตรวจ **log ของ cron รอบแรก** (Vercel → Logs / Cron Jobs) ว่าตอบ `status: "ran"` และมี `blob.deleted` (จำนวนไฟล์สลิปที่ลบ; 0 ได้ถ้าไม่มีสลิป) — ถ้าเป็น `skipped_locked` ซ้ำๆ, `skipped_not_demo`, `db_reset_blob_failed` หรือ 401/500 ให้แก้ก่อน เพราะข้อความบนเว็บอ้างว่ารีเซ็ตทุกวัน

---

## ออเดอร์เดโมคืนสินค้าเอง และการคืนสินค้าโดยเจ้าของร้าน

ปุ่ม "ลองหลังบ้านแบบเดโม" ทำให้ใครก็กดยืนยันออเดอร์ของตัวเองได้ ถ้าการยืนยันนั้นขายสินค้าถาวร ผู้ชมไม่กี่คนก็ทำให้ทั้งร้านหมดได้ จึงแยกตามว่า **ใครกดยืนยัน** (`orders.confirmed_by_role` = `owner` | `demo`, migration `0002`):

- **owner ยืนยัน** = ขายถาวร (สินค้า `sold`) ไม่คืนเอง — เจ้าของคืนสินค้าเข้าร้านเองได้จากหน้าออเดอร์หลังบ้านด้วยปุ่ม "คืนสินค้าเข้าร้าน" (ต้องใส่เหตุผล; ใช้ได้กับ `confirmed`/`shipped`/`completed`)
- **demo ยืนยัน** = ออเดอร์ทดลอง: สินค้าถูกกัน (`reserved`) ถึง `confirmed_at + 20 นาที` (`DEMO_ORDER_RETURN_MINUTES` ใน `lib/availability.ts`) แล้วคืนเป็นว่างเอง ตัดสินแบบ lazy ด้วย `now()` ของ DB (ไม่มี cron เพิ่ม) หน้าออเดอร์/หลังบ้านจะแสดง "เดโมสิ้นสุดแล้ว" และนับในแท็บ "ปิดแล้ว"
- ระหว่าง 20 นาที ออเดอร์เดโมที่ยืนยันแล้วนับรวมในเพดาน "ถือสินค้าต่อ IP" (≤ 3) ด้วย
- นิยามว่าใครถือสินค้าอยู่มีที่เดียว: `lib/availability.ts` (`holdingOrderExistsSql`) และคำสั่งหลังบ้านที่แตะสินค้าล็อกแถวสินค้า (`SELECT ... FOR UPDATE`) ก่อนตัดสินเสมอ เพื่อไม่ให้ชนกับการจองที่เข้ามาพร้อมกัน

## ย้ายฐานข้อมูล (migration 0002)

เพิ่มคอลัมน์ `orders.confirmed_by_role` (nullable + CHECK) — additive ไม่ลบ/แก้ข้อมูลเดิม ออเดอร์ที่ยืนยันก่อนมีคอลัมน์ (NULL) ถือเป็นขายถาวร ฐานข้อมูลของโปรเจกต์นี้สร้างด้วย `npm run db:push` (ไม่มีตาราง migration history) จึงใช้ `npm run db:push` กับ Neon เดิมได้ (จะเห็นเพียง `ALTER TABLE ... ADD COLUMN` + `ADD CONSTRAINT`) หรือรันไฟล์ `db/migrations/0002_*.sql` ตรงๆ — ต้องทำก่อนรันแอปเวอร์ชันนี้ ไม่งั้นทุก query ของ orders ล้ม (ฐานข้อมูลใหม่ที่สร้างตามหัวข้อ Deploy ได้คอลัมน์นี้อยู่แล้ว)

## รูปสินค้า

เจ้าของร้านอัปโหลดรูปที่ `/admin/items/[id]` (Vercel Blob client upload → `items/`) Blob store ที่ใช้เก็บสลิปเป็นแบบ private (ระดับ access เป็นของ store ไม่ใช่รายไฟล์) รูปสินค้าจึงอยู่ใน store เดียวกันและถูกเสิร์ฟสาธารณะผ่าน `GET /api/item-images/<ชื่อไฟล์>` ซึ่งอ่านได้เฉพาะ `items/` และเฉพาะไฟล์ที่มีสินค้าอ้างอิงอยู่ ส่วนบัญชีเดโมอัปโหลด/ลบรูปและแก้สินค้าไม่ได้

รูปของสินค้าตัวอย่าง 12 ชิ้น (A001–A012) มาจาก Unsplash ตามที่ระบุใน `db/seed-data.json`

---

## ความปลอดภัยและ security headers

สรุปจาก [`SPEC.md`](./SPEC.md) §9: input ทุกตัวผ่าน Zod ฝั่ง server, ราคาคิดที่ server, order token สุ่ม 32 bytes, session ของหลังบ้านตรวจซ้ำทุก server action/route, สลิปไม่มี URL สาธารณะ, ไม่ log ข้อมูลส่วนบุคคล, `/api/cron/reset` ตรวจ Bearer แบบ timing-safe และ fail-closed

**Security headers ทั้งเว็บ** ตั้งใน `next.config.ts`: `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` (หน้าที่มี token ลับและหลังบ้านใช้ `no-referrer`), `X-Frame-Options: DENY` (+ `frame-ancestors 'none'`)

- CSP เป็นแบบ **static ไม่ใช้ nonce**: ตามเอกสาร Next 16 nonce บังคับให้ทุกหน้า render แบบ dynamic และใช้ร่วมกับ Cache Components ไม่ได้ จึงอนุญาต `'unsafe-inline'` ใน `script-src`/`style-src` (ข้อแลกเปลี่ยน: CSP นี้กัน script จากโดเมนอื่น, `eval`, การฝังหน้า และการส่งฟอร์มออกนอกเว็บ แต่ไม่กัน inline script ถ้ามีช่องโหว่ XSS) `'unsafe-eval'` มีเฉพาะ `next dev`
- ที่อนุญาตนอกเหนือจากโดเมนตัวเอง: รูปจาก `images.unsplash.com`, `data:`/`blob:` สำหรับรูป (QR และตัวอย่างรูปฝั่ง client), และ `https://vercel.com` ใน `connect-src` เพราะ `@vercel/blob` (client upload) ยิงไปที่ `https://vercel.com/api/blob/` — อ่านจาก SDK เวอร์ชันที่ติดตั้ง ยังไม่ได้ยิงอัปโหลดจริงบน Vercel
- Zod ถูกตั้ง `jitless` (ใน `lib/validation.ts`) เพราะโหมด JIT ใช้ `new Function` ซึ่ง CSP นี้บล็อก
- response ที่เป็นไฟล์รูปล้วน (proxy สลิปและรูปสินค้า) ได้ CSP ที่เข้มกว่า (`default-src 'none'; sandbox`) — header ใน `next.config.ts` ทับ header ที่ route ตั้งเอง จึงตั้งค่าซ้ำไว้ใน config และมีเทสต์ตรวจ

---

## เครดิตรูปภาพ (Unsplash)

รูปประกอบสินค้าเดโมทั้งหมดมาจาก [Unsplash](https://unsplash.com) ตามเงื่อนไขของ Unsplash License ไม่ใช่ภาพถ่ายของสินค้าที่ขายจริง ชื่อช่างภาพของแต่ละรูปพร้อมลิงก์ไปยังโปรไฟล์แสดงอยู่ในส่วน "เครดิตภาพ" ท้ายหน้าสินค้าแต่ละชิ้น (`/item/A001` … `/item/A012`) และสรุปไว้ที่หน้า `/about` ข้อมูลเครดิตเดียวกันเก็บอยู่ในฟิลด์ `credit` ของแต่ละรูปใน `db/seed-data.json`
