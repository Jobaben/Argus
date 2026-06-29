import { ConnectionPill, IrisMark, MoreMenu } from "./ds";
import type { MoreItem } from "./ds";

export interface NavTab {
  id: string;
  label: string;
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
    <nav className="sticky top-0 z-30 border-b border-line bg-ground/80 backdrop-blur">
      <div className="mx-auto flex max-w-[1600px] items-center gap-3 px-6 py-2.5">
        <span className="flex shrink-0 items-center gap-2 text-sm font-bold">
          <IrisMark size={18} /> <span>ARG<span className="text-eye">U</span>S</span>
        </span>
        <div className="ml-2 flex items-center gap-1">
          {destinations.map((t) => (
            <a
              key={t.id}
              href={`#/${t.id}`}
              className={`shrink-0 rounded-md px-3 py-1.5 text-sm font-medium transition ${
                t.id === activeId ? "bg-surface-2 text-ink" : "text-ink-dim hover:text-ink"
              }`}
            >
              {t.label}
            </a>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <a
            href="#/search"
            aria-label="Search"
            className={`flex h-8 w-8 items-center justify-center rounded-md text-base transition ${
              activeId === "search" ? "bg-surface-2 text-ink" : "text-ink-dim hover:text-ink"
            }`}
          >
            ⌕
          </a>
          <MoreMenu items={overflow} active={overflowActive} />
          <ConnectionPill live={live} />
        </div>
      </div>
    </nav>
  );
}
