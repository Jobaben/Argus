import type { ReactNode } from "react";

export interface TabItem {
  id: string;
  label: string;
  href: string;
  /** A count worth seeing before you switch — anomalies, schedules. */
  count?: number;
  /** Colours the count when it is a call to attention rather than a tally. */
  countTone?: "neutral" | "fail" | "await";
}

/**
 * A page's own sub-views, as links: Health's Monitors and Watchtower, the
 * Scheduler's Schedules and One-off. Underlined rather than pilled, so they
 * cannot be mistaken for the segmented controls that filter *within* a view —
 * those change what you see here; these take you somewhere.
 */
export function Tabs({
  label,
  items,
  active,
  trailing,
}: {
  /** Accessible name for the nav landmark. */
  label: string;
  items: TabItem[];
  active: string;
  /** Content set at the far end of the tab rule — a filter, a count. */
  trailing?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3 border-b border-line">
      <nav aria-label={label} className="-mb-px flex gap-5">
        {items.map((t) => {
          const on = t.id === active;
          return (
            <a
              key={t.id}
              href={t.href}
              aria-current={on ? "page" : undefined}
              className={`flex items-center gap-2 border-b-2 pb-2.5 pt-1 text-sm font-semibold transition-colors duration-(--duration-quick) ${
                on
                  ? "border-eye text-ink"
                  : "border-transparent text-ink-faint hover:border-line-strong hover:text-ink-dim"
              }`}
            >
              {t.label}
              {t.count != null && t.count > 0 && (
                <span
                  className={`rounded-full px-1.5 py-px text-micro font-semibold leading-tight ${
                    t.countTone === "fail"
                      ? "bg-fail/15 text-fail"
                      : t.countTone === "await"
                        ? "bg-await/15 text-await"
                        : "bg-surface-3 text-ink-dim"
                  }`}
                >
                  {t.count}
                </span>
              )}
            </a>
          );
        })}
      </nav>
      {trailing && <div className="pb-2">{trailing}</div>}
    </div>
  );
}
