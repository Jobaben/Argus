import { Suspense, lazy, useMemo, useState } from "react";
import { runtimeLabel } from "../useRuntimes";
import { useMachineFacet } from "../fleet/useMachineFacet";
import { MachinePicker, PeerBanner, PeerEmpty } from "../fleet/MachineFacet";
import { useOverview } from "../useOverview";
import { useInsight } from "../useInsight";
import { useRuns } from "../useRuns";
import { SituationStrip } from "./SituationStrip";
import { ActivityRail } from "./ActivityRail";
import { PhaseGraph } from "./PhaseGraph";
import { useElementWidth, useLaneLayout } from "./useLaneLayout";
import { edgeState } from "./laneGraphLayout";
import { decisionFields, isLongValue } from "./decisionValue";
import { attentionPhase } from "./phaseAttention";
import { StepDrawer, type StepSelection } from "./StepDrawer";
import type { GateSelection } from "./GateDrawer";
import { hashSegments, useHashRoute } from "../useHashRoute";
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
import type { RouteDecision } from "../types";

// The review drawer carries the markdown lexer, which the board does not need
// until a gate is actually opened — so it is its own chunk, fetched on first
// open, and the Command Center (an eager route) stays inside the size budget.
const GateDrawer = lazy(() => import("./GateDrawer").then((m) => ({ default: m.GateDrawer })));

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

function StepTile({
  step,
  reason,
  live,
  rowModel,
  onOpen,
}: {
  step: StepPill;
  reason: string | null;
  live: LiveActivity | null;
  /** Pipeline-level model shown in the card header; the tile only repeats a
   *  model when its own differs from this. */
  rowModel: string | null;
  /** Opens this step's drawer, told where on screen the tile was. */
  onOpen: (originY: number) => void;
}) {
  const token = STATUS[step.status].token;
  const working = step.status === "working";
  // The elapsed clock lives in the tile that shows it. One clock at the board
  // root re-rendered every card once a second for the sake of a few labels —
  // and each of those renders re-measured the whole board for FLIP.
  const now = useTicker(working);
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
 * The route decision a phase's own result took: the value, what it selected,
 * what it consequently skipped.
 *
 * A short value stays on the line — `{"accepted":true}` is already the clearest
 * form of itself and a layout around it is ceremony. A long one is lifted into
 * a block of its own fields, a list drawn as a list, and folded to a few lines
 * until asked for. What it replaces was one paragraph of raw JSON broken
 * mid-word, which on a real agent verdict ran to a dozen lines and pushed the
 * step tiles — the reason anyone opened the phase — under the fold.
 */
function DecisionNote({
  decision,
  name,
}: {
  decision: RouteDecision;
  /** Phase ids as the names the reader knows them by. */
  name: (id: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const long = isLongValue(decision.value);
  return (
    <div data-testid="phase-decision" className="min-w-0 px-0.5 text-[11px] text-ink-faint">
      <p className="min-w-0">
        <span className="font-mono text-ink-dim">{decision.artifact}</span>{" "}
        {!long && (
          <>
            <span className="break-words font-mono text-ink-dim">
              {JSON.stringify(decision.value)}
            </span>{" "}
          </>
        )}
        → {decision.selected.length > 0 ? decision.selected.map(name).join(", ") : "nothing"}
        {decision.skipped.length > 0 && (
          <span> · skipped {decision.skipped.map(name).join(", ")}</span>
        )}
      </p>
      {long && (
        <div className="mt-1.5">
          <dl
            data-testid="decision-fields"
            className={`flex min-w-0 flex-col gap-1.5 rounded-lg border border-line/70 bg-ground-2/60 px-2.5 py-2 ${
              open
                ? ""
                : "max-h-24 overflow-hidden [mask-image:linear-gradient(to_bottom,black_55%,transparent)]"
            }`}
          >
            {decisionFields(decision.value).map((field, i) => (
              <div key={field.key ?? i} className="min-w-0">
                {field.key && (
                  <dt className="font-mono text-[9px] font-bold uppercase tracking-[0.12em] text-ink-faint">
                    {field.key}
                  </dt>
                )}
                <dd className="min-w-0 break-words leading-[1.55] text-ink-dim">
                  {field.kind === "list" ? (
                    <ul className="flex flex-col gap-1">
                      {field.items.map((item, j) => (
                        <li key={j} className="flex min-w-0 gap-1.5">
                          <span aria-hidden="true" className="text-ink-faint">
                            ·
                          </span>
                          <span className="min-w-0">{item}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    field.text
                  )}
                </dd>
              </div>
            ))}
          </dl>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="mt-1 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-faint transition hover:text-ink"
          >
            <span aria-hidden="true">{open ? "▾" : "▸"}</span>
            {open ? "Less" : "Full value"}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * One phase's step tiles — the focus panel beside the graph.
 *
 * The board used to render every step of every phase at all times, which put a
 * 14-phase pipeline at several screens per card, most of it "queued" tiles
 * carrying nothing. Now the graph is the complete always-on summary and
 * this panel renders the one phase being asked about, keyed by the caller so a
 * focus change enters as a change (same posture as a route swap: the outgoing
 * content is gone by the time React commits, the incoming one arrives with the
 * card entrance).
 */
function PhaseFocus({
  pill,
  index,
  phases,
  phaseNames,
  instanceId,
  gate,
  reviseLabel,
  liveActivity,
  rowModel,
  onOpenStep,
  onOpenGate,
}: {
  pill: PhasePill;
  index: number;
  /** Every phase of the instance, to name where this one's routes lead. */
  phases: PhasePill[];
  /** Phase names by id, to render `needs` as names rather than ids. */
  phaseNames: Map<string, string>;
  instanceId: string | null;
  /** This phase's gate, when it is the one waiting on a human. */
  gate: OverviewGate | null;
  reviseLabel?: string;
  liveActivity: Map<string, LiveActivity>;
  rowModel: string | null;
  onOpenStep: (step: StepPill, phaseName: string, reason: string | null, originY: number) => void;
  /** Open the review drawer — the only place Approve and Revise live. */
  onOpenGate: (originY: number) => void;
}) {
  const name = (id: string) => phaseNames.get(id) ?? id;
  const edges =
    pill.edges ??
    pill.needs.map((n) => ({ phase: n, label: "always", conditional: false, allowSkipped: false }));
  const needNames = pill.needs.map(name);
  // Where this phase leads, with the condition each route needs. The graph
  // draws the same labels on its edges; this is the line for a reader who is
  // looking at the steps and asks "and then?" — including a route that is
  // still to be decided by the result these steps produce.
  const routes = phases.flatMap((q) => {
    const edge = (q.edges ?? []).find((e) => e.phase === pill.id);
    const linked = edge !== undefined || q.needs.includes(pill.id);
    if (!linked || q.id === pill.id) return [];
    return [
      {
        to: q,
        index: phases.indexOf(q),
        condition: edge?.conditional ? edge.label : null,
        state: edgeState(pill, q),
      },
    ];
  });
  const undecided = routes.some((r) => r.condition) && pill.status !== "done";
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
      {routes.length > 0 && (
        <p
          data-testid="phase-routes"
          className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 px-0.5 text-[11px] text-ink-faint"
        >
          <span aria-hidden="true">→</span>
          {routes.map((r, i) => (
            <span key={r.to.id} className="inline-flex min-w-0 items-center gap-1.5">
              {i > 0 && <span className="opacity-60">·</span>}
              {r.condition && (
                <span
                  className={`rounded border bg-surface-2 px-[5px] font-mono text-[8.5px] leading-[14px] ${
                    r.state === "taken"
                      ? "border-ok/40 text-ink-dim"
                      : r.state === "skipped"
                        ? "border-line text-ink-faint opacity-60"
                        : "border-line text-ink-faint"
                  }`}
                >
                  {r.condition}
                </span>
              )}
              <span className={`min-w-0 truncate ${r.state === "skipped" ? "" : "text-ink-dim"}`}>
                {String(r.index + 1).padStart(2, "0")} {r.to.name}
              </span>
            </span>
          ))}
          {undecided && <span className="opacity-60">— decided by this phase's result</span>}
        </p>
      )}
      {/* Why this phase did not run, in the words of the decision that said so. */}
      {pill.skipped && pill.skipCause && (
        <p data-testid="phase-skip" className="px-0.5 text-[11px] text-ink-faint">
          Not selected — {name(pill.skipCause.source)}: {pill.skipCause.label}
        </p>
      )}
      {pill.decision && <DecisionNote decision={pill.decision} name={name} />}
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
                rowModel={rowModel}
                onOpen={(originY) => onOpenStep(step, pill.name, reason, originY)}
              />
            </li>
          );
        })}
      </ol>
      {/* One opener, no decision here: the artifacts this phase produced are
          what is being approved, and they live in the review drawer. */}
      {instanceId && gate?.phaseId === pill.id && (
        <div className="mt-1.5">
          <button
            type="button"
            data-testid="gate-opener"
            onClick={(e) => onOpenGate(e.currentTarget.getBoundingClientRect().top)}
            className={`rounded-md border px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.08em] transition-transform duration-(--duration-press) motion-safe:active:scale-[0.97] ${
              gate.canApprove
                ? "border-await bg-await/10 text-await"
                : "border-fail/40 bg-fail/10 text-fail"
            }`}
          >
            {gate.canApprove ? "Review" : `Review · ${reviseLabel ?? "Revise"}`}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * One instance's graph + focus panel, and the selection between them.
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
  liveActivity,
  onOpenStep,
  onOpenGate,
}: {
  row: OverviewRow;
  liveActivity: Map<string, LiveActivity>;
  onOpenStep: (selection: StepSelection) => void;
  onOpenGate: (selection: GateSelection) => void;
}) {
  const [pinned, setPinned] = useState<string | null>(null);
  // A pin outlives the phase it names only if the definition was edited
  // mid-flight; fall back to following rather than showing nothing.
  const auto = attentionPhase(row.phases);
  const selectedId = pinned && row.phases.some((p) => p.id === pinned) ? pinned : auto;
  const selectedIndex = row.phases.findIndex((p) => p.id === selectedId);
  const selected = selectedIndex === -1 ? null : row.phases[selectedIndex];
  const phaseNames = useMemo(() => new Map(row.phases.map((p) => [p.id, p.name])), [row.phases]);
  // The graph sits beside the focus panel on a wide card and above it on a
  // narrow one — the step tiles need the horizontal room more than the graph
  // does, so the graph is what moves. Measured here, not with a viewport
  // breakpoint: the card's width depends on whether the activity rail is
  // beside the board, which a media query cannot see.
  const [boardRef, width] = useElementWidth<HTMLDivElement>();
  const { layout, laneW, tileWidth, stacked } = useLaneLayout(row.phases, width);
  return (
    <div
      ref={boardRef}
      data-testid="instance-board"
      className={`min-w-0 ${stacked ? "flex flex-col gap-3" : "grid items-start gap-4"}`}
      style={stacked ? undefined : { gridTemplateColumns: `${tileWidth}px minmax(0, 1fr)` }}
    >
      <PhaseGraph
        phases={row.phases}
        layout={layout}
        laneW={laneW}
        tileWidth={tileWidth}
        stacked={stacked}
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
          phases={row.phases}
          phaseNames={phaseNames}
          instanceId={row.instanceId}
          gate={row.gates.find((g) => g.phaseId === selected.id) ?? null}
          reviseLabel={row.failure?.kind === "restarted" ? "Retry" : "Revise"}
          liveActivity={liveActivity}
          rowModel={row.model}
          onOpenStep={(step, phaseName, reason, originY) =>
            onOpenStep({ step, pipelineName: row.name, phaseName, reason, originY })
          }
          onOpenGate={(originY) => {
            if (row.instanceId) {
              onOpenGate({
                instanceId: row.instanceId,
                phaseId: selected.id,
                pipelineName: row.name,
                originY,
              });
            }
          }}
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
  liveActivity,
  index,
  onOpenStep,
  onOpenGate,
  ref,
}: {
  rows: OverviewRow[];
  liveActivity: Map<string, LiveActivity>;
  /** Position in the board, for the entrance stagger. */
  index: number;
  onOpenStep: (selection: StepSelection) => void;
  onOpenGate: (selection: GateSelection) => void;
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
            {/* The graph is the whole pipeline at a glance — statuses, stages,
                edges, routes, gates, step progress — and the focus panel beside
                it renders one phase's step tiles at a time, following the
                action unless a node is pinned. */}
            <InstanceBoard
              row={row}
              liveActivity={liveActivity}
              onOpenStep={onOpenStep}
              onOpenGate={onOpenGate}
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
  const [pickedGate, setPickedGate] = useState<GateSelection | null>(null);
  const rows = useMemo(() => overview.flatMap(toOverviewRows), [overview]);
  // `#/command/<instanceId>[/<phaseId>]` opens the review drawer — the link the
  // palette and `argus tail` hand out. Derived from the hash and the board, not
  // stored, so it cannot drift from either. Never on a peer's board: a gate is
  // decided by the machine that owns it, and this server does not.
  const segments = useHashRoute();
  const linkedGate = useMemo<GateSelection | null>(() => {
    if (facet.peer) return null;
    const [tab, instanceId, phaseId] = segments;
    if (tab !== "command" || !instanceId) return null;
    const row = rows.find((r) => r.instanceId === instanceId);
    if (!row) return null;
    const target = phaseId ? row.gates.find((g) => g.phaseId === phaseId) : row.gates[0];
    return target ? { instanceId, phaseId: target.phaseId, pipelineName: row.name } : null;
  }, [segments, rows, facet.peer]);
  const gate = pickedGate ?? linkedGate;
  // Once a gate has been opened the drawer stays mounted (closed), so its exit
  // animation plays and the next open is instant. Set during render, not in an
  // effect: the value follows `gate` and nothing outside React needs telling.
  const [everOpened, setEverOpened] = useState(false);
  if (gate && !everOpened) setEverOpened(true);
  const closeGate = () => {
    setPickedGate(null);
    // Drop the deep link too, or the board would reopen what was just closed.
    const here = hashSegments();
    if (here[0] === "command" && here.length > 1) window.location.hash = "#/command";
  };
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
                    liveActivity={liveActivity}
                    onOpenStep={setSelected}
                    onOpenGate={setPickedGate}
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
      {everOpened && (
        <Suspense fallback={null}>
          <GateDrawer selection={gate} onClose={closeGate} approve={approve} revise={revise} />
        </Suspense>
      )}
    </Page>
  );
}
