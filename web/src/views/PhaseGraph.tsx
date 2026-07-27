import type { DsStatus, PhasePill } from "../ds";
import { graphColumns, graphEdges, isBranching } from "./phaseGraph";

/**
 * The pipeline's shape, when it has one.
 *
 * Columns are depth, so a fan-out reads as a fan-out rather than as a list that
 * happens to be in a helpful order. Deliberately not an SVG with routed edges:
 * at the size a pipeline actually is (a handful of phases), column layout plus
 * a "needs" line under each phase is legible, responsive, and does not need a
 * layout engine — and it degrades to text for a screen reader instead of to
 * nothing.
 *
 * Renders only when the graph branches. A linear pipeline drawn as a graph is
 * one column per phase, which says "graph" and shows nothing the existing row
 * of phase pills didn't.
 */

const STATUS_STYLE: Record<DsStatus, string> = {
  idle: "border-line text-ink-faint",
  queued: "border-queue/50 bg-queue/10 text-queue",
  working: "border-run/50 bg-run/10 text-run",
  await: "border-await/50 bg-await/10 text-await",
  done: "border-ok/50 bg-ok/10 text-ok",
  failed: "border-fail/50 bg-fail/10 text-fail",
  stopped: "border-idle/50 bg-idle/10 text-idle",
};

function PhaseNode({ phase }: { phase: PhasePill }) {
  const retrying = phase.retryAt != null && phase.status === "failed";
  return (
    <li
      className={`rounded-md border px-2.5 py-1.5 ${STATUS_STYLE[phase.status]}`}
      title={
        phase.needs && phase.needs.length > 0
          ? `${phase.name} — waits for ${phase.needs.join(", ")}`
          : `${phase.name} — starts immediately`
      }
    >
      <span className="block truncate text-[12.5px] font-semibold">{phase.name}</span>
      <span className="mt-0.5 flex flex-wrap items-center gap-x-2 font-mono text-[10px] uppercase tracking-[0.1em] opacity-80">
        <span>{phase.status}</span>
        {phase.gated && <span title="Waits for a human">gate</span>}
        {(phase.attempt ?? 0) > 0 && <span>attempt {(phase.attempt ?? 0) + 1}</span>}
        {retrying && <span className="text-await">retry queued</span>}
      </span>
      {phase.needs && phase.needs.length > 0 && (
        <span className="mt-0.5 block truncate font-mono text-[10px] text-ink-faint">
          ← {phase.needs.join(", ")}
        </span>
      )}
    </li>
  );
}

export function PhaseGraph({ phases }: { phases: PhasePill[] }) {
  if (!isBranching(phases)) return null;
  const columns = graphColumns(phases);
  const edges = graphEdges(phases);

  return (
    <figure className="rounded-tile border border-line bg-ground-2 p-3">
      <figcaption className="mb-2 font-mono text-[10px] uppercase tracking-[0.13em] text-ink-faint">
        Graph — {columns.length} stage{columns.length === 1 ? "" : "s"}, {edges.length} dependenc
        {edges.length === 1 ? "y" : "ies"}
      </figcaption>
      <div className="flex items-stretch gap-2 overflow-x-auto">
        {columns.map((col, i) => (
          <div key={col.depth} className="flex items-stretch gap-2">
            {i > 0 && (
              <span aria-hidden="true" className="self-center font-mono text-ink-faint">
                →
              </span>
            )}
            <ul className="flex min-w-36 flex-col justify-center gap-2">
              {col.phases.map((p) => (
                <PhaseNode key={p.id} phase={p} />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </figure>
  );
}
