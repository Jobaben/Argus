import { useMemo, useState } from "react";
import { runtimeLabel } from "../useRuntimes";
import { useMachineFacet } from "../fleet/useMachineFacet";
import { MachinePicker, PeerBanner, PeerEmpty } from "../fleet/MachineFacet";
import { useOverview } from "../useOverview";
import { useInsight } from "../useInsight";
import { useRuns } from "../useRuns";
import { SituationStrip } from "./SituationStrip";
import { ActivityRail } from "./ActivityRail";
import { PhaseRail } from "./PhaseRail";
import { attentionPhase } from "./phaseAttention";
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
            {step.runtime && step.runtime !== "claude" && (
              <span title={`Run by the ${runtimeLabel(step.runtime) || step.runtime} CLI`}>
                {" "}
                · {step.runtime}
              </span>
            )}
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

/**
 * One phase's step tiles — the focus panel under the rail.
 *
 * The board used to render every step of every phase at all times, which put a
 * 14-phase pipeline at several screens per card, most of it "queued" tiles
 * carrying nothing. Now the rail above is the complete always-on summary and
 * this panel renders the one phase being asked about, keyed by the caller so a
 * focus change enters as a change (same posture as a route swap: the outgoing
 * content is gone by the time React commits, the incoming one arrives with the
 * card entrance).
 */
function PhaseFocus({
  pill,
  index,
  phaseNames,
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
  index: number;
  /** Phase names by id, to render `needs` as names rather than ids. */
  phaseNames: Map<string, string>;
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
  const name = (id: string) => phaseNames.get(id) ?? id;
  const edges =
    pill.edges ??
    pill.needs.map((n) => ({ phase: n, label: "always", conditional: false, allowSkipped: false }));
  const needNames = pill.needs.map(name);
  return (
    <div className="flex min-w-0 flex-col gap-2.5 motion-safe:animate-[slide-up_var(--duration-base)_var(--ease-out-expo)_both]">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-0.5">
        <span className="font-mono text-[10px] text-ink-faint">
          {String(index + 1).padStart(2, "0")}
        </span>
        <span className="min-w-0 break-words font-mono text-label font-bold uppercase tracking-[0.14em] text-ink-dim">
          {pill.name}
        </span>
        <span className="rounded-full border border-line px-2 font-mono text-label text-ink-faint">
          {pill.steps.length}
        </span>
        {(pill.attempt ?? 0) > 0 && (
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-faint">
            attempt {pill.attempt + 1}
          </span>
        )}
        {pill.retryAt && pill.status === "failed" && (
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-await">
            retry queued
          </span>
        )}
        {pill.skipped && (
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-faint">
            skipped
          </span>
        )}
        {/* Each incoming edge with the condition that governs it: an
            unconditional edge is just the arrow it always was, a conditional
            one says what has to be true, and a skip-tolerant join says it
            accepts a branch that never ran. */}
        {edges.length > 0 && (
          <span
            className="min-w-0 truncate font-mono text-[10px] text-ink-faint"
            title={`Waits for ${needNames.join(", ")}`}
          >
            ←{" "}
            {edges
              .map(
                (e) =>
                  `${name(e.phase)}${e.conditional ? ` (${e.label})` : ""}${
                    e.allowSkipped ? " or skipped" : ""
                  }`,
              )
              .join(", ")}
          </span>
        )}
      </div>
      {/* Why this phase did not run, in the words of the decision that said so. */}
      {pill.skipped && pill.skipCause && (
        <p data-testid="phase-skip" className="px-0.5 text-[11px] text-ink-faint">
          Not selected — {name(pill.skipCause.source)}: {pill.skipCause.label}
        </p>
      )}
      {/* The decision this phase's own result took: the value, then what it
          selected and what it consequently skipped. Compact on purpose — the
          journal has the long form, this is the line that stops the reader
          asking. */}
      {pill.decision && (
        <p data-testid="phase-decision" className="min-w-0 px-0.5 text-[11px] text-ink-faint">
          <span className="font-mono text-ink-dim">{pill.decision.artifact}</span>{" "}
          <span className="font-mono break-all">{JSON.stringify(pill.decision.value)}</span> →{" "}
          {pill.decision.selected.length > 0
            ? pill.decision.selected.map(name).join(", ")
            : "nothing"}
          {pill.decision.skipped.length > 0 && (
            <span> · skipped {pill.decision.skipped.map(name).join(", ")}</span>
          )}
        </p>
      )}
      <ol
        aria-label={`Steps of phase ${pill.name}`}
        data-testid="phase-grid"
        className="grid min-w-0 gap-x-3.5 gap-y-2.5"
        style={{
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))",
        }}
      >
        {pill.steps.map((step, i) => {
          const reason = step.status === "failed" ? pill.reason : null;
          return (
            <li key={`${step.name}-${i}`} className="min-w-0">
              <StepTile
                step={step}
                reason={reason}
                live={step.runId ? (liveActivity.get(step.runId) ?? null) : null}
                now={now}
                rowModel={rowModel}
                onOpen={(originY) => onOpenStep(step, pill.name, reason, originY)}
              />
            </li>
          );
        })}
      </ol>
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
 * One instance's rail + focus panel, and the selection between them.
 *
 * The focus follows the action by default — the gate waiting on you, the
 * failure, the live work (see {@link attentionPhase}) — so an untouched board
 * always shows the step detail that matters right now. Clicking a chip pins
 * that phase; clicking the pinned chip again returns to following. The pin
 * lives here, per instance, so two concurrent instances can be inspected
 * independently.
 */
function InstanceBoard({
  row,
  approve,
  revise,
  liveActivity,
  now,
  onOpenStep,
}: {
  row: OverviewRow;
  approve: (id: string) => Promise<unknown>;
  revise: (id: string, note?: string) => Promise<unknown>;
  liveActivity: Map<string, LiveActivity>;
  now: number;
  onOpenStep: (selection: StepSelection) => void;
}) {
  const [pinned, setPinned] = useState<string | null>(null);
  // A pin outlives the phase it names only if the definition was edited
  // mid-flight; fall back to following rather than showing nothing.
  const auto = attentionPhase(row.phases);
  const selectedId = pinned && row.phases.some((p) => p.id === pinned) ? pinned : auto;
  const selectedIndex = row.phases.findIndex((p) => p.id === selectedId);
  const selected = selectedIndex === -1 ? null : row.phases[selectedIndex];
  const phaseNames = useMemo(() => new Map(row.phases.map((p) => [p.id, p.name])), [row.phases]);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <PhaseRail
        phases={row.phases}
        selectedId={selectedId}
        onSelect={(id) => setPinned((prev) => (prev === id ? null : id))}
      />
      {selected && (
        <PhaseFocus
          // Keyed per phase so moving the focus is visible as a change — the
          // incoming panel plays the card entrance; reduced motion resolves
          // instantly via the global kill switch.
          key={selected.id}
          pill={selected}
          index={selectedIndex}
          phaseNames={phaseNames}
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
      )}
    </div>
  );
}

/**
 * One card per pipeline. Every instance gets a responsive phase grid that
 * wraps into additional rows instead of making the board horizontally scroll.
 * Keeping the grid instance-local also means an older in-flight instance stays
 * accurate if the pipeline definition is edited while it runs.
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
      <div className="mt-3.5 flex min-w-0 flex-col gap-4">
        {rows.map((row, rowIndex) => (
          <section
            key={row.instanceId ?? row.pipelineId}
            className={`min-w-0 ${rowIndex > 0 ? "border-t border-line pt-3.5" : ""}`}
          >
            {multi && (
              <div className="mb-3 flex min-w-0 flex-wrap items-center gap-3">
                <span className="min-w-0 truncate font-mono text-[10px] text-ink-faint">
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
            {/* The rail is the whole pipeline at a glance — statuses, stages,
                gates, step progress — and the focus panel under it renders one
                phase's step tiles at a time, following the action unless a chip
                is pinned. The complete view for linear and branching runs. */}
            <InstanceBoard
              row={row}
              approve={approve}
              revise={revise}
              liveActivity={liveActivity}
              now={now}
              onOpenStep={onOpenStep}
            />
          </section>
        ))}
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
