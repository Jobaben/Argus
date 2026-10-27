import { Suspense, lazy, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { runtimeLabel } from "../useRuntimes";
import { useMachineFacet } from "../fleet/useMachineFacet";
import { useOverview } from "../useOverview";
import { useAuth } from "../useAuth";
import { useInsight } from "../useInsight";
import { useRuns } from "../useRuns";
import { SituationStrip } from "./SituationStrip";
import { ActivityRail } from "./ActivityRail";
import { PhaseGraph, RouteCondition } from "./PhaseGraph";
import { useElementWidth, usePhaseLayout } from "./useLaneLayout";
import { edgeState } from "./laneGraphLayout";
import { decisionFields, isLongValue } from "./decisionValue";
import { attentionPhase } from "./phaseAttention";
import { ATTENTION_KINDS, attentionHref } from "./attentionKinds";
import { firstProseLine, withoutOutcome } from "./outcome";
import { reasonText, sentenceStart } from "./text";
import type { StepSelection } from "./StepDrawer";
import type { GateSelection } from "./GateDrawer";
import { hashSegments, useHashRoute } from "../useHashRoute";
import { useRunActivity } from "../useRunActivity";
import type { LiveActivity } from "../useRunActivity";
import { useTotals } from "../useTotals";
import {
  AlertStrip,
  Button,
  ButtonLink,
  chipClass,
  formatElapsed,
  Handoff,
  Icon,
  IconButton,
  instanceSectionId,
  IrisMark,
  Meter,
  Page,
  RAIL,
  rowTitle,
  Skeleton,
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
  useListPresence,
  useSyncedDelay,
  DURATION,
  EmptyState,
  useTicker,
} from "../ds";
import type { OverviewRow, OverviewGate, PhasePill, StepPill, DsStatus } from "../ds";
import type { AttentionItem as BriefingItem, AttentionKind, RouteDecision } from "../types";
import { UNREACHABLE, loadError } from "../live/loadError";

// The drawers are chunks of their own — the review drawer carries the markdown
// lexer — so the Command Center (an eager route) stays inside the size budget.
// One loader each, shared by lazy() and the prefetch once the board is up, so
// each chunk is fetched once and is usually in before the first open.
const loadStepDrawer = () => import("./StepDrawer");
const loadGateDrawer = () => import("./GateDrawer");
const StepDrawer = lazy(() => loadStepDrawer().then((m) => ({ default: m.StepDrawer })));
const GateDrawer = lazy(() => loadGateDrawer().then((m) => ({ default: m.GateDrawer })));

// A deleted pipeline's live instance is rare, and its Stop is the one place
// the board asks a question first, so the confirm is fetched with it.
const OrphanStop = lazy(() => import("./OrphanStop").then((m) => ({ default: m.OrphanStop })));
const PeerControls = lazy(() => import("./PeerBoard").then((m) => ({ default: m.PeerControls })));
const PeerBoard = lazy(() => import("./PeerBoard").then((m) => ({ default: m.PeerBoard })));

// A spawn phase's task tile and a spawned child's parent chip (DL-A2) are a
// chunk of their own: most boards have neither, and the board is the first
// paint. The review drawer imports the same module for its task list, so the
// drawer's idle prefetch fetches it too.
const loadSpawnBoard = () => import("./SpawnBoard");
const SpawnChildren = lazy(() => loadSpawnBoard().then((m) => ({ default: m.SpawnChildren })));
const ParentChip = lazy(() => loadSpawnBoard().then((m) => ({ default: m.ParentChip })));

/**
 * A drawer opener's click, as a transition. Opened urgently, a first open with
 * its chunk still loading committed the Suspense fallback, and React holds back
 * revealing a boundary that has shown its fallback (~300ms): the first drawer
 * of a page load took ~450ms to appear, later ones ~70ms. As a transition the
 * board stays as it is until the drawer is ready, and `opening` lets the opener
 * show any wait that is left. Here, not on the board, so marking one opener
 * busy re-renders that opener rather than every card.
 */
function useOpener<A extends unknown[]>(open: (...args: A) => void) {
  const [opening, start] = useTransition();
  return [opening, (...args: A) => start(() => open(...args))] as const;
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
      const name = rowTitle(r);
      if (r.badge === "await") msgs.push(`${name} needs approval`);
      else if (r.badge === "failed") msgs.push(`${name} failed`);
      else if (r.badge === "done") msgs.push(`${name} completed`);
      else if (before === "await" && r.badge === "working") msgs.push(`${name} resumed`);
    }
    setSeen({ badges, message: msgs.length > 0 ? msgs.join(". ") : seen.message });
  }
  return seen.message;
}

/** What a candidate badge means, spelled out for the tooltip. */
function candidateTitle(step: StepPill): string {
  const which = `Candidate ${(step.candidate?.index ?? 0) + 1} of ${step.candidate?.total ?? 1}`;
  if (step.selected) return `${which} — selected: its checks passed`;
  if (step.verified === false) return `${which} — its checks failed`;
  if (step.superseded) return `${which} — superseded by the candidate that won`;
  return `${which} — competing drafts of the same step; the phase's checks pick one`;
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
  const [opening, open] = useOpener(onOpen);
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
  // Told as the drawer tells it: no "failed:" beside the Failed pill.
  const said = reasonText(reason);
  return (
    <article
      // Fast attack, slow release. One duration for both directions made the
      // flash fade *in* as slowly as it faded out, which is the wrong way round:
      // attention should be claimed at once and then released on a curve, not
      // eased into and cut off.
      className={`relative flex flex-col gap-2 overflow-hidden rounded-tile border bg-gradient-to-b to-surface pb-3 pl-4 pr-3 pt-3 transition-[box-shadow,border-color,background-color] hover:border-line-strong ${
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
        {/* The name is the activator rather than the whole tile — a tile-sized
            button around the tile's own content would be a nested interactive
            element — but its hit area is stretched over the tile by `::after`,
            so the whole tile opens the drawer. The few things inside that carry
            a tooltip of their own sit above that layer. */}
        <button
          type="button"
          // The tile's own position, so the drawer grows out of the row you
          // pressed instead of out of the screen edge. Read from the event
          // rather than measured later: by then the board may have re-sorted.
          onClick={(e) => open(e.currentTarget.getBoundingClientRect().top)}
          aria-busy={opening || undefined}
          className="min-w-0 flex-1 text-left aria-busy:cursor-progress after:absolute after:inset-0 after:rounded-tile after:content-[''] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-eye"
          title="Open this step's run, log and cost"
        >
          <div className="flex min-w-0 items-baseline gap-1.5">
            {step.candidate && (
              // Which draft this is. The badge carries the verdict too, because
              // "c2" on its own says nothing about whether c2 is any good.
              <span
                data-testid="candidate-badge"
                title={candidateTitle(step)}
                className={`relative z-10 ${chipClass(
                  step.selected ? "ok" : step.verified === false ? "fail" : "neutral",
                )}`}
              >
                c{step.candidate.index + 1}
              </span>
            )}
            <span className="min-w-0 break-words text-tile-name font-semibold leading-snug text-ink">
              {step.name}
            </span>
          </div>
          <div className="mt-0.5 truncate font-mono text-id text-ink-faint">
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
        {step.superseded ? (
          // Not "stopped": this draft was not interrupted, it was outrun.
          <span
            data-testid="candidate-superseded"
            title="Another candidate passed its checks first, so this one was stopped"
            className={`relative z-10 ${chipClass("neutral")}`}
          >
            Superseded
          </span>
        ) : (
          <StatusPill status={step.status} size="sm" />
        )}
      </div>
      {step.selected && (
        <div className="flex items-center gap-1.5 text-caption font-semibold text-ok">
          <Icon name="check" size={13} strokeWidth={2.25} />
          Selected — its checks passed
        </div>
      )}
      {said && (
        <div className={`text-small leading-snug ${TILE_DETAIL[token] ?? "text-ink-dim"}`}>
          {said}
        </div>
      )}
      {activity && (
        <div className="flex min-w-0 items-start gap-1.5 text-caption leading-snug text-ink-dim">
          <Icon name="activity" size={13} className="mt-px text-run" />
          <span className="min-w-0 break-words font-mono">{activity}</span>
        </div>
      )}
      {elapsed && (
        <div className="text-caption text-ink-faint">
          <span className="font-semibold text-ink-dim">{elapsed}</span> elapsed
        </div>
      )}
      {working && <SweepBar />}
      {hasMeter && (
        <div className="flex items-center gap-2 text-caption text-ink-faint">
          <Meter
            level="step"
            tokens={step.tokens}
            usd={step.costUsd}
            durationMs={finished ? step.durationMs : null}
            title="Duration, tokens and dollar cost reported by this step's run"
          />
          {step.startedAt && (
            <span className="relative z-10 ml-auto">
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
    <div data-testid="phase-decision" className="min-w-0 px-0.5 text-caption text-ink-faint">
      <p className="min-w-0">
        <span className="font-mono text-ink-dim">{decision.artifact}</span>{" "}
        {!long && (
          <>
            <span className="break-words font-mono text-ink-dim">
              {JSON.stringify(decision.value)}
            </span>{" "}
          </>
        )}
        {/* The routes line's arrow, set in the text it leads. */}
        <Icon name="arrow-right" size={13} className="inline-block align-[-2px]" />{" "}
        {decision.selected.length > 0 ? decision.selected.map(name).join(", ") : "nothing"}
        {decision.skipped.length > 0 && (
          <span> · skipped {decision.skipped.map(name).join(", ")}</span>
        )}
      </p>
      {long && (
        <div className="mt-1.5">
          <dl
            data-testid="decision-fields"
            className={`flex min-w-0 flex-col gap-2 rounded-control border border-line bg-ground-2/60 px-3 py-2.5 ${
              open
                ? ""
                : "max-h-24 overflow-hidden [mask-image:linear-gradient(to_bottom,black_55%,transparent)]"
            }`}
          >
            {decisionFields(decision.value).map((field, i) => (
              <div key={field.key ?? i} className="min-w-0">
                {field.key && <dt className="eyebrow">{field.key}</dt>}
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
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="mt-1"
          >
            <Icon
              name="chevron-down"
              size={14}
              className={`transition-transform duration-(--duration-base) ease-(--ease-out-expo) ${open ? "rotate-180" : ""}`}
            />
            {open ? "Less" : "Full value"}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * The focus panel's "from" and "to" lines. A separator belongs to the item
 * after it and sits in the gap before it, which the line clips at its start:
 * where the line wraps, the dot goes with the wrap instead of leading the new
 * line and pointing at nothing — as the card header's facts do. The gap goes
 * only between items on a line, so a wrapped item still starts flush; the
 * arrow pulls its own gap back in to stay close to the first one.
 */
const ROUTE_LINE =
  "flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 overflow-hidden px-0.5 text-caption text-ink-faint";
const ROUTE_ITEM = "relative inline-flex min-w-0 items-center gap-1.5";
const ROUTE_SEP = "pointer-events-none absolute -left-2.5 opacity-60";

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
  board,
  onOpenStep,
  onOpenGate,
  onOpenChildGate,
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
  /** Every row on the board, for a spawn phase's tasks to find their children. */
  board: OverviewRow[];
  /** Open the review drawer — the only place Approve and Revise live. */
  onOpenGate: (originY: number) => void;
  /** Open a gate other than this phase's own: a task's child's. */
  onOpenChildGate: (selection: GateSelection) => void;
}) {
  const [opening, openGate] = useOpener(onOpenGate);
  const name = (id: string) => phaseNames.get(id) ?? id;
  const number = (id: string) => String(phases.findIndex((q) => q.id === id) + 1).padStart(2, "0");
  const edges =
    pill.edges ??
    pill.needs.map((n) => ({ phase: n, label: "always", conditional: false, allowSkipped: false }));
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
        condition: edge?.conditional ? edge.label : null,
        state: edgeState(pill, q),
      },
    ];
  });
  const undecided = routes.some((r) => r.condition) && pill.status !== "done";
  // Shown on each failed tile and handed to its drawer, without the agent's
  // `ARGUS_OUTCOME` line: the tile's status pill already says the verdict.
  const failReason = withoutOutcome(pill.reason) || null;
  return (
    <div className="flex min-w-0 flex-col gap-3 motion-safe:animate-[slide-up_var(--duration-base)_var(--ease-out-expo)_both]">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-0.5">
        <span className="font-mono text-caption text-ink-faint">
          {String(index + 1).padStart(2, "0")}
        </span>
        <span className="min-w-0 break-words text-heading font-semibold text-ink">{pill.name}</span>
        <span
          title={
            pill.spawn
              ? "One child instance per task"
              : `${pill.steps.length} ${pill.steps.length === 1 ? "step" : "steps"}`
          }
          className={chipClass("neutral")}
        >
          {pill.spawn && <Icon name="spawn" size={11} />}
          {pill.spawn ? pill.spawn.tasks.length || null : pill.steps.length}
        </span>
        {(pill.attempt ?? 0) > 0 && (
          <span className={chipClass("neutral")}>Attempt {pill.attempt + 1}</span>
        )}
        {pill.retryAt && pill.status === "failed" && (
          <span className={chipClass("await")}>Retry queued</span>
        )}
        {pill.skipped && <span className={chipClass("neutral")}>Skipped</span>}
      </div>
      {/* Where the work comes from, then where it goes: one line each, in one
          form — the phase by number and name, the condition that governs the
          edge in the same chip the graph draws on it. The incoming line used
          to sit in the header cut to one line with its conditions in
          parentheses, so the last dependency was reachable only by tooltip.
          The set has no left arrow, so "from" is the right one turned round. */}
      {edges.length > 0 && (
        <p data-testid="phase-needs" className={ROUTE_LINE}>
          <Icon name="arrow-right" size={13} className="-mr-2.5 rotate-180" />
          <span className="sr-only">Waits for</span>
          {edges.map((e, i) => (
            <span key={e.phase} className={ROUTE_ITEM}>
              {i > 0 && <span className={ROUTE_SEP}>·</span>}
              {e.conditional && (
                <RouteCondition
                  state={edgeState(phases.find((q) => q.id === e.phase) ?? pill, pill)}
                  className="leading-[18px]"
                >
                  {e.label}
                </RouteCondition>
              )}
              <span className="min-w-0 break-words text-ink-dim">
                {number(e.phase)} {name(e.phase)}
              </span>
              {e.allowSkipped && <span>or skipped</span>}
            </span>
          ))}
        </p>
      )}
      {routes.length > 0 && (
        <p data-testid="phase-routes" className={ROUTE_LINE}>
          <Icon name="arrow-right" size={13} className="-mr-2.5" />
          <span className="sr-only">Leads to</span>
          {routes.map((r, i) => (
            <span key={r.to.id} className={ROUTE_ITEM}>
              {i > 0 && <span className={ROUTE_SEP}>·</span>}
              {r.condition && (
                <RouteCondition state={r.state} className="leading-[18px]">
                  {r.condition}
                </RouteCondition>
              )}
              <span
                className={`min-w-0 break-words ${r.state === "skipped" ? "" : "text-ink-dim"}`}
              >
                {number(r.to.id)} {r.to.name}
              </span>
            </span>
          ))}
          {undecided && <span className="opacity-60">— decided by this phase's result</span>}
        </p>
      )}
      {/* Why this phase did not run, in the words of the decision that said so. */}
      {pill.skipped && pill.skipCause && (
        <p data-testid="phase-skip" className="px-0.5 text-caption text-ink-faint">
          Not selected — {name(pill.skipCause.source)}: {pill.skipCause.label}
        </p>
      )}
      {pill.decision && <DecisionNote decision={pill.decision} name={name} />}
      {/* One opener, no decision here: the artifacts this phase produced are
          what is being approved, and they live in the review drawer. It leads
          the panel rather than trailing the step grid — it is the reason this
          phase is in focus, and below six tiles it was below the fold. A
          spawn phase's `children` pause is led by its task tile instead. */}
      {instanceId && gate?.phaseId === pill.id && !gate.children && (
        // Sized by the panel, not the screen: beside the graph the panel can be
        // narrow at any viewport. Narrow, the button goes under the sentence,
        // lined up with it; it used to stay beside and squeeze the sentence
        // into a column of a few words a line.
        <div
          className={`@container rounded-control border px-3 py-2.5 ${
            gate.canApprove ? "border-await/35 bg-await/[0.07]" : "border-fail/30 bg-fail/[0.06]"
          }`}
        >
          <div className="flex flex-col items-start gap-2 @lg:flex-row @lg:items-center @lg:gap-3">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <Icon
                name={gate.canApprove ? "approve" : "alert"}
                size={18}
                className={`mt-px ${gate.canApprove ? "text-await" : "text-fail"}`}
              />
              <p className="min-w-0 flex-1 text-small text-ink-dim">
                {gate.canApprove
                  ? "Paused for your approval. Review what this phase produced, then approve or send it back."
                  : `This phase failed. Review what went wrong, then ${(reviseLabel ?? "Revise").toLowerCase()} it.`}
              </p>
            </div>
            {/* "Review" here as in "Needs you": it opens the review either way,
                and the revise or retry is decided in there. */}
            <Button
              data-testid="gate-opener"
              variant={gate.canApprove ? "attention" : "danger"}
              iconRight="arrow-right"
              className="ml-[30px] aria-busy:cursor-progress @lg:ml-0"
              aria-busy={opening || undefined}
              onClick={(e) => openGate(e.currentTarget.getBoundingClientRect().top)}
            >
              Review
            </Button>
          </div>
        </div>
      )}
      {pill.spawn ? (
        // A spawn phase runs no step: its tasks take the grid's place. Its own
        // chunk; the fallback holds the tile's place so the panel does not jump.
        <Suspense fallback={<Skeleton className="h-28 w-full rounded-tile" />}>
          <SpawnChildren
            spawn={pill.spawn}
            phaseName={pill.name}
            status={pill.status}
            board={board}
            gate={instanceId && gate?.phaseId === pill.id ? gate : null}
            opening={opening}
            onReview={openGate}
            onOpenGate={onOpenChildGate}
          />
        </Suspense>
      ) : (
        <ol
          aria-label={`Steps of phase ${pill.name}`}
          data-testid="phase-grid"
          className="grid min-w-0 gap-x-3.5 gap-y-2.5"
          style={{
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))",
          }}
        >
          {pill.steps.map((step, i) => {
            const reason = step.status === "failed" ? failReason : null;
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
  board,
  liveActivity,
  onOpenStep,
  onOpenGate,
}: {
  row: OverviewRow;
  /** Every row on the board, for a spawn phase's tasks to find their children. */
  board: OverviewRow[];
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
  // The graph sits above the focus panel at every width: the step tiles get
  // the card's full width, and the graph pans inside its own window. Measured
  // here, not with a viewport breakpoint: the card's width depends on whether
  // the activity rail is beside the board, which a media query cannot see.
  const [boardRef, width] = useElementWidth<HTMLDivElement>();
  const layout = usePhaseLayout(row.phases);
  return (
    <div ref={boardRef} data-testid="instance-board" className="flex min-w-0 flex-col gap-3">
      {/* The graph's well is as wide as the graph and sits at the start of
          the card, where the panel below starts — a 190px chain centred in a
          full-width well read as a loading placeholder. */}
      <div
        className="min-w-0 max-w-full"
        style={width > 0 ? { width: Math.min(layout.width + 2, width) } : undefined}
      >
        <PhaseGraph
          phases={row.phases}
          layout={layout}
          selectedId={selectedId}
          onSelect={(id) => setPinned((prev) => (prev === id ? null : id))}
        />
      </div>
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
          // A deleted pipeline's gate is not decided here: stopping is all that is left.
          gate={row.orphaned ? null : (row.gates.find((g) => g.phaseId === selected.id) ?? null)}
          reviseLabel={row.failure?.kind === "restarted" ? "Retry" : "Revise"}
          liveActivity={liveActivity}
          rowModel={row.model}
          board={board}
          onOpenStep={(step, phaseName, reason, originY) =>
            onOpenStep({ step, pipelineName: rowTitle(row), phaseName, reason, originY })
          }
          onOpenGate={(originY) => {
            if (row.instanceId) {
              onOpenGate({
                instanceId: row.instanceId,
                phaseId: selected.id,
                pipelineName: rowTitle(row),
                originY,
              });
            }
          }}
          onOpenChildGate={onOpenGate}
        />
      )}
    </div>
  );
}

/**
 * A card says what it wants from you before you read it: violet when a gate is
 * waiting, red when it failed, otherwise the plain panel. The tint is a wash at
 * the top edge, not a fill — the card is still a card, and the graph and tiles
 * inside it carry the detail.
 */
const CARD_SKIN = {
  await: "border-await/35 bg-gradient-to-b from-await/[0.07] via-surface to-surface",
  failed: "border-fail/30 bg-gradient-to-b from-fail/[0.06] via-surface to-surface",
  plain: "border-line bg-surface",
} as const;

function cardTone(rows: OverviewRow[]): keyof typeof CARD_SKIN {
  if (rows.some((r) => r.badge === "await")) return "await";
  if (rows.some((r) => r.badge === "failed")) return "failed";
  return "plain";
}

/** One of a card's header facts: its separator rides in the gap before it,
 *  where the row's negative margin clips it at the start of a line. */
const FACT =
  "relative ml-4 before:pointer-events-none before:absolute before:-left-2.5 before:text-ink-faint before:content-['·']";

/**
 * One card per pipeline. Every instance gets a responsive phase grid that
 * wraps into additional rows instead of making the board horizontally scroll.
 * Keeping the grid instance-local also means an older in-flight instance stays
 * accurate if the pipeline definition is edited while it runs.
 */
function Row({
  rows,
  board,
  liveActivity,
  index,
  onOpenStep,
  onOpenGate,
  onAbort,
  ref,
}: {
  rows: OverviewRow[];
  /** Every row on the board: a spawned child's chip finds its parent there. */
  board: OverviewRow[];
  liveActivity: Map<string, LiveActivity>;
  /** Position in the board, for the entrance stagger. */
  index: number;
  onOpenStep: (selection: StepSelection) => void;
  onOpenGate: (selection: GateSelection) => void;
  /** Stop an instance of a deleted pipeline; absent when signed out. */
  onAbort?: (instanceId: string) => Promise<unknown>;
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
      className={`min-w-0 overflow-x-clip rounded-panel border px-4 pb-4 pt-3.5 shadow-raised motion-safe:animate-[slide-up_var(--duration-base)_var(--ease-out-expo)_both] sm:px-5 ${CARD_SKIN[cardTone(rows)]}`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {/* `break-words` here used to hyphenate the pipeline name one letter per
            line once the row ran out of space on a phone. Wrapping the row
            instead keeps the name intact. */}
        <h2 className="text-title font-semibold text-ink">{first.name}</h2>
        {first.orphaned && (
          <span
            className={chipClass("fail")}
            title="This pipeline was deleted while these instances were live. Stopping them is the only action left."
          >
            Pipeline deleted
          </span>
        )}
        {multi ? (
          <span className={chipClass("neutral")}>{rows.length} instances</span>
        ) : (
          <StatusPill status={first.badge} />
        )}
        {/* The card's facts, quietest last: they answer "which one is this?",
            not "what is it doing?", which the pill and the graph already did.
            Separated by a dot that belongs to the fact after it and is clipped
            when that fact starts a line — a divider used to lead the wrapped
            line on a phone, pointing at nothing. */}
        <div className="min-w-0 overflow-hidden sm:ml-auto">
          <div className="-ml-4 flex min-w-0 flex-wrap items-center gap-y-1 text-caption text-ink-faint">
            <span className={FACT}>{first.phases.length} phases</span>
            {/* Cut short inside, not on the fact itself: clipping the fact
                clipped the dot it carries in front of it too. Mono, as on the
                step tiles: it is an id, and Hellix's wide hyphens spaced it out. */}
            {first.model && (
              <span
                title="Model running this pipeline (steps that differ say so on their tile)"
                className={`${FACT} min-w-0`}
              >
                <span className="block max-w-[16rem] truncate font-mono text-id text-ink-dim">
                  {first.model}
                </span>
              </span>
            )}
            {!multi && first.cost && (
              <span className={FACT}>
                <Meter
                  level="row"
                  tokens={first.cost.tokens}
                  usd={first.cost.usd}
                  title="Total tokens and dollar cost of the latest run, including revised attempts"
                />
              </span>
            )}
            {!multi && (
              <span className={FACT}>
                <TimeAgo iso={first.updatedAt} />
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="mt-4 flex min-w-0 flex-col gap-4">
        {rows.map((row, rowIndex) => (
          <section
            key={row.instanceId ?? row.pipelineId}
            // Where "Show" and a child's parent chip land: focusable, never in
            // the tab order.
            id={row.instanceId ? instanceSectionId(row.instanceId) : undefined}
            tabIndex={row.instanceId ? -1 : undefined}
            className={`min-w-0 scroll-mt-20 outline-none ${rowIndex > 0 ? "border-t border-line pt-3.5" : ""}`}
          >
            {multi && (
              <div className="mb-3 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
                <span className="min-w-0 truncate font-mono text-caption text-ink-dim">
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
                <span className="ml-auto text-caption">
                  <TimeAgo iso={row.updatedAt} />
                </span>
              </div>
            )}
            {row.parent && (
              // Its own chunk; the fallback is the chip's height so the graph
              // does not move when it lands.
              <Suspense fallback={<div className="mb-3 h-7" />}>
                <ParentChip parent={row.parent} board={board} />
              </Suspense>
            )}
            {row.orphaned && onAbort && row.instanceId && (
              <Suspense fallback={null}>
                <OrphanStop
                  pipelineName={first.name}
                  instanceId={row.instanceId}
                  onAbort={onAbort}
                />
              </Suspense>
            )}
            {/* The graph is the whole pipeline at a glance — statuses, stages,
                edges, routes, gates, step progress — and the focus panel beside
                it renders one phase's step tiles at a time, following the
                action unless a node is pinned. */}
            <InstanceBoard
              row={row}
              board={board}
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
  loading,
  reset,
}: {
  totals: { usd: number; tokens: number; since: string } | null;
  loading: boolean;
  reset: () => Promise<void>;
}) {
  const [arming, setArming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  // Its own height while it loads: the figure is taller than the button beside
  // it, so arriving into nothing grew the header and shifted the whole board
  // down — the largest layout shift on the landing page.
  if (!totals) {
    return loading ? (
      // The size of the real figure and its reset button (measured: 185 × 40
      // with a typical total), so a header that wraps on a phone wraps the
      // same way before and after it arrives. Wider, it pushed "Launch a
      // task" to a second line until the total came, then pulled it back.
      <span aria-hidden="true" className="mr-2 flex h-10 w-[185px] items-center justify-end gap-2">
        <span className="flex flex-col items-end gap-1.5">
          <Skeleton className="h-2.5 w-16" />
          <Skeleton className="h-5 w-36" />
        </span>
        <Skeleton className="h-7 w-7 rounded-control" />
      </span>
    ) : null;
  }
  const sinceLabel = new Date(totals.since).toLocaleString();
  const close = (refocus: boolean) => {
    setArming(false);
    setFailed(null);
    if (refocus) opener.current?.focus();
  };
  const confirmReset = () => {
    if (busy) return;
    setBusy(true);
    setFailed(null);
    reset().then(
      () => {
        setBusy(false);
        close(false);
        // Onto the total itself, not the icon: at zero the icon goes, and the
        // focus it held would fall to the top of the page.
        box.current?.focus();
      },
      (e: unknown) => {
        setBusy(false);
        setFailed(e instanceof Error ? e.message : String(e));
      },
    );
  };
  // The gap to the Launch button beside it is the total's own margin, so the
  // button does not sit indented when the total is absent.
  return (
    <div
      ref={box}
      tabIndex={-1}
      className="relative mr-2 flex items-center gap-2 rounded-control"
      // Focus moving on to something else answers "no". Only a real target
      // counts: a click on bare page moves focus nowhere, and nor does a
      // click on the icon itself in Safari, which would close and reopen it.
      onBlur={(e) => {
        const to = e.relatedTarget as Node | null;
        if (arming && !busy && to && !e.currentTarget.contains(to)) close(false);
      }}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || !arming || busy) return;
        e.stopPropagation();
        close(true);
      }}
    >
      {/* Labelled with what it counts, spend across completed runs: a run
          still going on the board below is not in it yet. */}
      <Meter
        level="board"
        label="Completed runs"
        tokens={totals.tokens}
        usd={totals.usd}
        title={`All-time tokens and dollar cost across every completed run since ${sinceLabel}`}
      />
      {/* Bookkeeping, not an action anyone came here to take: an icon beside
          the figure it resets, then a confirm. Gone at zero, where there is
          nothing to reset. A confirm already open stays until it is answered:
          hidden, a total zeroed elsewhere would leave it armed, to reappear
          unasked with the next completed run. */}
      {(arming || totals.usd !== 0 || totals.tokens !== 0) && (
        <IconButton
          ref={opener}
          icon="retry"
          label="Reset total"
          size="sm"
          aria-expanded={arming}
          onClick={() => (arming ? close(false) : setArming(true))}
        />
      )}
      {/* The confirm drops below the figure rather than in line with it: in
          line, it widened the header until it wrapped on a tablet, and the
          whole board jumped down while it was open. It opens on Cancel, the
          safe answer, and Escape or Cancel hand focus back to the icon. */}
      {arming && (
        <div
          role="group"
          aria-label="Reset the all-time total"
          className="absolute left-0 top-full z-20 mt-2 flex w-full min-w-56 flex-col gap-2.5 rounded-tile border border-line-strong bg-surface-2 p-3 shadow-overlay motion-safe:animate-[slide-up_var(--duration-base)_var(--ease-out-expo)_both]"
        >
          <p className="text-small text-ink-dim">
            Start the total again from zero? This can't be undone.
          </p>
          {failed && (
            <p role="alert" className="text-caption text-fail-ink">
              Couldn't reset: {failed}
            </p>
          )}
          <div className="flex justify-end gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              autoFocus
              aria-disabled={busy || undefined}
              onClick={() => !busy && close(true)}
            >
              Cancel
            </Button>
            {/* Disabled by aria while it runs, not by `disabled`: a disabled
                button drops the focus it holds to the page. */}
            <Button
              variant="danger"
              size="sm"
              aria-disabled={busy || undefined}
              onClick={confirmReset}
            >
              Confirm reset
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

interface AttentionItem {
  key: string;
  row: OverviewRow;
  gate: OverviewGate;
  phaseName: string;
  /** Why it stopped, for a failure; null for a gate waiting to be approved. */
  reason: string | null;
}

/** Every gate on the board, waiting ones first — the order the server already
 *  sorts the cards in, flattened to one line per decision. */
function attentionItems(rows: OverviewRow[]): AttentionItem[] {
  const items = rows.flatMap((row) =>
    row.orphaned || !row.instanceId
      ? []
      : row.gates.map((gate) => {
          const phase = row.phases.find((p) => p.id === gate.phaseId);
          return {
            key: `${row.instanceId}:${gate.phaseId}`,
            row,
            gate,
            phaseName: phase?.name ?? gate.phaseId,
            // The first line of prose, which is what the row has room for. A
            // reason that is nothing but an agent's `ARGUS_OUTCOME` marker
            // reads as the marker's own reason, never as the protocol line;
            // either way it is told as the drawers tell it.
            reason: gate.canApprove
              ? null
              : reasonText(firstProseLine(phase?.reason ?? row.failure?.reason)) || null,
          };
        }),
  );
  return [...items.filter((i) => i.gate.canApprove), ...items.filter((i) => !i.gate.canApprove)];
}

/** The deep link that opens one gate's review: what the palette and `argus
 *  tail` hand out, and now what the strip's "need approval" chip points at. */
function gateHref(item: AttentionItem | undefined): string {
  return item
    ? `#/command/${encodeURIComponent(item.row.instanceId!)}/${encodeURIComponent(item.gate.phaseId)}`
    : "#/command";
}

/**
 * What the Briefing says needs a person and the board has no card for — a
 * monitor down or failing, a critical anomaly, an open issue — with the same
 * labels, verbs, icons and destinations the Briefing gives them, from the one
 * table both read ({@link ATTENTION_KINDS}).
 */
interface ElsewhereItem {
  key: string;
  item: BriefingItem & { kind: Exclude<AttentionKind, "gate-waiting"> };
  /** Which thing: the schedule (or pipeline phase) it is about. */
  title: string;
  /** What is wrong with it, after the kind's label. */
  detail: string;
}

/** An issue's detail is `<count>× across <schedules>` by contract. */
const ACROSS = /^(\d+)× across (.+)$/;

/** Above this many, the rest of the Briefing's list is a link, not more rows. */
const ELSEWHERE_SHOWN = 4;

/** A "Needs you" row's name, which says which thing: two lines on a phone
 *  rather than one cut short, like the detail line under it. */
const NEEDS_TITLE = "break-words text-sm font-semibold text-ink max-sm:line-clamp-2 sm:truncate";

/**
 * The Briefing's attention list minus what the board already says.
 *
 * Gates are the board's own rows. So is a failed pipeline, and its failure is
 * usually also an open issue "across <pipeline> · <phase>" — the same problem
 * counted twice made the inbox, the nav badge and the strip give three
 * different answers to one question. With that one issue folded into the
 * pipeline's row, the inbox counts what the Briefing counts.
 *
 * A failing monitor's issue is the same problem twice too ("Monitor failing"
 * and "Open issue", one schedule, two verbs), so it is folded into the
 * monitor's row, where it adds what failed and how often. Unlike the
 * pipeline's fold this one costs the count: the Briefing lists both, so this
 * list runs one short of its badge per monitor. One row per problem is the
 * better answer for a list of things to do.
 */
function elsewhereItems(
  briefing: BriefingItem[] | null | undefined,
  board: AttentionItem[],
): ElsewhereItem[] {
  if (!briefing) return [];
  // The issue's text names the pipeline, never a task: match the bare name.
  const failed = new Set(
    board.filter((i) => !i.gate.canApprove).map((i) => `${i.row.name} · ${i.phaseName}`),
  );
  const known = briefing.filter(
    // By the table rather than by "not a gate": a kind this build does not
    // know (a newer server) is left to the Briefing instead of drawn blank.
    (i): i is ElsewhereItem["item"] => i.kind !== "gate-waiting" && i.kind in ATTENTION_KINDS,
  );
  const monitors = new Set(
    known
      .filter((i) => i.kind === "monitor-down" || i.kind === "monitor-failing")
      .map((i) => i.title),
  );
  // A monitor's issue, by the one schedule it is across.
  const raised = new Map<string, { id: string; title: string; count: string }>();
  for (const i of known) {
    const across = i.kind === "issue-open" ? ACROSS.exec(i.detail) : null;
    if (across && monitors.has(across[2]) && !raised.has(across[2])) {
      raised.set(across[2], { id: i.id, title: i.title, count: across[1] });
    }
  }
  return known
    .filter((i) => {
      if (i.kind !== "issue-open") return true;
      const across = ACROSS.exec(i.detail)?.[2];
      return !(across && (failed.has(across) || raised.get(across)?.id === i.id));
    })
    .sort((a, b) => ATTENTION_KINDS[a.kind].rank - ATTENTION_KINDS[b.kind].rank)
    .map((item) => {
      // An issue is titled by where it happens, like every other row here, so
      // a failing schedule and the issue it raised read as the same thing.
      const across = item.kind === "issue-open" ? ACROSS.exec(item.detail) : null;
      const issue = item.kind === "issue-open" ? undefined : raised.get(item.title);
      return {
        key: `${item.kind}:${item.id}`,
        item,
        title: across ? across[2] : item.title,
        // An issue's title is its signature as recorded ("exit code 1"),
        // capitalised as the Issues page and the Briefing show it.
        detail: across
          ? `${sentenceStart(item.title)} · ${across[1]}×`
          : issue
            ? `${item.detail} · ${sentenceStart(issue.title)} · ${issue.count}×`
            : item.detail,
      };
    });
}

/**
 * "Needs you": every decision the board is waiting on, as one list above it.
 *
 * The board is sorted attention-first, but a card holds a whole pipeline and
 * shows one phase at a time, so a fan-out with two gates showed one of them,
 * and a waiting gate on the fourth card was below the fold. This is the inbox:
 * one row per gate or failure, the reason in a line, and the Review that opens
 * it — the same drawer, the same deep link, nothing decided here.
 *
 * Below the board's own rows come the Briefing's (see {@link elsewhereItems}),
 * so "what needs me" is answered on this page, not only behind the nav's badge.
 */
function AttentionQueue({
  items,
  elsewhere,
  partial,
  onOpen,
}: {
  items: AttentionItem[];
  elsewhere: ElsewhereItem[];
  /** The board did not load, so its gates and failures are missing here. */
  partial: boolean;
  onOpen: (item: AttentionItem, originY: number) => void;
}) {
  const [opening, open] = useOpener(onOpen);
  // Which row's Review is opening, so only that button says it is busy.
  const [pressed, setPressed] = useState<string | null>(null);
  const shown = useListPresence(items, (i) => i.key);
  const listed = elsewhere.slice(0, ELSEWHERE_SHOWN);
  const more = elsewhere.length - listed.length;
  const shownElsewhere = useListPresence(listed, (i) => i.key);
  if (shown.length === 0 && shownElsewhere.length === 0) return null;
  const waiting = items.filter((i) => i.gate.canApprove).length;
  const total = items.length + elsewhere.length;
  return (
    <section
      aria-labelledby="needs-you-heading"
      className="mb-4 overflow-hidden rounded-tile border border-await/30 bg-surface shadow-raised"
    >
      <div className="flex items-center gap-2.5 border-b border-line bg-await/[0.05] px-4 py-2.5">
        <h2 id="needs-you-heading" className="eyebrow !text-await">
          Needs you
        </h2>
        <span className="rounded-full bg-await/15 px-1.5 py-px text-micro font-semibold text-await">
          {total}
        </span>
        {/* The words of the strip and the card pills: one state, one name. */}
        <span className="ml-auto hidden text-caption text-ink-faint sm:inline">
          {[
            waiting > 0 && `${waiting} ${waiting === 1 ? "needs" : "need"} approval`,
            items.length > waiting && `${items.length - waiting} failed`,
            elsewhere.length > 0 && !partial && `${elsewhere.length} outside pipelines`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>
      {/* Said, rather than left to look complete: without the board, a
          pipeline's gates are missing and its failure can only show as the
          issue it raised. */}
      {partial && (
        <p className="flex items-center gap-2 border-b border-line px-4 py-2 text-caption text-ink-faint">
          <Icon name="info" size={14} className="shrink-0" />
          Pipeline gates and failures are missing until the board loads.
        </p>
      )}
      <ul className="divide-y divide-line">
        {shown.map(({ key, item, leaving }) => {
          const approve = item.gate.canApprove;
          const titleId = `needs-you-${key}`;
          return (
            <li
              key={key}
              inert={leaving}
              aria-hidden={leaving ? true : undefined}
              className={`flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 ${
                leaving
                  ? "motion-safe:animate-[fade-out_var(--duration-exit)_var(--ease-in-expo)_forwards]"
                  : "motion-safe:animate-[slide-up_var(--duration-base)_var(--ease-out-expo)_both]"
              }`}
            >
              <span
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                  approve ? "bg-await/12 text-await" : "bg-fail/12 text-fail"
                }`}
              >
                <Icon name={approve ? "approve" : "alert"} size={16} />
              </span>
              <div className="min-w-0 flex-1 basis-56">
                {/* One text node: pipeline and phase are one name here, "which
                    decision", not two facts to scan. */}
                <p
                  id={titleId}
                  title={`${rowTitle(item.row)} · ${item.phaseName}`}
                  className={NEEDS_TITLE}
                >
                  {`${rowTitle(item.row)} · ${item.phaseName}`}
                </p>
                {/* Two lines on a phone rather than one cut short: the end of a
                    failure reason is usually the error code, the part worth
                    reading. */}
                <p className="text-caption text-ink-dim max-sm:line-clamp-2 sm:truncate">
                  {approve ? (
                    item.gate.children ? (
                      "Tasks need a decision"
                    ) : (
                      "Needs approval"
                    )
                  ) : (
                    <span className="text-fail-ink">{item.reason ?? "This phase failed"}</span>
                  )}
                  {item.row.updatedAt && (
                    <span className="text-ink-faint">
                      {" · "}
                      <TimeAgo iso={item.row.updatedAt} />
                    </span>
                  )}
                </p>
              </div>
              <Button
                variant={approve ? "attention" : "secondary"}
                size="sm"
                iconRight="arrow-right"
                aria-describedby={titleId}
                aria-busy={(opening && pressed === key) || undefined}
                // Wrapped under the text on a phone, it lines up with the text.
                className="aria-busy:cursor-progress max-sm:ml-11"
                onClick={(e) => {
                  setPressed(key);
                  open(item, e.currentTarget.getBoundingClientRect().top);
                }}
              >
                Review
              </Button>
            </li>
          );
        })}
      </ul>
      {shownElsewhere.length > 0 && (
        <>
          {/* Not while the board is missing: a failed pipeline's issue would
              be filed here as outside pipelines. */}
          {!partial && (
            <h3 className="eyebrow border-y border-line bg-ground-2/40 px-4 py-1.5">
              Outside pipelines
            </h3>
          )}
          <ul className="divide-y divide-line">
            {shownElsewhere.map(({ key, item: entry, leaving }) => {
              const meta = ATTENTION_KINDS[entry.item.kind];
              // An id is one token: a schedule name in an anomaly key has spaces.
              const titleId = `needs-you-${key.replace(/[^\w:-]/g, "_")}`;
              return (
                <li
                  key={key}
                  inert={leaving}
                  aria-hidden={leaving ? true : undefined}
                  className={`flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 ${
                    leaving
                      ? "motion-safe:animate-[fade-out_var(--duration-exit)_var(--ease-in-expo)_forwards]"
                      : "motion-safe:animate-[slide-up_var(--duration-base)_var(--ease-out-expo)_both]"
                  }`}
                >
                  <span
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                      meta.tone === "await" ? "bg-await/12 text-await" : "bg-fail/12 text-fail"
                    }`}
                  >
                    <Icon name={meta.icon} size={16} />
                  </span>
                  <div className="min-w-0 flex-1 basis-56">
                    <p id={titleId} title={entry.title} className={NEEDS_TITLE}>
                      {entry.title}
                    </p>
                    <p className="text-caption text-ink-faint max-sm:line-clamp-2 sm:truncate">
                      <span className="text-ink-dim">{meta.label}</span>
                      {entry.detail && ` · ${entry.detail}`}
                      {entry.item.at && (
                        <>
                          {" · "}
                          <TimeAgo iso={entry.item.at} />
                        </>
                      )}
                    </p>
                  </div>
                  <ButtonLink
                    href={attentionHref(entry.item)}
                    size="sm"
                    iconRight="arrow-right"
                    aria-describedby={titleId}
                    className="max-sm:ml-11"
                  >
                    {meta.verb}
                  </ButtonLink>
                </li>
              );
            })}
          </ul>
          {more > 0 && (
            <a
              href="#/briefing"
              className="flex items-center justify-between border-t border-line px-4 py-2.5 text-small font-semibold text-ink-dim transition-colors duration-(--duration-quick) hover:bg-surface-2/60 hover:text-ink"
            >
              {`+${more} more in the Briefing`}
              <Icon name="arrow-right" size={15} />
            </a>
          )}
        </>
      )}
    </section>
  );
}

/**
 * The board before there is a board.
 *
 * A first run used to land on one grey sentence pointing at another tab. This
 * is the brand's one large appearance on the board — the iris, watching an
 * empty field — and the three ways to give it something to watch, ranked: a
 * one-off task is the fastest way to see Argus work, so it is the primary.
 */
function EmptyBoard({ canBuild }: { canBuild: boolean }) {
  return (
    <div className="flex flex-col items-center rounded-panel border border-line bg-surface px-6 py-14 text-center shadow-raised sm:py-20">
      <IrisMark size={72} />
      <h2 className="mt-6 text-title font-semibold text-ink">No pipelines defined yet</h2>
      <p className="mt-2 max-w-md text-small text-ink-dim">
        Argus is watching. Pipelines appear here as ordered phases of agent steps, with the gates
        where a human signs off. Start small: run one task now, put it on a schedule, or build a
        pipeline.
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <ButtonLink href="#/schedules/oneoff" variant="primary" icon="bolt">
          Launch a task
        </ButtonLink>
        <ButtonLink href="#/schedules" variant="secondary" icon="clock">
          New schedule
        </ButtonLink>
        <ButtonLink href="#/pipelines" variant="secondary" icon="pipeline">
          Build a pipeline
        </ButtonLink>
      </div>
      {!canBuild && (
        // Said before the click, not after it: the Pipelines page opens on an
        // account form, which is a surprise to someone who came to build.
        <p className="mt-4 text-caption text-ink-faint">
          Building a pipeline starts with an admin account — the Pipelines page sets it up.
        </p>
      )}
    </div>
  );
}

/**
 * A load error in the words that fit it. An answer means the server was
 * reached and the board request failed — the strip, the rail and the Live
 * pill are plainly still talking to it — so it says why; no answer at all
 * means the server was not reached.
 */
function boardError(error: string): { reached: boolean; message: string } {
  return { reached: error !== UNREACHABLE, message: loadError("the board", error) };
}

/**
 * The board while it cannot load and nothing was loaded before.
 *
 * Not the first-run board: "no pipelines defined yet" under a connection error
 * told a returning operator their pipelines were gone. The strip above says
 * what happened and offers the retry; this only holds the board's place.
 */
function BoardUnavailable({ reached }: { reached: boolean }) {
  return (
    <EmptyState compact icon="pipeline" title="The board didn't load">
      {reached
        ? "Argus keeps trying on its own, and Retry above asks again now."
        : "It shows here again once Argus is reachable."}
    </EmptyState>
  );
}

export default function CommandCenter({
  attention: briefingAttention = null,
}: {
  /**
   * The Briefing's attention list, which the shell already holds for the nav
   * badge. Optional: without it "Needs you" lists the board's own gates and
   * failures only.
   */
  attention?: BriefingItem[] | null;
} = {}) {
  const facet = useMachineFacet();
  const { overview, loading, error, approve, revise, abort, refresh } = useOverview();
  const { isAdmin } = useAuth();
  const { totals, loading: totalsLoading, reset } = useTotals();
  const { situation, loading: situationLoading } = useInsight();
  const { runs, loading: runsLoading, error: runsError, cancelRun } = useRuns();
  const [selected, setSelected] = useState<StepSelection | null>(null);
  const [stepEverOpened, setStepEverOpened] = useState(false);
  if (selected && !stepEverOpened) setStepEverOpened(true);
  const [pickedGate, setPickedGate] = useState<GateSelection | null>(null);
  const rows = useMemo(() => overview.flatMap(toOverviewRows), [overview]);
  // Fetch both drawers once the board is up and the browser idle, so the first
  // open rarely waits at all. A failed prefetch is the open's to retry.
  const hasBoard = rows.length > 0;
  useEffect(() => {
    if (!hasBoard) return;
    const prefetch = () => {
      loadStepDrawer().catch(() => {});
      loadGateDrawer().catch(() => {});
    };
    if (typeof requestIdleCallback === "function") {
      const id = requestIdleCallback(prefetch, { timeout: 2000 });
      return () => cancelIdleCallback(id);
    }
    const id = setTimeout(prefetch, 200);
    return () => clearTimeout(id);
  }, [hasBoard]);
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
    if (!row || row.orphaned) return null;
    const target = phaseId ? row.gates.find((g) => g.phaseId === phaseId) : row.gates[0];
    return target ? { instanceId, phaseId: target.phaseId, pipelineName: rowTitle(row) } : null;
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
  const attention = useMemo(() => attentionItems(rows), [rows]);
  const elsewhere = useMemo(
    () => elsewhereItems(briefingAttention, attention),
    [briefingAttention, attention],
  );
  // The board's order comes from the server and changes as pipelines start,
  // finish and gate. A card that teleports to its new row shows nothing; one that
  // glides there shows exactly what moved.
  const flip = useFlip();
  const liveActivity = useRunActivity();
  // The first-run board carries its own primary "Launch a task"; the header's
  // steps down beside it, so the page still has one thing to press first.
  const firstRun = !facet.peer && !loading && !error && rows.length === 0;
  const failure = error ? boardError(error) : null;

  return (
    <Page
      wide
      title="Command Center"
      actions={
        <>
          {/* This machine's spend, so not over another machine's board. */}
          {!facet.peer && <BoardTotal totals={totals} loading={totalsLoading} reset={reset} />}
          <ButtonLink
            href="#/schedules/oneoff"
            variant={firstRun ? "secondary" : "primary"}
            icon="bolt"
          >
            Launch a task
          </ButtonLink>
        </>
      }
    >
      <div aria-live="polite" role="status" className="sr-only">
        {announcement}
      </div>
      {/* Only a machine paired with others has a picker, a banner or a peer's
          board to draw, so that code is fetched when it does, not with the
          first paint of every solo install. */}
      {facet.machines.length > 1 && (
        <Suspense fallback={null}>
          <PeerControls facet={facet} />
        </Suspense>
      )}
      {!facet.peer && (
        <SituationStrip
          situation={situation}
          loading={situationLoading}
          attentionHref={gateHref(attention.find((i) => i.gate.canApprove))}
          failedHref={gateHref(attention.find((i) => !i.gate.canApprove))}
        />
      )}
      {failure && (
        <div className="mb-4">
          <AlertStrip
            subject="Board"
            message={failure.message}
            action={
              <Button size="sm" icon="retry" onClick={() => void refresh()}>
                Retry
              </Button>
            }
          />
        </div>
      )}
      {facet.peer ? (
        <Suspense fallback={null}>
          <PeerBoard facet={facet} />
        </Suspense>
      ) : (
        <Handoff
          busy={loading}
          label="the board"
          skeleton={
            <div className="flex flex-col gap-4">
              <SkeletonBoardCard phases={4} />
              <SkeletonBoardCard phases={3} />
            </div>
          }
        >
          {/* The rail sits beside the board on a wide display and below it on a
              narrow one — the board needs the horizontal room more than the rail
              does, so the rail is what moves. It stays when there are no
              pipelines too: a schedule or a one-off can be running regardless,
              and an empty board used to hide the only place that said so. */}
          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_300px] 2xl:grid-cols-[minmax(0,1fr)_340px]">
            <div className="flex min-w-0 flex-col gap-4">
              {/* Above the empty board too: a failing schedule needs a person
                  whether or not any pipeline exists. */}
              <AttentionQueue
                items={attention}
                elsewhere={elsewhere}
                partial={!!failure && rows.length === 0}
                onOpen={(item, originY) =>
                  setPickedGate({
                    instanceId: item.row.instanceId!,
                    phaseId: item.gate.phaseId,
                    pipelineName: rowTitle(item.row),
                    originY,
                  })
                }
              />
              {rows.length === 0 ? (
                failure ? (
                  <BoardUnavailable reached={failure.reached} />
                ) : (
                  <EmptyBoard canBuild={isAdmin} />
                )
              ) : (
                groups.map((group, i) => (
                  <Row
                    key={group[0].pipelineId}
                    ref={flip(group[0].pipelineId)}
                    index={i}
                    rows={group}
                    board={rows}
                    liveActivity={liveActivity}
                    onOpenStep={setSelected}
                    onOpenGate={setPickedGate}
                    onAbort={isAdmin ? abort : undefined}
                  />
                ))
              )}
            </div>
            <ActivityRail
              rows={rows}
              liveActivity={liveActivity}
              runs={runs}
              loading={runsLoading}
              // Its own request only: every run, pipeline steps included, is
              // in the run list, so a board that failed to load leaves the
              // rail whole — and it used to say "unknown until Argus is
              // reachable" while listing what the server had just sent.
              error={!!runsError}
            />
          </div>
        </Handoff>
      )}
      {/* The boundaries are always there and the drawers mount inside them:
          only a boundary that has already shown its content lets a transition
          keep the page as it is while what is new in it loads. One mounting
          with its drawer shows its fallback, transition or not. */}
      <Suspense fallback={null}>
        {stepEverOpened && (
          <StepDrawer
            selection={selected}
            onClose={() => setSelected(null)}
            onCancelRun={cancelRun}
          />
        )}
      </Suspense>
      <Suspense fallback={null}>
        {everOpened && (
          <GateDrawer
            selection={gate}
            onClose={closeGate}
            approve={approve}
            revise={revise}
            abort={abort}
            onOpen={setPickedGate}
            board={rows}
          />
        )}
      </Suspense>
    </Page>
  );
}
