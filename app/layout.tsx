import type { Metadata, Viewport } from "next";
import {
  IBM_Plex_Mono,
  IBM_Plex_Sans_Thai,
  Instrument_Serif,
  Noto_Serif_Thai,
} from "next/font/google";
import "./globals.css";
import { DemoBanner } from "@/components/shop/DemoBanner";
import { SiteFooter } from "@/components/shop/SiteFooter";
import { SiteHeader } from "@/components/shop/SiteHeader";

const instrument = Instrument_Serif({
  variable: "--font-instrument",
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  display: "swap",
});

const notoSerifThai = Noto_Serif_Thai({
  variable: "--font-noto-thai",
  subsets: ["thai", "latin"],
  display: "swap",
});

const plexSansThai = IBM_Plex_Sans_Thai({
  variable: "--font-plex-thai",
  subsets: ["thai", "latin"],
  weight: ["300", "400", "500", "600"],
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Second Room — ของจากอีกห้องหนึ่ง",
    template: "%s · Second Room",
  },
  description:
    "ร้านของมือสองแบบเดโมที่แสดงทีละชิ้นพร้อมระบุตำหนิทุกชิ้น (สินค้าและรูปประกอบจาก Unsplash เป็นข้อมูลตัวอย่าง ไม่มีการเรียกเก็บเงินจริง)",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f1ea" },
    { media: "(prefers-color-scheme: dark)", color: "#121110" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="th"
      className={`${instrument.variable} ${notoSerifThai.variable} ${plexSansThai.variable} ${plexMono.variable}`}
    >
      <body className="flex min-h-dvh flex-col">
        <DemoBanner />
        <SiteHeader />
        <div className="flex-1">{children}</div>
        <SiteFooter />
      </body>
    </html>
  );
}
