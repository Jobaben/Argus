import { useMemo, useState } from "react";
import { useOverview } from "../useOverview";
import {
  toOverviewRow, STATUS, RAIL, TILE_SKIN, TILE_DETAIL,
  StatusPill, TimeAgo, EmptyState, Page,
} from "../ds";
import type { OverviewRow, OverviewGate, PhasePill, StepPill } from "../ds";

function Gate({
  instanceId,
  canApprove,
  approve,
  revise,
}: {
  instanceId: string;
  canApprove: boolean;
  approve: (id: string) => Promise<unknown>;
  revise: (id: string, note?: string) => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);

  // On success we leave busy=true: the row is expected to refresh away on the
  // next "pipelines:changed" ping (or the 10s poll), which also clears any
  // double-click window. On failure we surface the reason and re-enable.
  const run = (action: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    void action().catch((e: unknown) => {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    });
  };

  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      <div className="flex gap-1.5">
        {canApprove && (
          <button
            type="button"
            onClick={() => run(() => approve(instanceId))}
            disabled={busy}
            className="rounded-md border border-ok bg-ok/10 px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-ok disabled:opacity-40"
          >
            Approve
          </button>
        )}
        <button
          type="button"
          onClick={() => setNoteOpen((o) => !o)}
          disabled={busy}
          className="rounded-md border border-await bg-await/10 px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-await disabled:opacity-40"
        >
          Revise
        </button>
      </div>
      {noteOpen && (
        <div className="flex gap-1.5">
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Revise note (optional)"
            className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1 font-mono text-[11px] text-ink placeholder:text-ink-faint"
          />
          <button
            type="button"
            onClick={() => run(() => revise(instanceId, note.trim() || undefined))}
            disabled={busy}
            className="rounded-md border border-await bg-await/10 px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-await disabled:opacity-40"
          >
            Send
          </button>
        </div>
      )}
      {err && <p className="font-mono text-[10px] text-fail">{err}</p>}
    </div>
  );
}

function StepTile({ step, reason }: { step: StepPill; reason: string | null }) {
  const token = STATUS[step.status].token;
  return (
    <article
      className={`relative flex flex-col gap-1.5 overflow-hidden rounded-[11px] border bg-gradient-to-b to-surface py-2 pl-3.5 pr-2.5 ${TILE_SKIN[token]}`}
    >
      <span className={`absolute inset-y-0 left-0 w-[3px] ${RAIL[token]}`} />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-bold leading-tight">{step.name}</div>
          <div className="mt-0.5 font-mono text-[9.5px] text-ink-faint">
            {step.runId ? `job ${step.runId}` : "job ——"}
          </div>
        </div>
        <StatusPill status={step.status} size="sm" />
      </div>
      {reason && (
        <div className={`text-[11.5px] leading-snug ${TILE_DETAIL[token] ?? "text-ink-dim"}`}>
          {reason}
        </div>
      )}
      {step.status === "working" && (
        <div className="relative h-1 overflow-hidden rounded-full bg-ink-faint/15">
          <i className="absolute inset-y-0 w-2/5 animate-[sweep_1.6s_ease-in-out_infinite] rounded-full bg-gradient-to-r from-transparent via-run to-transparent" />
        </div>
      )}
    </article>
  );
}

function PhaseColumn({
  pill,
  index,
  instanceId,
  gate,
  approve,
  revise,
}: {
  pill: PhasePill;
  index: number;
  instanceId: string | null;
  gate: OverviewGate | null;
  approve: (id: string) => Promise<unknown>;
  revise: (id: string, note?: string) => Promise<unknown>;
}) {
  return (
    <section className="flex min-w-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-1.5 px-0.5">
        <span className="font-mono text-[9px] text-ink-faint">
          {String(index + 1).padStart(2, "0")}
        </span>
        <span className="truncate font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-ink-dim">
          {pill.name}
        </span>
        <span className="ml-auto rounded-full border border-line px-1.5 font-mono text-[10px] text-ink-faint">
          {pill.steps.length}
        </span>
      </div>
      <div className="h-[2px] rounded-full bg-line" />
      {pill.steps.map((step, i) => (
        <StepTile
          key={`${step.name}-${i}`}
          step={step}
          reason={step.status === "failed" ? pill.reason : null}
        />
      ))}
      {instanceId && gate?.phaseId === pill.id && (
        <Gate
          instanceId={instanceId}
          canApprove={gate.canApprove}
          approve={approve}
          revise={revise}
        />
      )}
    </section>
  );
}

function Row({
  row,
  approve,
  revise,
}: {
  row: OverviewRow;
  approve: (id: string) => Promise<unknown>;
  revise: (id: string, note?: string) => Promise<unknown>;
}) {
  return (
    <article className="rounded-tile border border-line bg-gradient-to-b from-surface-2 to-surface px-4 py-3.5">
      <div className="flex items-center gap-3">
        <span className="truncate text-[15px] font-extrabold tracking-[0.02em] text-ink">
          {row.name}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
          {row.phases.length} phases
        </span>
        <StatusPill status={row.badge} />
        <span className="ml-auto font-mono text-[10px]">
          <TimeAgo iso={row.updatedAt} />
        </span>
      </div>
      <div className="mt-3.5 flex items-start gap-3">
        {row.phases.map((pill, i) => (
          <PhaseColumn
            key={pill.id}
            pill={pill}
            index={i}
            instanceId={row.instanceId}
            gate={row.gate}
            approve={approve}
            revise={revise}
          />
        ))}
      </div>
    </article>
  );
}

export default function CommandCenter() {
  const { overview, loading, error, approve, revise } = useOverview();
  const rows = useMemo(() => overview.map(toOverviewRow), [overview]);

  return (
    <Page title="Command Center">
      {error && (
        <div className="mb-6 rounded-tile border border-fail/30 bg-fail/10 px-4 py-3 text-sm text-fail">
          Couldn't reach the Argus server: {error}
        </div>
      )}
      {loading ? (
        <p className="text-ink-faint">Loading pipelines…</p>
      ) : rows.length === 0 ? (
        <EmptyState>No pipelines defined yet.</EmptyState>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((row) => (
            <Row key={row.pipelineId} row={row} approve={approve} revise={revise} />
          ))}
        </div>
      )}
    </Page>
  );
}
