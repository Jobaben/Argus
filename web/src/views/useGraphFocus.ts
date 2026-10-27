import { useEffect, useRef, useState, type RefObject } from "react";
import { prefersReducedMotion } from "../ds";
import {
  activePhases,
  followScroll,
  scrollTargetFor,
  type FocusFrame,
  type FocusPhase,
  type Point,
  type Size,
} from "./graphFocus";
import type { LaneLayout } from "./laneGraphLayout";

function viewportOf(el: HTMLElement): Size {
  return { w: el.clientWidth, h: el.clientHeight };
}

/**
 * The tile's own scroll position, never `scrollIntoView`: that scrolls every
 * scrollable ancestor including the window, so a status change on a card below
 * the fold used to yank the whole page to it.
 */
function scrollTile(el: HTMLElement, target: { left: number; top: number }, smooth: boolean) {
  const behavior: ScrollBehavior = smooth && !prefersReducedMotion() ? "smooth" : "auto";
  if (typeof el.scrollTo === "function") el.scrollTo({ ...target, behavior });
  else {
    el.scrollLeft = target.left;
    el.scrollTop = target.top;
  }
}

/** Whether the tile has anything to scroll: a graph that fits has no view to take over. */
function overflows(el: HTMLElement): boolean {
  return el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth;
}

function nodeCentre(layout: LaneLayout, id: string): Point | null {
  const node = layout.nodes.find((n) => n.id === id);
  return node ? { x: node.x + layout.nodeW / 2, y: node.y + layout.nodeH / 2 } : null;
}

/** How long after the pointer leaves the graph a view the user moved returns to the run. */
export const RETURN_AFTER_MS = 5000;

/**
 * Keeps the phases the run is on centred in a scrolling graph (see
 * {@link followScroll}), moving on as the run does.
 *
 * Following is the user's switch. With it on, a drag or a node click only
 * looks away: the view is theirs while the pointer is over the graph, and
 * {@link RETURN_AFTER_MS} after it leaves, the view goes back to the run. The
 * countdown waits for the pointer to leave, so the graph never moves under
 * someone still reading a branch. With following off, the view stays where the
 * user put it.
 *
 * Looking away is driven by input, never by `scroll` events, which the
 * follow's own smooth scroll fires too. A selection the board makes itself — a
 * gate opening, a failure landing — is still centred once, followed or not,
 * unless following already has it in view.
 */
export function useGraphFocus(
  scrollerRef: RefObject<HTMLElement | null>,
  phases: readonly FocusPhase[],
  layout: LaneLayout,
  frame: FocusFrame & { ready: boolean },
  selectedId: string | null,
) {
  const [following, setFollowing] = useState(true);
  const [away, setAway] = useState(false);
  const returnTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tracking = following && !away;
  const last = useRef<{ left: number; top: number } | null>(null);
  const scrolled = useRef(false);
  const clicked = useRef<string | null>(null);
  const seenSelection = useRef(selectedId);
  const { scale, ready } = frame;
  const { x: runwayX, y: runwayY } = frame.runway;

  useEffect(() => {
    // Unmeasured, the scale and runway are placeholders: a scroll now would
    // land in the wrong place and make the real first placement a glide.
    if (!tracking || !ready) return;
    const el = scrollerRef.current;
    if (!el) return;
    const placed = { scale, runway: { x: runwayX, y: runwayY } };
    // A run with nothing to follow is still placed once, at the graph's start:
    // left at scroll 0 it opened on the empty runway before it, half a tile of
    // nothing. Placed once only, so a run that finishes stays where it ended.
    const target =
      followScroll(phases, layout, viewportOf(el), placed) ??
      (scrolled.current ? null : { left: Math.round(runwayX), top: Math.round(runwayY) });
    if (!target) return;
    const prev = last.current;
    if (prev && prev.left === target.left && prev.top === target.top) return;
    last.current = target;
    // The first placement jumps; every move after it is visible as a move.
    scrollTile(el, target, scrolled.current);
    scrolled.current = true;
  }, [tracking, ready, phases, layout, scale, runwayX, runwayY, scrollerRef]);

  useEffect(() => {
    if (!ready) return;
    const prev = seenSelection.current;
    seenSelection.current = selectedId;
    if (selectedId === null || selectedId === prev || selectedId === clicked.current) return;
    // The board's pick moves with the run, so centring a phase following has
    // just brought into view undid the follow each time the run moved on.
    if (tracking && activePhases(phases).includes(selectedId)) return;
    const el = scrollerRef.current;
    const point = nodeCentre(layout, selectedId);
    if (!el || !point) return;
    const runway = { x: runwayX, y: runwayY };
    scrollTile(el, scrollTargetFor(point, viewportOf(el), { scale, runway }), scrolled.current);
    scrolled.current = true;
  }, [selectedId, ready, tracking, phases, layout, scale, runwayX, runwayY, scrollerRef]);

  const cancelReturn = () => {
    if (returnTimer.current === null) return;
    clearTimeout(returnTimer.current);
    returnTimer.current = null;
  };

  useEffect(() => cancelReturn, []);

  /** The user moved the view: theirs until the pointer has been gone a while. */
  const lookAway = () => {
    const el = scrollerRef.current;
    if (!el || !overflows(el)) return;
    cancelReturn();
    setAway(true);
  };

  const resume = () => {
    cancelReturn();
    last.current = null;
    setAway(false);
    setFollowing(true);
  };

  const stop = () => {
    cancelReturn();
    setAway(false);
    setFollowing(false);
  };

  const onPointerLeave = () => {
    if (!following || !away) return;
    cancelReturn();
    returnTimer.current = setTimeout(() => {
      returnTimer.current = null;
      last.current = null;
      setAway(false);
    }, RETURN_AFTER_MS);
  };

  /** Centre one phase and look away: the user picked what to look at. */
  const centreOn = (id: string) => {
    clicked.current = id;
    lookAway();
    const el = scrollerRef.current;
    const point = nodeCentre(layout, id);
    if (!el || !point) return;
    scrollTile(el, scrollTargetFor(point, viewportOf(el), frame), true);
    scrolled.current = true;
  };

  return {
    following,
    tracking,
    away,
    lookAway,
    resume,
    stop,
    centreOn,
    onPointerEnter: cancelReturn,
    onPointerLeave,
  };
}
