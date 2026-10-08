import type { ReactNode } from "react";

export interface LegendItem {
  key: string;
  /** The mark as it appears on the page: a glyph, a swatch, a sample badge. */
  mark: ReactNode;
  label: string;
  description: ReactNode;
  note?: ReactNode;
}

/** A key to a page's marks: what each one looks like and what it means. */
export function Legend({
  items,
  label,
  wideMarks = false,
}: {
  items: LegendItem[];
  label: string;
  /** Room for marks wider than a glyph, such as a status badge. */
  wideMarks?: boolean;
}) {
  return (
    <dl aria-label={label} className="flex flex-col gap-3">
      {items.map((item) => (
        <div
          key={item.key}
          className={`grid items-baseline gap-x-3 ${wideMarks ? "grid-cols-[6.5rem_1fr]" : "grid-cols-[2rem_1fr]"}`}
        >
          <dt className="contents">
            <span
              aria-hidden="true"
              className={`flex text-ink-dim ${wideMarks ? "" : "justify-center"}`}
            >
              {item.mark}
            </span>
            <span className="font-semibold text-ink">{item.label}</span>
          </dt>
          <dd className="col-start-2 mt-0.5 text-[13px] leading-relaxed text-ink-dim">
            {item.description}
            {item.note && (
              <span className="mt-1.5 block border-l-2 border-eye/40 pl-2.5 text-ink">
                {item.note}
              </span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
