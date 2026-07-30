import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { SURFACE, usePresence, useSurfaceMotion } from "./presence";
import { createVelocityTracker, flickOutcome } from "./gesture";
import { DURATION, EASE, prefersReducedMotion } from "./motion";
import { springLinear } from "./spring";

/** The same spring `index.css` publishes as `--ease-spring-settle`; the Web
 *  Animations API takes an easing *value*, not a custom property reference. */
const SPRING_EASING = springLinear();

/**
 * A right-edge slide-over.
 *
 * The board's whole value is peripheral vision — a dozen pipelines in one
 * glance. Navigating away to inspect one step throws that away and makes
 * "check the failing step, then look at the others" a round trip through the
 * router. A drawer keeps the board on screen behind it, so the context you were
 * reading is still there when you close it.
 *
 * Mounted only while open *or leaving* (see {@link Drawer} at the bottom), so its
 * content starts fresh each time rather than needing a reset effect — and so it
 * has time to leave. It used to slide in over 180ms and vanish in zero.
 */
function Panel({
  title,
  subtitle,
  onClose,
  children,
  footer,
  visible,
  onExited,
  originY,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** The caller's `open`: false starts the exit while this stays mounted. */
  visible: boolean;
  onExited: () => void;
  /** Viewport Y of whatever opened the drawer, so it grows out of that row. */
  originY?: number;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(
    typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null),
  );
  const scrimRef = useSurfaceMotion<HTMLDivElement>(visible, SURFACE.scrim);
  // The panel is the surface that reports: one presence, two animated elements,
  // and the slower of the two decides when the drawer is really gone.
  const motionRef = useSurfaceMotion<HTMLDivElement>(
    visible,
    SURFACE.panel,
    onExited,
    originY == null ? undefined : `right ${Math.round(originY)}px`,
  );
  const setPanel = useCallback(
    (node: HTMLDivElement | null) => {
      panelRef.current = node;
      motionRef(node);
    },
    [motionRef],
  );

  /**
   * Hands focus back to whatever had it — but only if focus is still in here.
   *
   * Handed back when the drawer starts *leaving* rather than when it finishes:
   * waiting would park the caret inside a subtree that is by then `inert` and
   * `aria-hidden`, which is worse than either on its own.
   *
   * The guard matters because this runs twice by design: once on that
   * transition, and once on unmount as the fallback for an abrupt removal with
   * no exit at all. Without it the second call would yank the caret back from
   * wherever the user had moved it during those 126ms.
   */
  const handBackFocus = useCallback(() => {
    const active = document.activeElement;
    const inside = active === document.body || (panelRef.current?.contains(active) ?? false);
    if (inside) restoreFocus.current?.focus?.();
  }, []);

  useEffect(() => {
    const raf = requestAnimationFrame(() => closeRef.current?.focus());
    return () => {
      cancelAnimationFrame(raf);
      handBackFocus();
    };
  }, [handBackFocus]);

  // Focus goes back when the drawer starts *leaving*, not when it finishes.
  // Waiting would leave the caret inside a surface that is already
  // `aria-hidden`, which is the one arrangement worse than either alone.
  useEffect(() => {
    if (!visible) handBackFocus();
  }, [visible, handBackFocus]);

  const drag = useDragToDismiss(panelRef, onClose, visible);

  // Tab must not walk out of an aria-modal dialog into the page behind it.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (!focusable || focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    }
  };

  return (
    <div
      ref={scrimRef}
      className="fixed inset-0 z-40 flex justify-end bg-ground/60 backdrop-blur-[2px]"
      // A surface on its way out must not be clickable or reachable: it is a
      // picture of a dialog by then, and `inert` says exactly that to the
      // pointer, the tab order and the accessibility tree at once. `aria-hidden`
      // alongside it because jsdom implements `inert` as an attribute and
      // nothing more, so tests would still see the leaving surface as live.
      inert={!visible}
      aria-hidden={visible ? undefined : true}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={setPanel}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : "Details"}
        onKeyDown={onKeyDown}
        className="flex h-full w-full max-w-[520px] flex-col border-l border-line bg-surface shadow-[-24px_0_80px_-24px_rgb(0_0_0/0.9)]"
      >
        <header
          onPointerDown={drag}
          className="flex items-start gap-3 border-b border-line px-5 py-3.5 touch-none"
        >
          <div className="min-w-0 flex-1">
            <h2 className="break-words text-[15px] font-bold leading-tight text-ink">{title}</h2>
            {subtitle && (
              <p className="mt-1 break-words font-mono text-[11px] text-ink-faint">{subtitle}</p>
            )}
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-md border border-line px-2 py-1 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-dim transition duration-(--duration-quick) hover:text-ink motion-safe:active:scale-[0.97]"
          >
            Esc
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="border-t border-line px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

/**
 * Drag the drawer's header rightwards to throw it away.
 *
 * The panel tracks the pointer 1:1 — anything less than that is the thing that
 * makes a drag feel like a suggestion rather than a grip — and on release either
 * leaves at the speed it was flicked or springs back. Both outcomes are decided
 * from measured velocity (see `gesture.ts`), so a fast two-pixel flick dismisses
 * and a slow drag half-way across does not.
 *
 * Header only, not the whole panel: the body scrolls and holds selectable text,
 * and stealing those to a dismissal gesture would trade a real interaction for a
 * flourish. Skipped entirely under reduced motion, where the buttons and Escape
 * are the whole story.
 */
function useDragToDismiss(
  panelRef: React.RefObject<HTMLDivElement | null>,
  onClose: () => void,
  visible: boolean,
) {
  /**
   * Teardown for whatever the current gesture has outstanding.
   *
   * A gesture outlives a render: its listeners sit on `window` and its release
   * hands `onClose` to a timer. If the drawer goes away first — the route
   * changes, the row it belongs to disappears — the listeners would keep firing
   * against a detached panel until the pointer happened to come up, and the timer
   * would still call `onClose` on a drawer that closed long ago. Held in a ref so
   * unmount can reach it.
   */
  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    },
    [],
  );

  return useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const panel = panelRef.current;
      if (!panel || !visible || prefersReducedMotion()) return;
      if (event.button !== 0 || typeof panel.animate !== "function") return;
      // Let a click on the close button be a click.
      if ((event.target as HTMLElement).closest("button")) return;
      // A second pointerdown before the first gesture settled: the old one is
      // over, whatever it still had pending.
      cleanupRef.current?.();

      const startX = event.clientX;
      const width = panel.getBoundingClientRect().width || 1;
      const tracker = createVelocityTracker();
      tracker.sample(0, event.timeStamp);
      let offset = 0;
      let dragging = false;

      const onMove = (move: PointerEvent) => {
        // Only rightwards, and only once the gesture has committed: a 3px
        // wobble on a click must not shift the panel.
        offset = Math.max(0, move.clientX - startX);
        if (!dragging && offset < 4) return;
        dragging = true;
        tracker.sample(offset, move.timeStamp);
        panel.style.transform = `translateX(${offset}px)`;
        panel.style.opacity = String(Math.max(0.4, 1 - (offset / width) * 0.6));
      };

      let releaseTimer: number | null = null;
      const detachListeners = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };
      const teardown = () => {
        detachListeners();
        if (releaseTimer !== null) {
          window.clearTimeout(releaseTimer);
          releaseTimer = null;
        }
      };

      const onUp = (up: PointerEvent) => {
        detachListeners();
        if (!dragging) {
          cleanupRef.current = null;
          return;
        }
        tracker.sample(Math.max(0, up.clientX - startX), up.timeStamp);
        const { release, ms } = flickOutcome(offset, tracker.velocity(), width);
        if (release) {
          // Continue in the direction of travel at the speed of the flick, then
          // hand over to the caller — which unmounts, so this is the exit.
          panel.animate(
            [
              { transform: `translateX(${offset}px)`, opacity: panel.style.opacity || "1" },
              { transform: `translateX(${width}px)`, opacity: 0 },
            ],
            { duration: ms, easing: EASE.inExpo, fill: "forwards" },
          );
          // `cleanupRef` stays pointing at `teardown` until this fires, so an
          // unmount in the meantime cancels the close rather than firing it late.
          releaseTimer = window.setTimeout(() => {
            releaseTimer = null;
            cleanupRef.current = null;
            onClose();
          }, ms);
          return;
        }
        const back = panel.animate(
          [
            { transform: `translateX(${offset}px)`, opacity: panel.style.opacity || "1" },
            { transform: "translateX(0px)", opacity: 1 },
          ],
          { duration: Math.max(ms, DURATION.base), easing: SPRING_EASING },
        );
        back.onfinish = () => {
          panel.style.removeProperty("transform");
          panel.style.removeProperty("opacity");
        };
        // The gesture refused and nothing is outstanding; the animation is the
        // element's own and goes with it.
        cleanupRef.current = null;
      };

      cleanupRef.current = teardown;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [panelRef, onClose, visible],
  );
}

export function Drawer(props: {
  open: boolean;
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** Viewport Y of the row that opened it; the panel grows from there. */
  originY?: number;
}) {
  const { open, ...rest } = props;
  const { present, exited } = usePresence(open);
  if (!present) return null;
  return <Panel {...rest} visible={open} onExited={exited} />;
}
