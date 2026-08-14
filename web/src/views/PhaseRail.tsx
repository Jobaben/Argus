import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DsStatus, PhasePill } from "../ds";
import { DURATION, STATUS, useSyncedDelay } from "../ds";
import { graphColumns, graphEdges } from "./phaseGraphLayout";
import { packStages, packedRows } from "./railLayout";

/**
 * The pipeline's shape as the board's overhead: one compact chip per phase,
 * grouped into stages (phases that can run at the same time), packed into
 * rows that are each a tile of their own.
 *
 * This is the compression that keeps a 14-phase pipeline to one card-height:
 * the rail carries every phase's status, gate, attempt and step progress at a
 * glance, and the step tiles themselves — the expensive part — render for one
 * phase at a time in the focus panel beneath. Nothing is lost, it is one click
 * away instead of always on screen.
 *
 * Stage grouping reuses the graph layout: a fan-out stacks inside one stage, so
 * a branching pipeline still reads as branching. Instances that carry no
 * dependency edges at all (authored before Weave) fall back to one stage per
 * phase in order — absent edges mean "unknown", not "all parallel".
 *
 * Rows are packed by measurement rather than CSS wrapping: a flex wrap breaks
 * the line wherever it runs out of width and leaves the break invisible, which
 * on a long real-world chain read as chips floating loose. Packing the stages
 * ourselves lets every row be a real element — a bordered tile whose edge *is*
 * the row divider, with a trailing arrow when the chain continues below.
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

/** Width the chain costs between two stages on one row: the h-7 arrow box
 *  (~16px glyph) plus the row's gap on each side. Slightly generous — a row
 *  that measures a few pixels tight wraps inside its tile instead of clipping. */
const JOIN_PX = 30;
/** Row tile horizontal padding + borders, subtracted from the container width. */
const ROW_CHROME_PX = 22;

function chipTitle(pill: PhasePill, index: number, needNames: string[]): string {
  const bits = [`${index + 1}. ${pill.name} — ${STATUS[pill.status].label.toLowerCase()}`];
  if (pill.gated) bits.push("gated: waits for a human");
  if ((pill.attempt ?? 0) > 0) bits.push(`attempt ${pill.attempt + 1}`);
  if (pill.retryAt && pill.status === "failed") bits.push("retry queued");
  if (pill.reason) bits.push(pill.reason.split("\n")[0]);
  bits.push(needNames.length > 0 ? `waits for ${needNames.join(", ")}` : "starts immediately");
  return bits.join(" · ");
}

function PhaseChip({
  pill,
  index,
  needNames,
  selected,
  onSelect,
}: {
  pill: PhasePill;
  index: number;
  needNames: string[];
  selected: boolean;
  onSelect: () => void;
}) {
  const live = pill.status === "working" || pill.status === "await";
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
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      title={chipTitle(pill, index, needNames)}
      // One fixed height for every chip (names truncate to one line), so the
      // top-aligned rows read as straight lanes — content-sized heights made
      // wrapped rails visibly crooked on real data.
      className={`flex h-7 min-w-0 items-center gap-1.5 rounded-md border px-2 text-left transition-[border-color,background-color] duration-(--duration-quick) ${
        selected ? "border-ink-faint bg-surface-2" : border
      }`}
    >
      <span
        aria-hidden="true"
        style={live ? { animationDelay: beat } : undefined}
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${PHASE_DOT[pill.status]} ${
          live ? "motion-safe:animate-[pulse_var(--duration-pulse)_ease-in-out_infinite]" : ""
        }`}
      />
      <span className="shrink-0 font-mono text-[9px] text-ink-faint">
        {String(index + 1).padStart(2, "0")}
      </span>
      <span
        className={`max-w-[10rem] truncate text-[11px] font-semibold ${
          selected ? "text-ink" : "text-ink-dim"
        }`}
      >
        {pill.name}
      </span>
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

/** The h-7 arrow box: fixed to chip height so it centers on the chip row. */
function Arrow({ trailing = false }: { trailing?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`flex h-7 shrink-0 items-center font-mono text-[10px] ${
        trailing ? "text-ink-faint/60" : "text-ink-faint"
      }`}
    >
      →
    </span>
  );
}

export function PhaseRail({
  phases,
  selectedId,
  onSelect,
}: {
  phases: PhasePill[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const indexOf = new Map(phases.map((p, i) => [p.id, i]));
  const nameOf = new Map(phases.map((p) => [p.id, p.name]));
  // No edges at all means "unknown", not "one big parallel stage" — see the
  // header comment. graphColumns would collapse those to a single column.
  const columns =
    graphEdges(phases).length > 0
      ? graphColumns(phases)
      : phases.map((p, i) => ({ depth: i, phases: [p] }));

  const containerRef = useRef<HTMLOListElement>(null);
  const stageEls = useRef(new Map<number, HTMLOListElement>());
  // First stage of each visual row. Starts as one row holding everything; the
  // layout effect below corrects it from real measurements before first paint.
  const [breaks, setBreaks] = useState<number[]>([0]);

  const pack = useCallback(() => {
    const container = containerRef.current;
    if (!container || container.clientWidth === 0) return;
    const widths: number[] = [];
    for (let i = 0; i < columns.length; i++) widths.push(stageEls.current.get(i)?.offsetWidth ?? 0);
    const next = packStages(widths, container.clientWidth - ROW_CHROME_PX, JOIN_PX);
    setBreaks((prev) =>
      prev.length === next.length && prev.every((b, i) => b === next[i]) ? prev : next,
    );
    // The stage list itself is the effect's real dependency; its length is the
    // part measurement can see.
  }, [columns.length]);

  // Before paint, so the corrected rows never flash their unmeasured layout.
  useLayoutEffect(pack, [pack, phases]);
  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(pack);
    ro.observe(container);
    // Chip widths change when the webfonts land; ResizeObserver can't see that.
    document.fonts?.ready.then(pack).catch(() => {});
    return () => ro.disconnect();
  }, [pack]);

  const rows = packedRows(breaks, columns.length);
  return (
    <ol
      ref={containerRef}
      aria-label="Phases"
      data-testid="phase-rail"
      className="flex min-w-0 flex-col gap-1.5"
    >
      {rows.map((row, r) => (
        <li key={row.start} className="min-w-0">
          {/* The row tile. Its border is the row divider the bare wrap never
              had; flex-wrap stays on as a safety net so a measurement that is
              a few pixels off wraps inside the tile instead of clipping. */}
          <ol
            data-testid="rail-row"
            className="flex min-w-0 flex-wrap items-start gap-x-1.5 gap-y-1.5 rounded-tile border border-line/80 bg-ground-2/70 px-2 py-1.5"
          >
            {columns.slice(row.start, row.end).map((col, j) => {
              const i = row.start + j;
              const lastInRow = i === row.end - 1;
              return (
                <li
                  key={col.depth}
                  data-testid="rail-stage"
                  className="flex min-w-0 shrink-0 items-start gap-1.5"
                >
                  {j > 0 && <Arrow />}
                  {/* A stage with several phases stacks them, so a fan-out
                      hangs below the chain — the graph, at chip size. The
                      measurement ref sits on the stack, not the <li>: the
                      <li> also holds the arrows, whose width the packer
                      already budgets as `join` — measuring them twice would
                      shift widths with row membership and oscillate the pack. */}
                  <ol
                    ref={(el) => {
                      if (el) stageEls.current.set(i, el);
                      else stageEls.current.delete(i);
                    }}
                    className="flex min-w-0 flex-col gap-1"
                  >
                    {col.phases.map((p) => (
                      <li key={p.id} className="min-w-0">
                        <PhaseChip
                          pill={p}
                          index={indexOf.get(p.id) ?? 0}
                          needNames={p.needs.map((n) => nameOf.get(n) ?? n)}
                          selected={p.id === selectedId}
                          onSelect={() => onSelect(p.id)}
                        />
                      </li>
                    ))}
                  </ol>
                  {/* The chain continues in the next row's tile: say so at the
                      break instead of leaving the reader to infer it. */}
                  {lastInRow && r < rows.length - 1 && <Arrow trailing />}
                </li>
              );
            })}
          </ol>
        </li>
      ))}
    </ol>
  );
}
