import type { ReactNode } from "react";

export interface LegendItem {
  key: string;
  /** The mark as it appears on the page: a glyph, a swatch, a sample badge. */
  mark: ReactNode;
  label: string;
  /** What the mark means. In the inline key it is read to assistive tech only. */
  description?: ReactNode;
  note?: ReactNode;
}

/**
 * A key to a page's marks: what each one looks like and what it means.
 *
 * Two layouts of the same list. `list` is the full key — mark, name and a
 * sentence of explanation — for a field guide or a drawer. `inline` is the strip
 * that sits above a chart, where the marks *are* the reading and the key has to
 * stay out of its way: mark and name on one wrapping line, the explanation kept
 * for screen readers. One primitive for both, so a chart's key and a guide's key
 * describe a mark the same way instead of each view hand-rolling its own.
 */
export function Legend({
  items,
  label,
  wideMarks = false,
  variant = "list",
}: {
  items: LegendItem[];
  label: string;
  /** Room for marks wider than a glyph, such as a status badge. */
  wideMarks?: boolean;
  variant?: "list" | "inline";
}) {
  if (variant === "inline") {
    return (
      <dl
        aria-label={label}
        className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-caption text-ink-faint"
      >
        {items.map((item) => (
          <div key={item.key} className="flex items-center gap-1.5">
            <dt className="contents">
              <span aria-hidden="true" className="flex shrink-0 items-center">
                {item.mark}
              </span>
              <span>{item.label}</span>
            </dt>
            {item.description != null && <dd className="sr-only">{item.description}</dd>}
          </div>
        ))}
      </dl>
    );
  }
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
          <dd className="col-start-2 mt-0.5 text-small leading-relaxed text-ink-dim">
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
