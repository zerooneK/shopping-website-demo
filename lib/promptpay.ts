import generatePayload from "promptpay-qr";
import QRCode from "qrcode";

/**
 * QR PromptPay แบบเดโม — encode เลขที่ใช้โอนไม่ได้จริงเสมอ (SPEC §7)
 * ไม่รับเลขปลายทางจากภายนอก เพื่อไม่ให้เผลอใช้เลขจริง
 */
export const DEMO_PROMPTPAY_TARGET = "0000000000";

export function buildDemoPayload(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new RangeError("amount must be a positive number");
  }
  return generatePayload(DEMO_PROMPTPAY_TARGET, { amount });
}

/** data URL (PNG) ของ QR — ลายน้ำ "DEMO" ซ้อนทับตอนแสดงผลที่ฝั่ง UI (ขั้น 3b) */
export async function buildDemoQrDataUrl(amount: number): Promise<string> {
  return QRCode.toDataURL(buildDemoPayload(amount), {
    errorCorrectionLevel: "H",
    margin: 2,
    width: 320,
  });
}
