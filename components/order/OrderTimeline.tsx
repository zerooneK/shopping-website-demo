import { formatThaiDateTime } from "@/lib/labels";
import type { TimelineEntry } from "@/lib/orders/view";

/** timeline สถานะจาก order_events (เรนเดอร์ฝั่ง server — เวลาจัดรูปแบบตามเขตเวลาไทย) */
export function OrderTimeline({ entries }: { entries: TimelineEntry[] }) {
  return (
    <section aria-labelledby="timeline-heading">
      <h2 id="timeline-heading" className="meta meta-th text-ink">
        ความคืบหน้า
      </h2>
      <ol className="mt-4 border-l border-ink">
        {entries.map((e, i) => {
          const latest = i === entries.length - 1;
          return (
            <li key={e.key} className="relative pb-6 pl-6 last:pb-0" aria-current={latest ? "step" : undefined}>
              <span
                aria-hidden="true"
                className={`absolute top-2 -left-[5px] block h-[9px] w-[9px] border border-ink ${
                  latest ? "bg-accent" : "bg-paper"
                }`}
              />
              <p className={latest ? "font-medium text-ink" : "text-ink"}>{e.label}</p>
              {e.detail ? <p className="text-sm text-muted">{e.detail}</p> : null}
              <p className="meta meta-th mt-1">{formatThaiDateTime(e.atMs)}</p>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
