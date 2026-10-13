/**
 * ตัวตรวจ Origin สำหรับ mutation ของหลังบ้าน (กัน CSRF ซ้อนอีกชั้นนอกเหนือจาก SameSite=Lax
 * และการตรวจ Origin/Host ในตัวของ Next Server Actions)
 *
 * กฎ (fail-closed):
 *  - ต้องมี header Origin และเป็น URL ที่ถูกต้อง (บราวเซอร์ส่ง Origin ทุก POST ข้ามหน้า/ฟอร์ม)
 *  - host:port ของ Origin ต้องตรงกับ x-forwarded-host (ค่าแรก) หรือ host ของคำขอ
 *  - "null" (sandbox/redirect ข้ามเว็บ) ถูกปฏิเสธ
 */
export type OriginHeaders = Pick<Headers, "get">;

export function isSameOrigin(headers: OriginHeaders): boolean {
  const origin = headers.get("origin");
  if (!origin || origin === "null") return false;

  let originHost: string;
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    originHost = url.host.toLowerCase();
  } catch {
    return false;
  }

  const forwarded = headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = (forwarded || headers.get("host") || "").trim().toLowerCase();
  if (!host) return false;
  return originHost === host;
}
