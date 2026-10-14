/**
 * ลบไฟล์สลิปใน Vercel Blob ใต้ prefix `slips/` เป็นหน้าๆ (list + del) — ขั้นหนึ่งของ cron รีเซ็ตรายวัน
 *
 * ความปลอดภัยของข้อมูล:
 *  - ลบเฉพาะ pathname ที่ขึ้นต้นด้วย `slips/` (ตรวจซ้ำทุกไฟล์ก่อนลบ ไม่เชื่อ prefix ของ list อย่างเดียว) → รูปสินค้า (`items/`) ไม่มีทางถูกลบ
 *  - list จากทั้ง prefix ไม่ใช่เฉพาะที่อ้างจาก DB เพราะมีไฟล์กำพร้าได้ (อัปโหลดแล้วไม่ได้บันทึก)
 *  - ลบเฉพาะไฟล์ที่อัปโหลด "ก่อน" เวลาเริ่มรีเซ็ต (before) กันลบสลิปของออเดอร์ใหม่ที่เกิดระหว่างรีเซ็ต
 *  - จำกัดจำนวนหน้า/ไฟล์สูงสุดต่อรอบ (กันวนไม่รู้จบ/เกินเวลา function) ที่เหลือจะถูกลบในรอบถัดไป
 */

export const SLIP_BLOB_PREFIX = "slips/";

export type BlobListItem = { pathname: string; uploadedAt: Date };
export type BlobApi = {
  list(o: { prefix: string; cursor?: string; limit: number }): Promise<{
    blobs: BlobListItem[];
    cursor?: string;
    hasMore: boolean;
  }>;
  del(pathnames: string[]): Promise<void>;
};

export type BlobCleanupResult = {
  deleted: number;
  /** เจอแต่ไม่ลบ เพราะอัปโหลดหลังเวลา before */
  skippedNewer: number;
  /** ไม่ลบเพราะ pathname ไม่ขึ้นต้น slips/ (ไม่ควรเกิด) */
  skippedOutsidePrefix: number;
  pages: number;
  /** true = ถึงเพดานหน้าที่ตั้งไว้แล้วยังเหลือ (จะลบต่อรอบหน้า) */
  truncated: boolean;
};

export const LIST_PAGE_SIZE = 500;
export const DEL_CHUNK = 100;
export const MAX_PAGES = 40;

export async function cleanSlipBlobs(
  api: BlobApi,
  opts: { before: Date; maxPages?: number },
): Promise<BlobCleanupResult> {
  const maxPages = opts.maxPages ?? MAX_PAGES;
  const out: BlobCleanupResult = {
    deleted: 0,
    skippedNewer: 0,
    skippedOutsidePrefix: 0,
    pages: 0,
    truncated: false,
  };

  let cursor: string | undefined;
  for (;;) {
    if (out.pages >= maxPages) {
      out.truncated = true;
      break;
    }
    const page = await api.list({ prefix: SLIP_BLOB_PREFIX, cursor, limit: LIST_PAGE_SIZE });
    out.pages += 1;

    const victims: string[] = [];
    for (const b of page.blobs) {
      if (!b.pathname.startsWith(SLIP_BLOB_PREFIX)) {
        out.skippedOutsidePrefix += 1;
      } else if (b.uploadedAt.getTime() >= opts.before.getTime()) {
        out.skippedNewer += 1;
      } else {
        victims.push(b.pathname);
      }
    }
    for (let i = 0; i < victims.length; i += DEL_CHUNK) {
      const chunk = victims.slice(i, i + DEL_CHUNK);
      await api.del(chunk);
      out.deleted += chunk.length;
    }

    if (!page.hasMore || !page.cursor) break;
    cursor = page.cursor;
  }
  return out;
}
