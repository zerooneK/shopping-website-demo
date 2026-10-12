"use client";

import Image from "next/image";
import { useState } from "react";

type Props = {
  src: string;
  alt: string;
  sizes: string;
  className?: string;
  /** รูปบนจอ/LCP: โหลดทันที ความสำคัญสูง */
  eager?: boolean;
  /** รูปแรกของหน้าสินค้า: preload ใน <head> */
  preload?: boolean;
};

/**
 * รูปเต็มกรอบ parent (parent ต้อง relative + มี aspect)
 * ถ้ารูปโหลดไม่ได้ (เช่น ช่างภาพลบรูปบน Unsplash) แสดงรูปสำรองโทนเดียวกับธีมแทน
 */
export function SafeImage({ src, alt, sizes, className = "", eager, preload }: Props) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div
        role="img"
        aria-label={`${alt} (ภาพไม่พร้อมใช้งาน)`}
        className={`absolute inset-0 flex flex-col items-center justify-center gap-2 border border-rule bg-paper p-4 text-center ${className}`}
        style={{
          backgroundImage:
            "repeating-linear-gradient(135deg, transparent 0 11px, var(--rule) 11px 12px)",
        }}
      >
        <span className="display bg-paper px-3 text-2xl text-muted">Second Room</span>
        <span className="meta meta-th bg-paper px-2">ภาพไม่พร้อมใช้งาน</span>
      </div>
    );
  }

  return (
    <Image
      src={src}
      alt={alt}
      fill
      sizes={sizes}
      loading={eager || preload ? "eager" : "lazy"}
      fetchPriority={eager || preload ? "high" : "auto"}
      preload={preload}
      onError={() => setFailed(true)}
      className={`object-cover ${className}`}
    />
  );
}
