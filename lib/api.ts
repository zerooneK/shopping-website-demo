import { NextResponse } from "next/server";
import { z } from "zod";
import { createOrderSchema, type CreateOrderInput } from "./validation";

/** ตัวช่วยของ route handler ฝั่งลูกค้า */

export const NO_STORE = { "Cache-Control": "no-store" } as const;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return NextResponse.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

const MAX_BODY_BYTES = 16 * 1024;

export type JsonBodyResult =
  | { ok: true; body: unknown }
  | { ok: false; response: NextResponse };

/**
 * อ่าน JSON body อย่างปลอดภัย:
 *  - ต้องเป็น application/json (ทำให้ฟอร์มข้ามเว็บ/ cross-site POST แบบ simple request ใช้ไม่ได้ — กัน CSRF พื้นฐาน)
 *  - จำกัดขนาด
 */
export async function readJsonBody(request: Request): Promise<JsonBodyResult> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) {
    return { ok: false, response: json({ error: "ต้องส่งข้อมูลเป็น JSON" }, 415) };
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, response: json({ error: "อ่านข้อมูลไม่ได้" }, 400) };
  }
  if (text.length > MAX_BODY_BYTES) {
    return { ok: false, response: json({ error: "ข้อมูลใหญ่เกินไป" }, 413) };
  }
  try {
    return { ok: true, body: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, response: json({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400) };
  }
}

export type FieldErrors = Record<string, string[]>;

export type ParseOrderResult =
  | { ok: true; input: CreateOrderInput }
  | { ok: false; fieldErrors: FieldErrors };

/**
 * ตรวจ body ของ POST /api/orders ด้วย createOrderSchema
 * key ที่ไม่รู้จัก (เช่น price/amount ที่ client แอบส่งมา) ถูก strip ทิ้งโดย schema — ราคาคิดที่ server เท่านั้น
 */
export function parseCreateOrderBody(body: unknown): ParseOrderResult {
  const parsed = createOrderSchema.safeParse(body);
  if (parsed.success) return { ok: true, input: parsed.data };
  return { ok: false, fieldErrors: z.flattenError(parsed.error).fieldErrors as FieldErrors };
}
