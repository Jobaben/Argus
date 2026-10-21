import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
  activeLabel,
}: {
  destinations: NavTab[];
  overflow: MoreItem[];
  activeId: string;
  activeLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const { present, exited } = usePresence(open);
  const scrimRef = useSurfaceMotion<HTMLDivElement>(open, SURFACE.scrim);
  // `top` — the sheet belongs to the bar it drops out of, so that is the edge it
  // collapses back into rather than shrinking toward its own middle.
  const sheetRef = useSurfaceMotion<HTMLDivElement>(open, SURFACE.rise, exited, "top center");

  // Navigating closes the sheet: the hash change is the confirmation. Escape
  // closes it too, and opening it moves focus to the current destination — a
  // sheet you can open from the keyboard but not leave from it is a trap.
  // However it closes (a link, the scrim, Escape, a hash change), focus goes
  // back to the toggle: left on a link in a sheet going inert and then away,
  // it fell to <body>, and the next Tab started again from the top.
  const sheetEl = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
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
  }, [open, close]);

  const attention = destinations.reduce((n, d) => n + (d.badge ?? 0), 0);

  return (
    // Tabbing out of the open sheet closes it: left open, the next stop is
    // page content under the scrim, focused where nobody can see it.
    <div
      className="min-w-0 md:hidden"
      onBlur={(e) => {
        const to = e.relatedTarget;
        if (open && to instanceof Node && !e.currentTarget.contains(to)) setOpen(false);
      }}
    >
      {/* The one control in the bar that gives way: the page name truncates so
          the search, bell and connection pill always fit, offline Retry
          included, at every phone width. The hit area reaches 44px tall on
          a phone without making the bar any taller. */}
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={
          open
            ? "Close the menu"
            : attention > 0
              ? `Open the menu (${attention} waiting on you)`
              : "Open the menu"
        }
        className="relative flex h-9 min-w-0 max-w-full items-center gap-2.5 rounded-control border border-line-strong bg-surface/60 pl-2.5 pr-3 text-sm text-ink transition duration-(--duration-quick) before:absolute before:-inset-y-1 before:inset-x-0 hover:bg-surface-2 motion-safe:active:scale-[0.97]"
      >
        {/* The attention count sits on the icon, not after the page name: as a
            suffix, "Health 5" read as five things wrong with Health when it is
            everything, anywhere, that is waiting on a person. */}
        <span className="relative flex shrink-0">
          <Icon name={open ? "close" : "menu"} size={17} className="text-ink-dim" />
          {!open && attention > 0 && (
            <span
              aria-hidden="true"
              className="absolute -right-1.5 -top-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-await px-1 text-micro font-semibold leading-none text-ground ring-2 ring-ground"
            >
              {attention > 9 ? "9+" : attention}
            </span>
          )}
        </span>
        <span className="min-w-0 truncate font-semibold">{activeLabel}</span>
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
            onClick={close}
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
                    onClick={close}
                    className={`flex h-11 items-center rounded-control px-3 text-heading transition-transform duration-(--duration-press) motion-safe:active:scale-[0.98] ${
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
                      onClick={close}
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
 * The active-destination pill, as one element that moves — and how many
 * destinations fit beside it.
 *
 * The pill used to be a background colour on whichever tab was current, which
 * meant it *teleported* between tabs — there and then here, with nothing in
 * between. One absolutely-positioned indicator that slides instead is the
 * cheapest shared-element transition there is, and it answers "which tab did I
 * come from?" without the user having to have been watching.
 *
 * Between ~768px and ~1150px the eight destinations do not fit. The strip used
 * to scroll sideways behind a fade, which hid Health, Issues and Budget from
 * anyone without a trackpad and clipped the focus ring of whichever one the
 * keyboard reached. Now the ones that do not fit leave the bar for the head of
 * the More menu ("priority+"), so every destination is one click away at every
 * width. Tabs past the fit stay laid out, invisibly, at the end of the strip:
 * each keeps a measurable position, so the count never depends on itself.
 *
 * Measured rather than computed: labels and badges are variable-width, so the
 * only honest source for where the pill goes is where the anchor actually is.
 * Until the first measurement (and in jsdom, where nothing has a width) every
 * tab counts as fitting and the pill is hidden, so nothing paints in the wrong
 * place.
 */
function useTrack(activeId: string, tabCount: number) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ left: number; width: number } | null>(null);
  const [fit, setFit] = useState(tabCount);

  // Layout effect: the measurement has to land in the same frame as the tab
  // change, or the pill starts sliding one frame after the label goes bold.
  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const measure = () => {
      const tabs = Array.from(track.querySelectorAll<HTMLElement>("[data-tab]"));
      // The track's right padding is the focus ring's room, not the tabs'.
      const room = track.clientWidth - (parseFloat(getComputedStyle(track).paddingRight) || 0);
      let fits = tabs.length;
      if (track.clientWidth > 0) {
        const first = tabs.findIndex((t) => t.offsetLeft + t.offsetWidth > room + 0.5);
        if (first !== -1) fits = first;
      }
      setFit((f) => (f === fits ? f : fits));
      const index = tabs.findIndex((t) => t.dataset.tab === activeId);
      const current = index !== -1 && index < fits ? tabs[index] : null;
      setBox((b) => {
        if (!current) return null;
        const left = current.offsetLeft;
        const width = current.offsetWidth;
        return b && b.left === left && b.width === width ? b : { left, width };
      });
    };
    measure();
    // The room changes with the window, and every tab changes width when the
    // web font arrives: the first measurement is taken against the fallback
    // face, and when Hellix swapped in the pill was left parked between two
    // tabs until something else happened to re-measure it. A ResizeObserver on
    // the track and on the tabs catches that, and a badge appearing.
    window.addEventListener("resize", measure);
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(track);
    for (const tab of track.querySelectorAll("[data-tab]")) ro?.observe(tab);
    let live = true;
    void document.fonts?.ready.then(() => {
      if (live) measure();
    });
    return () => {
      live = false;
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [activeId, tabCount]);

  return { trackRef, box, fit: Math.min(fit, tabCount) };
}

export function NavBar({
  destinations,
  overflow,
  activeId,
  activeLabel,
  live,
  onOpenPalette,
}: {
  destinations: NavTab[];
  overflow: MoreItem[];
  activeId: string;
  /** The current page's name, from the whole route table. Drill-downs (an
   *  agent, a run) and Search are in neither list, and a page the viewer may
   *  not see in the menu (Users, signed out) is not in it either; looked up
   *  from the lists, all of them left the phone header saying only "Menu". */
  activeLabel: string;
  live: boolean;
  onOpenPalette: () => void;
}) {
  const { trackRef, box: pill, fit } = useTrack(activeId, destinations.length);
  // The destinations the bar had no room for, at the head of the More menu
  // with their badges: a count that leaves the bar must not leave the screen.
  const spilled: MoreItem[] = destinations.slice(fit).map((d) => ({
    id: d.id,
    label: d.label,
    href: `#/${d.id}`,
    badge: d.badge,
  }));
  const overflowActive = [...spilled, ...overflow].some((o) => o.id === activeId);
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
            gives up room first: below xl the destinations need it more. The
            iris stays, and it is still the way home. */}
        <a
          href="#/command"
          aria-label="Argus home"
          className="flex shrink-0 items-center gap-2.5 rounded-control py-1 pr-1 text-heading font-semibold tracking-[0.14em]"
        >
          <IrisMark size={22} />
          <span aria-hidden="true" className="hidden xl:inline">
            ARG<span className="text-eye">U</span>S
          </span>
        </a>

        <MobileNav
          destinations={destinations}
          overflow={overflow}
          activeId={activeId}
          activeLabel={activeLabel}
        />

        {/* Destinations take the room the bar has and no more: the ones that
            do not fit move to the More menu (see useTrack). Below `md` the
            sheet above replaces them entirely. The padding is the focus ring's
            room — the strip clips, and a clipped ring is no ring. */}
        <div
          ref={trackRef}
          className="relative ml-0.5 hidden min-w-0 flex-1 items-center gap-0.5 overflow-hidden p-1 md:flex lg:ml-2"
        >
          {/* First in DOM order and unpositioned in z, so it paints *under* the
              anchors: same pixels the active tab's own background used to draw,
              now able to travel between them. `width` is transitioned alongside
              the transform because the tabs are different widths and the pill has
              to become the new one, not just arrive at it — it is absolutely
              positioned, so that width change cannot move anything else. */}
          <span
            aria-hidden="true"
            className={`pointer-events-none absolute inset-y-1 left-0 rounded-md bg-surface-2 ${
              reduced ? "" : "transition-[transform,width,opacity] duration-(--duration-base)"
            } ease-(--ease-out-expo)`}
            style={
              pill
                ? { transform: `translateX(${pill.left}px)`, width: `${pill.width}px`, opacity: 1 }
                : { opacity: 0, width: 0 }
            }
          />
          {destinations.map((t, i) => {
            // Past the fit: still laid out, so it can be measured, but not seen,
            // focused or announced — the More menu carries it instead.
            const spilt = i >= fit;
            return (
              <a
                key={t.id}
                href={`#/${t.id}`}
                data-tab={t.id}
                aria-current={t.id === activeId && !spilt ? "page" : undefined}
                aria-hidden={spilt ? true : undefined}
                tabIndex={spilt ? -1 : undefined}
                className={`relative flex h-8 shrink-0 items-center rounded-md px-3 text-sm transition duration-(--duration-quick) motion-safe:active:scale-[0.97] ${
                  t.id === activeId ? "text-ink" : "text-ink-dim hover:text-ink"
                }${spilt ? " invisible" : ""}`}
              >
                {t.label}
                {t.badge != null && t.badge > 0 && <Badge count={t.badge} />}
              </a>
            );
          })}
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
          {/* The palette is the fastest path to anything in Argus, so it gets a
              real affordance with its shortcut on it — not a bare icon nobody
              would guess is keyboard-driven. Below xl it gives its label and
              keycap to the destinations and keeps the shortcut in its tooltip.
              On a phone its hit area grows to 44px tall without the bar
              growing, as the bell's does. */}
          <button
            type="button"
            onClick={onOpenPalette}
            aria-label={`Search — open the command palette (${modLabel})`}
            title={`Search (${modLabel})`}
            className="group relative flex h-8 items-center gap-2 rounded-control border border-line-strong bg-surface/60 px-2 text-ink-dim transition duration-(--duration-quick) hover:border-ink-faint/45 hover:bg-surface-2 hover:text-ink motion-safe:active:scale-[0.97] max-md:before:absolute max-md:before:-inset-x-[3px] max-md:before:-inset-y-1.5 xl:pl-2.5 xl:pr-1.5 min-[1400px]:min-w-56"
          >
            <Icon name="search" size={16} />
            <span className="hidden text-sm xl:inline">Search</span>
            <span aria-hidden="true" className="kbd ml-auto hidden xl:inline-flex">
              {modLabel}
            </span>
          </button>
          {/* The overflow menu duplicates the sheet's secondary list on mobile,
              so it only appears once the desktop bar does. It also carries the
              destinations the bar had no room for, ahead of its own pages. */}
          <span className="hidden md:inline">
            <MoreMenu lead={spilled} items={overflow} active={overflowActive} activeId={activeId} />
          </span>
          <NotificationCenter />
          <ConnectionPill live={live} />
        </div>
      </div>
    </nav>
  );
}
