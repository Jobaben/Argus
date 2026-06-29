import { usePipeline, STATUS, StatusPill, RAIL, Page } from "../ds";
import type { PipelineTile, DsStatus } from "../ds";

// Status-specific border + background tint, per the design system Command Center.
// failed/await get a colored frame + wash; working gets a warm border; the rest stay neutral.
const TILE_SKIN: Record<DsStatus, string> = {
  working: "border-run/28 from-surface-2 to-surface",
  failed: "border-fail/40 from-fail/10 to-surface",
  await: "border-await/40 from-await/12 to-surface",
  done: "border-line from-surface-2 to-surface",
  queued: "border-line from-surface-2 to-surface",
  idle: "border-line from-surface-2 to-surface",
};

function Tile({ tile }: { tile: PipelineTile }) {
  const token = STATUS[tile.status].token;
  const hasMeter = tile.tokens != null || tile.costUsd != null;
  return (
    <article className={`relative flex flex-col gap-1.5 overflow-hidden rounded-tile border bg-gradient-to-b ${TILE_SKIN[tile.status]} px-3 py-2.5 pl-3.5`}>
      <span className={`absolute inset-y-0 left-0 w-[3px] ${RAIL[token]}`} />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {tile.jobShort ? (
            <a
              href={`#/agent/${encodeURIComponent(tile.jobShort)}`}
              className="block truncate text-sm font-bold leading-tight text-ink transition hover:text-eye"
            >
              {tile.name}
            </a>
          ) : (
            <div className="truncate text-sm font-bold leading-tight">{tile.name}</div>
          )}
          <div className="mt-0.5 font-mono text-[10px] text-ink-faint">
            {tile.jobShort ? `job ${tile.jobShort}` : "job ——"} · {tile.subId}
          </div>
        </div>
        <StatusPill status={tile.status} />
      </div>
      <div className="text-[12px] leading-snug text-ink-dim">{tile.detail}</div>
      {tile.status === "working" && (
        <div className="relative h-1 overflow-hidden rounded-full bg-line">
          <span className="absolute top-0 h-full w-2/5 rounded-full bg-gradient-to-r from-transparent via-run to-transparent animate-[sweep_1.6s_ease-in-out_infinite]" />
        </div>
      )}
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
        {tile.status === "working" && (
          <span className="flex items-center gap-1 text-eye">
            <span className="h-1 w-1 rounded-full bg-current" /> live
          </span>
        )}
        {hasMeter && (
          <span className={`flex items-center gap-1 ${tile.status === "working" ? "ml-auto border-l border-line pl-2" : ""}`}>
            {tile.tokens != null && <span className="text-ink-dim">{Math.round(tile.tokens / 1000)}k tok</span>}
            {tile.costUsd != null && <span>· ${tile.costUsd.toFixed(2)}</span>}
          </span>
        )}
      </div>
    </article>
  );
}

export default function CommandCenter() {
  const pipeline = usePipeline();
  return (
    <Page title="Command Center">
      <div className="mb-5 font-mono text-[11px] uppercase tracking-[0.16em] text-ink-faint">
        feature: {pipeline.feature} · {pipeline.phases.length} phases
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,11rem),1fr))] items-start gap-3.5 pb-2.5">
        {pipeline.phases.map((phase) => (
          <section key={phase.id} className="flex min-w-0 flex-col gap-2.5">
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
    </Page>
  );
}
