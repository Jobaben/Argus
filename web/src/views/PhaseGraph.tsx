import { useLayoutEffect, useState, type HTMLAttributes } from "react";
import type { DsStatus, PhasePill } from "../ds";
import { Button, DURATION, Icon, STATUS, useSyncedDelay } from "../ds";
import { fadeEdges, overflows, runwayFor } from "./graphFocus";
import {
  LANE_GEOMETRY,
  MAX_TILE_HEIGHT_PX,
  MIN_SCALE,
  type EdgeState,
  type LaneLayout,
} from "./laneGraphLayout";
import { useGraphFocus } from "./useGraphFocus";
import { reasonText } from "./text";
import { useElementWidth } from "./useLaneLayout";

/**
 * The pipeline's shape as a lane graph: one node per phase, stages as rows,
 * every dependency a drawn edge, conditions as labels on the edge they govern.
 *
 * This is the board's overhead for an instance. It carries every phase's
 * status, gate, attempt and step progress at a glance; the step tiles — the
 * expensive part — render for one phase at a time in the focus panel beside
 * it. See {@link laneLayout} for why the shape is drawn rather than packed.
 *
 * Geometry comes from the pure layout; this component paints it inside a
 * bounded viewport. Whatever the shape, the graph never sizes its container:
 * it is scaled to fit down to {@link MIN_SCALE}, scrolls beyond that, keeps the
 * phase the run is on in view, and fades the edges that have more beyond them.
 */

const PHASE_DOT: Record<DsStatus, string> = {
  working: "bg-run",
  done: "bg-ok",
  failed: "bg-fail",
  queued: "bg-queue",
  idle: "bg-idle",
  await: "bg-await",
  stopped: "bg-idle",
};

/**
 * Edge strokes by state. Same colour brighter and heavier when the edge is
 * incident to the selected node, so selection never repaints a taken edge as
 * something else.
 */
const STROKE: Record<EdgeState, { color: string; opacity: number; hot: number }> = {
  taken: { color: "var(--color-ok)", opacity: 0.5, hot: 0.95 },
  pending: { color: "var(--color-ink-faint)", opacity: 0.3, hot: 0.85 },
  skipped: { color: "var(--color-ink-faint)", opacity: 0.32, hot: 0.7 },
};

const LABEL: Record<EdgeState, string> = {
  taken: "border-ok/40 text-ink-dim",
  pending: "border-line text-ink-faint",
  skipped: "border-line text-ink-faint opacity-60",
};

/**
 * A route's condition as a chip, tinted by whether the edge it governs ran.
 * The graph draws it on the edge; the focus panel's "from" and "to" lines draw
 * the same one, so a condition looks like itself wherever it appears.
 */
export function RouteCondition({
  state,
  hot = false,
  className = "",
  ...rest
}: { state: EdgeState; hot?: boolean } & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      {...rest}
      className={`rounded-md border bg-surface-2 px-1.5 text-micro ${
        hot ? "border-ink-faint text-ink" : LABEL[state]
      } ${className}`}
    />
  );
}

/** Best-of-N in the space a phase pill has: "2/3 verified · c2 selected". */
function candidateNote(c: NonNullable<PhasePill["candidates"]>): string {
  const verified = `${c.verified}/${c.total} verified`;
  return c.selected == null ? verified : `${verified} · c${c.selected + 1} selected`;
}

/** A spawn phase in a title's words: how far its tasks got, and who is waited on. */
function spawnNote(s: NonNullable<PhasePill["spawn"]>): string {
  if (s.tasks.length === 0) return "spawns one child instance per task";
  const bits = [`${s.succeeded}/${s.tasks.length} tasks done`];
  if (s.waiting > 0) bits.push(`${s.waiting} waiting for you`);
  if (s.halted > 0) bits.push(`${s.halted} failed or stopped`);
  return bits.join(" · ");
}

function chipTitle(pill: PhasePill, index: number, needNames: string[]): string {
  // A skipped phase says so in words. The DS token behind it is the quiet one,
  // which is right for the colour and wrong for the word: "idle" would promise
  // work that is never coming.
  const state = pill.skipped ? "skipped" : STATUS[pill.status].label.toLowerCase();
  const bits = [`${index + 1}. ${pill.name} — ${state}`];
  if (pill.gated) bits.push("gated: waits for a human");
  if ((pill.attempt ?? 0) > 0) bits.push(`attempt ${pill.attempt + 1}`);
  if (pill.retryAt && pill.status === "failed") bits.push("retry queued");
  if (pill.candidates) bits.push(candidateNote(pill.candidates));
  if (pill.spawn) bits.push(spawnNote(pill.spawn));
  // Without the "failed:" the scheduler stores it with: the line already says so.
  if (pill.reason) bits.push(reasonText(pill.reason.split("\n")[0]));
  if (pill.skipCause) bits.push(`not selected — ${pill.skipCause.source}: ${pill.skipCause.label}`);
  for (const edge of pill.edges ?? []) {
    if (edge.conditional) bits.push(`only if ${edge.phase}: ${edge.label}`);
    if (edge.allowSkipped) bits.push(`accepts ${edge.phase} skipped`);
  }
  bits.push(needNames.length > 0 ? `waits for ${needNames.join(", ")}` : "starts immediately");
  return bits.join(" · ");
}

function PhaseNode({
  pill,
  index,
  needNames,
  x,
  y,
  width,
  height,
  stage,
  lane,
  selected,
  onSelect,
}: {
  pill: PhasePill;
  index: number;
  needNames: string[];
  x: number;
  y: number;
  width: number;
  height: number;
  stage: number;
  lane: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const live = pill.status === "working" || pill.status === "await";
  const skipped = pill.skipped === true;
  // Same beat as every other pulsing surface on the board.
  const beat = useSyncedDelay(DURATION.pulse);
  // Tinted borders for the states that demand attention while unselected, and
  // for work in flight — a running node used to look exactly like an idle one,
  // which on a long chain made "where is it now?" a hunt for a 6px dot.
  const border =
    pill.status === "failed"
      ? "border-fail/45 bg-fail/[0.07] hover:bg-fail/[0.12]"
      : pill.status === "await"
        ? "border-await/50 bg-await/[0.08] hover:bg-await/[0.13]"
        : pill.status === "working"
          ? "border-run/40 bg-surface hover:bg-surface-2"
          : "border-line bg-surface hover:border-line-strong hover:bg-surface-2";
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      data-stage={stage}
      data-lane={lane}
      title={chipTitle(pill, index, needNames)}
      style={{ left: x, top: y, width, height }}
      // Selected is an outer ring in the eye's colour, not one more shade of
      // border: it must read at a glance next to a hovered node, which the old
      // `border-ink-faint` did not. It goes *around* the status tint rather
      // than replacing it — focus follows attention, so the selected node is
      // usually the waiting gate or the failure, and painting it the same
      // cyan as any clicked node hid exactly the status it was selected for.
      // Focus on the selected node rings outside its selection ring: the
      // usual 2px offset landed exactly on it, so focusing only brightened it.
      className={`absolute flex min-w-0 items-center gap-1.5 rounded-md border px-2 text-left transition-[border-color,background-color,box-shadow] duration-(--duration-quick) ${border} ${
        selected
          ? `shadow-[0_0_0_2px_var(--color-ground-2),0_0_0_4px_rgb(54_227_232/0.55)] focus-visible:outline-offset-[6px] ${
              pill.status === "failed" || pill.status === "await" || pill.status === "working"
                ? ""
                : "!border-line-strong !bg-surface-2"
            }`
          : ""
      }`}
    >
      {/* Hollow, not dim: a skipped phase is terminal, and an outline reads as
          "decided against" where another filled dot reads as "not yet". */}
      <span
        aria-hidden="true"
        style={live ? { animationDelay: beat } : undefined}
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
          skipped ? "border border-ink-faint" : PHASE_DOT[pill.status]
        } ${live ? "motion-safe:animate-[pulse_var(--duration-pulse)_ease-in-out_infinite]" : ""}`}
      />
      <span className="shrink-0 font-mono text-micro leading-none text-ink-faint">
        {String(index + 1).padStart(2, "0")}
      </span>
      <span
        data-full-name={pill.name}
        className={`min-w-0 flex-1 truncate text-caption font-semibold ${
          skipped
            ? "text-ink-faint line-through decoration-line"
            : selected
              ? "text-ink"
              : "text-ink-dim"
        }`}
      >
        {pill.name}
      </span>
      {skipped && <span className={MARKER}>Skipped</span>}
      {/* Violet only on the gate someone is waiting at: on a gate nobody has
          reached yet it is a category, and the waiting colour is not one. */}
      {pill.gated && (
        <span className={`${MARKER} ${pill.status === "await" ? "!text-await" : ""}`}>Gate</span>
      )}
      {(pill.attempt ?? 0) > 0 && <span className={MARKER}>Try {pill.attempt + 1}</span>}
      {/* Best-of-N replaces the step dots: N dots would all be the same step,
          and what a reader wants is how many of the drafts survived. */}
      {pill.candidates && (
        <span
          data-testid="candidate-summary"
          className="shrink-0 whitespace-nowrap text-micro text-ink-faint"
        >
          {candidateNote(pill.candidates)}
        </span>
      )}
      {/* A spawn phase: the glyph, and how many of its tasks are done. Violet
          while a child waits for you — the parent is still running, so the
          node's own colour cannot say it. */}
      {pill.spawn && (
        <span
          data-testid="spawn-summary"
          className={`flex shrink-0 items-center gap-0.5 whitespace-nowrap text-micro ${
            pill.spawn.waiting > 0
              ? "font-semibold text-await"
              : pill.spawn.halted > 0
                ? "text-fail"
                : "text-ink-faint"
          }`}
        >
          <Icon name="spawn" size={12} />
          {pill.spawn.tasks.length > 0 && `${pill.spawn.succeeded}/${pill.spawn.tasks.length}`}
        </span>
      )}
      {/* Step progress without step tiles: one dot per step, or a count once
          dots would stop being countable at a glance. */}
      {!pill.candidates &&
        pill.steps.length > 1 &&
        (pill.steps.length <= 6 ? (
          <span aria-hidden="true" className="flex shrink-0 items-center gap-[3px]">
            {pill.steps.map((s, i) => (
              <span key={i} className={`h-1 w-1 rounded-full ${PHASE_DOT[s.status]}`} />
            ))}
          </span>
        ) : (
          <span className="shrink-0 text-micro text-ink-faint">
            {pill.steps.filter((s) => s.status === "done").length}/{pill.steps.length}
          </span>
        ))}
    </button>
  );
}

/** Edge fade written straight to the element, so scrolling never re-renders. */
function applyFade(el: HTMLElement, runway: { x: number; y: number }) {
  const f = fadeEdges(el, runway);
  el.style.setProperty("--fade-t", `${f.top}px`);
  el.style.setProperty("--fade-r", `${f.right}px`);
  el.style.setProperty("--fade-b", `${f.bottom}px`);
  el.style.setProperty("--fade-l", `${f.left}px`);
}

const FADE_MASK = [
  "linear-gradient(to bottom, transparent 0, #000 var(--fade-t, 0px), #000 calc(100% - var(--fade-b, 0px)), transparent 100%)",
  "linear-gradient(to right, transparent 0, #000 var(--fade-l, 0px), #000 calc(100% - var(--fade-r, 0px)), transparent 100%)",
].join(", ");

const SCROLL_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);

/** A node's small word — "Gate", "Skipped", "Try 2": readable, not shouted. */
const MARKER = "shrink-0 text-micro font-semibold leading-none text-ink-faint";

function terminatorPath(
  n: { x: number; y: number },
  layout: Pick<LaneLayout, "orientation" | "nodeW" | "nodeH">,
): string {
  if (layout.orientation === "TB") {
    const cx = n.x + layout.nodeW / 2;
    const by = n.y + layout.nodeH;
    return `M${cx} ${by}L${cx} ${by + 7}M${cx - 5} ${by + 7}L${cx + 5} ${by + 7}`;
  }
  const rx = n.x + layout.nodeW;
  const cy = n.y + layout.nodeH / 2;
  return `M${rx} ${cy}L${rx + 7} ${cy}M${rx + 7} ${cy - 5}L${rx + 7} ${cy + 5}`;
}

export function PhaseGraph({
  phases,
  layout,
  selectedId,
  onSelect,
}: {
  phases: PhasePill[];
  layout: LaneLayout;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const indexOf = new Map(phases.map((p, i) => [p.id, i]));
  const nameOf = new Map(phases.map((p) => [p.id, p.name]));
  const pillOf = new Map(phases.map((p) => [p.id, p]));
  const { nodeW, nodeH } = layout;

  const [scrollerRef, viewportW] = useElementWidth<HTMLDivElement>();
  const [zoom, setZoom] = useState<"fit" | "actual">("fit");
  // Fit the width only: the long axis is what scrolling and following are
  // for, and shrinking a long chain to fit its height would shrink its text.
  // Unmeasured (first paint, jsdom) draws at full size rather than guessing.
  const fitScale = viewportW > 0 ? Math.min(1, viewportW / layout.width) : 1;
  const scale = zoom === "fit" ? Math.max(MIN_SCALE, fitScale) : 1;
  const scaledW = layout.width * scale;
  const scaledH = layout.height * scale;
  const pad = LANE_GEOMETRY.pad * scale;
  const runway = {
    x: runwayFor(scaledW, viewportW, pad),
    y: runwayFor(scaledH, MAX_TILE_HEIGHT_PX, pad),
  };
  // Whether the graph scrolls, from geometry alone, so the toolbar is settled
  // before any input.
  const scrolls =
    viewportW > 0 && (overflows(scaledW, viewportW) || overflows(scaledH, MAX_TILE_HEIGHT_PX));
  const { following, pause, resume, centreOn } = useGraphFocus(
    scrollerRef,
    phases,
    layout,
    { scale, runway, ready: viewportW > 0 },
    selectedId,
  );

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const empty = { x: runway.x, y: runway.y };
    applyFade(el, empty);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => applyFade(el, empty));
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollerRef, scaledW, scaledH, runway.x, runway.y]);

  const hot = (e: { from: string; to: string }) =>
    selectedId !== null && (e.from === selectedId || e.to === selectedId);
  // Incident edges paint last so they sit over their neighbours.
  const edges = [...layout.edges].sort((a, b) => Number(hot(a)) - Number(hot(b)));

  // The view controls get a row of their own above the graph. Floated over
  // it, they covered nodes — on a fitted fan-out, the right third of the very
  // node the board had selected. The row is there whenever the graph scrolls or
  // can zoom, which depends on the geometry and not on what the user does, so
  // following and pausing never move the graph under the pointer. Follow goes
  // with scrolling alone: in a graph that fits there is nothing to follow, and
  // a Follow left over from a scrolled view vanished from under the press
  // that switched it back on.
  const toolbar = fitScale < 1 || scrolls;

  return (
    <div
      data-orientation={layout.orientation}
      className="relative w-full min-w-0 max-w-full rounded-tile border border-line bg-ground-2/70 shadow-[inset_0_1px_3px_rgb(0_0_0/0.25)]"
    >
      {toolbar && (
        <div className="flex items-center justify-end gap-1 border-b border-line/70 px-1 py-1">
          {scrolls && (
            // A toggle rather than a button that appears once the view is
            // taken over: pressed, the graph keeps the phase the run is on in
            // view by itself, which is worth knowing when it moves unasked.
            <Button
              variant="ghost"
              size="sm"
              icon="eye"
              data-testid="graph-follow"
              aria-pressed={following}
              title={
                following
                  ? "Keeping the phase the run is on in view. Press to stop following"
                  : "Bring the phase the run is on into view, and keep following it"
              }
              onClick={following ? pause : resume}
              className="aria-pressed:bg-eye/10 aria-pressed:text-eye"
            >
              Follow
            </Button>
          )}
          {fitScale < 1 && (
            <Button
              variant="ghost"
              size="sm"
              data-testid="graph-zoom"
              title={zoom === "fit" ? "Show the graph at full size" : "Fit the graph to the tile"}
              onClick={() => setZoom((z) => (z === "fit" ? "actual" : "fit"))}
            >
              {zoom === "fit" ? "Full size" : "Fit"}
            </Button>
          )}
        </div>
      )}
      <div
        ref={scrollerRef}
        role="group"
        aria-label="Phases"
        data-testid="phase-graph"
        data-following={following ? "true" : "false"}
        onScroll={(e) => applyFade(e.currentTarget, runway)}
        onWheel={pause}
        onTouchStart={pause}
        onPointerDown={(e) => {
          // The scrollbar or the canvas takes the view over; a node click
          // centres that node instead.
          if (!(e.target as Element).closest("button")) pause();
        }}
        onKeyDown={(e) => {
          if (SCROLL_KEYS.has(e.key)) pause();
        }}
        style={{
          maxHeight: MAX_TILE_HEIGHT_PX,
          maskImage: FADE_MASK,
          WebkitMaskImage: FADE_MASK,
          maskComposite: "intersect",
          WebkitMaskComposite: "source-in",
        }}
        className="overflow-auto"
      >
        {/* Sized to the scaled graph plus its runway so the scrollbars are
            honest; centred when it is narrower than the tile. */}
        <div
          className="relative mx-auto"
          style={{ width: scaledW + runway.x * 2, height: scaledH + runway.y * 2 }}
        >
          <div
            data-testid="graph-canvas"
            className="absolute origin-top-left"
            style={{
              left: runway.x,
              top: runway.y,
              width: layout.width,
              height: layout.height,
              transform: scale === 1 ? undefined : `scale(${scale})`,
            }}
          >
            <svg
              aria-hidden="true"
              className="absolute inset-0 overflow-visible"
              width={layout.width}
              height={layout.height}
              viewBox={`0 0 ${layout.width} ${layout.height}`}
            >
              {edges.map((e) => {
                const on = hot(e);
                const s = STROKE[e.state];
                return (
                  <path
                    key={`${e.from}>${e.to}`}
                    data-testid="graph-edge"
                    data-state={e.state}
                    d={e.d}
                    fill="none"
                    stroke={s.color}
                    strokeOpacity={on ? s.hot : s.opacity}
                    strokeWidth={on ? 2 : 1.5}
                    strokeDasharray={e.state === "skipped" ? "3 3" : undefined}
                  />
                );
              })}
              {/* A leaf ends the run: say so with a terminator rather than
                  leaving the reader to infer it from the absence of a line. */}
              {layout.nodes
                .filter((n) => n.leaf)
                .map((n) => (
                  <path
                    key={`end-${n.id}`}
                    data-testid="graph-terminator"
                    d={terminatorPath(n, layout)}
                    fill="none"
                    stroke="var(--color-ink-faint)"
                    strokeOpacity={0.45}
                    strokeWidth={1.5}
                  />
                ))}
            </svg>
            {layout.nodes.map((n) => {
              const pill = pillOf.get(n.id);
              if (!pill) return null;
              return (
                <PhaseNode
                  key={n.id}
                  pill={pill}
                  index={indexOf.get(n.id) ?? 0}
                  needNames={pill.needs.map((d) => nameOf.get(d) ?? d)}
                  x={n.x}
                  y={n.y}
                  width={nodeW}
                  height={nodeH}
                  stage={n.stage}
                  lane={n.lane}
                  selected={n.id === selectedId}
                  onSelect={() => {
                    centreOn(n.id);
                    onSelect(n.id);
                  }}
                />
              );
            })}
            {/* Only the conditions are drawn. An unconditional edge already
                reads as a line, and labelling every one "always" would bury
                the two that actually decide something. */}
            {layout.edges
              .filter((e) => e.label)
              .map((e) => (
                <RouteCondition
                  key={`label-${e.from}>${e.to}`}
                  data-testid="route-label"
                  state={e.state}
                  hot={hot(e)}
                  style={{ left: e.label!.x, top: e.label!.y }}
                  className="absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap leading-[14px]"
                >
                  {e.label!.text}
                </RouteCondition>
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}
