import { ensureFixtures } from "./fixtures";

// serve.ts สร้าง fixture ไว้ก่อน build แล้ว; ตรงนี้เป็นตาข่ายกันพลาด (สร้างเฉพาะเมื่อยังไม่ครบ)
export default async function globalSetup() {
  await ensureFixtures();
}
