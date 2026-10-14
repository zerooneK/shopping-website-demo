"use server";

import { BlobNotFoundError, del, head } from "@vercel/blob";
import { eq } from "drizzle-orm";
import { revalidatePath, updateTag } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { items } from "@/db/schema";
import type { ItemImage } from "@/db/schema";
import type { ActionState } from "@/lib/admin/action-state";
import {
  changeItemStatus,
  createItem,
  deleteItem,
  updateItem,
  type ItemCommandError,
  type ItemFields,
} from "@/lib/admin/item-commands";
import {
  IMAGE_ERROR_MESSAGE,
  verifyItemImages,
  type ImageVerifyDeps,
} from "@/lib/admin/item-images";
import {
  firstIssuePerField,
  formDataToRecord,
  ITEM_FORM_KEYS,
  itemCreateSchema,
  itemIdSchema,
  itemStatusChangeSchema,
  itemUpdateSchema,
} from "@/lib/admin/item-validation";
import { can, type AdminSession, type Permission } from "@/lib/auth";
import { getSession, requestHasSameOrigin } from "@/lib/auth-server";
import { isValidItemImagePathname } from "@/lib/item-image";
import { unreferencedUploadPathnames } from "@/lib/item-image-ref";

/**
 * Server Actions จัดการสินค้า (ขั้น 3c-2)
 *
 * ลำดับตรวจทุก action (ไม่พึ่ง proxy.ts / layout): Origin → session → สิทธิ์ role → Zod → ตรวจรูป → คำสั่งใน DB
 *  - owner: ทำได้ทุกอย่าง
 *  - demo: ดูอย่างเดียว (ไม่มี item.edit / image.upload / item.delete) — ถูกปฏิเสธที่นี่แม้ฟอร์มถูกแก้ด้วย devtools
 * หลังบันทึกสำเร็จเรียก updateTag("items") (read-your-own-writes: เจ้าของเห็นหน้าร้านเปลี่ยนทันที ไม่ได้ stale-while-revalidate)
 * ห้าม log ข้อมูลผู้ใช้ — log เฉพาะชื่อชนิดของ error
 */

const BAD_ORIGIN: ActionState = { error: "คำขอไม่ถูกต้อง กรุณาโหลดหน้านี้ใหม่แล้วลองอีกครั้ง" };
const NO_SESSION: ActionState = { error: "เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่" };
const FORBIDDEN: ActionState = { error: "บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้ (โหมดเดโมดูสินค้าได้อย่างเดียว)" };
const SERVER_ERROR: ActionState = { error: "ระบบขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้ง" };

const COMMAND_MESSAGE: Record<ItemCommandError, string> = {
  not_found: "ไม่พบสินค้านี้ (อาจถูกลบไปแล้ว)",
  code_taken: "รหัสสินค้านี้ถูกใช้แล้ว กรุณาใช้รหัสอื่น",
  item_held:
    "สินค้านี้มีออเดอร์ถืออยู่ เปลี่ยนสถานะไม่ได้ กรุณายืนยันหรือปฏิเสธออเดอร์ที่เกี่ยวข้องก่อน",
  images_required: "สินค้าที่แสดงบนหน้าร้านต้องมีรูปอย่างน้อย 1 รูป (หรือตั้งสถานะเป็นซ่อนไว้เป็นฉบับร่างก่อน)",
  has_orders: "สินค้านี้มีประวัติออเดอร์จึงลบไม่ได้ ให้ตั้งสถานะเป็นซ่อนแทน",
};

type Guard = { ok: true; session: AdminSession } | { ok: false; state: ActionState };

async function guard(permission: Permission): Promise<Guard> {
  if (!(await requestHasSameOrigin())) return { ok: false, state: BAD_ORIGIN };
  const session = await getSession();
  if (!session) return { ok: false, state: NO_SESSION };
  if (!can(session, permission)) return { ok: false, state: FORBIDDEN };
  return { ok: true, session };
}

function blobDeps(): ImageVerifyDeps {
  return {
    blobConfigured: !!process.env.BLOB_READ_WRITE_TOKEN,
    head: async (pathname) => {
      try {
        const m = await head(pathname);
        return { pathname: m.pathname, contentType: m.contentType, size: m.size };
      } catch (e) {
        if (e instanceof BlobNotFoundError) return null;
        throw e;
      }
    },
  };
}

/** ลบไฟล์รูปที่ไม่ใช้แล้ว (เฉพาะ items/ ที่ผ่านการตรวจรูปแบบ) — ล้มเหลวไม่กระทบผลบันทึก (เหลือไฟล์กำพร้าได้) */
async function deleteBlobFiles(pathnames: string[]): Promise<void> {
  const safe = pathnames.filter(isValidItemImagePathname);
  if (safe.length === 0 || !process.env.BLOB_READ_WRITE_TOKEN) return;
  try {
    await del(safe);
  } catch (e) {
    console.error("[admin-items] blob cleanup failed:", e instanceof Error ? e.name : "unknown");
  }
}

/**
 * ลบไฟล์ของรูปที่เพิ่งถูกเอาออก (หลัง commit) — ใช้ `removed` ที่คำสั่งคืนมาจากแถวที่ล็อกแล้ว (ไม่ใช่ที่อ่านนอก tx)
 * และข้ามไฟล์ที่ยังมีสินค้าอื่นอ้างอยู่; เช็ก DB ไม่ได้ = ไม่ลบอะไร
 */
async function cleanupRemovedImages(db: ReturnType<typeof getDb>, removed: readonly ItemImage[]): Promise<void> {
  if (removed.length === 0) return;
  let pathnames: string[];
  try {
    pathnames = await unreferencedUploadPathnames(db, removed);
  } catch (e) {
    console.error("[admin-items] reference check failed; skipping blob cleanup:", e instanceof Error ? e.name : "unknown");
    return;
  }
  await deleteBlobFiles(pathnames);
}

function afterWrite() {
  updateTag("items");
  revalidatePath("/admin", "layout");
}

function fieldsOf(d: ItemFields): ItemFields {
  return {
    title: d.title,
    description: d.description,
    flaws: d.flaws,
    condition: d.condition,
    category: d.category,
    price: d.price,
    sortOrder: d.sortOrder,
  };
}

// ----------------------------------------------------------------------------------------------

export async function createItemAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const g = await guard("item.edit");
  if (!g.ok) return g.state;
  if (!can(g.session, "image.upload")) return FORBIDDEN;

  const parsed = itemCreateSchema.safeParse(formDataToRecord(formData, ITEM_FORM_KEYS));
  if (!parsed.success) {
    return { error: "กรุณาตรวจข้อมูลในฟอร์มอีกครั้ง", fieldErrors: firstIssuePerField(parsed.error) };
  }
  const d = parsed.data;

  const verified = await verifyItemImages(d.images, [], blobDeps());
  if (!verified.ok) {
    return { error: IMAGE_ERROR_MESSAGE[verified.error], fieldErrors: { images: IMAGE_ERROR_MESSAGE[verified.error] } };
  }

  let result;
  try {
    result = await createItem(getDb(), {
      code: d.code,
      fields: fieldsOf(d),
      images: verified.images,
      status: d.status,
    });
  } catch (e) {
    console.error("[admin-items] create failed:", e instanceof Error ? e.name : "unknown");
    return SERVER_ERROR;
  }
  if (!result.ok) {
    return {
      error: COMMAND_MESSAGE[result.error],
      fieldErrors: result.error === "code_taken" ? { code: COMMAND_MESSAGE.code_taken } : undefined,
    };
  }

  afterWrite();
  redirect(`/admin/items/${result.id}`);
}

export async function updateItemAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const g = await guard("item.edit");
  if (!g.ok) return g.state;

  const idParsed = itemIdSchema.safeParse(formData.get("itemId"));
  if (!idParsed.success) return { error: COMMAND_MESSAGE.not_found };
  const itemId = idParsed.data;

  const parsed = itemUpdateSchema.safeParse(formDataToRecord(formData, ITEM_FORM_KEYS));
  if (!parsed.success) {
    return { error: "กรุณาตรวจข้อมูลในฟอร์มอีกครั้ง", fieldErrors: firstIssuePerField(parsed.error) };
  }
  const d = parsed.data;

  const db = getDb();
  let existing: ItemImage[];
  try {
    const [row] = await db.select({ images: items.images }).from(items).where(eq(items.id, itemId));
    if (!row) return { error: COMMAND_MESSAGE.not_found };
    existing = row.images;
  } catch (e) {
    console.error("[admin-items] read failed:", e instanceof Error ? e.name : "unknown");
    return SERVER_ERROR;
  }

  const verified = await verifyItemImages(d.images, existing, blobDeps());
  if (!verified.ok) {
    return { error: IMAGE_ERROR_MESSAGE[verified.error], fieldErrors: { images: IMAGE_ERROR_MESSAGE[verified.error] } };
  }
  // เพิ่ม/ลบ/สลับรูป = สิทธิ์อัปโหลดรูป (ตรวจซ้ำแยกจาก item.edit) — แก้เฉพาะคำอธิบายรูป (alt) ไม่นับ
  const urlsBefore = existing.map((i) => i.url).join("\n");
  const urlsAfter = verified.images.map((i) => i.url).join("\n");
  if (urlsBefore !== urlsAfter && !can(g.session, "image.upload")) return FORBIDDEN;

  let result;
  try {
    result = await updateItem(db, {
      id: itemId,
      fields: fieldsOf(d),
      images: verified.images,
      status: d.status,
    });
  } catch (e) {
    console.error("[admin-items] update failed:", e instanceof Error ? e.name : "unknown");
    return SERVER_ERROR;
  }
  if (!result.ok) return { error: COMMAND_MESSAGE[result.error] };

  afterWrite();
  // ลบไฟล์หลัง invalidate cache (หน้าร้านเลิกอ้างรูปเก่าแล้ว) — best-effort
  await cleanupRemovedImages(db, result.removedImages);
  return { ok: true, message: "บันทึกสินค้าแล้ว" };
}

export async function changeItemStatusAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const g = await guard("item.edit");
  if (!g.ok) return g.state;

  const parsed = itemStatusChangeSchema.safeParse({
    itemId: formData.get("itemId"),
    status: formData.get("status"),
  });
  if (!parsed.success) return { error: "ข้อมูลไม่ถูกต้อง" };

  let result;
  try {
    result = await changeItemStatus(getDb(), { id: parsed.data.itemId, status: parsed.data.status });
  } catch (e) {
    console.error("[admin-items] status failed:", e instanceof Error ? e.name : "unknown");
    return SERVER_ERROR;
  }
  if (!result.ok) return { error: COMMAND_MESSAGE[result.error] };

  if (result.changed) afterWrite();
  return { ok: true, message: result.changed ? "เปลี่ยนสถานะแล้ว" : "สถานะเดิมอยู่แล้ว" };
}

export async function deleteItemAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const g = await guard("item.delete");
  if (!g.ok) return g.state;

  const idParsed = itemIdSchema.safeParse(formData.get("itemId"));
  if (!idParsed.success) return { error: COMMAND_MESSAGE.not_found };
  if (formData.get("confirm") !== "yes") return { error: "กรุณาติ๊กยืนยันก่อนลบสินค้า" };

  const db = getDb();
  let result;
  try {
    result = await deleteItem(db, { id: idParsed.data });
  } catch (e) {
    console.error("[admin-items] delete failed:", e instanceof Error ? e.name : "unknown");
    return SERVER_ERROR;
  }
  if (!result.ok) return { error: COMMAND_MESSAGE[result.error] };

  afterWrite();
  await cleanupRemovedImages(db, result.images);
  redirect("/admin/items");
}
