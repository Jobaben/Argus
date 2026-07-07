import { useEffect, useMemo, useState } from "react";
import { useOverview } from "../useOverview";
import { useRunActivity } from "../useRunActivity";
import type { LiveActivity } from "../useRunActivity";
import {
  toOverviewRow,
  formatElapsed,
  STATUS,
  RAIL,
  TILE_SKIN,
  TILE_DETAIL,
  StatusPill,
  TimeAgo,
  EmptyState,
  Page,
  Meter,
} from "../ds";
import type { OverviewRow, OverviewGate, PhasePill, StepPill, DsStatus } from "../ds";

/** One clock for every running tile; only ticks while something is working. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/**
 * The board re-renders in place as pipelines change state, which is invisible
 * to screen readers. Track badge transitions and speak the attention-relevant
 * ones (needs approval / failed / completed / resumed) through one polite live
 * region, so assistive tech perceives the live monitoring the board exists for.
 */
function useBoardAnnouncer(rows: OverviewRow[]): string {
  // "Storing information from previous renders": compare against the badges
  // seen last render and update state during render (not in an effect), so
  // React re-renders immediately without a cascading effect pass.
  const [seen, setSeen] = useState<{ badges: Map<string, DsStatus>; message: string }>(() => ({
    badges: new Map(),
    message: "",
  }));
  const badges = new Map(rows.map((r) => [r.pipelineId, r.badge]));
  const differs =
    badges.size !== seen.badges.size || rows.some((r) => seen.badges.get(r.pipelineId) !== r.badge);
  if (differs) {
    const msgs: string[] = [];
    for (const r of rows) {
      const before = seen.badges.get(r.pipelineId);
      if (before === undefined || before === r.badge) continue;
      if (r.badge === "await") msgs.push(`${r.name} needs approval`);
      else if (r.badge === "failed") msgs.push(`${r.name} failed`);
      else if (r.badge === "done") msgs.push(`${r.name} completed`);
      else if (before === "await" && r.badge === "working") msgs.push(`${r.name} resumed`);
    }
    setSeen({ badges, message: msgs.length > 0 ? msgs.join(". ") : seen.message });
  }
  return seen.message;
}

function Gate({
  instanceId,
  canApprove,
  approve,
  revise,
  reviseLabel = "Revise",
}: {
  instanceId: string;
  canApprove: boolean;
  approve: (id: string) => Promise<unknown>;
  revise: (id: string, note?: string) => Promise<unknown>;
  reviseLabel?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  // On success we leave busy=true: the row is expected to refresh away on the
  // next "pipelines:changed" ping (or the 10s poll), which also clears any
  // double-click window. A polite status line announces the accepted action
  // until then. On failure we surface the reason and re-enable.
  const run = (action: () => Promise<unknown>, sentLabel: string) => {
    setBusy(true);
    setErr(null);
    void action()
      .then(() => setSent(sentLabel))
      .catch((e: unknown) => {
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
            onClick={() => run(() => approve(instanceId), "Approved — pipeline resuming")}
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
          {reviseLabel}
        </button>
      </div>
      {noteOpen && (
        <div className="flex gap-1.5">
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-label="Revision note"
            placeholder="Revise note (optional)"
            className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1 font-mono text-[11px] text-ink placeholder:text-ink-faint"
          />
          <button
            type="button"
            onClick={() =>
              run(
                () => revise(instanceId, note.trim() || undefined),
                "Revision sent — phase restarting",
              )
            }
            disabled={busy}
            className="rounded-md border border-await bg-await/10 px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-await disabled:opacity-40"
          >
            Send
          </button>
        </div>
      )}
      {sent && !err && (
        <p role="status" className="font-mono text-[10px] text-ok">
          {sent}
        </p>
      )}
      {err && (
        <p role="alert" className="font-mono text-[10px] text-fail">
          {err}
        </p>
      )}
    </div>
  );
}

function StepTile({
  step,
  reason,
  live,
  now,
}: {
  step: StepPill;
  reason: string | null;
  live: LiveActivity | null;
  now: number;
}) {
  const token = STATUS[step.status].token;
  const working = step.status === "working";
  const activity = working ? (live?.label ?? step.currentActivity) : null;
  const elapsed =
    working && step.startedAt ? formatElapsed(now - new Date(step.startedAt).getTime()) : null;
  const finished = step.status === "done" || step.status === "failed";
  const hasMeter =
    step.tokens != null || step.costUsd != null || (finished && step.durationMs != null);
  return (
    <article
      className={`relative flex flex-col gap-[7px] overflow-hidden rounded-tile border bg-gradient-to-b to-surface pb-2.5 pl-3.5 pr-3 pt-[11px] ${TILE_SKIN[token]}`}
    >
      <span className={`absolute inset-y-0 left-0 w-[3px] ${RAIL[token]}`} />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="break-words text-tile-name font-bold leading-tight">{step.name}</div>
          <div className="mt-0.5 font-mono text-id text-ink-faint">
            {step.runId ? `job ${step.runId}` : "job ——"}
          </div>
        </div>
        <StatusPill status={step.status} size="sm" />
      </div>
      {reason && (
        <div className={`text-detail leading-snug ${TILE_DETAIL[token] ?? "text-ink-dim"}`}>
          {reason}
        </div>
      )}
      {activity && (
        <div className="break-words font-mono text-meter text-ink-dim">
          <span aria-hidden="true">▸ </span>
          {activity}
        </div>
      )}
      {elapsed && (
        <div className="font-mono text-meter text-ink-faint">
          {elapsed} <span className="text-ink-faint/70">elapsed</span>
        </div>
      )}
      {working && (
        <div className="relative h-[5px] overflow-hidden rounded-full bg-ink-faint/15">
          <i className="absolute inset-y-0 w-2/5 animate-[sweep_1.6s_ease-in-out_infinite] rounded-full bg-gradient-to-r from-transparent via-run to-transparent" />
        </div>
      )}
      {hasMeter && (
        <div className="flex items-center gap-2 font-mono text-meter text-ink-faint">
          <Meter
            level="step"
            tokens={step.tokens}
            usd={step.costUsd}
            durationMs={finished ? step.durationMs : null}
            title="Duration, tokens and dollar cost reported by this step's run"
          />
          {step.startedAt && (
            <span className="ml-auto">
              <TimeAgo iso={step.startedAt} />
            </span>
          )}
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
  reviseLabel,
  liveActivity,
  now,
}: {
  pill: PhasePill;
  index: number;
  instanceId: string | null;
  gate: OverviewGate | null;
  approve: (id: string) => Promise<unknown>;
  revise: (id: string, note?: string) => Promise<unknown>;
  reviseLabel?: string;
  liveActivity: Map<string, LiveActivity>;
  now: number;
}) {
  return (
    <section className="flex w-[248px] flex-none flex-col gap-2.5">
      <div className="flex items-center gap-2 px-0.5">
        <span className="font-mono text-[10px] text-ink-faint">
          {String(index + 1).padStart(2, "0")}
        </span>
        <span className="min-w-0 break-words font-mono text-label font-bold uppercase tracking-[0.14em] text-ink-dim">
          {pill.name}
        </span>
        <span className="ml-auto rounded-full border border-line px-2 font-mono text-label text-ink-faint">
          {pill.steps.length}
        </span>
      </div>
      <div className="h-[2px] rounded-full bg-line" />
      {pill.steps.map((step, i) => (
        <StepTile
          key={`${step.name}-${i}`}
          step={step}
          reason={step.status === "failed" ? pill.reason : null}
          live={step.runId ? (liveActivity.get(step.runId) ?? null) : null}
          now={now}
        />
      ))}
      {instanceId && gate?.phaseId === pill.id && (
        <Gate
          instanceId={instanceId}
          canApprove={gate.canApprove}
          approve={approve}
          revise={revise}
          reviseLabel={reviseLabel}
        />
      )}
    </section>
  );
}

function Row({
  row,
  approve,
  revise,
  liveActivity,
  now,
}: {
  row: OverviewRow;
  approve: (id: string) => Promise<unknown>;
  revise: (id: string, note?: string) => Promise<unknown>;
  liveActivity: Map<string, LiveActivity>;
  now: number;
}) {
  const reviseLabel = row.failure?.kind === "restarted" ? "Retry" : "Revise";
  return (
    <article className="rounded-tile border border-line bg-gradient-to-b from-surface-2 to-surface px-4 py-3.5">
      <div className="flex items-center gap-3">
        <span className="min-w-0 break-words text-[15px] font-extrabold tracking-[0.02em] text-ink">
          {row.name}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
          {row.phases.length} phases
        </span>
        <StatusPill status={row.badge} />
        {row.cost && (
          <Meter
            level="row"
            tokens={row.cost.tokens}
            usd={row.cost.usd}
            title="Total tokens and dollar cost of the latest run, including revised attempts"
          />
        )}
        <span className="ml-auto font-mono text-[10px]">
          <TimeAgo iso={row.updatedAt} />
        </span>
      </div>
      {/* Phase columns keep a readable minimum width and scroll horizontally
          rather than squishing to nothing on narrow viewports. */}
      <div className="mt-3.5 flex items-start gap-3.5 overflow-x-auto pb-1">
        {row.phases.map((pill, i) => (
          <PhaseColumn
            key={pill.id}
            pill={pill}
            index={i}
            instanceId={row.instanceId}
            gate={row.gate}
            approve={approve}
            revise={revise}
            reviseLabel={reviseLabel}
            liveActivity={liveActivity}
            now={now}
          />
        ))}
      </div>
    </article>
  );
}

export default function CommandCenter() {
  const { overview, loading, error, approve, revise } = useOverview();
  const rows = useMemo(() => overview.map(toOverviewRow), [overview]);
  const announcement = useBoardAnnouncer(rows);
  const liveActivity = useRunActivity();
  const anyWorking = useMemo(
    () => rows.some((r) => r.phases.some((p) => p.steps.some((s) => s.status === "working"))),
    [rows],
  );
  const now = useNow(anyWorking);
  // Grand total across everything on the board: sum whichever metrics were
  // reported; a metric stays null (hidden) until at least one run reports it.
  const total = useMemo(() => {
    let usd: number | null = null;
    let tokens: number | null = null;
    for (const r of rows) {
      if (r.cost?.usd != null) usd = (usd ?? 0) + r.cost.usd;
      if (r.cost?.tokens != null) tokens = (tokens ?? 0) + r.cost.tokens;
    }
    return { usd, tokens };
  }, [rows]);

  return (
    <Page
      wide
      title="Command Center"
      actions={
        total.usd == null && total.tokens == null ? undefined : (
          <Meter
            level="board"
            tokens={total.tokens}
            usd={total.usd}
            title="Combined tokens and dollar cost of every pipeline's latest run"
          />
        )
      }
    >
      <div aria-live="polite" role="status" className="sr-only">
        {announcement}
      </div>
      {error && (
        <div className="mb-6 rounded-tile border border-fail/30 bg-fail/10 px-4 py-3 text-sm text-fail">
          Couldn't reach the Argus server: {error}
        </div>
      )}
      {loading ? (
        <p className="text-ink-faint">Loading pipelines…</p>
      ) : rows.length === 0 ? (
        <EmptyState>
          No pipelines defined yet. Create one in the{" "}
          <a href="#/pipelines" className="text-ink underline decoration-line underline-offset-2">
            Pipelines
          </a>{" "}
          tab.
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((row) => (
            <Row
              key={row.pipelineId}
              row={row}
              approve={approve}
              revise={revise}
              liveActivity={liveActivity}
              now={now}
            />
          ))}
        </div>
      )}
    </Page>
  );
}
