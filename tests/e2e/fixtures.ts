import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { inArray } from "drizzle-orm";
import { getDb } from "../../db/client";
import { items, orderEvents, orders } from "../../db/schema";
import type { ItemImage } from "../../db/schema";

/**
 * สินค้า fixture สำหรับ e2e — ใช้รหัส T981-T991 เท่านั้น (ไม่แตะ seed A001-A012)
 * ลบเฉพาะแถวของตัวเอง (order_events -> orders -> items) ทั้งก่อนสร้างและหลังจบ
 */
export const E2E_CODES = {
  /** flow หลัก: จอง → กรอกฟอร์ม → QR → สลิปตัวอย่าง → awaiting_review */
  main: "T981",
  /** flow ยกเลิก */
  cancel: "T982",
  /** ขายแล้ว: หน้า checkout ต้องแสดงข้อความ ไม่ใช่ฟอร์ม */
  sold: "T983",
  /** ใช้ตรวจ UI ฝั่ง responsive/สกรีนช็อต (ส่งไปรษณีย์) */
  post: "T984",
  /** ชุดทดสอบ API: ราคาปลอม / rate limit / 409 */
  api1: "T985",
  api2: "T986",
  api3: "T987",
  /** ชุดทดสอบ rate limit ต่อ IP (ไม่ส่ง cookie, IP เดียวกัน) */
  ip1: "T988",
  ip2: "T989",
  ip3: "T990",
  ip4: "T991",
  /** หลังบ้าน (admin.spec.ts) — รหัส V001-V005 ไม่ชนกับ integration test (T901-T999, U801-U860) */
  adminConfirm: "V001",
  adminReject: "V002",
  adminShip: "V003",
  demoOwn: "V004",
  demoOther: "V005",
  /** demo ปฏิเสธออเดอร์ของตัวเอง (ตรวจป้ายข้อความจากผู้ลองเดโมฝั่งลูกค้า) */
  demoOwnReject: "V006",
  /** จัดการสินค้า (admin-items.spec.ts) — แก้ราคา / เปลี่ยนสถานะเร็ว / สินค้าที่ออเดอร์ถือ / demo ดูอย่างเดียว */
  itemEdit: "V007",
  itemStatus: "V008",
  itemHeld: "V009",
  itemDemo: "V010",
  /** คืนสินค้าเข้าร้านโดย owner / ออเดอร์เดโมสิ้นสุดแล้ว (admin.spec.ts) */
  ownerReturn: "V011",
  demoEnded: "V012",
  /** ตรวจ security headers / CSP ในเบราว์เซอร์จริง (security-headers.spec.ts) */
  csp: "V013",
} as const;

const ALL_CODES = [
  ...Array.from({ length: 11 }, (_, i) => `T${981 + i}`),
  ...Array.from({ length: 13 }, (_, i) => `V${String(i + 1).padStart(3, "0")}`),
];

function sampleImages(): ItemImage[] {
  // ใช้รูปของ seed เป็นข้อมูลตัวอย่าง (อ่านจากไฟล์ ไม่แตะ DB ของ seed)
  const raw = JSON.parse(readFileSync(resolve(process.cwd(), "db", "seed-data.json"), "utf8")) as {
    images: ItemImage[];
  }[];
  return raw[0].images.slice(0, 2);
}

export async function deleteFixtures() {
  const db = getDb();
  const ids = (await db.select({ id: items.id }).from(items).where(inArray(items.code, ALL_CODES))).map(
    (r) => r.id,
  );
  if (ids.length === 0) return;
  const orderIds = (
    await db.select({ id: orders.id }).from(orders).where(inArray(orders.itemId, ids))
  ).map((r) => r.id);
  if (orderIds.length > 0) {
    await db.delete(orderEvents).where(inArray(orderEvents.orderId, orderIds));
    await db.delete(orders).where(inArray(orders.id, orderIds));
  }
  await db.delete(items).where(inArray(items.id, ids));
}

/** สร้างเฉพาะเมื่อยังไม่ครบ (serve.ts สร้างไว้ก่อน build แล้ว) */
export async function ensureFixtures() {
  const rows = await getDb()
    .select({ id: items.id })
    .from(items)
    .where(inArray(items.code, Object.values(E2E_CODES)));
  if (rows.length !== Object.values(E2E_CODES).length) await createFixtures();
}

export async function createFixtures() {
  await deleteFixtures();
  const images = sampleImages();
  const base = {
    description: "สินค้าตัวอย่างสำหรับเทสต์ e2e (ไม่ใช่สินค้าจริง)",
    flaws: "ไม่มีตำหนิที่สังเกตเห็น",
    condition: "good" as const,
    category: "other" as const,
    images,
  };
  await getDb()
    .insert(items)
    .values([
      { ...base, code: E2E_CODES.main, title: "ของทดสอบ e2e หลัก", price: 450, sortOrder: -9 },
      { ...base, code: E2E_CODES.cancel, title: "ของทดสอบ e2e ยกเลิก", price: 320, sortOrder: -8 },
      {
        ...base,
        code: E2E_CODES.sold,
        title: "ของทดสอบ e2e ขายแล้ว",
        price: 200,
        status: "sold" as const,
        sortOrder: -7,
      },
      { ...base, code: E2E_CODES.post, title: "ของทดสอบ e2e ส่งไปรษณีย์", price: 600, sortOrder: -6 },
      { ...base, code: E2E_CODES.api1, title: "ของทดสอบ e2e API 1", price: 300, sortOrder: -5 },
      { ...base, code: E2E_CODES.api2, title: "ของทดสอบ e2e API 2", price: 310, sortOrder: -4 },
      { ...base, code: E2E_CODES.api3, title: "ของทดสอบ e2e API 3", price: 320, sortOrder: -3 },
      { ...base, code: E2E_CODES.ip1, title: "ของทดสอบ e2e IP 1", price: 100, sortOrder: -2 },
      { ...base, code: E2E_CODES.ip2, title: "ของทดสอบ e2e IP 2", price: 100, sortOrder: -2 },
      { ...base, code: E2E_CODES.ip3, title: "ของทดสอบ e2e IP 3", price: 100, sortOrder: -2 },
      { ...base, code: E2E_CODES.ip4, title: "ของทดสอบ e2e IP 4", price: 100, sortOrder: -2 },
      { ...base, code: E2E_CODES.adminConfirm, title: "ของทดสอบ e2e หลังบ้าน ยืนยัน", price: 410, sortOrder: 90 },
      { ...base, code: E2E_CODES.adminReject, title: "ของทดสอบ e2e หลังบ้าน ปฏิเสธ", price: 420, sortOrder: 91 },
      { ...base, code: E2E_CODES.adminShip, title: "ของทดสอบ e2e หลังบ้าน จัดส่ง", price: 430, sortOrder: 92 },
      { ...base, code: E2E_CODES.demoOwn, title: "ของทดสอบ e2e เดโม ของตัวเอง", price: 440, sortOrder: 93 },
      { ...base, code: E2E_CODES.demoOther, title: "ของทดสอบ e2e เดโม ของคนอื่น", price: 450, sortOrder: 94 },
      { ...base, code: E2E_CODES.demoOwnReject, title: "ของทดสอบ e2e เดโม ปฏิเสธเอง", price: 460, sortOrder: 95 },
      { ...base, code: E2E_CODES.itemEdit, title: "ของทดสอบ e2e แก้ราคา", price: 480, sortOrder: 96 },
      { ...base, code: E2E_CODES.itemStatus, title: "ของทดสอบ e2e เปลี่ยนสถานะ", price: 490, sortOrder: 97 },
      { ...base, code: E2E_CODES.itemHeld, title: "ของทดสอบ e2e ออเดอร์ถือ", price: 500, sortOrder: 98 },
      { ...base, code: E2E_CODES.itemDemo, title: "ของทดสอบ e2e เดโมดูสินค้า", price: 510, sortOrder: 99 },
      { ...base, code: E2E_CODES.ownerReturn, title: "ของทดสอบ e2e คืนสินค้า", price: 520, sortOrder: 100 },
      { ...base, code: E2E_CODES.demoEnded, title: "ของทดสอบ e2e เดโมสิ้นสุด", price: 530, sortOrder: 101 },
      { ...base, code: E2E_CODES.csp, title: "ของทดสอบ e2e ตรวจ CSP", price: 540, sortOrder: 102 },
    ]);
}

// รันตรงๆ: tsx --env-file=.env.local tests/e2e/fixtures.ts create|delete
if (process.argv[1] && /fixtures\.ts$/.test(process.argv[1])) {
  const cmd = process.argv[2];
  const run = cmd === "create" ? createFixtures : cmd === "delete" ? deleteFixtures : null;
  if (!run) {
    console.error("usage: fixtures.ts create|delete");
    process.exit(1);
  }
  run()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e instanceof Error ? e.name : "error");
      process.exit(1);
    });
}
