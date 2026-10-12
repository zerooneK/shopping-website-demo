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

## รูปแบบ `docs/BUILD_LOG.md`
เพิ่มต่อท้ายเสมอ ห้ามแก้รายการเก่า:
```
## <วันที่> · ขั้น <x> · <agent> (<model> · <effort>)
- งาน: ...
- ผล: ผ่าน/ไม่ผ่าน (เทสต์ที่รัน)
- ปัญหาที่เจอ / การ escalate: ...
```
