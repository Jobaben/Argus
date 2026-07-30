import { prefersReducedMotion } from "./motion";
import type { RouteDirection } from "./direction";

/**
 * View Transitions, as progressive enhancement.
 *
 * Without them a route change can only animate the *arriving* view: the old one
 * is unmounted by the time React commits, so "the old view settles out as the new
 * one arrives" is not expressible. The browser API keeps a snapshot of the old
 * document alive across the commit, which makes a true crossfade — and
 * element-level continuity, where the agent tile you clicked visibly *becomes*
 * the detail page's header — a stylesheet concern rather than a state machine.
 *
 * Everything here degrades to calling `update()` directly:
 *
 * - no `document.startViewTransition` (Firefox, Safari at time of writing) →
 *   today's keyed entrance, which is what the app already did everywhere;
 * - reduced motion → the update, immediately, with no snapshot. The API is *not*
 *   covered by the global `prefers-reduced-motion` rule in `index.css`, because
 *   `*` does not match `::view-transition-*` pseudo-elements. So the guard has to
 *   be here, and it is the reason this wrapper exists at all rather than the call
 *   sites reaching for `document.startViewTransition` themselves.
 */

/**
 * Whether the browser will keep the old view on screen for us.
 *
 * Callers need this, not just `startViewTransition`, because the two paths are
 * mutually exclusive: with view transitions the *browser* animates the arriving
 * view, so a route container that also animates its own entrance would play the
 * same motion twice, at double strength.
 */
export function supportsViewTransitions(): boolean {
  if (typeof document === "undefined") return false;
  // Typed as always present by the DOM lib, and absent in Firefox, Safari and
  // jsdom — so the check has to be a runtime one.
  return typeof document.startViewTransition === "function";
}

/** The transition's direction, published for `index.css` to select on. */
export function setRouteDirection(direction: RouteDirection): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.route = direction;
}

/**
 * Runs `update` inside a view transition when that is both available and wanted.
 *
 * `update` must apply the state change *synchronously* — the browser snapshots
 * the DOM when the callback returns, so a React update has to be flushed inside
 * it (`flushSync`) rather than scheduled.
 */
export function startViewTransition(update: () => void): void {
  if (typeof document === "undefined") {
    update();
    return;
  }
  if (!supportsViewTransitions() || prefersReducedMotion()) {
    update();
    return;
  }
  try {
    document.startViewTransition(update);
  } catch {
    // A transition already in flight, or a browser that has the method but
    // refuses (a hidden document). The navigation still has to happen.
    update();
  }
}

/**
 * A `view-transition-name` for an element that exists on both sides of a
 * navigation, so the browser tweens between the two instead of crossfading them.
 *
 * Names are custom-idents and must be unique per document, which is why they are
 * built from an id: an agent tile and the agent's detail header share
 * `agent-<short>` and are never on screen at the same time.
 */
export function transitionName(kind: string, id: string | null | undefined): string | undefined {
  if (!id) return undefined;
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, "-");
  if (safe === "" || /^-*$/.test(safe)) return undefined;
  return `${kind}-${safe}`;
}
