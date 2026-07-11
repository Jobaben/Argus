import { ConnectionPill, IrisMark, MoreMenu } from "./ds";
import type { MoreItem } from "./ds";

export interface NavTab {
  id: string;
  label: string;
  /** Attention count rendered as a chip after the label; hidden when 0/absent. */
  badge?: number;
}

export function NavBar({
  destinations,
  overflow,
  activeId,
  live,
}: {
  destinations: NavTab[];
  overflow: MoreItem[];
  activeId: string;
  live: boolean;
}) {
  const overflowActive = overflow.some((o) => o.id === activeId);
  return (
    <nav
      aria-label="Primary"
      className="sticky top-0 z-30 border-b border-line bg-ground/80 backdrop-blur"
    >
      <div className="mx-auto flex max-w-[1600px] items-center gap-3 px-4 py-2.5 sm:px-6">
        <span className="flex shrink-0 items-center gap-2 text-sm font-bold">
          <IrisMark size={18} />{" "}
          <span>
            ARG<span className="text-eye">U</span>S
          </span>
        </span>
        {/* Destinations scroll horizontally rather than overflow the bar on
            narrow viewports. */}
        <div className="ml-2 flex min-w-0 items-center gap-1 overflow-x-auto">
          {destinations.map((t) => (
            <a
              key={t.id}
              href={`#/${t.id}`}
              aria-current={t.id === activeId ? "page" : undefined}
              className={`shrink-0 rounded-md px-3 py-1.5 text-sm font-medium transition ${
                t.id === activeId ? "bg-surface-2 text-ink" : "text-ink-dim hover:text-ink"
              }`}
            >
              {t.label}
              {t.badge != null && t.badge > 0 && (
                <span className="ml-1.5 inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-fail/15 px-1.5 py-0.5 font-mono text-[10px] font-bold leading-none text-fail">
                  {t.badge}
                </span>
              )}
            </a>
          ))}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <a
            href="#/search"
            aria-label="Search"
            aria-current={activeId === "search" ? "page" : undefined}
            className={`flex h-8 w-8 items-center justify-center rounded-md text-base transition ${
              activeId === "search" ? "bg-surface-2 text-ink" : "text-ink-dim hover:text-ink"
            }`}
          >
            ⌕
          </a>
          <MoreMenu items={overflow} active={overflowActive} activeId={activeId} />
          <ConnectionPill live={live} />
        </div>
      </div>
    </nav>
  );
}
