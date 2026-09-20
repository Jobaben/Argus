import type { DsStatus } from "./status";
import { edgeViews, effectiveEdges, type RouteEdgeView } from "./routes";
import type {
  AgentRuntimeId,
  CandidateOutcome,
  DependencyEdge,
  VerificationReport,
  WorkspaceRecord,
  InstanceStatus,
  RouteDecision,
  PhaseStatus,
  StepStatus,
  PhaseProgress,
  PhaseDef,
  OverviewCost,
  OverviewEntry,
  PipelineInstance,
} from "../types";

export interface StepPill {
  name: string;
  runId: string | null;
  status: DsStatus;
  /** USD cost of the step's run, when reported. */
  costUsd: number | null;
  /** Total tokens of the step's run, when reported. */
  tokens: number | null;
  /** Model running the step: the run's recorded model when a run exists,
   *  otherwise the definition's step/pipeline model. Null = CLI default. */
  model: string | null;
  /** Agent CLI running the step, resolved the same way: the run's recorded
   *  runtime when a run exists, otherwise the step/phase/pipeline override.
   *  Null = the server default. */
  runtime: AgentRuntimeId | null;
  /** Latest live-activity label, while the step is running. */
  currentActivity: string | null;
  /** Run start time (ISO) for the elapsed ticker. */
  startedAt: string | null;
  /** Final run duration once the step ended. */
  durationMs: number | null;
  /** The isolated worktree the step's phase ran in, when it declared one.
   *  Carried onto the step because the drawer is where a run is explained. */
  workspace?: WorkspaceRecord | null;
  /**
   * Which candidate of a best-of-N phase this run is (0-based), and how many
   * there are. Null on an ordinary step, which is the whole of its own work.
   */
  candidate: { index: number; total: number } | null;
  /** This candidate's own checks: `true` passed, `false` failed, `null` still
   *  running or never reached. Always null on an ordinary step, which is
   *  verified phase-wide rather than per run. */
  verified: boolean | null;
  /** This candidate won its phase's selection. */
  selected: boolean;
  /**
   * This candidate was stopped because another one won.
   *
   * Distinct from `failed` on purpose: nothing went wrong with a superseded
   * draft, and a board that reports three failures inside a phase that
   * succeeded is a board that teaches people to ignore red.
   */
  superseded: boolean;
}

/** What a phase's candidates came to, for the one line a phase pill can spare. */
export interface CandidateSummary {
  total: number;
  verified: number;
  /** The winning candidate index, or null while the selection is open (or when
   *  no candidate could win). */
  selected: number | null;
}

export interface PhasePill {
  id: string;
  name: string;
  status: DsStatus;
  activeStep: string | null;
  steps: StepPill[];
  /** Failure reason from the phase payload, when the phase failed. */
  reason: string | null;
  /** Whether the phase waits for a human. */
  gated: boolean;
  /**
   * Phase ids this one waited for, carried through from the instance so the
   * board can draw the graph without also fetching the definition — which may
   * since have been edited into a different shape than the one that ran.
   */
  needs: string[];
  /** Attempt index (0 = first). Bumped by a revise and by an automatic retry. */
  attempt: number;
  /** When an automatic retry is due, while one is queued. */
  retryAt: string | null;
  /**
   * Terminal, deliberate, and not idle.
   *
   * Carried beside the status rather than folded into it: the DS status token
   * still reads `idle` (a skipped phase is quiet, and it borrows the quiet
   * colour), while the board says "skipped" in words — because "idle" tells a
   * reader the work is about to happen, which is the one thing that is false.
   */
  skipped?: boolean;
  /** Incoming edges with the condition that governs each, for route labels.
   *  Absent means the caller built a pill without a graph to read. */
  edges?: RouteEdgeView[];
  /** The route decision this phase's own result took, if it took one. */
  decision?: RouteDecision | null;
  /** Why this phase was skipped: the phase that decided, and on what grounds. */
  skipCause?: { source: string; label: string } | null;
  /** Best-of-N, summarised: how many drafts verified, and which one won. Null
   *  on an ordinary phase. */
  candidates?: CandidateSummary | null;
}

/**
 * One phase of a row waiting on a human: `awaiting-approval` (Approve + Revise)
 * or `failed` (Revise-only retry, since the engine's applyRevise also accepts a
 * failed instance). The board renders an opener per gate; the decision itself
 * is made in the review drawer, nowhere else.
 */
export interface OverviewGate {
  phaseId: string;
  canApprove: boolean;
}

export interface OverviewRow {
  pipelineId: string;
  name: string;
  badge: DsStatus;
  updatedAt: string | null;
  phases: PhasePill[];
  instanceId: string | null;
  /** Every phase waiting on a human; empty when nothing is. */
  gates: OverviewGate[];
  failure: { step: string | null; reason: string | null; kind: string | null } | null;
  /** Total spend of the latest run (all attempts); null when unknown. */
  cost: OverviewCost | null;
  /** The definition's pipeline-level model; null = CLI default. */
  model: string | null;
  /** Short instance id, set only when the pipeline has several concurrent
   *  instances on the board so their otherwise-identical cards can be told apart. */
  instanceLabel: string | null;
  /** How the latest/active instance was fired. Null when there is no instance
   *  yet (the "never run" row). */
  trigger: PipelineInstance["trigger"] | null;
}

const PHASE_STATUS_TO_DS: Record<PhaseStatus, DsStatus> = {
  pending: "idle",
  running: "working",
  "awaiting-approval": "await",
  succeeded: "done",
  skipped: "idle",
  failed: "failed",
  aborted: "stopped",
};

const STEP_STATUS_TO_DS: Record<StepStatus, DsStatus> = {
  pending: "queued",
  running: "working",
  succeeded: "done",
  skipped: "idle",
  failed: "failed",
  aborted: "stopped",
};

/** Upcoming phases report no step progress yet; tile them from the definition. */
const FALLBACK_STEP_STATUS: Record<PhaseStatus, DsStatus> = {
  pending: "queued",
  running: "working",
  "awaiting-approval": "done",
  succeeded: "done",
  skipped: "idle",
  failed: "failed",
  aborted: "stopped",
};

/** Whether one candidate's own checks have reported, and what they said. */
function verifiedOf(step: PhaseProgress["steps"][number]): boolean | null {
  const status = (step.verification as VerificationReport | undefined)?.status;
  if (status === "passed") return true;
  if (status === "failed") return false;
  return null;
}

function stepPills(
  phase: PhaseProgress,
  def: PhaseDef | undefined,
  defaultModel: string | null,
  defaultRuntime: AgentRuntimeId | null,
): StepPill[] {
  // A candidates phase runs `count` copies of one step, so the definition's
  // step list is read by candidate rather than by position — and the model and
  // runtime a candidate was launched with come from its variant first.
  const total = def?.candidates?.count ?? 0;
  const variants = def?.candidates?.variants ?? [];
  const variantOf = (i: number) => (variants.length ? variants[i % variants.length] : undefined);
  const defIndex = (i: number, candidate: number | undefined) => (candidate === undefined ? i : 0);
  const defModel = (i: number, candidate: number | undefined) =>
    (candidate === undefined ? undefined : variantOf(candidate)?.model) ??
    def?.steps[defIndex(i, candidate)]?.model ??
    defaultModel;
  const defRuntime = (i: number, candidate: number | undefined) =>
    (candidate === undefined ? undefined : variantOf(candidate)?.runtime) ??
    def?.steps[defIndex(i, candidate)]?.runtime ??
    def?.runtime ??
    defaultRuntime;
  if (phase.steps.length > 0) {
    // `count` on the definition can disagree with the attempt that actually ran
    // (an edit mid-flight); the attempt is what happened, so it wins.
    const ran = phase.steps.filter((s) => s.candidate !== undefined).length;
    return phase.steps.map((s, i) => ({
      name: s.name,
      runId: s.runId,
      status: STEP_STATUS_TO_DS[s.status],
      costUsd: s.costUsd ?? null,
      tokens: s.tokens ?? null,
      // Absent = no run record joined yet; fall back to the definition.
      model: s.model !== undefined ? s.model : defModel(i, s.candidate),
      runtime: s.runtime !== undefined ? s.runtime : defRuntime(i, s.candidate),
      currentActivity: s.currentActivity ?? null,
      startedAt: s.startedAt ?? null,
      durationMs: s.durationMs ?? null,
      candidate:
        s.candidate === undefined
          ? null
          : { index: s.candidate, total: Math.max(ran, total, s.candidate + 1) },
      verified: verifiedOf(s),
      selected: s.candidate !== undefined && phase.selectedCandidate === s.candidate,
      // A draft stopped because a sibling won. Only ever true once a winner
      // exists, so a candidate killed by an abort still reads as stopped.
      superseded:
        s.candidate !== undefined &&
        s.status === "aborted" &&
        phase.selectedCandidate != null &&
        phase.selectedCandidate !== s.candidate,
      // Only when there is one: a step of a phase that ran in its own cwd has
      // no workspace to speak of, and an always-present null would say it did.
      // A candidate carries its own tree; everyone else shares the phase's.
      ...(s.workspace
        ? { workspace: s.workspace }
        : phase.workspace
          ? { workspace: phase.workspace }
          : {}),
    }));
  }
  // A phase that has not started yet: one tile per declared step, or one per
  // planned candidate, so the board shows what is about to happen.
  const upcoming: StepPill[] =
    total > 0 && def?.steps[0]
      ? Array.from({ length: total }, (_, i) => ({
          name: def.steps[0].name,
          runId: null,
          status: FALLBACK_STEP_STATUS[phase.status],
          costUsd: null,
          tokens: null,
          model: variantOf(i)?.model ?? def.steps[0].model ?? defaultModel,
          runtime: variantOf(i)?.runtime ?? def.steps[0].runtime ?? def.runtime ?? defaultRuntime,
          currentActivity: null,
          startedAt: null,
          durationMs: null,
          candidate: { index: i, total },
          verified: null,
          selected: false,
          superseded: false,
          ...(phase.workspace ? { workspace: phase.workspace } : {}),
        }))
      : (def?.steps ?? []).map((s) => ({
          name: s.name,
          runId: null,
          status: FALLBACK_STEP_STATUS[phase.status],
          costUsd: null,
          tokens: null,
          model: s.model ?? defaultModel,
          runtime: s.runtime ?? def?.runtime ?? defaultRuntime,
          currentActivity: null,
          startedAt: null,
          durationMs: null,
          candidate: null,
          verified: null,
          selected: false,
          superseded: false,
          ...(phase.workspace ? { workspace: phase.workspace } : {}),
        }));
  return upcoming;
}

/**
 * Best-of-N in one line: how many drafts cleared the checks, and which one the
 * phase kept.
 *
 * Read from the live steps while the phase runs and from the recorded outcomes
 * once it has settled — the losers' step records survive, but the outcomes are
 * what the phase itself decided, and they are the honest source after the fact.
 */
function candidateSummary(
  phase: PhaseProgress,
  def: PhaseDef | undefined,
): CandidateSummary | null {
  const outcomes = (phase.candidateOutcomes ?? []) as CandidateOutcome[];
  const running = phase.steps.filter((s) => s.candidate !== undefined);
  if (outcomes.length === 0 && running.length === 0 && !def?.candidates) return null;
  if (outcomes.length > 0) {
    return {
      total: outcomes.length,
      verified: outcomes.filter((o) => o.verified === true).length,
      selected: phase.selectedCandidate ?? null,
    };
  }
  if (running.length === 0) {
    return { total: def?.candidates?.count ?? 0, verified: 0, selected: null };
  }
  return {
    total: running.length,
    verified: running.filter((s) => verifiedOf(s) === true).length,
    selected: phase.selectedCandidate ?? null,
  };
}

const INSTANCE_BADGE: Record<InstanceStatus, DsStatus> = {
  running: "working",
  "awaiting-approval": "await",
  failed: "failed",
  succeeded: "done",
  aborted: "stopped",
};

function activeStepName(phase: PhaseProgress): string | null {
  if (phase.status !== "running") return null;
  return phase.steps.find((s) => s.status === "running")?.name ?? null;
}

function gatesFor(latest: OverviewEntry["latest"]): OverviewGate[] {
  if (!latest) return [];
  if (latest.status === "awaiting-approval") {
    return latest.phases
      .filter((p) => p.status === "awaiting-approval")
      .map((p) => ({ phaseId: p.id, canApprove: true }));
  }
  if (latest.status === "failed") {
    return latest.phases
      .filter((p) => p.status === "failed")
      .map((p) => ({ phaseId: p.id, canApprove: false }));
  }
  return [];
}

function extractReason(payload: unknown): string | null {
  if (typeof payload === "string") return payload.trim() || null;
  if (payload && typeof payload === "object" && "reason" in payload) {
    const r = (payload as { reason: unknown }).reason;
    return typeof r === "string" ? r.trim() || null : null;
  }
  return null;
}

function extractKind(payload: unknown): string | null {
  if (payload && typeof payload === "object" && "kind" in payload) {
    const k = (payload as { kind: unknown }).kind;
    return typeof k === "string" ? k : null;
  }
  return null;
}

function failureFor(latest: PipelineInstance): OverviewRow["failure"] {
  if (latest.status !== "failed") return null;
  const phase = latest.phases.find((p) => p.status === "failed");
  if (!phase) return null;
  const failed = phase.steps.filter((s) => s.status === "failed").map((s) => s.name);
  const step = failed.length ? failed.join(", ") : phase.name;
  return { step, reason: extractReason(phase.payload), kind: extractKind(phase.payload) };
}

/**
 * Why a phase was skipped.
 *
 * Two shapes, and the difference is the whole explanation: a decision named
 * this phase (so the condition on its own incoming edge is what did not match),
 * or the branch above it was cancelled and the skip simply travelled down.
 */
function skipCauseFor(
  phase: PhaseProgress,
  edges: RouteEdgeView[],
  decisions: RouteDecision[],
  statusById: Map<string, PhaseStatus>,
): PhasePill["skipCause"] {
  if (phase.status !== "skipped") return null;
  const decided = decisions.find((d) => d.skipped.includes(phase.id));
  if (decided) {
    const edge = edges.find((e) => e.phase === decided.sourcePhase);
    return { source: decided.sourcePhase, label: edge?.label ?? "not selected" };
  }
  const upstream = edges.find((e) => statusById.get(e.phase) === "skipped");
  return upstream ? { source: upstream.phase, label: "was skipped too" } : null;
}

function instanceRow(
  live: OverviewEntry["definition"],
  instance: PipelineInstance,
  cost: OverviewCost | null,
): OverviewRow {
  // What the instance actually runs: the definition it snapshotted when it
  // started. The live one may since have been edited, and labelling running
  // work with prompts and models it is not using would be a lie. An instance
  // from before the snapshot existed reads the live definition, as it always
  // did; a phase that definition no longer has falls back to its recorded
  // edges — a mid-flight edit costs the labels, never the graph.
  const definition = instance.definition ?? live;
  const defEdges = effectiveEdges(definition.phases);
  const decisions = instance.routeDecisions ?? [];
  const statusById = new Map(instance.phases.map((p) => [p.id, p.status]));
  const edgesFor = (p: PhaseProgress): DependencyEdge[] =>
    defEdges.get(p.id) ?? (p.needs ?? []).map((phase) => ({ phase }));
  const phases: PhasePill[] = instance.phases.map((p) => ({
    id: p.id,
    name: p.name,
    status: PHASE_STATUS_TO_DS[p.status],
    activeStep: activeStepName(p),
    steps: stepPills(
      p,
      definition.phases.find((d) => d.id === p.id),
      definition.model ?? null,
      definition.runtime ?? null,
    ),
    reason: p.status === "failed" ? extractReason(p.payload) : null,
    gated: p.gated,
    needs: p.needs ?? [],
    attempt: p.attempt,
    retryAt: p.retryAt ?? null,
    skipped: p.status === "skipped",
    edges: edgeViews(edgesFor(p)),
    decision: decisions.find((d) => d.sourcePhase === p.id) ?? null,
    skipCause: skipCauseFor(p, edgeViews(edgesFor(p)), decisions, statusById),
    candidates: candidateSummary(
      p,
      definition.phases.find((d) => d.id === p.id),
    ),
  }));

  return {
    // The row still belongs to the live pipeline's card, whatever it is called now.
    pipelineId: live.id,
    name: live.name,
    badge: INSTANCE_BADGE[instance.status],
    updatedAt: instance.updatedAt,
    phases,
    instanceId: instance.id,
    gates: gatesFor(instance),
    failure: failureFor(instance),
    cost,
    model: definition.model ?? null,
    instanceLabel: null,
    trigger: instance.trigger,
  };
}

export function toOverviewRow(entry: OverviewEntry): OverviewRow {
  const { definition, latest } = entry;

  if (!latest) {
    const edges = effectiveEdges(definition.phases);
    return {
      pipelineId: definition.id,
      name: definition.name,
      badge: "idle",
      updatedAt: null,
      phases: definition.phases.map((p) => ({
        id: p.id,
        name: p.name,
        status: "idle" as const,
        activeStep: null,
        steps: (p.candidates
          ? Array.from({ length: p.candidates.count }, (_, i) => ({
              step: p.steps[0],
              candidate: { index: i, total: p.candidates!.count },
              variant: p.candidates!.variants?.length
                ? p.candidates!.variants[i % p.candidates!.variants.length]
                : undefined,
            }))
          : p.steps.map((step) => ({ step, candidate: null, variant: undefined }))
        ).map(({ step: s, candidate, variant }) => ({
          name: s.name,
          runId: null,
          status: "idle" as const,
          costUsd: null,
          tokens: null,
          model: variant?.model ?? s.model ?? definition.model ?? null,
          runtime: variant?.runtime ?? s.runtime ?? p.runtime ?? definition.runtime ?? null,
          currentActivity: null,
          startedAt: null,
          durationMs: null,
          candidate,
          verified: null,
          selected: false,
          superseded: false,
        })),
        reason: null,
        gated: p.gated,
        // A pipeline that has never run has no instance to carry resolved
        // edges, so they are resolved from the definition here — same rule as
        // the server: no phase declaring `needs` means linear.
        needs: (edges.get(p.id) ?? []).map((edge) => edge.phase),
        attempt: 0,
        retryAt: null,
        skipped: false,
        edges: edgeViews(edges.get(p.id) ?? []),
        decision: null,
        skipCause: null,
        candidates: p.candidates
          ? { total: p.candidates.count, verified: 0, selected: null }
          : null,
      })),
      instanceId: null,
      gates: [],
      failure: null,
      cost: null,
      model: definition.model ?? null,
      instanceLabel: null,
      trigger: null,
    };
  }

  return instanceRow(definition, latest, entry.cost ?? null);
}

/**
 * One row per concurrent instance. With overlapPolicy "allow" a pipeline can
 * have several active instances; each gets its own card (labelled with a short
 * instance id when there is more than one). With no active instance, falls
 * back to the single latest-instance row, exactly as before.
 */
export function toOverviewRows(entry: OverviewEntry): OverviewRow[] {
  const active = entry.active ?? [];
  if (active.length === 0) return [toOverviewRow(entry)];
  return active.map((a) => ({
    ...instanceRow(entry.definition, a.instance, a.cost),
    instanceLabel: active.length > 1 ? a.instance.id.slice(0, 8) : null,
  }));
}
