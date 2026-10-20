import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ConnectionPill,
  Icon,
  IrisMark,
  MoreMenu,
  SURFACE,
  prefersReducedMotion,
  usePresence,
  useSurfaceMotion,
} from "./ds";
import type { MoreItem } from "./ds";
import { NotificationCenter } from "./notify/NotificationCenter";

export interface NavTab {
  id: string;
  label: string;
  /** Attention count rendered as a chip after the label; hidden when 0/absent. */
  badge?: number;
}

/**
 * An attention count. Violet, the colour of "waiting on you", not red: the
 * Briefing's count is everything that wants a human — a gate, a down monitor —
 * and painting it the colour of failure made a waiting approval look like an
 * outage.
 */
function Badge({ count }: { count: number }) {
  return (
    <span className="ml-1.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-await/18 px-1.5 text-micro font-semibold leading-none text-await">
      {count}
    </span>
  );
}

/**
 * The mobile destination sheet.
 *
 * On a phone the horizontal tab strip was technically usable and practically
 * not: eight destinations in a 360px scroller means the one you want is almost
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
  const { present, exited } = usePresence(open);
  const scrimRef = useSurfaceMotion<HTMLDivElement>(open, SURFACE.scrim);
  // `top` — the sheet belongs to the bar it drops out of, so that is the edge it
  // collapses back into rather than shrinking toward its own middle.
  const sheetRef = useSurfaceMotion<HTMLDivElement>(open, SURFACE.rise, exited, "top center");

  // Navigating closes the sheet: the hash change is the confirmation. Escape
  // closes it too and hands focus back to the toggle, and opening it moves
  // focus to the current destination — a sheet you can open from the keyboard
  // but not leave from it is a trap.
  const sheetEl = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    window.addEventListener("hashchange", close);
    document.addEventListener("keydown", onKey);
    const raf = requestAnimationFrame(() =>
      (
        sheetEl.current?.querySelector<HTMLElement>('[aria-current="page"]') ??
        sheetEl.current?.querySelector<HTMLElement>("a")
      )?.focus(),
    );
    return () => {
      window.removeEventListener("hashchange", close);
      document.removeEventListener("keydown", onKey);
      cancelAnimationFrame(raf);
    };
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
        className="flex h-9 items-center gap-2 rounded-control border border-line-strong bg-surface/60 pl-2.5 pr-3 text-sm text-ink transition duration-(--duration-quick) hover:bg-surface-2 motion-safe:active:scale-[0.97]"
      >
        <Icon name={open ? "close" : "menu"} size={17} className="text-ink-dim" />
        <span className="max-w-[9rem] truncate font-semibold">{activeLabel ?? "Menu"}</span>
        {!open && attention > 0 && <Badge count={attention} />}
      </button>

      {present && (
        <>
          {/* A full-screen scrim so a tap anywhere outside dismisses, and the
              page behind cannot be scrolled by accident. */}
          <div
            ref={scrimRef}
            className="fixed inset-0 top-14 z-20 bg-ground/70 backdrop-blur-[2px]"
            inert={!open}
            aria-hidden={open ? undefined : true}
            onClick={() => setOpen(false)}
          />
          <div
            ref={(node) => {
              sheetEl.current = node;
              sheetRef(node);
            }}
            inert={!open}
            aria-hidden={open ? undefined : true}
            className="absolute inset-x-0 top-full z-30 border-b border-line-strong bg-surface px-3 pb-4 pt-3 shadow-[0_24px_60px_-24px_rgb(0_0_0/0.9)]"
          >
            <ul className="grid grid-cols-2 gap-1">
              {destinations.map((t) => (
                <li key={t.id}>
                  <a
                    href={`#/${t.id}`}
                    aria-current={t.id === activeId ? "page" : undefined}
                    onClick={() => setOpen(false)}
                    className={`flex h-11 items-center rounded-control px-3 text-[15px] transition-transform duration-(--duration-press) motion-safe:active:scale-[0.98] ${
                      t.id === activeId
                        ? "bg-surface-3 font-semibold text-ink"
                        : "text-ink-dim hover:bg-surface-2"
                    }`}
                  >
                    {t.label}
                    {t.badge != null && t.badge > 0 && <Badge count={t.badge} />}
                  </a>
                </li>
              ))}
            </ul>
            {overflow.length > 0 && (
              <ul className="mt-3 flex flex-wrap gap-1 border-t border-line pt-3">
                {overflow.map((o) => (
                  <li key={o.id}>
                    <a
                      href={o.href}
                      aria-current={o.id === activeId ? "page" : undefined}
                      onClick={() => setOpen(false)}
                      className={`inline-flex h-9 items-center rounded-control px-3 text-sm transition-transform duration-(--duration-press) motion-safe:active:scale-[0.98] ${
                        o.id === activeId
                          ? "bg-surface-3 text-ink"
                          : "text-ink-faint hover:text-ink"
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

/**
 * The active-destination pill, as one element that moves.
 *
 * It used to be a background colour on whichever tab was current, which meant
 * the pill *teleported* between tabs — there and then here, with nothing in
 * between. One absolutely-positioned indicator that slides instead is the
 * cheapest shared-element transition there is, and it answers "which tab did I
 * come from?" without the user having to have been watching.
 *
 * Measured rather than computed: the tab strip is a horizontal scroller with
 * variable-width labels and optional badges, so the only honest source for where
 * the pill goes is where the anchor actually is. Returns null until the first
 * measurement, so nothing paints in the wrong place.
 */
function useActivePill(activeId: string, tabCount: number) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ left: number; width: number } | null>(null);
  // Which ends of the strip have tabs scrolled out of sight. Between ~768px and
  // ~1150px the eight destinations do not fit, and a strip that is silently
  // clipped reads as "there are only six"; a fade at the clipped edge says
  // "there is more this way".
  const [overflow, setOverflow] = useState<{ start: boolean; end: boolean }>({
    start: false,
    end: false,
  });

  // Layout effect: the measurement has to land in the same frame as the tab
  // change, or the pill starts sliding one frame after the label goes bold.
  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const measure = () => {
      const start = track.scrollLeft > 1;
      const end = track.scrollLeft + track.clientWidth < track.scrollWidth - 1;
      setOverflow((o) => (o.start === start && o.end === end ? o : { start, end }));
      const current = track.querySelector<HTMLElement>('[aria-current="page"]');
      if (!current) {
        setBox(null);
        return;
      }
      setBox({ left: current.offsetLeft - track.scrollLeft, width: current.offsetWidth });
    };
    measure();
    // The strip scrolls, and it reflows when the window does — both move the
    // anchor without changing which one is active. So does the web font
    // arriving: the first measurement is taken against the fallback face, and
    // when Hellix swaps in every tab changes width, which left the pill parked
    // between two tabs until something else happened to re-measure it. A
    // ResizeObserver on the tabs themselves catches that and a badge appearing.
    track.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    for (const tab of track.querySelectorAll("a")) ro?.observe(tab);
    let live = true;
    void document.fonts?.ready.then(() => {
      if (live) measure();
    });
    return () => {
      live = false;
      ro?.disconnect();
      track.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, [activeId, tabCount]);

  return { trackRef, box, overflow };
}

const FADE = {
  none: undefined,
  start: "linear-gradient(to right, transparent, black 28px)",
  end: "linear-gradient(to right, black calc(100% - 28px), transparent)",
  both: "linear-gradient(to right, transparent, black 28px, black calc(100% - 28px), transparent)",
} as const;

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
  const { trackRef, box: pill, overflow: clipped } = useActivePill(activeId, destinations.length);
  const fade =
    FADE[
      clipped.start && clipped.end ? "both" : clipped.start ? "start" : clipped.end ? "end" : "none"
    ];
  const reduced = prefersReducedMotion();
  // ⌘ on Apple, Ctrl elsewhere — showing the wrong one is worse than showing
  // none, since the hint is the only place most users learn the shortcut.
  const modLabel =
    typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
      ? "⌘K"
      : "Ctrl K";
  return (
    <nav
      aria-label="Primary"
      className="sticky top-0 z-30 border-b border-line bg-ground/75 backdrop-blur-md backdrop-saturate-150"
    >
      <div className="relative mx-auto flex h-14 max-w-[1600px] items-center gap-2 px-4 sm:gap-3 sm:px-6">
        {/* The wordmark is the least load-bearing thing in the bar, so it is what
            gives up room first on a phone. It is also the way home. */}
        <a
          href="#/command"
          aria-label="Argus home"
          className="flex shrink-0 items-center gap-2.5 rounded-control py-1 pr-1 text-[15px] font-semibold tracking-[0.14em]"
        >
          <IrisMark size={22} />
          <span aria-hidden="true" className="hidden lg:inline">
            ARG<span className="text-eye">U</span>S
          </span>
        </a>

        <MobileNav destinations={destinations} overflow={overflow} activeId={activeId} />

        {/* Destinations scroll horizontally rather than overflow the bar; below
            `md` the sheet above replaces them entirely. */}
        <div
          ref={trackRef}
          style={fade ? { maskImage: fade, WebkitMaskImage: fade } : undefined}
          className="relative ml-1 hidden min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] md:flex lg:ml-3"
        >
          {/* First in DOM order and unpositioned in z, so it paints *under* the
              anchors: same pixels the active tab's own background used to draw,
              now able to travel between them. `width` is transitioned alongside
              the transform because the tabs are different widths and the pill has
              to become the new one, not just arrive at it — it is absolutely
              positioned, so that width change cannot move anything else. */}
          <span
            aria-hidden="true"
            className={`pointer-events-none absolute inset-y-1 rounded-md bg-surface-2 ${
              reduced ? "" : "transition-[transform,width,opacity] duration-(--duration-base)"
            } ease-(--ease-out-expo)`}
            style={
              pill
                ? { transform: `translateX(${pill.left}px)`, width: `${pill.width}px`, opacity: 1 }
                : { opacity: 0, width: 0 }
            }
          />
          {destinations.map((t) => (
            <a
              key={t.id}
              href={`#/${t.id}`}
              aria-current={t.id === activeId ? "page" : undefined}
              className={`relative flex h-8 shrink-0 items-center rounded-md px-3 text-sm transition duration-(--duration-quick) motion-safe:active:scale-[0.97] ${
                t.id === activeId ? "text-ink" : "text-ink-dim hover:text-ink"
              }`}
            >
              {t.label}
              {t.badge != null && t.badge > 0 && <Badge count={t.badge} />}
            </a>
          ))}
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
          {/* The palette is the fastest path to anything in Argus, so it gets a
              real affordance with its shortcut on it — not a bare icon nobody
              would guess is keyboard-driven. It collapses to the icon alone on
              narrow viewports. */}
          <button
            type="button"
            onClick={onOpenPalette}
            aria-label={`Search — open the command palette (${modLabel})`}
            className="group flex h-8 items-center gap-2 rounded-control border border-line-strong bg-surface/60 px-2 text-ink-dim transition duration-(--duration-quick) hover:border-ink-faint/45 hover:bg-surface-2 hover:text-ink motion-safe:active:scale-[0.97] lg:pl-2.5 lg:pr-1.5 xl:min-w-56"
          >
            <Icon name="search" size={16} />
            <span className="hidden text-sm lg:inline">Search</span>
            <span aria-hidden="true" className="kbd ml-auto hidden lg:inline-flex">
              {modLabel}
            </span>
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
