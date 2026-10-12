import { deleteFixtures } from "./fixtures";

// ลบเฉพาะสินค้า/ออเดอร์/event ของ fixture (T981-T989) — ไม่แตะ seed
export default async function globalTeardown() {
  await deleteFixtures();
}
