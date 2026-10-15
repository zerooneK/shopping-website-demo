import { del, list } from "@vercel/blob";
import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import seedData from "@/db/seed-data.json";
import { getDb } from "@/db/client";
import { parseSeedItems } from "@/db/seed-schema";
import { checkCronAuth } from "@/lib/cron/auth";
import { cleanSlipBlobs, type BlobApi, type BlobCleanupResult } from "@/lib/cron/blob-cleanup";
import { resetDemoData, type ResetRan } from "@/lib/cron/reset";
import { isDemoMode } from "@/lib/demo";

export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "no-store" } as const;

const blobApi: BlobApi = {
  list: async ({ prefix, cursor, limit }) => {
    const r = await list({ prefix, cursor, limit });
    return {
      blobs: r.blobs.map((b) => ({ pathname: b.pathname, uploadedAt: b.uploadedAt })),
      cursor: r.cursor,
      hasMore: r.hasMore,
    };
  },
  del: (pathnames) => del(pathnames),
};

function summarize(r: ResetRan) {
  return {
    ordersDeleted: r.ordersDeleted,
    eventsDeleted: r.eventsDeleted,
    itemsUpserted: r.itemsUpserted,
    itemsRemoved: r.itemsRemoved,
    soldCodes: r.soldCodes,
  };
}

/**
 * GET|POST /api/cron/reset — รีเซ็ตร้านเดโมรายวัน (SPEC §7) เรียกโดย Vercel Cron (GET + Authorization: Bearer CRON_SECRET)
 *
 * 1) ตรวจ Bearer แบบ timing-safe (ไม่ตั้ง CRON_SECRET = ปฏิเสธทุกคำขอ) — ไม่แตะ DB/Blob ก่อนผ่านด่านนี้
 * 1.5) ไม่ใช่โหมดเดโม (DEMO_MODE ไม่ใช่ "true") → 200 { status: "skipped_not_demo" } โดยไม่แตะ DB/Blob/cache — ร้านจริงที่ปิดเดโมแล้ว
 *    ต้องไม่โดนล้างออเดอร์และสินค้าทุกวัน (เช็กหลังตรวจ Bearer เพื่อไม่เปิดเผยโหมดของร้านให้คนที่ไม่มี secret)
 * 2) DB: resetDemoData (advisory lock + tx เดียว) — ถ้ามีรอบอื่นรันอยู่ ตอบ 200 skipped_locked
 * 3) Blob: ลบสลิปใต้ slips/ ที่อัปโหลดก่อนเริ่มรีเซ็ต (ไม่แตะ items/); ไม่มี BLOB_READ_WRITE_TOKEN (dev) = ข้ามพร้อม log
 *    ล้มเหลวที่ขั้นนี้ → 500 แต่ DB รีเซ็ตเสร็จแล้ว และรอบวันถัดไป list ทั้ง prefix จึงเก็บกวาดไฟล์ที่ค้างให้เอง
 * 4) revalidateTag("items", { expire: 0 }) ให้หน้าร้านเห็นข้อมูล seed ทันที (Route Handler ใช้ updateTag ไม่ได้ และรูปแบบ
 *    อาร์กิวเมนต์เดียวเลิกใช้แล้วตามเอกสาร Next 16)
 * ตอบเฉพาะจำนวน/รหัสสินค้า ไม่มี PII
 */
async function handle(request: Request): Promise<Response> {
  const auth = checkCronAuth(request.headers.get("authorization"), process.env.CRON_SECRET);
  if (auth !== "ok") {
    if (auth === "not_configured") console.error("[cron] CRON_SECRET is not set (or too short); rejecting");
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }

  if (!isDemoMode()) {
    console.info("[cron] DEMO_MODE is not true; skipping reset");
    return NextResponse.json({ status: "skipped_not_demo" }, { headers: NO_STORE });
  }

  let result;
  try {
    result = await resetDemoData(getDb(), { seedItems: parseSeedItems(seedData) });
  } catch (e) {
    console.error("[cron] reset failed:", e instanceof Error ? e.name : "unknown");
    return NextResponse.json({ error: "reset failed" }, { status: 500, headers: NO_STORE });
  }

  if (result.status === "skipped_locked") {
    return NextResponse.json({ status: "skipped_locked" }, { headers: NO_STORE });
  }

  revalidateTag("items", { expire: 0 });

  let blob: BlobCleanupResult | { skipped: "no_blob_token" };
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.warn("[cron] BLOB_READ_WRITE_TOKEN is not set; skipping slip file cleanup");
    blob = { skipped: "no_blob_token" };
  } else {
    try {
      blob = await cleanSlipBlobs(blobApi, { before: result.dbNow });
    } catch (e) {
      console.error("[cron] blob cleanup failed:", e instanceof Error ? e.name : "unknown");
      return NextResponse.json(
        { status: "db_reset_blob_failed", db: summarize(result) },
        { status: 500, headers: NO_STORE },
      );
    }
  }

  return NextResponse.json({ status: "ran", db: summarize(result), blob }, { headers: NO_STORE });
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
