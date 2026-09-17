import { useEffect, useRef } from "react";
import type { DsStatus, PhasePill } from "../ds";
import { DURATION, STATUS, useSyncedDelay } from "../ds";
import {
  LANE_GEOMETRY,
  MAX_TILE_HEIGHT_PX,
  type EdgeState,
  type LaneLayout,
} from "./laneGraphLayout";

/**
 * The pipeline's shape as a lane graph: one node per phase, stages as rows,
 * every dependency a drawn edge, conditions as labels on the edge they govern.
 *
 * This is the board's overhead for an instance. It carries every phase's
 * status, gate, attempt and step progress at a glance; the step tiles — the
 * expensive part — render for one phase at a time in the focus panel beside
 * it. See {@link laneLayout} for why the shape is drawn rather than packed.
 *
 * Geometry comes from the pure layout; this component only paints it and
 * measures the one thing layout cannot know — how wide the card is — to pick
 * the lane width and whether the graph sits beside or above the focus panel.
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

function chipTitle(pill: PhasePill, index: number, needNames: string[]): string {
  // A skipped phase says so in words. The DS token behind it is the quiet one,
  // which is right for the colour and wrong for the word: "idle" would promise
  // work that is never coming.
  const state = pill.skipped ? "skipped" : STATUS[pill.status].label.toLowerCase();
  const bits = [`${index + 1}. ${pill.name} — ${state}`];
  if (pill.gated) bits.push("gated: waits for a human");
  if ((pill.attempt ?? 0) > 0) bits.push(`attempt ${pill.attempt + 1}`);
  if (pill.retryAt && pill.status === "failed") bits.push("retry queued");
  if (pill.reason) bits.push(pill.reason.split("\n")[0]);
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
  nodeRef,
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
  nodeRef: (el: HTMLButtonElement | null) => void;
}) {
  const live = pill.status === "working" || pill.status === "await";
  const skipped = pill.skipped === true;
  // Same beat as every other pulsing surface on the board.
  const beat = useSyncedDelay(DURATION.pulse);
  // Tinted borders only for the states that demand attention while unselected.
  const border =
    pill.status === "failed"
      ? "border-fail/40 bg-surface hover:bg-surface-2"
      : pill.status === "await"
        ? "border-await/40 bg-surface hover:bg-surface-2"
        : "border-line bg-surface hover:border-ink-faint/60 hover:bg-surface-2";
  return (
    <button
      ref={nodeRef}
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      data-stage={stage}
      data-lane={lane}
      title={chipTitle(pill, index, needNames)}
      style={{ left: x, top: y, width, height }}
      className={`absolute flex min-w-0 items-center gap-1.5 rounded-md border px-2 text-left transition-[border-color,background-color] duration-(--duration-quick) ${
        selected ? "border-ink-faint bg-surface-2" : border
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
      <span className="shrink-0 font-mono text-[9px] text-ink-faint">
        {String(index + 1).padStart(2, "0")}
      </span>
      <span
        className={`min-w-0 flex-1 truncate text-[11px] font-semibold ${
          skipped
            ? "text-ink-faint line-through decoration-line"
            : selected
              ? "text-ink"
              : "text-ink-dim"
        }`}
      >
        {pill.name}
      </span>
      {skipped && (
        <span className="shrink-0 font-mono text-[8px] font-bold uppercase tracking-[0.1em] text-ink-faint">
          skip
        </span>
      )}
      {pill.gated && (
        <span className="shrink-0 font-mono text-[8px] font-bold uppercase tracking-[0.1em] text-await">
          gate
        </span>
      )}
      {(pill.attempt ?? 0) > 0 && (
        <span className="shrink-0 font-mono text-[8px] uppercase tracking-[0.1em] text-ink-faint">
          try {pill.attempt + 1}
        </span>
      )}
      {/* Step progress without step tiles: one dot per step, or a count once
          dots would stop being countable at a glance. */}
      {pill.steps.length > 1 &&
        (pill.steps.length <= 6 ? (
          <span aria-hidden="true" className="flex shrink-0 items-center gap-[3px]">
            {pill.steps.map((s, i) => (
              <span key={i} className={`h-1 w-1 rounded-full ${PHASE_DOT[s.status]}`} />
            ))}
          </span>
        ) : (
          <span className="shrink-0 font-mono text-[9px] text-ink-faint">
            {pill.steps.filter((s) => s.status === "done").length}/{pill.steps.length}
          </span>
        ))}
    </button>
  );
}

export function PhaseGraph({
  phases,
  layout,
  laneW,
  tileWidth,
  stacked,
  selectedId,
  onSelect,
}: {
  phases: PhasePill[];
  layout: LaneLayout;
  /** The node width the layout was computed with. */
  laneW: number;
  /** The graph's width plus the tile's own chrome, so the graph never scrolls
   *  sideways inside it. */
  tileWidth: number;
  /** Whether the graph sits above the focus panel (fits the card) or beside it. */
  stacked: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const indexOf = new Map(phases.map((p, i) => [p.id, i]));
  const nameOf = new Map(phases.map((p) => [p.id, p.name]));
  const pillOf = new Map(phases.map((p) => [p.id, p]));
  const { nodeH } = LANE_GEOMETRY;

  // A long graph scrolls inside its tile; keep the phase being asked about in
  // view when the selection moves (a gate opening, a failure landing).
  const tileRef = useRef<HTMLDivElement>(null);
  const nodeEls = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => {
    const tile = tileRef.current;
    const el = selectedId ? nodeEls.current.get(selectedId) : undefined;
    if (!tile || !el || typeof el.scrollIntoView !== "function") return;
    if (tile.scrollHeight <= tile.clientHeight && tile.scrollWidth <= tile.clientWidth) return;
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedId]);

  const hot = (e: { from: string; to: string }) =>
    selectedId !== null && (e.from === selectedId || e.to === selectedId);
  // Incident edges paint last so they sit over their neighbours.
  const edges = [...layout.edges].sort((a, b) => Number(hot(a)) - Number(hot(b)));

  return (
    // Clipped sideways, not scrolled: the lanes are already sized to fit the
    // tile, so anything left over is sub-pixel — a device-pixel rounding at
    // fractional display scaling, or a scrollbar a pixel wider than the 16 we
    // budgeted for. That is a bar across the bottom of the card and nothing to
    // read by dragging it.
    <div
      ref={tileRef}
      role="group"
      aria-label="Phases"
      data-testid="phase-graph"
      data-stacked={stacked ? "true" : undefined}
      style={{ maxHeight: MAX_TILE_HEIGHT_PX, width: stacked ? undefined : tileWidth }}
      className={`relative overflow-x-clip overflow-y-auto rounded-tile border border-line/80 bg-ground-2/70 ${
        stacked ? "w-full" : "shrink-0"
      }`}
    >
      <div className="relative" style={{ width: layout.width, height: layout.height }}>
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
          {/* A leaf ends the run: say so with a terminator rather than leaving
              the reader to infer it from the absence of a line. */}
          {layout.nodes
            .filter((n) => n.leaf)
            .map((n) => {
              const cx = n.x + laneW / 2;
              const by = n.y + nodeH;
              return (
                <path
                  key={`end-${n.id}`}
                  d={`M${cx} ${by}L${cx} ${by + 7}M${cx - 5} ${by + 7}L${cx + 5} ${by + 7}`}
                  fill="none"
                  stroke="var(--color-ink-faint)"
                  strokeOpacity={0.45}
                  strokeWidth={1.5}
                />
              );
            })}
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
              width={laneW}
              height={nodeH}
              stage={n.stage}
              lane={n.lane}
              selected={n.id === selectedId}
              onSelect={() => onSelect(n.id)}
              nodeRef={(el) => {
                if (el) nodeEls.current.set(n.id, el);
                else nodeEls.current.delete(n.id);
              }}
            />
          );
        })}
        {/* Only the conditions are drawn. An unconditional edge already reads
            as a line, and labelling every one "always" would bury the two
            that actually decide something. */}
        {layout.edges
          .filter((e) => e.label)
          .map((e) => (
            <span
              key={`label-${e.from}>${e.to}`}
              data-testid="route-label"
              style={{ left: e.label!.x, top: e.label!.y }}
              className={`absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded border bg-surface-2 px-[5px] font-mono text-[8.5px] leading-[14px] ${
                hot(e) ? "border-ink-faint text-ink" : LABEL[e.state]
              }`}
            >
              {e.label!.text}
            </span>
          ))}
      </div>
    </div>
  );
}
