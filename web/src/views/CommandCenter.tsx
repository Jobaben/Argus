import { usePipeline, STATUS, StatusPill, RAIL } from "../ds";
import type { PipelineTile } from "../ds";

function Tile({ tile }: { tile: PipelineTile }) {
  const token = STATUS[tile.status].token;
  return (
    <article className="relative flex flex-col gap-1.5 overflow-hidden rounded-tile border border-line bg-gradient-to-b from-surface-2 to-surface px-3 py-2.5 pl-3.5">
      <span className={`absolute inset-y-0 left-0 w-[3px] ${RAIL[token]}`} />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-bold leading-tight">{tile.name}</div>
          <div className="mt-0.5 font-mono text-[10px] text-ink-faint">
            {tile.jobShort ? `job ${tile.jobShort}` : "job ——"} · {tile.subId}
          </div>
        </div>
        <StatusPill status={tile.status} />
      </div>
      <div className="text-[12px] leading-snug text-ink-dim">{tile.detail}</div>
      {tile.status === "await" && (
        <div className="mt-px flex gap-1.5">
          {/* TODO: wire to real approval action when pipeline becomes non-stub */}
          <button type="button" className="flex-1 rounded-md border border-ok bg-ok/10 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-ok">
            Approve
          </button>
          <button type="button" className="flex-1 rounded-md border border-await bg-await/10 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-await">
            Revise
          </button>
        </div>
      )}
      <div className="flex items-center gap-2 font-mono text-[10px] text-ink-faint">
        {tile.tokens != null && <span className="text-ink-dim">{Math.round(tile.tokens / 1000)}k tok</span>}
        {tile.costUsd != null && <span>· ${tile.costUsd.toFixed(2)}</span>}
      </div>
    </article>
  );
}

export default function CommandCenter() {
  const pipeline = usePipeline();
  return (
    <div className="mx-auto max-w-[1600px] px-6 py-8">
      <header className="mb-5 flex items-baseline gap-3.5">
        <span className="text-[22px] font-extrabold tracking-[0.03em]">
          ARG<span className="text-eye">U</span>S · command center
        </span>
        <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-faint">
          feature: {pipeline.feature} · {pipeline.phases.length} phases
        </span>
      </header>
      <div className="flex items-start gap-3.5 overflow-x-auto pb-2.5">
        {pipeline.phases.map((phase) => (
          <section key={phase.id} className="flex w-[248px] shrink-0 flex-col gap-2.5">
            <div className="flex items-center gap-2 px-0.5 pb-0.5">
              <span className="font-mono text-[10px] text-ink-faint">
                {String(phase.index).padStart(2, "0")}
              </span>
              <span className="font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-ink-dim">
                {phase.name}
              </span>
              <span className="ml-auto rounded-full border border-line px-2 py-px font-mono text-[11px] text-ink-faint">
                {phase.tiles.length}
              </span>
            </div>
            <div className="mb-0.5 h-0.5 rounded-full bg-line" />
            {phase.tiles.map((tile, i) => (
              <Tile key={`${tile.jobShort ?? "x"}-${i}`} tile={tile} />
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
