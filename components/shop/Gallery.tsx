"use client";

import { useRef, useState } from "react";
import { SafeImage } from "@/components/ui/SafeImage";
import type { ItemImage } from "@/db/schema";

const SIZES = "(min-width: 1024px) 58vw, 100vw";

type Props = {
  images: ItemImage[];
  code: string;
  grayscale?: boolean;
  children?: React.ReactNode; // overlay (ป้าย SOLD)
};

/** แกลเลอรีปัดได้ (scroll-snap) + จุดบอกตำแหน่ง (mobile) + thumbnail (desktop) */
export function Gallery({ images, code, grayscale, children }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const gray = grayscale ? "grayscale" : "";

  function onScroll() {
    const el = scroller.current;
    if (!el) return;
    setIndex(Math.round(el.scrollLeft / el.clientWidth));
  }

  function goTo(i: number) {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ left: i * el.clientWidth, behavior: "smooth" });
  }

  return (
    <div>
      <div className="relative">
        <div
          ref={scroller}
          onScroll={onScroll}
          className="no-scrollbar flex snap-x snap-mandatory overflow-x-auto border border-rule"
          role="group"
          aria-roledescription="carousel"
          aria-label="รูปสินค้า ปัดซ้ายขวาเพื่อดูรูปถัดไป"
        >
          {images.map((img, i) => (
            <div
              key={img.url}
              className="relative aspect-[4/5] w-full shrink-0 snap-center bg-rule/40"
              style={i === 0 ? { viewTransitionName: `item-${code}` } : undefined}
              role="group"
              aria-roledescription="slide"
              aria-label={`รูปที่ ${i + 1} จาก ${images.length}`}
            >
              <SafeImage
                src={img.url}
                alt={img.alt}
                sizes={SIZES}
                preload={i === 0}
                className={gray}
              />
            </div>
          ))}
        </div>
        {children}
      </div>

      {images.length > 1 ? (
        <>
          {/* mobile: จุดบอกตำแหน่ง (touch target 44px) */}
          <div className="flex items-center justify-center md:hidden">
            {images.map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => goTo(i)}
                className="tap flex items-center justify-center"
                aria-label={`ไปที่รูปที่ ${i + 1}`}
                aria-current={i === index}
              >
                <span
                  className={`block h-2 w-2 border border-ink ${i === index ? "bg-ink" : "bg-transparent"}`}
                />
              </button>
            ))}
          </div>

          {/* desktop: thumbnail */}
          <div className="mt-3 hidden grid-cols-5 gap-3 md:grid">
            {images.map((img, i) => (
              <button
                key={img.url}
                type="button"
                onClick={() => goTo(i)}
                aria-label={`ดูรูปที่ ${i + 1}`}
                aria-current={i === index}
                className={`relative aspect-[4/5] border ${i === index ? "border-ink" : "border-rule opacity-70 hover:opacity-100"}`}
              >
                <SafeImage src={img.url} alt={img.alt} sizes="12vw" className={gray} />
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
