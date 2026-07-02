import { useMemo, useState } from "react";
import { useOverview } from "../useOverview";
import { toOverviewRow, STATUS, RAIL, StatusPill, TimeAgo, EmptyState, Page } from "../ds";
import type { OverviewRow, PhasePill } from "../ds";

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

function PhaseCell({ pill }: { pill: PhasePill }) {
  const token = STATUS[pill.status].token;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <span className={`h-2 w-2 shrink-0 rounded-full ${RAIL[token]}`} />
        <span className="truncate font-mono text-[11px] uppercase tracking-[0.1em] text-ink-dim">
          {pill.name}
        </span>
      </div>
      {pill.activeStep && (
        <span className="truncate pl-3.5 font-mono text-[10px] text-ink-faint">{pill.activeStep}</span>
      )}
    </div>
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
    <article className="rounded-tile border border-line bg-gradient-to-b from-surface-2 to-surface px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="truncate text-sm font-bold text-ink">{row.name}</span>
        <StatusPill status={row.badge} />
        <span className="ml-auto font-mono text-[10px]">
          <TimeAgo iso={row.updatedAt} />
        </span>
      </div>
      {row.failure && (
        <p className="mt-1.5 truncate font-mono text-[11px] text-fail">
          <span className="font-bold">{row.failure.step ?? "Pipeline"} failed</span>
          {row.failure.reason && <span className="text-ink-dim">: {row.failure.reason}</span>}
        </p>
      )}
      <div className="mt-2.5 grid grid-cols-[repeat(auto-fit,minmax(7rem,1fr))] items-start gap-3">
        {row.phases.map((pill) => (
          <PhaseCell key={pill.id} pill={pill} />
        ))}
      </div>
      {row.instanceId && row.gate && (
        <Gate
          instanceId={row.instanceId}
          canApprove={row.gate.canApprove}
          approve={approve}
          revise={revise}
        />
      )}
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
