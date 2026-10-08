import { useEffect, useRef, useState, type RefObject } from "react";
import { prefersReducedMotion } from "../ds";
import {
  followTarget,
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

/**
 * Keeps the phase the run is on centred in a scrolling graph, moving on as the
 * run does — until the user scrolls it themselves. From then on the view is
 * theirs until they ask to follow again: a board that pulls the view back
 * while someone is reading a branch is worse than one that never moved.
 *
 * Pausing is driven by input (wheel, touch, pointer, keys), never by `scroll`
 * events, which the follow's own smooth scroll fires too. A selection the
 * board makes itself — a gate opening, a failure landing — is still centred
 * once, followed or not.
 */
export function useGraphFocus(
  scrollerRef: RefObject<HTMLElement | null>,
  phases: readonly FocusPhase[],
  layout: LaneLayout,
  frame: FocusFrame & { ready: boolean },
  selectedId: string | null,
) {
  const [following, setFollowing] = useState(true);
  const last = useRef<{ left: number; top: number } | null>(null);
  const scrolled = useRef(false);
  const clicked = useRef<string | null>(null);
  const seenSelection = useRef(selectedId);
  const { scale, ready } = frame;
  const { x: runwayX, y: runwayY } = frame.runway;

  useEffect(() => {
    // Unmeasured, the scale and runway are placeholders: a scroll now would
    // land in the wrong place and make the real first placement a glide.
    if (!following || !ready) return;
    const el = scrollerRef.current;
    if (!el) return;
    const viewport = viewportOf(el);
    const point = followTarget(phases, layout, { w: viewport.w / scale, h: viewport.h / scale });
    if (!point) return;
    const target = scrollTargetFor(point, viewport, { scale, runway: { x: runwayX, y: runwayY } });
    const prev = last.current;
    if (prev && prev.left === target.left && prev.top === target.top) return;
    last.current = target;
    // The first placement jumps; every move after it is visible as a move.
    scrollTile(el, target, scrolled.current);
    scrolled.current = true;
  }, [following, ready, phases, layout, scale, runwayX, runwayY, scrollerRef]);

  useEffect(() => {
    if (!ready) return;
    const prev = seenSelection.current;
    seenSelection.current = selectedId;
    if (selectedId === null || selectedId === prev || selectedId === clicked.current) return;
    const el = scrollerRef.current;
    const point = nodeCentre(layout, selectedId);
    if (!el || !point) return;
    const runway = { x: runwayX, y: runwayY };
    scrollTile(el, scrollTargetFor(point, viewportOf(el), { scale, runway }), scrolled.current);
    scrolled.current = true;
  }, [selectedId, ready, layout, scale, runwayX, runwayY, scrollerRef]);

  const pause = () => {
    const el = scrollerRef.current;
    if (el && overflows(el)) setFollowing(false);
  };

  const resume = () => {
    last.current = null;
    setFollowing(true);
  };

  /** Centre one phase and stop following: the user picked what to look at. */
  const centreOn = (id: string) => {
    clicked.current = id;
    pause();
    const el = scrollerRef.current;
    const point = nodeCentre(layout, id);
    if (!el || !point) return;
    scrollTile(el, scrollTargetFor(point, viewportOf(el), frame), true);
    scrolled.current = true;
  };

  return { following, pause, resume, centreOn };
}
