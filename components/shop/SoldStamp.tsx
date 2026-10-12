/** ป้าย SOLD เอียงทับรูป (ตกแต่งอย่างเดียว — ข้อความอ่านจริงอยู่ที่ป้ายสถานะ) */
export function SoldStamp({ large = false }: { large?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 flex items-center justify-center"
    >
      <span
        className={`display -rotate-12 border-2 border-accent bg-paper/80 px-4 leading-none text-accent ${
          large ? "py-2 text-7xl sm:text-8xl" : "py-1 text-5xl sm:text-6xl"
        }`}
      >
        SOLD
      </span>
    </span>
  );
}
