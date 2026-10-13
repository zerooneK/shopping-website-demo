/**
 * ตัวช่วยของ proxy สลิปหลังบ้าน (pure)
 *
 * ไม่เชื่อ content-type ที่ Blob รายงาน: ตรวจ "ลายเซ็นไฟล์" (magic bytes) จากเนื้อไฟล์จริง แล้วตอบด้วย
 * Content-Type จาก allowlist เท่านั้น (jpeg/png/webp/heic) — ไฟล์อื่นที่ไม่ใช่รูป (เช่น HTML/SVG ที่แอบอัป)
 * จะไม่ถูกส่งต่อ
 *
 * HEIC: ลูกค้าอัปโหลดได้ (SPEC §6) แต่ browser ส่วนใหญ่แสดงไม่ได้ → ตรวจลายเซ็น ISO-BMFF
 * (`ftyp` + brand heic/heix/mif1/heim/hevc) แล้วเสิร์ฟเป็น attachment ให้ดาวน์โหลดเท่านั้น (ไม่ inline)
 * ไฟล์ ISO-BMFF ที่ brand อื่น (mp4, mov, avif ฯลฯ) อยู่นอก allowlist = ไม่ส่งต่อ (415)
 */

export const SLIP_PROXY_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic"] as const;
export type SlipProxyType = (typeof SLIP_PROXY_TYPES)[number];

/** ชนิดที่ browser แสดงในหน้าเว็บ (<img>) ได้ — ที่เหลือเสิร์ฟเป็นไฟล์ดาวน์โหลด */
export function isInlineSlipType(type: SlipProxyType): boolean {
  return type !== "image/heic";
}

/** major brand ของไฟล์ HEIC/HEIF ที่ยอมรับ */
const HEIC_BRANDS: ReadonlySet<string> = new Set(["heic", "heix", "mif1", "heim", "hevc"]);

function ascii(bytes: Uint8Array, from: number, to: number): string {
  let out = "";
  for (let i = from; i < to; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

export function sniffImageType(bytes: Uint8Array): SlipProxyType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  // RIFF....WEBP
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  // ISO-BMFF: [size:4]["ftyp"][major brand:4]
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === "ftyp" && HEIC_BRANDS.has(ascii(bytes, 8, 12))) {
    return "image/heic";
  }
  return null;
}

/** header ความปลอดภัยของ response สลิป (ไม่ cache, ไม่ sniff, ไม่ฝังจากเว็บอื่น, ไม่ส่ง referrer) */
export function slipResponseHeaders(type: SlipProxyType, length: number): Record<string, string> {
  return {
    "Content-Type": type,
    "Content-Length": String(length),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
    // HEIC (browser แสดงไม่ได้) = ดาวน์โหลดเท่านั้น; ชื่อไฟล์ตายตัว ไม่ใช้ค่าจากผู้ใช้
    "Content-Disposition": isInlineSlipType(type) ? "inline" : 'attachment; filename="slip.heic"',
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; sandbox",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
  };
}

export class SlipTooLargeError extends Error {
  constructor() {
    super("slip too large");
    this.name = "SlipTooLargeError";
  }
}

/** อ่าน stream ทั้งก้อนแต่ไม่เกิน maxBytes (เกิน → ยกเลิก stream แล้ว throw SlipTooLargeError) */
export async function readStreamCapped(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new SlipTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
