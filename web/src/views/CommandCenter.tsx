import { Fragment, useMemo, useState } from "react";
import { useMachineFacet } from "../fleet/useMachineFacet";
import { MachinePicker, PeerBanner, PeerEmpty } from "../fleet/MachineFacet";
import { useOverview } from "../useOverview";
import { useInsight } from "../useInsight";
import { useRuns } from "../useRuns";
import { SituationStrip } from "./SituationStrip";
import { ActivityRail } from "./ActivityRail";
import { PhaseGraph } from "./PhaseGraph";
import { StepDrawer, type StepSelection } from "./StepDrawer";
import { useRunActivity } from "../useRunActivity";
import type { LiveActivity } from "../useRunActivity";
import { useTotals } from "../useTotals";
import {
  EmptyState,
  formatElapsed,
  Handoff,
  Meter,
  Page,
  RAIL,
  SkeletonBoardCard,
  staggerDelay,
  STATUS,
  StatusPill,
  SweepBar,
  TILE_DETAIL,
  TILE_SKIN,
  TimeAgo,
  toOverviewRows,
  useChangeFlash,
  useFlip,
  useSyncedDelay,
  DURATION,
  useTicker,
} from "../ds";
import type { OverviewRow, OverviewGate, PhasePill, StepPill, DsStatus } from "../ds";

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
  // Keyed per instance: with overlap several rows can share a pipelineId.
  const rowKey = (r: OverviewRow) => r.instanceId ?? r.pipelineId;
  const badges = new Map(rows.map((r) => [rowKey(r), r.badge]));
  const differs =
    badges.size !== seen.badges.size || rows.some((r) => seen.badges.get(rowKey(r)) !== r.badge);
  if (differs) {
    const msgs: string[] = [];
    for (const r of rows) {
      const before = seen.badges.get(rowKey(r));
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
            className="rounded-md border border-ok bg-ok/10 px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-ok transition-transform duration-(--duration-press) disabled:opacity-40 motion-safe:active:scale-[0.97]"
          >
            Approve
          </button>
        )}
        <button
          type="button"
          onClick={() => setNoteOpen((o) => !o)}
          disabled={busy}
          className="rounded-md border border-await bg-await/10 px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-await transition-transform duration-(--duration-press) disabled:opacity-40 motion-safe:active:scale-[0.97]"
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
            className="rounded-md border border-await bg-await/10 px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-await transition-transform duration-(--duration-press) disabled:opacity-40 motion-safe:active:scale-[0.97]"
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
  rowModel,
  onOpen,
}: {
  step: StepPill;
  reason: string | null;
  live: LiveActivity | null;
  now: number;
  /** Pipeline-level model shown in the card header; the tile only repeats a
   *  model when its own differs from this. */
  rowModel: string | null;
  /** Opens this step's drawer, told where on screen the tile was. */
  onOpen: (originY: number) => void;
}) {
  const token = STATUS[step.status].token;
  const working = step.status === "working";
  const activity = working ? (live?.label ?? step.currentActivity) : null;
  const elapsed =
    working && step.startedAt ? formatElapsed(now - new Date(step.startedAt).getTime()) : null;
  const finished = step.status === "done" || step.status === "failed";
  // A board that swaps a status silently makes you doubt you saw it. A brief
  // ring on the tile that just moved answers "what changed?" at a glance.
  const justChanged = useChangeFlash(step.status);
  const beat = useSyncedDelay(DURATION.pulse);
  const hasMeter =
    step.tokens != null || step.costUsd != null || (finished && step.durationMs != null);
  return (
    <article
      // Fast attack, slow release. One duration for both directions made the
      // flash fade *in* as slowly as it faded out, which is the wrong way round:
      // attention should be claimed at once and then released on a curve, not
      // eased into and cut off.
      className={`relative flex flex-col gap-[7px] overflow-hidden rounded-tile border bg-gradient-to-b to-surface pb-2.5 pl-3.5 pr-3 pt-[11px] transition-[box-shadow,border-color,background-color] ${
        justChanged ? "duration-(--duration-quick)" : "duration-(--duration-slow)"
      } ${TILE_SKIN[token]} ${
        justChanged ? "shadow-[0_0_0_1px_var(--color-eye),0_0_24px_-4px_var(--color-eye)]" : ""
      }`}
    >
      <span
        style={{ animationDelay: beat }}
        className={`absolute inset-y-0 left-0 w-[3px] ${RAIL[token]}`}
      />
      <div className="flex items-start justify-between gap-2">
        {/* The name is the activator rather than the whole tile: a tile-sized
            button would swallow the gate's Approve/Revise controls inside it,
            and a nested interactive element is invalid. */}
        <button
          type="button"
          // The tile's own position, so the drawer grows out of the row you
          // pressed instead of out of the screen edge. Read from the event
          // rather than measured later: by then the board may have re-sorted.
          onClick={(e) => onOpen(e.currentTarget.getBoundingClientRect().top)}
          className="min-w-0 flex-1 text-left"
          title="Open this step's run, log and cost"
        >
          <div className="break-words text-tile-name font-bold leading-tight underline decoration-transparent decoration-dotted underline-offset-[3px] transition duration-(--duration-quick) hover:decoration-ink-faint">
            {step.name}
          </div>
          <div className="mt-0.5 font-mono text-id text-ink-faint">
            {step.runId ? `job ${step.runId}` : "job ——"}
            {step.model && step.model !== rowModel && (
              <span title="Model running this step"> · {step.model}</span>
            )}
            {step.runtime === "codex" && <span title="Run by the Codex CLI"> · codex</span>}
          </div>
        </button>
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
      {working && <SweepBar />}
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

function PhaseHeader({ pill, index }: { pill: PhasePill; index: number }) {
  return (
    <div className="flex items-baseline gap-2 self-start px-0.5">
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
  );
}

function PhaseCell({
  pill,
  instanceId,
  gate,
  approve,
  revise,
  reviseLabel,
  liveActivity,
  now,
  rowModel,
  onOpenStep,
}: {
  pill: PhasePill;
  instanceId: string | null;
  gate: OverviewGate | null;
  approve: (id: string) => Promise<unknown>;
  revise: (id: string, note?: string) => Promise<unknown>;
  reviseLabel?: string;
  liveActivity: Map<string, LiveActivity>;
  now: number;
  rowModel: string | null;
  onOpenStep: (step: StepPill, phaseName: string, reason: string | null, originY: number) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      {pill.steps.map((step, i) => {
        const reason = step.status === "failed" ? pill.reason : null;
        return (
          <StepTile
            key={`${step.name}-${i}`}
            step={step}
            reason={reason}
            live={step.runId ? (liveActivity.get(step.runId) ?? null) : null}
            now={now}
            rowModel={rowModel}
            onOpen={(originY) => onOpenStep(step, pill.name, reason, originY)}
          />
        );
      })}
      {instanceId && gate?.phaseId === pill.id && (
        <Gate
          instanceId={instanceId}
          canApprove={gate.canApprove}
          approve={approve}
          revise={revise}
          reviseLabel={reviseLabel}
        />
      )}
    </div>
  );
}

/**
 * One card per pipeline. With a single instance the header carries its badge,
 * cost and freshness exactly as before. With several concurrent instances the
 * card stays singular: the phase titles render once, and each instance
 * contributes only its own row of step tiles under those shared columns,
 * headed by the short instance id, badge and per-instance meter.
 */
function Row({
  rows,
  approve,
  revise,
  liveActivity,
  now,
  index,
  onOpenStep,
  ref,
}: {
  rows: OverviewRow[];
  approve: (id: string) => Promise<unknown>;
  revise: (id: string, note?: string) => Promise<unknown>;
  liveActivity: Map<string, LiveActivity>;
  now: number;
  /** Position in the board, for the entrance stagger. */
  index: number;
  onOpenStep: (selection: StepSelection) => void;
  /** FLIP registration, so the card glides when the board re-orders. */
  ref?: React.Ref<HTMLElement>;
}) {
  const first = rows[0];
  const multi = rows.length > 1;
  return (
    <article
      ref={ref}
      // Staggered so the board reads as assembling top-down rather than
      // flashing in all at once; capped in `staggerDelay` so a long board still
      // finishes fast.
      style={{ animationDelay: staggerDelay(index) }}
      className="rounded-tile border border-line bg-gradient-to-b from-surface-2 to-surface px-4 py-3.5 motion-safe:animate-[slide-up_var(--duration-base)_var(--ease-out-expo)_both]"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {/* `break-words` here used to hyphenate the pipeline name one letter per
            line once the row ran out of space on a phone. Wrapping the row
            instead keeps the name intact. */}
        <span className="text-[15px] font-extrabold tracking-[0.02em] text-ink">{first.name}</span>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
          {first.phases.length} phases
        </span>
        {first.model && (
          <span
            title="Model running this pipeline (steps that differ say so on their tile)"
            className="rounded-full border border-line px-2 font-mono text-[10px] text-ink-dim"
          >
            {first.model}
          </span>
        )}
        {multi ? (
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
            {rows.length} instances
          </span>
        ) : (
          <>
            <StatusPill status={first.badge} />
            {first.cost && (
              <Meter
                level="row"
                tokens={first.cost.tokens}
                usd={first.cost.usd}
                title="Total tokens and dollar cost of the latest run, including revised attempts"
              />
            )}
            <span className="ml-auto font-mono text-[10px]">
              <TimeAgo iso={first.updatedAt} />
            </span>
          </>
        )}
      </div>
      {/* One flat grid per card keeps every instance's tiles under the same
          shared phase headers, so titles render once and columns stay aligned.
          Columns share the row equally *until* a column would fall below 200px,
          at which point the card scrolls horizontally instead. The old
          `minmax(0, 1fr)` had no floor, so a 4-phase board on a 390px phone gave
          each phase ~60px and rendered its title one letter per line. Every
          phase still fits at any desktop width; below that, a Kanban-style
          scroll beats an illegible one. */}
      <div className="-mx-1 overflow-x-auto px-1">
        <div
          className="mt-3.5 grid min-w-full gap-x-3.5 gap-y-2.5 pb-1"
          style={{ gridTemplateColumns: `repeat(${first.phases.length}, minmax(200px, 1fr))` }}
        >
          {first.phases.map((pill, i) => (
            <PhaseHeader key={pill.id} pill={pill} index={i} />
          ))}
          {first.phases.map((pill) => (
            <div key={pill.id} className="h-[2px] rounded-full bg-line" />
          ))}
          {rows.map((row, rowIndex) => (
            <Fragment key={row.instanceId ?? row.pipelineId}>
              {multi && (
                <div
                  className={`col-span-full flex items-center gap-3 ${
                    rowIndex > 0 ? "mt-1 border-t border-line pt-2.5" : ""
                  }`}
                >
                  <span className="font-mono text-[10px] text-ink-faint">
                    #{row.instanceLabel ?? row.instanceId}
                  </span>
                  <StatusPill status={row.badge} size="sm" />
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
              )}
              {/* The shape, when there is one to see. A linear pipeline renders
                  nothing here — the phase cells below already are the shape. */}
              <PhaseGraph phases={row.phases} />
              {row.phases.map((pill) => (
                <PhaseCell
                  key={pill.id}
                  pill={pill}
                  instanceId={row.instanceId}
                  gate={row.gate}
                  approve={approve}
                  revise={revise}
                  reviseLabel={row.failure?.kind === "restarted" ? "Retry" : "Revise"}
                  liveActivity={liveActivity}
                  now={now}
                  rowModel={row.model}
                  onOpenStep={(step, phaseName, reason, originY) =>
                    onOpenStep({ step, pipelineName: row.name, phaseName, reason, originY })
                  }
                />
              ))}
            </Fragment>
          ))}
        </div>
      </div>
    </article>
  );
}

/** Board-level all-time total with a two-click confirming reset (reset is
 *  irreversible, so a bare click must not fire it). */
function BoardTotal({
  totals,
  reset,
}: {
  totals: { usd: number; tokens: number; since: string } | null;
  reset: () => Promise<void>;
}) {
  const [arming, setArming] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!totals) return null;
  const sinceLabel = new Date(totals.since).toLocaleString();
  return (
    <div className="flex items-center gap-3">
      <Meter
        level="board"
        tokens={totals.tokens}
        usd={totals.usd}
        title={`All-time tokens and dollar cost across every completed run since ${sinceLabel}`}
      />
      {arming ? (
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => {
              setBusy(true);
              void reset().finally(() => {
                setBusy(false);
                setArming(false);
              });
            }}
            disabled={busy}
            className="rounded-md border border-fail bg-fail/10 px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-fail disabled:opacity-40"
          >
            Confirm reset
          </button>
          <button
            type="button"
            onClick={() => setArming(false)}
            disabled={busy}
            className="rounded-md border border-line px-2 py-1 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-dim disabled:opacity-40"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setArming(true)}
          title="Reset the all-time total"
          className="rounded-md border border-line px-2 py-1 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint"
        >
          Reset total
        </button>
      )}
    </div>
  );
}

/**
 * A peer's live pipelines.
 *
 * A card, not the board: the board's phase grid is built from step-level state
 * that a summary does not carry, and drawing an empty grid would say "no steps"
 * where the truth is "not sent". What a peer does send — which pipelines are
 * live and which phase each is at — is exactly the question the board answers
 * at a glance, so that is what this shows.
 *
 * No approve or revise buttons. A gate is opened by the machine that owns it;
 * a button here would either fail or need a second control plane across the
 * pairing, and the link out is the honest affordance.
 */
function PeerBoard({ facet }: { facet: ReturnType<typeof useMachineFacet> }) {
  const pipelines = facet.peer?.summary?.facets.pipelines ?? [];
  if (pipelines.length === 0) return <PeerEmpty what="live pipelines" />;
  return (
    <ul className="flex flex-col gap-2">
      {pipelines.map((p) => {
        const gated = p.status === "awaiting-approval";
        return (
          <li
            key={p.id}
            className={`flex flex-wrap items-baseline gap-x-3 rounded-tile border bg-surface px-3 py-2 ${
              gated ? "border-await/40" : "border-line"
            }`}
          >
            <span className="min-w-0 flex-1 truncate text-sm text-ink">{p.name}</span>
            {p.phase && (
              <span className="shrink-0 font-mono text-[11px] text-ink-faint">at {p.phase}</span>
            )}
            <span
              className={`shrink-0 font-mono text-[10px] uppercase tracking-[0.1em] ${
                gated ? "text-await" : "text-run"
              }`}
            >
              {gated ? "needs approval" : p.status}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export default function CommandCenter() {
  const facet = useMachineFacet();
  const { overview, loading, error, approve, revise } = useOverview();
  const { totals, reset } = useTotals();
  const { situation, loading: situationLoading } = useInsight();
  const { runs, loading: runsLoading, cancelRun } = useRuns();
  const [selected, setSelected] = useState<StepSelection | null>(null);
  const rows = useMemo(() => overview.flatMap(toOverviewRows), [overview]);
  // One card per pipeline: concurrent instances of the same pipeline share a
  // card and contribute a phase grid each.
  const groups = useMemo(() => {
    const byPipeline = new Map<string, OverviewRow[]>();
    for (const r of rows) {
      const g = byPipeline.get(r.pipelineId);
      if (g) g.push(r);
      else byPipeline.set(r.pipelineId, [r]);
    }
    return [...byPipeline.values()];
  }, [rows]);
  const announcement = useBoardAnnouncer(rows);
  // The board's order comes from the server and changes as pipelines start,
  // finish and gate. A card that teleports to its new row shows nothing; one that
  // glides there shows exactly what moved.
  const flip = useFlip();
  const liveActivity = useRunActivity();
  const anyWorking = useMemo(
    () => rows.some((r) => r.phases.some((p) => p.steps.some((s) => s.status === "working"))),
    [rows],
  );
  // One clock for every running tile; idle boards do not tick.
  const now = useTicker(anyWorking);

  return (
    <Page wide title="Command Center" actions={<BoardTotal totals={totals} reset={reset} />}>
      <div aria-live="polite" role="status" className="sr-only">
        {announcement}
      </div>
      <MachinePicker facet={facet} label="Show the board from" />
      <PeerBanner facet={facet} />
      {!facet.peer && <SituationStrip situation={situation} loading={situationLoading} />}
      {error && (
        <div className="mb-6 rounded-tile border border-fail/30 bg-fail/10 px-4 py-3 text-sm text-fail">
          Couldn't reach the Argus server: {error}
        </div>
      )}
      {facet.peer ? (
        <PeerBoard facet={facet} />
      ) : (
        <Handoff
          busy={loading}
          label="the board"
          skeleton={
            <div className="flex flex-col gap-3">
              <SkeletonBoardCard phases={4} />
              <SkeletonBoardCard phases={3} />
            </div>
          }
        >
          {rows.length === 0 ? (
            <EmptyState>
              No pipelines defined yet. Create one in the{" "}
              <a
                href="#/pipelines"
                className="text-ink underline decoration-line underline-offset-2"
              >
                Pipelines
              </a>{" "}
              tab.
            </EmptyState>
          ) : (
            // The rail sits beside the board on a wide display and below it on a
            // narrow one — the board needs the horizontal room more than the rail
            // does, so the rail is what moves.
            <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_320px]">
              <div className="flex min-w-0 flex-col gap-3">
                {groups.map((group, i) => (
                  <Row
                    key={group[0].pipelineId}
                    ref={flip(group[0].pipelineId)}
                    index={i}
                    rows={group}
                    approve={approve}
                    revise={revise}
                    liveActivity={liveActivity}
                    now={now}
                    onOpenStep={setSelected}
                  />
                ))}
              </div>
              <ActivityRail
                rows={rows}
                liveActivity={liveActivity}
                runs={runs}
                loading={runsLoading}
              />
            </div>
          )}
        </Handoff>
      )}
      <StepDrawer selection={selected} onClose={() => setSelected(null)} onCancelRun={cancelRun} />
    </Page>
  );
}
