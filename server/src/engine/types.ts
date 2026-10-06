import type { PreparedInvocation } from "../harness/invocation.js";
import type { SignalBinding } from "../harness/signalToken.js";
import type { ResolvedKnowledgeContext } from "../knowledge/context.js";
import { readTransitionLog } from "../transitionLog/store.js";
import type { AppendOutcome } from "../transitionLog/store.js";
import type {
  TransitionRecord,
  GateDecision,
  GateDecisionChannel,
  GateDecisionPrincipal,
  AcceptanceCriterion,
  AcceptedChangeProposal,
  AgentRuntimeId,
  ChangeRealization,
  ChangeRequest,
  ChangeRuleState,
  ClaimRef,
  ImplementationScope,
  KnowledgeDelta,
  RemediationContext,
  StepKnowledgeDelta,
} from "@argus/contracts";
import type { PipelineProcessHandle } from "../pipelineProcess.js";
import type { Run } from "../sources/scheduleTypes.js";
import type {
  PhaseDef,
  PhaseStep,
  RetryableClass,
  WorkspaceRecord,
  PipelineDefinition,
  PipelineInstance,
  PipelineSignal,
} from "../sources/pipelineTypes.js";
import type { TransitionResult } from "../pipelineTransitions.js";

/**
 * One run of one step, planned but not yet launched.
 *
 * A candidates phase plans `count` of these from a single `stepDef`, each with
 * a worktree, an artifact directory and a baseline of its own — which is why
 * the per-run context is a record here rather than being derived from the
 * phase at launch time.
 */
export interface PlannedRun {
  stepDef: PhaseStep;
  run: Run;
  publishes: boolean;
  timeoutSeconds: number | null;
  /** Which candidate this run is, on a `candidates` phase. */
  candidate: number | undefined;
  artifactDir: string;
  workspace: WorkspaceRecord | null;
  /** Full values of any placeholder {@link interpolate} trimmed, for the
   *  engine to write under this run's invocation directory. */
  contextFiles: { path: string; contents: string }[];
  /** The semantic context this run receives, resolved at planning against
   *  the attempt's one ledger snapshot. Null = the step declares none. */
  knowledgeContext: PlannedKnowledgeContext | null;
  /** The change-intent input this run receives, resolved at planning. Null =
   *  the phase is not a change-intent phase. */
  changeIntent: PlannedChangeIntent | null;
  /** The accepted change proposal this run implements, resolved at planning
   *  from the ledger. Null = the phase declares no `changeContext`. */
  changeContext: PlannedChangeContext | null;
  /** The change realization this run is an attempt of (Phase 8). Null = the
   *  phase declares no `implementation`. */
  realization: PlannedRealization | null;
  /** The acceptance criteria this run must answer for (Phase 8). Null = the
   *  phase declares no `acceptanceVerification`. */
  acceptance: PlannedAcceptance | null;
  /** This run's own signal token, held in memory only until it is handed to
   *  the process. Null = its runtime has no signal hook, so it gets none. */
  signalToken: string | null;
}

/**
 * An implementation phase attempt's realization (Phase 8): the durable record
 * it belongs to, which attempt it is, the deterministic scope its agent
 * receives, and — from attempt 2 — exactly what the previous attempt left
 * unmet. Or the reason the attempt may not start at all: a stale semantic
 * target, an exhausted attempt budget, an unusable accepted proposal.
 */
export type PlannedRealization =
  | {
      realization: ChangeRealization;
      attempt: number;
      kind: "implementation" | "remediation";
      scope: ImplementationScope;
      scopeText: string;
      remediation: { context: RemediationContext; text: string } | null;
    }
  | { error: string };

/** An acceptance-verification phase attempt's accountability (Phase 8): which
 *  accepted proposal, and every criterion of it. */
export type PlannedAcceptance = { proposalId: string; required: AcceptanceCriterion[] };

/**
 * A step's `knowledgeContext` after resolution against the phase attempt's
 * ledger snapshot: the frozen document, or the reason it could not be built
 * (an unknown claim or revision), which fails the step as `configuration`
 * before any process starts. Resolved once per attempt, at planning, so every
 * run of the attempt saw the same ledger and the prompt can name what the
 * run will find in the file.
 */
export type PlannedKnowledgeContext = { resolved: ResolvedKnowledgeContext } | { error: string };

/**
 * A change-intent phase's input after resolution (Phase 7): the frozen
 * request, the rules the run is accountable for with their current
 * conformance, and the document Argus materializes for it — or the reason no
 * request could be resolved, which fails the step as `configuration` before
 * any process starts. A phase whose author declared `changeIntent` and whose
 * instance supplied no request is a definition that cannot run, not a run
 * that should invent one.
 */
export type PlannedChangeIntent =
  | { request: ChangeRequest; selected: ClaimRef[]; relevant: ChangeRuleState[]; text: string }
  | { error: string };

/**
 * A downstream phase's accepted change intent after resolution (Phase 7): the
 * approved proposal and the document Argus materializes for it, or the reason
 * it could not be resolved — no accepted proposal for the named phase (one is
 * still staged at its gate, or the phase committed none), or one that is not
 * implementation-ready. Both refuse the launch rather than letting an
 * implementation run proceed on unapproved or unfinished intent.
 */
export type PlannedChangeContext =
  { accepted: AcceptedChangeProposal; text: string } | { error: string };

export type PipelineSpawnFn = (
  run: Run,
  logPath: string,
  env: Record<string, string>,
  /**
   * The invocation as the harness prepared it: argv, materialized config and
   * the *complete* child environment with the step's policy applied. The real
   * spawn uses exactly this; a test double may ignore it.
   */
  prepared?: PreparedInvocation,
) => PipelineProcessHandle | Promise<PipelineProcessHandle>;

export interface EngineDeps {
  now: () => Date;
  newId: () => string;
  spawn: PipelineSpawnFn;
  signalUrlBase: string;
  maxConcurrent: number;
  tickMs?: number;
  onChange?: () => void;
  /** Called when an instance reaches the 'failed' state (failure notifications). */
  onFailure?: (inst: PipelineInstance) => void;
  /** Optional pre-run guard. When it returns { ok: false }, start() throws PreflightError. */
  preflight?: () => Promise<{ ok: boolean; reasons: string[] }>;
  /** Kills a run's process tree; injectable for tests. Defaults to killRunProcess. */
  kill?: (pid: number, signal?: NodeJS.Signals) => Promise<boolean> | boolean;
  /**
   * Makes a gate decision durable before the transition it causes is saved.
   * Must throw when the record could not be written — the engine then refuses
   * the decision rather than letting it take effect unrecorded. Injectable for
   * tests; defaults to the append-only `gate-decisions.jsonl`.
   */
  recordGateDecision?: (decision: GateDecision) => Promise<void>;
  /**
   * Test seam for deterministic fault injection: called at each effect
   * boundary of a gate decision. A probe that throws simulates the process
   * failing at exactly that point. Never set in production.
   */
  gateEffectProbe?: (point: GateEffectPoint, instanceId: string) => Promise<void> | void;
  /** The environment step env policies are applied to. Defaults to process.env. */
  parentEnv?: NodeJS.ProcessEnv;
  /**
   * The transition log's storage seams, for fault injection: an append that
   * fails or is capped, a log that reads back damaged. Default: the real
   * per-instance log (`transitionLog/store.ts`).
   */
  transitionLog?: {
    append?: (record: TransitionRecord) => Promise<AppendOutcome>;
    readLog?: typeof readTransitionLog;
    /** Replaces instance publication (`writeInstance`), so a test can fail
     *  the commit point itself. */
    publish?: (inst: PipelineInstance) => Promise<void>;
  };
  /**
   * Told when a save changes pipeline status that no recorded transition
   * accounts for. Default: a warning in the log. Tests make it throw, so a
   * forgotten transition fails the suite rather than going unnoticed.
   */
  onUnattributedTransition?: (instanceId: string, changes: string[]) => void;
  /** Source of per-run signal tokens, given what the token will be bound to.
   *  Defaults to 256 random bits (the binding is unused); injectable so tests
   *  can name the token a run was given. */
  newSignalToken?: (binding: SignalBinding) => string;
  /** Grace between the deadline's SIGTERM and a SIGKILL escalation. */
  killGraceMs?: number;
  /** Live-activity tailer; told when step runs start and end, and under which
   *  runtime so it reads the log in that CLI's event vocabulary. */
  tailer?: {
    track(runId: string, instanceId: string, runtime?: AgentRuntimeId | null): void;
    untrack(runId: string): void;
    /** This process's most recent observed activity per tracked run, for
     *  stall detection. Optional so existing test doubles need not implement
     *  it; absent means every stall check falls back to `startedAt`. */
    latest?(): Map<string, { at: string }>;
  };
}

export interface ActionResult {
  ok: boolean;
  code: number;
  /** Human-readable reason on the failure paths (404/409), for surfacing to a client. */
  error?: string;
}

/** The effect boundaries {@link EngineDeps.gateEffectProbe} is called at. */
export type GateEffectPoint =
  | "revise:recorded"
  | "revise:linked"
  | "revise:superseded"
  | "revise:killed"
  | "revise:saved"
  | "abort:recorded"
  | "abort:linked"
  | "abort:killed"
  | "abort:realizations-settled"
  | "abort:saved"
  | "approve:validated"
  | "approve:recorded"
  | "approve:linked"
  | "approve:knowledge-settled"
  | "approve:realizations-settled"
  | "approve:saved";

/** Which paused phase a gate action means, when more than one could be. */
export interface GateTarget {
  phaseId?: string;
  /**
   * The attempt the caller decided on. When given, the action is refused if
   * the phase has moved to another attempt since — the decision was about work
   * that is no longer the work waiting at the gate.
   */
  attempt?: number;
  /**
   * Where the decision came from, established by the caller's own trusted
   * code (the HTTP route reads the authenticated session) — never from a
   * request body. Absent = an in-process caller that did not say, recorded as
   * `unspecified` / `unknown` rather than guessed.
   */
  source?: OperatorSource;
}

/** A person-facing channel's account of who asked. Operators only: an
 *  automated rule never approves through {@link Engine.approve}. */
export interface OperatorSource {
  channel: Exclude<GateDecisionChannel, "verdict-watcher">;
  principal: GateDecisionPrincipal;
}

/**
 * An automated approval request: the exact phase attempt, the exact runs of
 * that attempt, and the exact verdicts it rests on. The engine re-checks every
 * part of it under the instance lock, because the watcher read all of it
 * outside that lock and a human may have revised the phase since.
 */
export interface AutomatedApproval {
  instanceId: string;
  phaseId: string;
  attempt: number;
  runIds: string[];
  /**
   * The proposed basis: which stored verdict the caller believes is each
   * run's current one. Identity only — everything recorded about a verdict is
   * read from the verdict store, and any other field here is ignored.
   */
  verdicts: Array<{ runId: string; verdictId: string | null }>;
  /**
   * The proposed trajectory basis, kept apart from `verdicts`: required —
   * one entry per relevant run — when the phase's rubric declares a
   * trajectory, and refused when it does not. Identity only, like `verdicts`.
   */
  trajectoryVerdicts?: Array<{ runId: string; verdictId: string | null }>;
}

export interface Engine {
  start(
    pipelineId: string,
    trigger?: PipelineInstance["trigger"],
    /** Set for `trigger: "webhook"` (the request body) or `"chained"` (the
     *  source instance's outcome) — omitted for `"manual"`/`"scheduled"`. */
    firing?: { triggerPayload?: unknown; chainedFrom?: string },
  ): Promise<PipelineInstance | null>;
  onSignal(instanceId: string, signal: PipelineSignal): Promise<ActionResult>;
  /** Open a gate. `phaseId` names which paused phase when a fan-out has more
   *  than one waiting; absent, the single paused phase is meant. */
  approve(instanceId: string, answers?: unknown, options?: GateTarget): Promise<ActionResult>;
  /**
   * Open a gate because an automated rule (a Verdict score clearing the
   * phase's `autoApprove` bar) says it may. Refused, whatever the score, when
   * the gate would commit knowledge — see `sources/gatePolicy.ts`.
   */
  approveAutomatically(request: AutomatedApproval): Promise<ActionResult>;
  /** Send a paused phase back to its agent with the human's note. */
  revise(instanceId: string, note?: string, options?: GateTarget): Promise<ActionResult>;
  abort(instanceId: string, options?: { source?: OperatorSource }): Promise<ActionResult>;
  reconcile(): Promise<void>;
  /** On boot: claim still-alive runs from running instances so they keep
   *  their concurrency slots and get finalized by reconcile when they end. */
  adopt(): Promise<void>;
  /**
   * Resolves once every piece of detached work the engine has queued — phase
   * launches deferred off a signal, verifications, deadline handlers — has
   * settled. For an orderly shutdown, and for tests that must observe the
   * state a transition leads to rather than the one it left.
   */
  drain(): Promise<void>;
}

export interface LaunchContext {
  def: PipelineDefinition;
  phaseDef: PhaseDef;
  stepDef: PhaseStep;
  inst: PipelineInstance;
  publishes: boolean;
  artifactDir: string;
  timeoutSeconds: number | null;
  gitHead: string | null;
  /** The worktree the step runs in, when its phase declared a policy. */
  workspace: WorkspaceRecord | null;
  /** This pipeline's durable-notes directory, when `memory` is enabled. */
  memoryDir: string | null;
  /** Full values of any placeholder {@link interpolate} trimmed for this
   *  run's prompt, to write under its own invocation directory. */
  contextFiles: { path: string; contents: string }[];
  /** The run's semantic context as planned, or null for a step without one. */
  knowledgeContext: PlannedKnowledgeContext | null;
  /** The run's change-intent input as planned (Phase 7), or null. */
  changeIntent: PlannedChangeIntent | null;
  /** The accepted change intent this run implements, or null. */
  changeContext: PlannedChangeContext | null;
  /** The realization this run is an attempt of (Phase 8), or null. */
  realization: PlannedRealization | null;
  /** The acceptance criteria this run must answer for (Phase 8), or null. */
  acceptance: PlannedAcceptance | null;
  /** The run's own signal token, or null when its runtime has no hook. */
  signalToken: string | null;
}

export type Launched =
  { handle: PipelineProcessHandle } | { failure: "spawn" | "configuration"; reason: string };

export type Intake =
  | { ok: true; staged: StepKnowledgeDelta | null }
  | { ok: false; reason: string; failure: RetryableClass };

// ── Change intent (Phase 7) ────────────────────────────────────────────────
//
// The same three moments again, on their own channel:
//
//   intake   — a change-intent run completed; its proposal is read, validated
//              against the request and the rules Argus supplied it, and
//              staged beside the run. Its `semanticDelta` is handed to the
//              KnowledgeDelta intake, so the semantic half is staged by
//              exactly the Phase 3 machinery and there is still one path to
//              canonical;
//   commit   — the phase crossed every acceptance condition; the proposal's
//              delta and the durable record of the request that caused it are
//              written in the *same* ledger transition, or neither is;
//   retire   — an attempt failed, was revised, was aborted, or lost a
//              selection; its staged proposal is superseded and can never
//              become canonical.
//
// What a change proposal never does, at any of the three: become canonical
// without a person, or let the implementation's current behaviour stand in
// for what the business intends.

export type ProposalIntake =
  | {
      ok: true;
      /** The proposal's semantic half, for the delta intake. Absent when the
       *  phase is not a change-intent phase. */
      semanticDelta?: KnowledgeDelta;
      /** The run whose staged proposal must be bound to the delta. */
      recordRunId?: string;
    }
  | { ok: false; reason: string; failure: RetryableClass };

export interface Continued {
  instance: PipelineInstance;
  startPhases: number[];
  suffix?: string;
  routing?: TransitionResult["routing"];
}
