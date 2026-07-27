import { useEffect, useRef, useState } from "react";
import { ConnectionPill, IrisMark, MoreMenu } from "./ds";
import type { MoreItem } from "./ds";
import { NotificationCenter } from "./notify/NotificationCenter";

export interface NavTab {
  id: string;
  label: string;
  /** Attention count rendered as a chip after the label; hidden when 0/absent. */
  badge?: number;
}

function Badge({ count }: { count: number }) {
  return (
    <span className="ml-1.5 inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-fail/15 px-1.5 py-0.5 font-mono text-[10px] font-bold leading-none text-fail">
      {count}
    </span>
  );
}

/**
 * The mobile destination sheet.
 *
 * On a phone the horizontal tab strip was technically usable and practically
 * not: nine destinations in a 360px scroller means the one you want is almost
 * always off-screen, with no indication of how many others exist. A sheet shows
 * every destination at once, at a real tap size, with its attention badge — and
 * it is the same `destinations` array the desktop bar renders, so the two can't
 * drift.
 */
function MobileNav({
  destinations,
  overflow,
  activeId,
}: {
  destinations: NavTab[];
  overflow: MoreItem[];
  activeId: string;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const activeLabel = destinations.find((d) => d.id === activeId)?.label;

  // Navigating closes the sheet: the hash change is the confirmation.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("hashchange", close);
    return () => window.removeEventListener("hashchange", close);
  }, [open]);

  const attention = destinations.reduce((n, d) => n + (d.badge ?? 0), 0);

  return (
    <div className="md:hidden">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={open ? "Close the menu" : "Open the menu"}
        className="flex h-8 items-center gap-2 rounded-md border border-line px-2.5 text-sm text-ink-dim transition duration-(--duration-quick) hover:text-ink"
      >
        <span aria-hidden="true" className="font-mono leading-none">
          {open ? "✕" : "☰"}
        </span>
        <span className="max-w-[6.5rem] truncate sm:max-w-[9rem]">{activeLabel ?? "Menu"}</span>
        {!open && attention > 0 && <Badge count={attention} />}
      </button>

      {open && (
        <>
          {/* A full-screen scrim so a tap anywhere outside dismisses, and the
              page behind cannot be scrolled by accident. */}
          <div
            className="fixed inset-0 top-[49px] z-20 bg-ground/60 backdrop-blur-[2px] motion-safe:animate-[fade-in_var(--duration-quick)_ease-out]"
            onClick={() => setOpen(false)}
          />
          <div className="absolute inset-x-0 top-full z-30 border-b border-line bg-surface px-3 pb-3 pt-2 shadow-[0_24px_60px_-24px_rgb(0_0_0/0.9)] motion-safe:animate-[rise-in_var(--duration-base)_var(--ease-out-expo)]">
            <ul className="grid grid-cols-2 gap-1.5">
              {destinations.map((t) => (
                <li key={t.id}>
                  <a
                    href={`#/${t.id}`}
                    aria-current={t.id === activeId ? "page" : undefined}
                    onClick={() => setOpen(false)}
                    className={`flex items-center rounded-md px-3 py-2.5 text-sm ${
                      t.id === activeId ? "bg-surface-2 font-semibold text-ink" : "text-ink-dim"
                    }`}
                  >
                    {t.label}
                    {t.badge != null && t.badge > 0 && <Badge count={t.badge} />}
                  </a>
                </li>
              ))}
            </ul>
            {overflow.length > 0 && (
              <ul className="mt-2 flex flex-wrap gap-1.5 border-t border-line pt-2">
                {overflow.map((o) => (
                  <li key={o.id}>
                    <a
                      href={o.href}
                      aria-current={o.id === activeId ? "page" : undefined}
                      onClick={() => setOpen(false)}
                      className={`inline-flex rounded-md px-2.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.1em] ${
                        o.id === activeId ? "bg-surface-2 text-ink" : "text-ink-faint"
                      }`}
                    >
                      {o.label}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
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
      <div className="relative mx-auto flex max-w-[1600px] items-center gap-2 px-3 py-2.5 sm:gap-3 sm:px-6">
        {/* The wordmark is the least load-bearing thing in the bar, so it is what
            gives up room first on a phone. */}
        <span className="flex shrink-0 items-center gap-2 text-sm font-bold">
          <IrisMark size={18} />{" "}
          <span className="hidden sm:inline">
            ARG<span className="text-eye">U</span>S
          </span>
        </span>

        <MobileNav destinations={destinations} overflow={overflow} activeId={activeId} />

        {/* Destinations scroll horizontally rather than overflow the bar; below
            `md` the sheet above replaces them entirely. */}
        <div className="ml-2 hidden min-w-0 items-center gap-1 overflow-x-auto md:flex">
          {destinations.map((t) => (
            <a
              key={t.id}
              href={`#/${t.id}`}
              aria-current={t.id === activeId ? "page" : undefined}
              className={`relative shrink-0 rounded-md px-3 py-1.5 text-sm font-medium transition duration-(--duration-quick) ${
                t.id === activeId ? "bg-surface-2 text-ink" : "text-ink-dim hover:text-ink"
              }`}
            >
              {t.label}
              {t.badge != null && t.badge > 0 && <Badge count={t.badge} />}
            </a>
          ))}
        </div>

        <div className="ml-auto flex min-w-0 shrink items-center gap-1.5 sm:gap-2">
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
          {/* The overflow menu duplicates the sheet's secondary list on mobile,
              so it only appears once the desktop bar does. */}
          <span className="hidden md:inline">
            <MoreMenu items={overflow} active={overflowActive} activeId={activeId} />
          </span>
          <NotificationCenter />
          <ConnectionPill live={live} />
        </div>
      </div>
    </nav>
  );
}
