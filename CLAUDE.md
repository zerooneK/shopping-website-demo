# shop-website — กฎของทีม AI

เว็บร้านขายของมือสองแบบ **เดโม** (showcase) ห้ามรับเงินจริง — สเปคหลักอยู่ที่ `SPEC.md`
แผนต้นทาง: Notion "แผนสร้างร้านขายของมือสอง ด้วย AI Team"

## ทีม
| บทบาท | Agent | โมเดล · Effort เริ่มต้น | งาน |
|---|---|---|---|
| Orchestrator | session หลัก | — | แบ่งงาน ส่งต่อ ตัดสินใจ คุยกับผู้ใช้ deploy/push (เมื่อผู้ใช้อนุมัติ) |
| Builder | `shop-builder` | Sonnet · medium | เขียนโค้ดทั้งหมด |
| Reviewer | `shop-reviewer` | Opus · medium (re-review จุดเล็ก: low) | ตรวจระบบสั่งซื้อ สลิป ความปลอดภัย — อ่านอย่างเดียว |
| Writer | `shop-writer` | Haiku · low | ข้อมูลสินค้า คอนเทนต์ TikTok |

## วิธีเรียก agent (สำคัญ — อ่านก่อนสั่งงานทุกครั้ง)
session นี้เรียก `shop-builder` / `shop-reviewer` / `shop-writer` ด้วยชื่อตรงๆ ไม่ได้ (ไฟล์ถูกสร้างหลัง session เริ่ม ผู้ใช้ตกลงไม่รีสตาร์ต) **ให้เรียกแบบนี้เสมอ:**
- `subagent_type: "general-purpose"` + ตั้ง `model` และ `effort` ตามตารางทีม (override ตามกฎ effort ด้านล่าง)
- ขึ้นต้น prompt ให้ agent **อ่านไฟล์บทบาทก่อนเริ่ม** แล้วทำตามทุกข้อ: `D:\showcase-project\.claude\agents\shop-builder.md` (หรือ `shop-reviewer.md` / `shop-writer.md`, ข้ามส่วน frontmatter) + `CLAUDE.md` + `SPEC.md` + `AGENTS.md` และเอกสาร Next.js 16 ใน `node_modules/next/dist/docs/` เมื่อแตะโค้ด Next
- ไฟล์บทบาทเป็นแหล่งความจริงของกฎ ห้ามย่อ/ถอดความ แค่สั่งให้อ่าน
- agent ทั่วไปมีสิทธิ์เขียนไฟล์เสมอ → Reviewer ต้องมีข้อความ "**อ่านอย่างเดียว ห้ามแก้/สร้าง/ลบไฟล์ ห้าม commit/push ห้ามฆ่า process ตามชื่อ ห้ามแตะ .env.local**" ใน prompt ทุกครั้ง (ข้อห้ามเป็นแค่คำสั่ง ไม่ใช่สิทธิ์เครื่องมือ)
- ทุก prompt ของ Builder ต้องใส่: ห้าม commit/push/deploy, ห้ามแสดง/log secret, ต้องรายงานแยก "ทดสอบกับของจริงแล้ว" กับ "ยังไม่ได้ทดสอบ"

## กฎการปรับ Effort (ผู้ใช้อนุญาตให้ orchestrator override effort ตามกฎนี้)
1. เริ่มทุกงานที่ effort เริ่มต้นตามตาราง
2. งานไม่ผ่านเทสต์หรือรีวิว → ส่งกลับให้ agent เดิมแก้ที่ effort สูงขึ้นทีละขั้น: medium → high → xhigh
3. Builder ที่ xhigh ยังทำไม่ได้ → ส่งงานนั้นให้ Opus (override `model: opus`) ห้ามดันไป max
4. งานซ้ำๆ/กลไก (แก้ lint, rename, format) → ลดเป็น low
5. ไม่ใช้ max เป็นค่าเริ่มต้นเด็ดขาด

## Workflow ต่อขั้น
`Builder ทำ → Builder รัน lint/typecheck/test/build → Reviewer ตรวจ (ขั้นที่แตะ order/slip/auth) → Builder แก้ → บันทึก BUILD_LOG`

ขั้นตาม SPEC §11: 3a (scaffold + DB + reserve/transition) → 3b (หน้าบ้าน) → 3c (หลังบ้าน + demo + cron) → 4 (seed content) → 5 (review รวม + deploy)

## ข้อตกลงทางเทคนิค
- Package manager: **npm** (ไม่ใช้ pnpm/yarn)
- OS ของผู้พัฒนา: Windows 11
- Secret อยู่ใน `.env.local` เท่านั้น มี `.env.example` เป็นแม่แบบ
- ห้าม deploy / push / สร้างทรัพยากรบนบริการภายนอก โดยไม่ผ่านผู้ใช้
- **ห้ามฆ่า process ตามชื่อ** (`taskkill /IM node.exe`, `pkill node`, `Stop-Process -Name node` ฯลฯ) เพราะปิดโปรแกรมอื่นของผู้ใช้ด้วย — ให้หยุดเฉพาะ process ที่ตัวเองเปิด ด้วย PID ของมัน (หรือใช้ preview_stop / ให้ Playwright `webServer` จัดการเอง) ถ้าหา PID ไม่ได้ ให้รายงานแทนการฆ่า

## บทเรียนที่ต้องไม่ลืม (จากขั้น 3a–3b-2 รายละเอียดเต็มอยู่ใน `docs/BUILD_LOG.md`)
- **ห้ามเชื่อรายงานของ agent ลอยๆ** orchestrator ต้องรัน test/lint/typecheck/integration เองซ้ำ และตรวจ diff ว่าแก้นอกขอบเขตไหม ก่อน commit ทุกครั้ง
- **ข้อกำหนดที่ orchestrator เพิ่มเองก็ต้องผ่านรีวิว** (เพดานรวมทั้งร้านที่สั่งเองปิดร้านถาวรได้ จนรีวิวรอบ 2 จับได้)
- **รีวิวไม่ผ่าน → ขยับ effort ทันทีตามกฎ** (เคยส่งแก้ที่ medium เดิมโดยผิดกฎ) และ Reviewer ต้องมีรอบตรวจซ้ำก่อน commit เมื่อ FAIL
- **งานเลือกรูป/ข้อมูลภายนอกต้องดูของจริงก่อนเลือก** (โหลดภาพมาเปิดดู ไม่เลือกจากชื่อ/แท็ก) และทุก URL ต้องตรวจด้วย curl
- **เทสต์ที่ assert หลวมบังบั๊กได้** ต้อง assert ผลที่เจาะจง (เช่นขายซ้ำต้องได้ `unavailable` และออเดอร์ยังมี 1 ใบ) และ SQL ที่เกี่ยวกับ concurrency ต้องมี integration test กับ Neon จริง ไม่ใช่แค่ in-memory
- **เวลาตัดสินหมดอายุใช้ `now()` ของ DB เท่านั้น** ไม่ใช้เวลาจากแอป
- **ข้อความบนเว็บต้องไม่อ้างสิ่งที่ยังไม่ได้ทำ/ยังไม่ได้พิสูจน์** (เช่น "รีเซ็ตทุกวัน", "เก็บแบบ private")
- **ห้ามฆ่า process ตามชื่อ** (agent เคยปิด Node ทั้งเครื่อง) — ใช้ PID ของตัวเอง
- **Windows/shell:** connection string มี `&` ใช้ `source .env` ไม่ได้ ให้โหลดผ่าน `node --env-file=.env.local`

## สถานะ (อัปเดตเมื่อจบแต่ละขั้น)
เสร็จ: 2 (สเปค), 3a, 3b-1, 3b-2, 4 · ถัดไป: **3c** (หลังบ้าน auth owner/demo, หน้าตรวจออเดอร์, จัดการสินค้า, cron รีเซ็ต+ลบ blob) แล้ว **5** (รีวิวรวม + deploy)
**เงื่อนไขบังคับก่อน deploy:** รีเซ็ตรายวัน + หลังบ้าน reject (กันล็อกสินค้า), `SESSION_SECRET` ใน Vercel ทั้ง Production/Preview, Blob store + `BLOB_READ_WRITE_TOKEN` + ทดสอบอัปไฟล์จริง, คืนข้อความ "รีเซ็ตทุกวัน" ใน แถบเดโม/about/privacy, ตรวจ checklist ท้าย `docs/BUILD_LOG.md`

## รูปแบบ `docs/BUILD_LOG.md`
เพิ่มต่อท้ายเสมอ ห้ามแก้รายการเก่า:
```
## <วันที่> · ขั้น <x> · <agent> (<model> · <effort>)
- งาน: ...
- ผล: ผ่าน/ไม่ผ่าน (เทสต์ที่รัน)
- ปัญหาที่เจอ / การ escalate: ...
```
