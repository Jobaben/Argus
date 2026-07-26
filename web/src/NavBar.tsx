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
  onOpenPalette,
}: {
  destinations: NavTab[];
  overflow: MoreItem[];
  activeId: string;
  live: boolean;
  onOpenPalette: () => void;
}) {
  const overflowActive = overflow.some((o) => o.id === activeId);
  // ⌘ on Apple, Ctrl elsewhere — showing the wrong one is worse than showing
  // none, since the hint is the only place most users learn the shortcut.
  const modLabel =
    typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
      ? "⌘K"
      : "Ctrl K";
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
          {/* The palette is the fastest path to anything in Argus, so it gets a
              real affordance with its shortcut on it — not a bare icon nobody
              would guess is keyboard-driven. It collapses to the icon alone on
              narrow viewports. */}
          <button
            type="button"
            onClick={onOpenPalette}
            aria-label={`Open the command palette (${modLabel})`}
            className="group flex h-8 items-center gap-2 rounded-md border border-line px-2 text-ink-dim transition duration-(--duration-quick) hover:border-ink-faint/40 hover:text-ink sm:pr-1.5"
          >
            <span aria-hidden="true" className="text-base leading-none">
              ⌕
            </span>
            <span className="hidden text-sm sm:inline">Jump to…</span>
            <kbd
              aria-hidden="true"
              className="hidden rounded border border-line bg-ground-2 px-1.5 py-0.5 font-mono text-[10px] text-ink-faint transition duration-(--duration-quick) group-hover:text-ink-dim sm:inline"
            >
              {modLabel}
            </kbd>
          </button>
          <MoreMenu items={overflow} active={overflowActive} activeId={activeId} />
          <ConnectionPill live={live} />
        </div>
      </div>
    </nav>
  );
}
