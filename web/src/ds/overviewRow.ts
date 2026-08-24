import type { DsStatus } from "./status";
import { edgeViews, effectiveEdges, type RouteEdgeView } from "./routes";
import type {
  AgentRuntimeId,
  DependencyEdge,
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
}

/**
 * The actionable gate for a row. Present when the instance is paused awaiting a
 * human: `awaiting-approval` (Approve + Revise) or `failed` (Revise-only retry,
 * since the engine's applyRevise also accepts a failed instance).
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
  gate: OverviewGate | null;
  failure: { step: string | null; reason: string | null; kind: string | null } | null;
  /** Total spend of the latest run (all attempts); null when unknown. */
  cost: OverviewCost | null;
  /** The definition's pipeline-level model; null = CLI default. */
  model: string | null;
  /** Short instance id, set only when the pipeline has several concurrent
   *  instances on the board so their otherwise-identical cards can be told apart. */
  instanceLabel: string | null;
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

function stepPills(
  phase: PhaseProgress,
  def: PhaseDef | undefined,
  defaultModel: string | null,
  defaultRuntime: AgentRuntimeId | null,
): StepPill[] {
  // Definition model/runtime for a step, by position (progress steps are
  // created from the definition's step list in order). The runtime chain
  // mirrors the engine's: step, then phase, then pipeline.
  const defModel = (i: number) => def?.steps[i]?.model ?? defaultModel;
  const defRuntime = (i: number) => def?.steps[i]?.runtime ?? def?.runtime ?? defaultRuntime;
  if (phase.steps.length > 0) {
    return phase.steps.map((s, i) => ({
      name: s.name,
      runId: s.runId,
      status: STEP_STATUS_TO_DS[s.status],
      costUsd: s.costUsd ?? null,
      tokens: s.tokens ?? null,
      // Absent = no run record joined yet; fall back to the definition.
      model: s.model !== undefined ? s.model : defModel(i),
      runtime: s.runtime !== undefined ? s.runtime : defRuntime(i),
      currentActivity: s.currentActivity ?? null,
      startedAt: s.startedAt ?? null,
      durationMs: s.durationMs ?? null,
    }));
  }
  return (def?.steps ?? []).map((s) => ({
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
  }));
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

function gateFor(latest: OverviewEntry["latest"]): OverviewGate | null {
  if (!latest) return null;
  if (latest.status === "awaiting-approval") {
    const phase = latest.phases.find((p) => p.status === "awaiting-approval");
    if (phase) return { phaseId: phase.id, canApprove: true };
  }
  if (latest.status === "failed") {
    const phase = latest.phases.find((p) => p.status === "failed");
    if (phase) return { phaseId: phase.id, canApprove: false };
  }
  return null;
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
  definition: OverviewEntry["definition"],
  instance: PipelineInstance,
  cost: OverviewCost | null,
): OverviewRow {
  // Conditions live in the definition; the instance carries only resolved ids.
  // A phase the definition no longer has falls back to its recorded edges —
  // a mid-flight edit costs the labels, never the graph.
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
  }));

  return {
    pipelineId: definition.id,
    name: definition.name,
    badge: INSTANCE_BADGE[instance.status],
    updatedAt: instance.updatedAt,
    phases,
    instanceId: instance.id,
    gate: gateFor(instance),
    failure: failureFor(instance),
    cost,
    model: definition.model ?? null,
    instanceLabel: null,
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
        steps: p.steps.map((s) => ({
          name: s.name,
          runId: null,
          status: "idle" as const,
          costUsd: null,
          tokens: null,
          model: s.model ?? definition.model ?? null,
          runtime: s.runtime ?? p.runtime ?? definition.runtime ?? null,
          currentActivity: null,
          startedAt: null,
          durationMs: null,
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
      })),
      instanceId: null,
      gate: null,
      failure: null,
      cost: null,
      model: definition.model ?? null,
      instanceLabel: null,
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
