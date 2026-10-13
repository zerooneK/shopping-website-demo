import type { NextConfig } from "next";

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
  // หน้าออเดอร์มี token ลับอยู่ใน URL: ห้าม cache ห้ามส่ง referrer ห้ามให้ search engine เก็บ
  async headers() {
    const privatePage = [
      { key: "Cache-Control", value: "no-store" },
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "X-Robots-Tag", value: "noindex, nofollow" },
      { key: "X-Content-Type-Options", value: "nosniff" },
    ];
    // หลังบ้านห้ามถูกฝังใน iframe (clickjacking): CSP frame-ancestors + X-Frame-Options สำหรับ browser เก่า
    const noFraming = [
      { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
      { key: "X-Frame-Options", value: "DENY" },
    ];
    return [
      { source: "/order/:path*", headers: privatePage },
      { source: "/checkout/:path*", headers: privatePage },
      { source: "/api/orders/:path*", headers: privatePage },
      // หลังบ้าน: ห้าม cache / ห้ามให้ search engine เก็บ
      { source: "/admin/:path*", headers: [...privatePage, ...noFraming] },
      { source: "/api/admin/:path*", headers: [...privatePage, ...noFraming] },
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
