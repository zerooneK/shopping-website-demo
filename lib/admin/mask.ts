/**
 * Mask ข้อมูลส่วนตัวของลูกค้าสำหรับ role demo (SPEC §7) — pure function ทำงานฝั่ง server เท่านั้น
 * ค่าจริงต้องไม่ถูกส่งไปถึง client: ชั้น view (lib/admin/view.ts) เรียกใช้ที่นี่ก่อนสร้าง DTO
 *
 * รูปแบบตาม SPEC: ชื่อ `ส***`, เบอร์ `08x-xxx-xx12`
 * ที่อยู่/หมายเหตุ: ไม่เปิดเผยแม้ความยาว (ใช้ข้อความคงที่)
 */

export const MASKED_ADDRESS = "(ซ่อนที่อยู่ในโหมดเดโม)";
export const MASKED_NOTE = "(ซ่อนหมายเหตุในโหมดเดโม)";

export function maskName(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? `${first}***` : "***";
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `${digits.slice(0, 2)}x-xxx-xx${digits.slice(-2)}`;
  return "xxx-xxx-xxxx";
}

export function maskAddress(address: string | null): string | null {
  return address && address.trim() ? MASKED_ADDRESS : null;
}

export function maskNote(note: string | null): string | null {
  return note && note.trim() ? MASKED_NOTE : null;
}
