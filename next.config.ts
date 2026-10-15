import type { NextConfig } from "next";

/**
 * Content-Security-Policy แบบ static (ไม่ใช้ nonce)
 *
 * ทำไมไม่ใช้ nonce: เอกสาร Next 16 (guides/content-security-policy.md) ระบุว่า nonce บังคับให้ "ทุกหน้า" render แบบ dynamic
 * และใช้ร่วมกับ Partial Prerendering / Cache Components (ที่โปรเจกต์นี้เปิดอยู่) ไม่ได้ จึงใช้แนวทาง "Without Nonces"
 * ของเอกสาร: script-src/style-src มี 'unsafe-inline' (Next ฝัง inline script ของ RSC payload และ React ใช้ style attribute)
 * ข้อแลกเปลี่ยน: CSP นี้กัน script จากโดเมนภายนอก/eval/ฝังหน้า/ส่งฟอร์มออกนอก แต่ไม่กัน inline script ถ้ามีช่อง XSS
 * (ป้องกัน XSS หลักยังเป็นการ escape ของ React + ไม่มี dangerouslySetInnerHTML)
 *
 * ที่มาของแต่ละ origin (ตรวจจากโค้ดจริง ไม่เดา):
 *  - img-src: data: = QR PromptPay ฝั่ง server (PaymentPanel), blob: = ตัวอย่าง/ผลย่อรูปฝั่ง client,
 *    images.unsplash.com = รูปสินค้าเดโม (next/image ปกติเรียกผ่าน /_next/image ซึ่งเป็น 'self' ใส่ไว้เป็นชั้นสำรอง)
 *    ไม่ใส่โดเมน Blob store เพราะ store เป็น private — รูปสินค้า/สลิปเสิร์ฟผ่าน /api/item-images และ /api/admin/slips เท่านั้น
 *  - font-src 'self': next/font/google ดาวน์โหลดฟอนต์ตอน build แล้วเสิร์ฟจาก /_next/static/media
 *  - connect-src: 'self' (poll สถานะออเดอร์, token ของ Blob upload, สลิปตัวอย่าง) + https://vercel.com
 *    เพราะ @vercel/blob@2.8.1 (client upload) ยิง PUT/POST ไปที่ https://vercel.com/api/blob/ ... (ค่า default ใน
 *    node_modules/@vercel/blob/dist, ไม่มีการเรียก *.blob.vercel-storage.com จากเบราว์เซอร์) — ไม่ใช้ path-scope เพราะ
 *    CSP ไม่ตรวจ path หลัง redirect และ API ปลายทางรับ token ของ store ใดก็ได้ จึงแคบลงไม่ได้ประโยชน์จริง แต่เสี่ยงพังถ้า SDK เปลี่ยน path
 *  - ไม่ใส่ upgrade-insecure-requests (ทำให้ http://localhost ตอน e2e/dev มีปัญหา; Vercel บังคับ HTTPS อยู่แล้ว)
 *  - 'unsafe-eval' เฉพาะ `next dev` (React ใช้ eval ตอน dev เท่านั้น — เอกสารเดียวกัน)
 */
function buildCsp(isDev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://images.unsplash.com",
    "font-src 'self'",
    "connect-src 'self' https://vercel.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

/** CSP ของ proxy สลิป (ต้องตรงกับ slipResponseHeaders ใน lib/admin/slip-proxy.ts) */
const SLIP_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";
/** CSP ของ proxy รูปสินค้า (ต้องตรงกับ app/api/item-images/[name]/route.ts) */
const IMAGE_FILE_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  images: {
    // รูปสินค้าเดโมจาก Unsplash เท่านั้น (SPEC §2)
    remotePatterns: [
      {
        protocol: "https",
        hostname: "images.unsplash.com",
        pathname: "/**",
      },
    ],
  },
  /**
   * Security headers (SPEC §9)
   *
   * กฎของ Next: ถ้ามีหลายกฎที่ match path เดียวกันและตั้ง header key เดียวกัน "กฎหลังทับกฎก่อน" (เอกสาร headers.md
   * "Header Overriding Behavior") — จึงต้องเรียงกฎทั่วไป (/:path*) ไว้ก่อนเสมอ และกฎเฉพาะที่ตั้ง key ซ้ำ
   * ต้องมีค่าที่เข้มเท่าเดิมหรือกว่า (ห้ามทับ CSP เต็มด้วยค่าที่เหลือไม่กี่ directive) — มี unit test ตรวจ
   * และ header ใน config ก็ทับ header ที่ route handler ตั้งเอง (ดูกฎ proxy สลิป/รูปสินค้าท้าย list)
   */
  async headers() {
    const csp = buildCsp(process.env.NODE_ENV === "development");
    // ทั้งเว็บ
    const baseSecurity = [
      { key: "Content-Security-Policy", value: csp },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "X-Frame-Options", value: "DENY" },
    ];
    // หน้าที่มี token ลับอยู่ใน URL: ห้าม cache ห้ามส่ง referrer ห้ามให้ search engine เก็บ
    // (Referrer-Policy no-referrer ทับค่าทั่วไปที่เข้มน้อยกว่า)
    const privatePage = [
      { key: "Cache-Control", value: "no-store" },
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "X-Robots-Tag", value: "noindex, nofollow" },
      { key: "X-Content-Type-Options", value: "nosniff" },
    ];
    // หลังบ้านห้ามถูกฝังใน iframe (clickjacking): ใส่ CSP "เต็ม" (มี frame-ancestors 'none' อยู่แล้ว) ไม่ใช่เฉพาะ
    // frame-ancestors — เพราะกฎนี้ทับ CSP ทั่วไป ถ้าเหลือแค่ directive เดียวหลังบ้านจะไม่มี script-src/connect-src เลย
    const noFraming = [
      { key: "Content-Security-Policy", value: csp },
      { key: "X-Frame-Options", value: "DENY" },
    ];
    return [
      { source: "/:path*", headers: baseSecurity },
      { source: "/order/:path*", headers: privatePage },
      { source: "/checkout/:path*", headers: privatePage },
      { source: "/api/orders/:path*", headers: privatePage },
      // หลังบ้าน: ห้าม cache / ห้ามให้ search engine เก็บ
      { source: "/admin/:path*", headers: [...privatePage, ...noFraming] },
      { source: "/api/admin/:path*", headers: [...privatePage, ...noFraming] },
      // Response ที่เป็นไฟล์รูปล้วน (ไม่ใช่หน้าเว็บ): ใช้ CSP เข้มกว่า (ไม่มีทรัพยากรใดเลย + sandbox)
      // ต้องตั้งซ้ำที่นี่ เพราะ header ใน next.config "ทับ" header ที่ route handler ตั้งเอง (ตรวจจริงแล้ว) —
      // ถ้าไม่ตั้ง route จะได้ CSP ทั่วไปแทนค่า sandbox ของตัวเอง; ค่าต้องตรงกับ lib/admin/slip-proxy.ts และ
      // app/api/item-images/[name]/route.ts (มี unit test ตรวจ)
      { source: "/api/admin/slips/:path*", headers: [{ key: "Content-Security-Policy", value: SLIP_CSP }] },
      { source: "/api/item-images/:path*", headers: [{ key: "Content-Security-Policy", value: IMAGE_FILE_CSP }] },
    ];
  },
  // หน้า /about อ่าน docs/BUILD_LOG.md ตอน build (fs) — บังคับให้ไฟล์ถูก trace เข้า bundle ของ Vercel
  outputFileTracingIncludes: {
    "/about": ["./docs/BUILD_LOG.md"],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
