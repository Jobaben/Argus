import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  encodeProject,
  killRunProcess,
  patchRun,
  readInvocation,
  readRun,
  readRunResult,
  runInvocationDir,
  runLogPath,
  runResultPath,
  writeInvocation,
  writeRun,
} from "./sources/runs.js";
import { paths } from "./claudeHome.js";
import { atomicWriteJson } from "./sources/atomicWrite.js";
import {
  candidateArtifactDir,
  phaseArtifactDir,
  phaseBaselinePath,
  prepareInvocation,
  readGitHead,
  resolveCapabilities,
  resolveTimeoutSeconds,
} from "./harness/invocation.js";
import type { PreparedInvocation } from "./harness/invocation.js";
import { buildChildEnv } from "./harness/childEnv.js";
import { checkLabel, runChecks, snapshotWorkingTree } from "./harness/verification.js";
import type { WorkingTreeSnapshot } from "./harness/verification.js";
import {
  createWorktree,
  plannedRemovals,
  removeWorktree,
  workspacePolicyFor,
  workspaceTarget,
} from "./harness/workspace.js";
import {
  DEFAULT_MEMORY_BYTES,
  ensureMemoryDir,
  isSettled,
  memoryDirFor,
  readMemoryNotes,
  summarizeInstance,
  trimMemoryIfNeeded,
} from "./harness/memory.js";
import { isStalled, resolveStallSeconds } from "./harness/stall.js";
import { KnowledgeDeltaError, isEmptyDelta, parseKnowledgeDelta } from "./knowledge/delta.js";
import { validArtifactPath } from "./knowledge/kernel.js";
import type { DeltaProposal } from "./knowledge/delta.js";
import type { VerificationProposal } from "./knowledge/store.js";
import {
  commitPhaseSemantics,
  preflightKnowledgeDeltas,
  registerSuppliedContext,
} from "./knowledge/store.js";
import {
  ensureKnowledgeDeltaDir,
  knowledgeDeltaFile,
  readAgentDelta,
  readDeltaRecord,
  updateDeltaStatus,
  writeDeltaRecord,
} from "./knowledge/staging.js";
import {
  KnowledgeContextError,
  describeIntegrityFailure,
  effectiveContextSpec,
  knowledgeContextFile,
  resolveKnowledgeContext,
  verifyKnowledgeContextIntegrity,
  writeKnowledgeContextFile,
} from "./knowledge/context.js";
import type { ResolvedKnowledgeContext } from "./knowledge/context.js";
import { formatClaimRef, suppliedContextOf } from "./knowledge/kernel.js";
import {
  checkDiscoveryDelta,
  discoveryInstruction,
  previewKnowledgeDelta,
  summarizeDiscovery,
  type DiscoveryContext,
} from "./knowledge/discovery.js";
import {
  RuleVerificationError,
  bindCheckEvidence,
  checkRuleVerification,
  declaredCheckLabels,
  describeReport,
  holdsPolicy,
  holdsPolicyRefusal,
  parseRuleVerificationReport,
  previewRuleVerification,
  selectedRules,
  summarizeRuleVerification,
  verificationDeltaRefusal,
  verificationInstruction,
  type VerificationContext,
} from "./knowledge/ruleVerification.js";
import {
  ensureRuleVerificationDir,
  readAgentVerification,
  readVerificationRecord,
  ruleVerificationFile,
  updateVerificationStatus,
  writeVerificationRecord,
} from "./knowledge/verificationStaging.js";
import {
  ChangeProposalError,
  buildChangeContext,
  buildChangeIntentInput,
  changeContextFile,
  changeContextInstruction,
  changeIntentInstruction,
  changeRequestFile,
  checkChangeProposal,
  describeChangeProposal,
  parseChangeProposal,
  previewChangeProposal,
  requestWithIdentity,
  selectedChangeRules,
  summarizeChangeIntent,
  validateChangeRequest,
  writeReadOnlyInput,
  type ChangeIntentContext,
} from "./knowledge/changeIntent.js";
import type { ChangeProposalAcceptance } from "./knowledge/changeIntent.js";
import {
  ensureChangeProposalDir,
  changeProposalFile,
  readAgentProposal,
  readProposalRecord,
  updateProposalStatus,
  writeProposalRecord,
} from "./knowledge/changeStaging.js";
import {
  acceptedChangeProposalOfPhase,
  changeProposalById,
  changeRealizationById,
  changeRealizationOfPhase,
  formatCriterionRef,
  formatRepositoryState,
  realizationIntentCurrency,
  sameRepositoryState,
} from "./knowledge/kernel.js";
import {
  deriveImplementationScope,
  describeScope,
  implementationScopeInstruction,
  implementationScopeText,
} from "./knowledge/implementationScope.js";
import {
  buildRemediationContext,
  evaluateCompletion,
  implementationScopeFile,
  remediationContextFile,
  remediationContextText,
  remediationInstruction,
  repositoryStateFrom,
  technicalResultFrom,
  type CompletionVerdict,
} from "./knowledge/realization.js";
import {
  AcceptanceVerificationError,
  acceptanceCheckLabels,
  acceptanceCheckRefusal,
  acceptanceInstruction,
  acceptanceProposalMissing,
  bindAcceptanceChecks,
  checkAcceptanceReport,
  describeAcceptanceReport,
  parseAcceptanceReport,
  previewAcceptance,
  summarizeAcceptance,
  type AcceptanceContext,
} from "./knowledge/acceptance.js";
import {
  acceptanceVerificationFile,
  ensureAcceptanceDir,
  readAcceptanceRecord,
  readAgentAcceptance,
  updateAcceptanceStatus,
  writeAcceptanceRecord,
} from "./knowledge/acceptanceStaging.js";
import {
  closeRealization,
  openChangeRealization,
  recordRealizationAttempt,
} from "./knowledge/store.js";
import type { AcceptanceProposal } from "./knowledge/store.js";
import { sha256Hex } from "./knowledge/context.js";

import { readLedger } from "./knowledge/store.js";
import { markPipelineStarted, readPipelines } from "./sources/pipelines.js";
import { accumulateRun } from "./sources/totals.js";
import {
  INSTANCE_KEEP,
  pruneInstances,
  readInstance,
  readInstances,
  writeInstance,
} from "./sources/instances.js";
import {
  advance,
  applyAbort,
  applyApprove,
  applyKnowledgeCommit,
  applyRemediation,
  commitFailureClass,
  applyCandidateSelection,
  applyCandidateVerification,
  applyCandidatesExhausted,
  applyRevise,
  applyRetry,
  applyUnlaunchable,
  applyVerification,
  candidateFailureClass,
  candidateFailureReason,
  candidateRecordOf,
  retryDelayMs,
  selectCandidate,
  shouldRetry,
  initInstance,
  toCandidateOutcomes,
  withFailureClass,
} from "./pipelineTransitions.js";
import {
  interpolate,
  livePhases,
  previousPayloadFor,
  resolveNeeds,
  resultStepName,
} from "./sources/dag.js";
import type { VerificationReport } from "./sources/pipelineTypes.js";
import { journal } from "./sources/journal.js";
import { isAlive } from "./scheduler.js";
import { claudeRuntime, parseEnvelopeFor, resolveRuntimeId, runtimeFor } from "./runtimes/index.js";
import { graceMsFor, previousFireTime } from "./sources/nextFire.js";
import { KeyedMutex } from "./mutex.js";
import { spawnPipelineProcess } from "./pipelineProcess.js";
import type { PipelineProcessHandle } from "./pipelineProcess.js";
import type { SpawnPlan } from "./runtimes/index.js";
import type {
  AcceptanceCriterion,
  AcceptanceVerification,
  AcceptanceVerificationRecord,
  AcceptedChangeProposal,
  AgentRuntimeId,
  ChangeProposalRecord,
  ChangeRealization,
  ChangeRealizationAttempt,
  ChangeRequest,
  ChangeRuleState,
  ClaimRef,
  ImplementationScope,
  InvocationChannelKind,
  KnowledgeDelta,
  KnowledgeDeltaRecord,
  RemediationContext,
  RepositoryStateRef,
  RuleVerification,
  RuleVerificationRecord,
  RunExecutionRef,
  StepKnowledgeDelta,
} from "@argus/contracts";
import type { Run } from "./sources/scheduleTypes.js";
import type {
  PhaseDef,
  PhaseFailureClass,
  PhaseFailurePayload,
  PhaseProgress,
  PhaseStep,
  RetryableClass,
  StepProgress,
  WorkspacePolicy,
  WorkspaceRecord,
} from "./sources/pipelineTypes.js";

/**
 * One run of one step, planned but not yet launched.
 *
 * A candidates phase plans `count` of these from a single `stepDef`, each with
 * a worktree, an artifact directory and a baseline of its own — which is why
 * the per-run context is a record here rather than being derived from the
 * phase at launch time.
 */
interface PlannedRun {
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
}

/**
 * An implementation phase attempt's realization (Phase 8): the durable record
 * it belongs to, which attempt it is, the deterministic scope its agent
 * receives, and — from attempt 2 — exactly what the previous attempt left
 * unmet. Or the reason the attempt may not start at all: a stale semantic
 * target, an exhausted attempt budget, an unusable accepted proposal.
 */
type PlannedRealization =
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
type PlannedAcceptance = { proposalId: string; required: AcceptanceCriterion[] };

/**
 * A step's `knowledgeContext` after resolution against the phase attempt's
 * ledger snapshot: the frozen document, or the reason it could not be built
 * (an unknown claim or revision), which fails the step as `configuration`
 * before any process starts. Resolved once per attempt, at planning, so every
 * run of the attempt saw the same ledger and the prompt can name what the
 * run will find in the file.
 */
type PlannedKnowledgeContext = { resolved: ResolvedKnowledgeContext } | { error: string };

/**
 * A change-intent phase's input after resolution (Phase 7): the frozen
 * request, the rules the run is accountable for with their current
 * conformance, and the document Argus materializes for it — or the reason no
 * request could be resolved, which fails the step as `configuration` before
 * any process starts. A phase whose author declared `changeIntent` and whose
 * instance supplied no request is a definition that cannot run, not a run
 * that should invent one.
 */
type PlannedChangeIntent =
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
type PlannedChangeContext = { accepted: AcceptedChangeProposal; text: string } | { error: string };
import type {
  CandidateRecord,
  KnowledgeCommitVerdict,
  RouteOutcome,
  TransitionResult,
} from "./pipelineTransitions.js";
import type {
  PipelineDefinition,
  PipelineInstance,
  PipelineSignal,
} from "./sources/pipelineTypes.js";
import { log } from "./log.js";

/** Thrown by start() when the pre-run guard finds a critical prerequisite still broken. */
export class PreflightError extends Error {
  constructor(public readonly reasons: string[]) {
    super(`setup preconditions not met: ${reasons.join("; ")}`);
    this.name = "PreflightError";
  }
}

/** Caps the number of concurrently spawned child processes. */
export class Semaphore {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async acquire(): Promise<void> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
  }
  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

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

/**
 * Injected into every step run's system prompt so the Stop hook can derive an
 * outcome without the pipeline author writing the ARGUS_OUTCOME mechanic. Must
 * stay a pure constant — no per-run data — or the prompt cache prefix breaks.
 */
export const OUTCOME_CONTRACT =
  "When you finish, the final line of your last message must report the outcome " +
  "so the pipeline can decide whether to advance. Write `ARGUS_OUTCOME: succeeded` " +
  "if you fully met the task's stated criteria, or `ARGUS_OUTCOME: failed` " +
  "(use `blocked` if you could not proceed) followed by a one-line reason. " +
  "Judge success against the criteria in the task, not merely whether you stopped cleanly. " +
  "This is a one-shot batch run: it will not be re-invoked when background tasks or " +
  "subagents finish, so do not stop while any are still in flight. If you must stop " +
  "with deferred work unfinished, report `ARGUS_OUTCOME: blocked`.";

/**
 * The Knowledge Ledger's half of the agent contract (docs/KNOWLEDGE-LEDGER.md
 * § KnowledgeDelta protocol). Like {@link OUTCOME_CONTRACT} it is a pure
 * constant — the per-run file path travels in the environment, never in the
 * text — so the system-prompt prefix stays cacheable. Deliberately short: it
 * says that a delta is optional, where it goes, what shape it has, and the two
 * rules an agent must not break (no invented canonical ids; exact revisions
 * only). Everything else is Argus's to validate, and the whole architecture
 * does not belong in every prompt.
 */
export const KNOWLEDGE_DELTA_CONTRACT =
  "Knowledge Ledger (optional). Only if this task establishes or revises durable semantic " +
  "knowledge that later work should rely on — a business rule, fact, assumption, constraint, " +
  "conclusion or decision — write one JSON KnowledgeDelta to the file path in the " +
  "ARGUS_KNOWLEDGE_DELTA_FILE environment variable before you finish. Shape: " +
  '{"schemaVersion":1,"claims":[{"localId":"<label>","kind":"business-rule","statement":"..."}],' +
  '"revisions":[{"claimId":"<existing id>","expectedRevision":<its current revision>,"statement":"..."}],' +
  '"justifications":[{"conclusion":{"local":"<label>"},"premises":["<ID>:v<N>"]}],' +
  '"evidence":[{"claim":{"local":"<label>"},"source":{"type":"source-code","path":"..."}}],' +
  '"consumed":["<ID>:v<N>"],"artifacts":[{"location":"repository","path":"<relative path>"}]}. ' +
  "Every section is optional. Do not invent canonical ids: a new claim gets a localId of your " +
  "choosing and Argus assigns its identity. Reference existing claims only by exact revision " +
  "(ID:vN), never by bare id. Argus validates the delta and applies it only once the phase is " +
  "accepted; a delta that fails validation fails this step. Ordinary work that establishes no " +
  "durable knowledge writes no file.";

/**
 * The KnowledgeContext half of the agent contract (docs/KNOWLEDGE-LEDGER.md
 * § KnowledgeContext protocol). A pure constant like the two above — phrased
 * conditionally on the variable, because most runs have no context and the
 * system-prompt prefix must be the same for every run. It says where the
 * context is, that each ref is immutable historical identity, and how to
 * declare consumption against it. It does not describe the ledger and does
 * not ask the agent to use everything it was given.
 */
export const KNOWLEDGE_CONTEXT_CONTRACT =
  "Semantic context. If the ARGUS_KNOWLEDGE_CONTEXT_FILE environment variable is set, Argus " +
  "has supplied canonical semantic context — business rules, facts, constraints, decisions — as " +
  "a read-only JSON file at that path; read it before reasoning about the task. Each entry's " +
  '"ref" (ID:vN) is an immutable historical identity: it names exactly that revision, whose ' +
  "lifecycle and support are stated in the entry. Never modify the file. Use only what is " +
  "relevant. If you write a KnowledgeDelta that declares an existing claim as consumed, name the " +
  "exact revision you relied upon, as given by its ref.";

/** Everything Argus itself tells a step's agent, in one constant. */
export const STEP_CONTRACT = `${OUTCOME_CONTRACT}\n\n${KNOWLEDGE_DELTA_CONTRACT}\n\n${KNOWLEDGE_CONTEXT_CONTRACT}`;

/**
 * The instruction a result-producing step gets appended to its prompt.
 *
 * Not part of {@link OUTCOME_CONTRACT}: that is a pure constant so the prompt
 * cache prefix holds across every run, and this text carries the phase's own
 * schema. It goes in the prompt rather than the system prompt for the same
 * reason the schema is in the definition — it is this phase's contract, not
 * Argus's.
 *
 * The two say different things and both are needed. `ARGUS_OUTCOME` reports
 * whether the run *worked*; the result file reports what it *decided*. An agent
 * that decides "reject" has succeeded operationally, and conflating the two is
 * how a failing audit becomes a failing pipeline.
 */
export function resultInstruction(result: PhaseDef["result"]): string {
  if (!result) return "";
  return (
    "\n\nStructured result required. Before you finish, write this phase's result as JSON " +
    "to the file path given in the ARGUS_RESULT_FILE environment variable. It must match " +
    `this schema: ${JSON.stringify(result.schema)}. The pipeline reads that file — not your ` +
    "message text — to decide what runs next, and the phase fails if it is missing or does " +
    "not match. Reporting `ARGUS_OUTCOME: succeeded` still means the work itself went fine, " +
    "whatever the result says."
  );
}

/**
 * The instruction a step gets when its phase requires file artifacts.
 *
 * Which files must exist afterwards is system control — a check Argus runs —
 * so Argus states it, in the prompt, beside the path the files go to. The
 * author's prompt says what the files should contain; this says that they
 * must exist and where.
 */
export function artifactInstruction(checks: PhaseDef["checks"], artifactDir: string): string {
  const required = (checks ?? []).flatMap((c) => (c.kind === "artifact" ? [c.path] : []));
  if (required.length === 0) return "";
  return (
    "\n\nRequired artifacts. Before you finish, this phase must leave the following " +
    `file${required.length === 1 ? "" : "s"} in its artifact directory ${artifactDir} ` +
    `(also given as the ARGUS_ARTIFACT_DIR environment variable): ${required.join(", ")}. ` +
    "The pipeline checks that each exists and is non-empty; the phase fails otherwise."
  );
}

/**
 * The instruction a step gets when its pipeline has `memory` enabled.
 *
 * Argus states where the file is and what it is for; what to actually write
 * in it is the author's business (or the agent's own judgment) — this is only
 * the fixed, system-owned part: the path, and the cap Argus itself enforces
 * after the fact (§ harness/memory.ts `trimMemoryIfNeeded`).
 */
export function memoryInstruction(memory: PipelineDefinition["memory"] | undefined): string {
  if (!memory?.enabled) return "";
  const cap = memory.maxBytes ?? DEFAULT_MEMORY_BYTES;
  return (
    "\n\nDurable notes for this pipeline live at $ARGUS_MEMORY_DIR/NOTES.md. Append what a " +
    "future run of this pipeline must know (decisions, gotchas, what was tried); keep it under " +
    `${cap} bytes — Argus trims the head beyond that.`
  );
}

/**
 * The instruction a step gets when Argus supplied it a KnowledgeContext:
 * how many revisions, exactly which, and where. The refs in the prompt are
 * the same refs the file carries; the file is the channel, the prompt only
 * makes sure the agent knows the context is there and what it is called.
 */
export function knowledgeContextInstruction(supplied: ClaimRef[]): string {
  if (supplied.length === 0) return "";
  const refs = supplied.map(formatClaimRef).join(", ");
  return (
    `\n\nSemantic context supplied. Argus has placed ${supplied.length} canonical claim ` +
    `revision${supplied.length === 1 ? "" : "s"} (${refs}) as read-only JSON at the path in ` +
    "the ARGUS_KNOWLEDGE_CONTEXT_FILE environment variable. Read it before reasoning about " +
    "this task; treat each ref as the exact revision to cite if you declare it consumed."
  );
}

/**
 * Build the invocation for a step run, with the outcome contract carried into
 * the agent's instructions.
 *
 * The runtime decides how that contract is delivered — Claude Code takes it on
 * `--append-system-prompt`, Codex has no such flag so it rides at the top of
 * the prompt — and both produce a run that reports `ARGUS_OUTCOME` the same way.
 * Kept pure for unit testing.
 */
export function buildStepPlan(run: Run): SpawnPlan {
  return runtimeFor(run.runtime).streamPlan({
    prompt: run.prompt,
    sessionId: run.sessionId,
    model: run.model,
    reasoningEffort: run.reasoningEffort,
    systemPrompt: STEP_CONTRACT,
  });
}

/** The Claude Code argument vector for a step run. Retained as the narrow,
 *  named form of {@link buildStepPlan} for callers and tests that mean Claude. */
export function buildClaudeArgs(run: Run): string[] {
  return claudeRuntime.streamPlan({
    prompt: run.prompt,
    sessionId: run.sessionId,
    model: run.model,
    systemPrompt: STEP_CONTRACT,
  }).args;
}

/** Real spawn: the run's agent CLI, prompt on stdin, with the signal env
 *  injected. POSIX starts the agent directly and detached; Windows uses a
 *  hidden, detached two-stage host so the real agent PID can be confirmed over
 *  IPC before this handle resolves. Both keep fd-backed logs so the run survives
 *  an Argus restart. The handshake, rather than the host itself, preserves PID
 *  tracking across restarts.
 *
 *  With a prepared invocation the child gets exactly what the harness decided —
 *  argv and environment alike; `process.env` is not consulted here, because
 *  the environment policy has already been applied to it. The legacy branch
 *  (no preparation) is kept for callers that build a run by hand. */
export const defaultPipelineSpawn: PipelineSpawnFn = async (run, logPath, env, prepared) => {
  const fd = openSync(logPath, "a");
  const plan = prepared?.plan ?? buildStepPlan(run);
  try {
    return await spawnPipelineProcess(
      {
        bin: plan.bin,
        args: plan.args,
        stdin: plan.stdin,
        cwd: run.cwd,
        env: prepared ? prepared.env : { ...process.env, ...plan.env, ...env },
      },
      fd,
    );
  } finally {
    closeSync(fd);
  }
};

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
  /** The environment step env policies are applied to. Defaults to process.env. */
  parentEnv?: NodeJS.ProcessEnv;
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

/** Which paused phase a gate action means, when more than one could be. */
export interface GateTarget {
  phaseId?: string;
}

interface RecoveredOutcome {
  signalType: "completed" | "failed";
  outcome: NonNullable<Run["outcome"]>;
  payload: unknown;
  /** Failure policy class. Absent for a recovered success. */
  failureClass?: RetryableClass;
  failureReason?: string;
}

const OUTCOME_LINE_RE = /^\s*ARGUS_OUTCOME:\s*(succeeded|failed|blocked)\b[^\S\r\n]*(.*)$/gim;

/**
 * Recover a run's work-level conclusion from the final message stored on a
 * terminal run record. A completion signal remains authoritative when one
 * arrives; this is only used by reconciliation while the tracked step is still
 * `running`.
 *
 * For Codex it backstops a hook whose delivery is best-effort. For OpenCode,
 * which exposes no command hook at all, it *is* the completion protocol — the
 * agent writes the same `ARGUS_OUTCOME` line either way, and the only
 * difference is that the conclusion is read off the record on the next
 * reconcile tick instead of being pushed the instant the run ends. Which
 * runtimes are eligible is the runtime's own declaration
 * ({@link AgentRuntime.outcomeFromRecord}), so a runtime whose hook Argus
 * installs is never quietly rubber-stamped when that hook fails to fire.
 *
 * Conflicting sentinels are deliberately ambiguous. Repeating the same
 * sentinel is harmless (models sometimes recap before the required last
 * line), but two different conclusions must never be guessed into success.
 */
export function recoverRunOutcome(run: Run): RecoveredOutcome {
  if (run.status !== "succeeded" || (run.exitCode != null && run.exitCode !== 0)) {
    const reason =
      run.error?.trim() ||
      (run.exitCode != null ? `exit code ${run.exitCode}` : `run ended with status ${run.status}`);
    return {
      signalType: "failed",
      outcome: "failed",
      payload: { reason },
      failureClass: failureClassOfRecord(run),
      failureReason: reason,
    };
  }

  const message = run.resultSummary ?? "";
  const matches = [...message.matchAll(OUTCOME_LINE_RE)];
  const kinds = new Set(matches.map((m) => m[1].toLowerCase()));
  if (matches.length === 0 || kinds.size !== 1) {
    const reason =
      matches.length === 0
        ? "run succeeded but ended without an ARGUS_OUTCOME completion marker"
        : `run succeeded but reported conflicting ARGUS_OUTCOME markers (${[...kinds].join(", ")})`;
    return {
      signalType: "failed",
      outcome: "failed",
      payload: { reason },
      // A missing/ambiguous completion protocol is recoverable infrastructure,
      // not a considered agent failure, so existing exit-code retry policies
      // keep their pre-fallback behavior.
      failureClass: "exit-code",
      failureReason: reason,
    };
  }

  const kind = matches[matches.length - 1][1].toLowerCase() as NonNullable<Run["outcome"]>;
  const payload = {
    last_assistant_message: message,
    completion_source: "run-record-fallback",
  };
  if (kind === "succeeded") return { signalType: "completed", outcome: kind, payload };

  const tail = (matches[matches.length - 1][2] ?? "").replace(/^[\s:–—-]+/, "").trim();
  const reason = tail ? `${kind}: ${tail}` : kind;
  return {
    signalType: "failed",
    outcome: kind,
    payload: { ...payload, reason },
    failureClass: "signal",
    failureReason: reason,
  };
}

/** How a run that ended without a considered agent verdict is classed for the
 *  retry policy, from what its record shows: never started, killed at its
 *  deadline (or for going quiet — a stall is a timeout that noticed sooner),
 *  or exited on its own. */
export function failureClassOfRecord(run: Run): RetryableClass {
  if (run.termination === "timed-out" || run.termination === "stalled") return "timeout";
  return run.pid == null ? "spawn" : "exit-code";
}

/** Bound on the whole retry note, across every class — generous enough for a
 *  handful of failed checks' output tails, small enough that a retry prompt
 *  never balloons past what one bad attempt is worth repeating. */
const RETRY_NOTE_MAX_BYTES = 2000;
/** Per-check output tail kept in a verification retry note. */
const VERIFICATION_TAIL_CHARS = 600;
/** Tail of a run's own error/result text kept in an exit-code retry note. */
const EXIT_CODE_TAIL_CHARS = 800;

export interface RetryNoteInput {
  failureClass?: PhaseFailureClass;
  /** The phase's own one-line reason — used as-is for `timeout`, `spawn` and
   *  `signal`, which already carry everything worth repeating. */
  reason?: string;
  /** The failed attempt's own checks, when the class is `verification`. */
  verification?: VerificationReport;
  /** The failed run's exit code, when the class is `exit-code`. */
  exitCode?: number | null;
  /** The failed run's own error/result text, when the class is `exit-code`. */
  runText?: string | null;
  /** Which attempt just failed (1-based) and how many the policy allows, for
   *  the note's own header. */
  attempt: number;
  maxAttempts: number;
}

/**
 * A retry re-runs the same prompt. Every retryable class now hands the next
 * attempt *something* worth repairing against — this is the best-evidenced
 * loop in the harness literature (Aider, CodeRabbit; see
 * docs/HARNESS-RESEARCH.md §2 #4) — bounded per class so a chatty check
 * output can never balloon the prompt:
 *
 *  - `verification`: each failed check by name, with the tail of its output.
 *  - `exit-code`: the exit code plus the tail of the run's own error/result text.
 *  - `timeout` (including a stall — "stalled: no output for Ns"), `spawn` and
 *    `signal`: the one-line reason already computed where the failure was
 *    recorded — there is nothing more specific to add.
 *
 * Pure, so every class is unit-testable without touching a run record: the
 * caller (which does the I/O to read the failed run and the report) hands in
 * exactly what it found.
 */
export function retryNote(input: RetryNoteInput): string {
  const cls = input.failureClass;
  if (!cls || cls === "configuration") return "";

  let body = "";
  if (cls === "verification" && input.verification) {
    body = input.verification.checks
      .filter((c) => c.status === "failed")
      .map((c) => `${c.label}: ${(c.output ?? "").trim().slice(-VERIFICATION_TAIL_CHARS)}`)
      .join("\n");
  } else if (cls === "exit-code") {
    const tail = (input.runText ?? "").trim().slice(-EXIT_CODE_TAIL_CHARS);
    body = `exit code ${input.exitCode ?? "unknown"}${tail ? `: ${tail}` : ""}`;
  } else {
    // timeout (incl. stalled), spawn, signal
    body = (input.reason ?? "").trim();
  }
  body = body.trim();
  if (!body) return "";
  if (body.length > RETRY_NOTE_MAX_BYTES) body = `…${body.slice(-(RETRY_NOTE_MAX_BYTES - 1))}`;
  return `\n\nPrevious attempt (${input.attempt} of ${input.maxAttempts}) failed — ${cls}:\n${body}`;
}

/**
 * Gather what {@link retryNote} needs for one failed phase, doing the one bit
 * of I/O it can't do itself: reading the failed run's own record for an
 * `exit-code` class. Every other class reads only what is already on the
 * phase (`payload`, `verification`).
 */
async function buildRetryNote(def: PipelineDefinition, phase: PhaseProgress): Promise<string> {
  const payload = (phase.payload ?? {}) as PhaseFailurePayload;
  const policy = def.phases.find((p) => p.id === phase.id)?.retry;
  const attempt = (phase.retries ?? 0) + 1;
  let exitCode: number | null = null;
  let runText: string | null = null;
  if (payload.failureClass === "exit-code") {
    const failedStep = phase.steps.find((s) => s.status === "failed" && s.runId);
    if (failedStep?.runId) {
      const got = await readRun(failedStep.runId);
      exitCode = got?.run.exitCode ?? null;
      runText = got?.run.error ?? got?.run.resultSummary ?? null;
    }
  }
  return retryNote({
    failureClass: payload.failureClass,
    reason: typeof payload.reason === "string" ? payload.reason : undefined,
    verification: phase.verification,
    exitCode,
    runText,
    attempt,
    maxAttempts: policy?.attempts ?? attempt,
  });
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
  /** Send a paused phase back to its agent with the human's note. */
  revise(instanceId: string, note?: string, options?: GateTarget): Promise<ActionResult>;
  abort(instanceId: string): Promise<ActionResult>;
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

export function createEngine(deps: EngineDeps): Engine {
  const sem = new Semaphore(deps.maxConcurrent);
  // Serializes all read-modify-write mutations of a single instance so
  // concurrent signals / reconcile passes cannot lose each other's updates.
  const locks = new KeyedMutex();
  /** Runs spawned by a previous server process, reattached after restart. */
  const adopted = new Map<string, { instanceId: string }>();
  const nowISO = () => deps.now().toISOString();
  const kill = deps.kill ?? killRunProcess;
  const parentEnv = () => deps.parentEnv ?? process.env;
  /** Phase attempts whose checks this process is currently running. */
  const verifying = new Set<string>();
  /** Runs this process spawned and is still awaiting the exit of. */
  const live = new Set<string>();
  /** Detached continuations in flight, so `drain` can wait for them. */
  const detached = new Set<Promise<unknown>>();
  function track<T>(p: Promise<T>): Promise<T> {
    detached.add(p);
    void p.finally(() => detached.delete(p)).catch(() => {});
    return p;
  }
  async function drain(): Promise<void> {
    while (detached.size > 0) await Promise.allSettled([...detached]);
  }

  /** Instances whose worktrees this process has already cleaned up. */
  const cleaned = new Set<string>();
  /** Instances whose memory notes this process has already trimmed. */
  const memoryChecked = new Set<string>();

  /**
   * Persist an instance, and — once it has settled — remove the worktrees it
   * created and trim its pipeline's memory notes if they have grown past cap.
   *
   * Every write of an instance goes through here rather than through
   * `writeInstance` directly, because an instance can reach a terminal status
   * from a dozen places (a signal, a deadline, a failed check, an abort, a
   * reconcile pass), and a cleanup hook on each of them is a cleanup hook
   * somebody eventually forgets. The removal is detached and never throws into
   * the transition that caused it: a worktree Argus cannot delete is a warning
   * in the log, never a pipeline that fails to finish.
   */
  async function saveInstance(inst: PipelineInstance): Promise<void> {
    await retireStagedDeltas(inst);
    await writeInstance(inst);
    if (inst.status === "running" || inst.status === "awaiting-approval") {
      // Alive again — a revise of a failed instance, a scheduled retry. What it
      // creates from here is cleaned up by the settlement that follows.
      cleaned.delete(inst.id);
      memoryChecked.delete(inst.id);
      return;
    }
    if (!memoryChecked.has(inst.id)) {
      memoryChecked.add(inst.id);
      void track(trimMemoryFor(inst));
    }
    if (cleaned.has(inst.id)) return;
    // Steps as well as phases: a candidates phase records a tree per candidate
    // and never one of its own until a winner is chosen, so an instance aborted
    // mid-selection has trees that only the steps know about.
    const anyTree =
      inst.workspace ||
      inst.phases.some((p) => p.workspace || p.steps.some((step) => step.workspace));
    if (!anyTree) return;
    cleaned.add(inst.id);
    void track(cleanupWorkspaces(inst));
  }

  /** Trim one settled instance's pipeline's `NOTES.md` back to its cap, when
   *  `memory` is enabled and the file has grown past it. Never throws — a
   *  file Argus cannot trim is a warning in the log, never a settlement that
   *  fails to finish. */
  async function trimMemoryFor(inst: PipelineInstance): Promise<void> {
    const def = await defFor(inst);
    if (!def?.memory?.enabled) return;
    const cap = def.memory.maxBytes ?? DEFAULT_MEMORY_BYTES;
    try {
      const trimmed = await trimMemoryIfNeeded(def.id, cap);
      if (trimmed) {
        await journal(inst.id, {
          at: nowISO(),
          kind: "memory.trimmed",
          detail: `NOTES.md trimmed to ${cap} bytes`,
        });
      }
    } catch (e) {
      log.warn("pipeline memory could not be trimmed", { pipelineId: def.id, err: e });
    }
  }

  /** Remove every worktree of a settled instance whose policy did not ask for
   *  it to be kept. The branches are never touched: they are the deliverable. */
  async function cleanupWorkspaces(inst: PipelineInstance): Promise<void> {
    const def = await defFor(inst);
    if (!def) return;
    for (const removal of plannedRemovals(def, inst)) {
      await removeWorkspace(inst.id, removal.repoCwd, removal.path, removal.branch);
    }
  }

  /** One worktree, gone. Never throws — a directory Argus could not remove must
   *  not take a transition (or an instance's settlement) down with it. Returns
   *  whether it is actually gone, so a caller that was about to forget the
   *  record can keep it and let the instance's own cleanup try again. */
  async function removeWorkspace(
    instanceId: string,
    repoCwd: string,
    workspacePath: string,
    branch: string,
  ): Promise<boolean> {
    try {
      await removeWorktree({ repoCwd, path: workspacePath });
      // Awaited, unlike the engine's other journal calls: this one runs off the
      // transition path already, and a settled instance's evidence should be on
      // disk by the time `drain()` says the settlement is finished.
      await journal(instanceId, {
        at: nowISO(),
        kind: "workspace.removed",
        detail: `${branch} at ${workspacePath}`,
      });
      return true;
    } catch (e) {
      log.warn("workspace could not be removed", { instanceId, path: workspacePath, err: e });
      return false;
    }
  }

  /**
   * The worktree this phase attempt runs in, created (or re-attached) before
   * anything is planned.
   *
   * `scope: "instance"` resolves to one tree per instance, shared by every
   * phase that opts in and recorded on the instance the first time it is used —
   * the record is kept as it was, so the base commit it was cut from stays the
   * one it was cut from however many phases reuse it. `scope: "attempt"` gives
   * each attempt its own, and the superseded attempt's tree is removed as the
   * new one is created unless the policy says to keep it.
   *
   * Throws {@link WorkspaceError} (with git's own words) when the repository,
   * the base ref or git itself is not what the definition assumed: the caller
   * turns that into a `configuration` failure of the phase.
   */
  async function ensureWorkspace(
    inst: PipelineInstance,
    phaseDef: PhaseDef,
    progress: PhaseProgress,
    policy: WorkspacePolicy,
    /** One candidate of this attempt, when the phase runs best-of-N: each gets
     *  its own tree, because candidates that share a checkout are not samples. */
    candidate?: number,
  ): Promise<WorkspaceRecord> {
    const target = workspaceTarget({
      root: paths.worktreesDir(),
      instanceId: inst.id,
      phaseId: phaseDef.id,
      attempt: progress.attempt,
      policy,
      ...(candidate === undefined ? {} : { candidate }),
    });
    const previous = candidate === undefined ? progress.workspace : undefined;
    if (previous && previous.path !== target.path && policy.keep !== true) {
      await removeWorkspace(inst.id, phaseDef.cwd, previous.path, previous.branch);
    }
    // A restart finds the directory already there (reused as it stands) or the
    // branch already there without it (checked out again, keeping its commits).
    const shared =
      policy.scope === "instance" && inst.workspace?.path === target.path ? inst.workspace : null;
    const created = await createWorktree({
      repoCwd: phaseDef.cwd,
      path: target.path,
      branch: target.branch,
      ...(policy.base ? { base: policy.base } : {}),
    });
    const record = shared ?? created;
    if (policy.scope === "instance") inst.workspace = record;
    if (!shared) {
      void journal(inst.id, {
        at: nowISO(),
        kind: "workspace.created",
        phaseId: phaseDef.id,
        attempt: progress.attempt,
        detail:
          candidate === undefined
            ? `${record.branch} at ${record.path}`
            : `c${candidate}: ${record.branch} at ${record.path}`,
      });
    }
    return record;
  }

  async function loadDef(pipelineId: string): Promise<PipelineDefinition | undefined> {
    return (await readPipelines()).find((d) => d.id === pipelineId);
  }

  /**
   * The definition an existing instance runs against: the copy it snapshotted
   * when it started. Only `start` reads the live definition; everything after
   * — a signal, an approval, a revise, a retry, a verification, a run healed
   * after a restart — reads the snapshot, so an edit (or a delete) saved
   * mid-flight cannot change what the instance does. An instance written
   * before the snapshot existed has none and falls back to the live definition,
   * which is exactly the behaviour it was started under.
   */
  async function defFor(inst: PipelineInstance): Promise<PipelineDefinition | undefined> {
    return inst.definition ?? (await loadDef(inst.pipelineId));
  }

  /**
   * Launch a wave of ready phases, given as indices into `inst.phases`.
   *
   * Sequential over the wave rather than `Promise.all`: each phase's launch
   * writes the instance, and two concurrent writers would race on the same
   * file. The steps *within* a phase already run concurrently, and the phases
   * themselves proceed concurrently once launched — this loop only serializes
   * the handful of milliseconds it takes to record their runIds.
   */
  async function startPhases(
    def: PipelineDefinition,
    inst: PipelineInstance,
    indices: number[],
    noteSuffix = "",
  ): Promise<void> {
    for (const i of indices) await startPhase(def, inst, i, noteSuffix);
  }

  /**
   * Launch one instance phase. `phaseIndex` indexes `inst.phases`; the phase's
   * definition is found by id, never by that index. `def` is normally the
   * instance's own snapshot, where the two line up — but an instance from
   * before the snapshot existed runs against the live definition, which may
   * have been edited since it started (a phase inserted ahead shifts every
   * index, and its id is the one stable key).
   */
  async function startPhase(
    def: PipelineDefinition,
    inst: PipelineInstance,
    phaseIndex: number,
    noteSuffix = "",
  ): Promise<void> {
    const progress = inst.phases[phaseIndex];
    const phaseDef = def.phases.find((p) => p.id === progress.id);
    if (!phaseDef) {
      await failUnlaunchable(def, inst, progress.id);
      return;
    }
    // "Previous" is the phase's own dependency, which for a linear pipeline is
    // the phase before it — the same value the cursor version produced. A
    // dependency the edited definition names but the instance never had reads
    // as absent, which is the honest answer.
    const prevPayload = previousPayloadFor(def, inst, phaseDef.id);
    const startedAt = nowISO();
    // Isolation first: the worktree is what the steps' `cwd` will be, so it has
    // to exist before a single run is planned — and a tree that cannot be
    // created is a definition Argus cannot honour, not a step that failed.
    const policy = workspacePolicyFor(def, phaseDef);
    // Best-of-N: `count` runs of the phase's one step, each in a worktree of
    // its own. The phase-level tree is *not* created for such an attempt — the
    // winner's becomes the phase's at selection, and a shared one would be a
    // directory nothing ever ran in.
    const candidates = phaseDef.candidates;
    // "none" is a phase opting *out* of a pipeline-wide policy it inherited —
    // the same as no policy at all for this one phase: it runs in its own
    // `cwd`, no worktree is created or recorded.
    if (policy && policy.scope !== "none" && !candidates) {
      try {
        progress.workspace = await ensureWorkspace(inst, phaseDef, progress, policy);
      } catch (e) {
        await failPhaseConfiguration(
          def,
          inst,
          phaseDef.id,
          e instanceof Error ? e.message : String(e),
        );
        return;
      }
    }
    const artifactDir = phaseArtifactDir(paths.artifactsDir(), inst.id, phaseDef.id);
    progress.artifactDir = artifactDir;
    const byPhase = Object.fromEntries(
      inst.phases.flatMap((p) => (p.artifactDir ? [[p.id, p.artifactDir]] : [])),
    ) as Record<string, string>;
    // Exactly one step may publish the phase's result; only that step is told
    // about it, so concurrent siblings cannot race to write a decision. Every
    // candidate of a candidates phase is that step — each writes to its own
    // run's result file, and the phase takes the winner's.
    const publishingStep = resultStepName(phaseDef);

    // Pipeline memory (§B): read once per phase-start, and only when a step
    // actually asks for it — the common case is a pipeline with `memory` off,
    // or a phase whose prompt has nothing to do with it, and neither should
    // pay for a file read it never uses.
    const promptsHere = phaseDef.steps.map((s) => s.prompt).join("\n");
    const memoryPolicy = def.memory;
    const memoryDir = memoryPolicy?.enabled ? memoryDirFor(def.id) : null;
    const memoryText =
      memoryPolicy?.enabled && promptsHere.includes("{{memory}}")
        ? await readMemoryNotes(def.id, memoryPolicy.maxBytes ?? DEFAULT_MEMORY_BYTES)
        : "";
    if (memoryDir) await ensureMemoryDir(def.id);

    // `{{previous.instance}}` (§B): the most recent settled instance of this
    // pipeline that started before this one. Not gated on `memory.enabled` —
    // it costs one instance listing, already read from disk elsewhere, and
    // says nothing a pipeline needs to opt into.
    let previousInstanceSummary = "";
    if (promptsHere.includes("{{previous.instance}}")) {
      const siblings = (await readInstances({ pipelineId: def.id }))
        .filter((i) => i.id !== inst.id && i.createdAt < inst.createdAt && isSettled(i))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      if (siblings[0]) previousInstanceSummary = summarizeInstance(siblings[0]);
    }
    // Semantic context (Phase 4): one ledger snapshot per phase attempt, read
    // only when some step of the phase declares a `knowledgeContext`. Every
    // selector of every run of this attempt — exact and active alike — is
    // resolved against this one document, so the runs of one attempt cannot
    // disagree about which revision "active" meant, and a revision committed
    // while the agents run is, by construction, not in any of their files.
    // A retry or a revise plans a new attempt and reads a new snapshot.
    // The same snapshot answers Phase 7's two questions — which rules a change
    // agent is accountable for, and which accepted proposal an implementation
    // run receives — so a change phase reads the ledger exactly once too.
    const contextSpecs = phaseDef.steps.map((sd) => effectiveContextSpec(phaseDef, sd));
    const needsLedger =
      contextSpecs.some((spec) => spec !== null) ||
      phaseDef.changeIntent !== undefined ||
      phaseDef.changeContext !== undefined;
    const ledgerSnapshot = needsLedger ? await readLedger() : null;
    // The repository revision a change-intent phase's conformance projection is
    // scoped to: the phase's own tree, read once. A change phase reads no code,
    // so this is only the commit the answer is *about* — never evidence.
    const changeGitHead = phaseDef.changeIntent ? await readGitHead(phaseDef.cwd) : null;
    // What is actually launched: one run per declared step, or `count` runs of
    // the single step a candidates phase has.
    const units = candidates
      ? Array.from({ length: candidates.count }, (_, i) => ({
          stepDef: phaseDef.steps[0],
          candidate: i as number | undefined,
        }))
      : phaseDef.steps.map((stepDef) => ({ stepDef, candidate: undefined as number | undefined }));

    // The accepted change intent this phase acts on (Phase 7 §downstream
    // handoff), resolved once per attempt from the same snapshot: it is a
    // phase-level selector, and every run of the attempt must receive exactly
    // the same approved intent. Resolved from the ledger's *accepted*
    // proposals only, so a proposal still staged at its gate resolves to
    // nothing and refuses the launch.
    let phaseChangeContext: PlannedChangeContext | null = null;
    if (phaseDef.changeContext) {
      const spec = phaseDef.changeContext;
      const accepted = ledgerSnapshot
        ? acceptedChangeProposalOfPhase(ledgerSnapshot, inst.id, spec.fromPhase)
        : null;
      if (!accepted) {
        phaseChangeContext = {
          error:
            `change context: phase "${spec.fromPhase}" has no accepted ChangeProposal on this ` +
            "instance; a staged proposal waiting at a gate is deliberately not readable here",
        };
      } else if ((spec.requireReady ?? true) && accepted.readiness !== "ready") {
        phaseChangeContext = {
          error:
            `change context: the accepted proposal ${accepted.id} from phase ` +
            `"${spec.fromPhase}" is ${accepted.readiness}; it has unresolved questions or ` +
            "uncovered rule changes, so it may not drive an implementation",
        };
      } else {
        phaseChangeContext = { accepted, text: buildChangeContext(accepted, startedAt).text };
      }
    }
    // The change realization this attempt belongs to (Phase 8). Opened before
    // any run is planned — and therefore before any agent exists — so "which
    // implementation run was intended to realize CP-12?" is answerable even if
    // every one of them crashes.
    const plannedRealization = await planRealization(
      def,
      inst,
      phaseDef,
      progress,
      phaseChangeContext,
      ledgerSnapshot,
      startedAt,
    );
    if (plannedRealization && "realization" in plannedRealization) {
      progress.realization = {
        id: plannedRealization.realization.id,
        proposalId: plannedRealization.realization.proposalId,
        attempt: plannedRealization.attempt,
        kind: plannedRealization.kind,
        maxAttempts: plannedRealization.realization.maxAttempts,
      };
    } else {
      delete progress.realization;
    }
    // The acceptance criteria this attempt must answer for (Phase 8). Exactly
    // the accepted proposal's own, so there is no second selection mechanism
    // here any more than there is for rules.
    const plannedAcceptance =
      phaseDef.acceptanceVerification && phaseChangeContext && "accepted" in phaseChangeContext
        ? {
            proposalId: phaseChangeContext.accepted.id,
            required: phaseChangeContext.accepted.acceptanceCriteria,
          }
        : null;
    if (plannedAcceptance && ledgerSnapshot) {
      const linked = changeRealizationOfPhase(
        ledgerSnapshot,
        inst.id,
        phaseDef.acceptanceVerification!.implementationPhase,
      );
      if (linked) {
        progress.realization = {
          id: linked.id,
          proposalId: linked.proposalId,
          attempt: Math.max(1, linked.attempts.length + 1),
          kind: linked.attempts.length > 0 ? "remediation" : "implementation",
          maxAttempts: linked.maxAttempts,
        };
      }
    }

    const planned: PlannedRun[] = [];
    for (const { stepDef, candidate } of units) {
      let workspace = progress.workspace ?? null;
      if (candidates && policy && policy.scope !== "none") {
        try {
          workspace = await ensureWorkspace(inst, phaseDef, progress, policy, candidate);
        } catch (e) {
          await failPhaseConfiguration(
            def,
            inst,
            phaseDef.id,
            e instanceof Error ? e.message : String(e),
          );
          return;
        }
      }
      // Where this run's work actually happens: its worktree, else the phase's
      // own directory exactly as before workspaces existed.
      const cwd = workspace?.path ?? phaseDef.cwd;
      const own =
        candidate === undefined ? artifactDir : candidateArtifactDir(artifactDir, candidate);
      // Cycled, so `count: 4` with two variants alternates them. Absent = the
      // step's own settings, which is what makes `count` alone mean "sample the
      // same thing N times".
      const variant =
        candidates && candidate !== undefined && candidates.variants?.length
          ? candidates.variants[candidate % candidates.variants.length]
          : undefined;
      const runId = deps.newId();
      const publishes = stepDef.name === publishingStep;
      // This run's semantic context, frozen now. A selector the snapshot
      // cannot resolve is carried to the launch as the reason the step will
      // not start — the definition names knowledge the ledger does not hold.
      const contextSpec = effectiveContextSpec(phaseDef, stepDef);
      let knowledgeContext: PlannedKnowledgeContext | null = null;
      if (contextSpec && ledgerSnapshot) {
        try {
          knowledgeContext = {
            resolved: resolveKnowledgeContext(ledgerSnapshot, contextSpec, startedAt, {
              instanceId: inst.id,
              phaseStatus: (id) => inst.phases.find((ph) => ph.id === id)?.status ?? null,
            }),
          };
        } catch (e) {
          knowledgeContext = {
            error:
              e instanceof KnowledgeContextError
                ? `knowledge context ${e.code}: ${e.message}`
                : e instanceof Error
                  ? e.message
                  : String(e),
          };
        }
      }
      // The change-intent input (Phase 7), frozen now for the same reason the
      // semantic context is: every run of one attempt must answer the same
      // request against the same reading of the ledger. The rules the run is
      // accountable for are exactly the ones its KnowledgeContext supplied —
      // there is no second selection mechanism — and their current
      // implementation conformance is projected at the commit the run will
      // work at.
      let changeIntent: PlannedChangeIntent | null = null;
      if (phaseDef.changeIntent) {
        const resolved = resolveChangeRequest(phaseDef, inst, progress.attempt, startedAt);
        if ("error" in resolved) {
          changeIntent = { error: resolved.error };
        } else {
          const request = resolved.request;
          const supplied =
            knowledgeContext && "resolved" in knowledgeContext
              ? knowledgeContext.resolved.supplied
              : [];
          const selected = selectedChangeRules(ledgerSnapshot, supplied, phaseDef.changeIntent);
          const built = buildChangeIntentInput(
            ledgerSnapshot,
            request,
            selected,
            changeGitHead,
            startedAt,
          );
          changeIntent = { request, selected, relevant: built.relevant, text: built.text };
        }
      }
      // The accepted change intent this run implements (Phase 7 §downstream
      // handoff). Resolved from the ledger's *accepted* proposals only, so a
      // proposal still staged at its gate resolves to nothing and refuses the
      // launch — unapproved intent can never reach an implementation run.
      const changeContext = phaseChangeContext;
      // Narrowest wins: a candidate's variant names its runtime, else the step,
      // else its phase, else the pipeline, else the server default. Resolved and
      // written down here, so a mixed-runtime pipeline stays readable on the
      // board and in the record.
      const runtime = resolveRuntimeId(
        variant?.runtime,
        stepDef.runtime,
        phaseDef.runtime,
        def.runtime,
      );
      const timeoutSeconds = resolveTimeoutSeconds(phaseDef, stepDef);
      const stallSeconds = resolveStallSeconds(phaseDef, stepDef);
      // Argus-injected blocks ride after the agent's own prompt, in a fixed
      // order, with the retry note last: the note is what matters most on a
      // retry, and recency in the prompt is what the model weighs most (see
      // docs/HARNESS-RESEARCH.md §2 #5, "lost in the middle").
      const rendered = interpolate(
        stepDef.prompt,
        prevPayload,
        inst.artifacts ?? {},
        { own, byPhase },
        {
          triggerPayload: inst.triggerPayload,
          memory: memoryText,
          previousInstanceSummary,
          maxPlaceholderBytes: def.contextLimits?.placeholderBytes,
          contextDir: runInvocationDir(runId),
        },
      );
      const run: Run = {
        id: runId,
        scheduleId: `pipeline:${inst.pipelineId}`,
        scheduleName: `${inst.pipelineName} · ${phaseDef.name}`,
        prompt:
          rendered.prompt +
          (publishes ? resultInstruction(phaseDef.result) : "") +
          artifactInstruction(phaseDef.checks, own) +
          discoveryInstruction(phaseDef.discovery) +
          // Business-rule verification (Phase 6): the rules this run is
          // accountable for are exactly the business rules its own
          // KnowledgeContext supplies — there is no second selection
          // mechanism — so the instruction can name them, and Argus can hold
          // the answer to them.
          verificationInstruction(
            phaseDef.ruleVerification,
            knowledgeContext && "resolved" in knowledgeContext
              ? selectedRules(
                  ledgerSnapshot,
                  knowledgeContext.resolved.supplied,
                  phaseDef.ruleVerification,
                )
              : [],
          ) +
          // Change-intent reasoning (Phase 7): the request, the rules this run
          // must account for, and their current implementation conformance —
          // context for the reasoning, never a reason to change a rule.
          changeIntentInstruction(
            phaseDef.changeIntent,
            changeIntent && "error" in changeIntent ? null : (changeIntent?.request ?? null),
            changeIntent && "error" in changeIntent ? [] : (changeIntent?.relevant ?? []),
          ) +
          changeContextInstruction(
            changeContext && "accepted" in changeContext ? changeContext.accepted : null,
          ) +
          // Targeted implementation (Phase 8): where the ledger says this
          // change lives, and — on a remediation — exactly what the previous
          // attempt left unmet. Both are provenance Argus derived, never an
          // agent's recollection of a previous transcript.
          implementationScopeInstruction(
            plannedRealization && "realization" in plannedRealization
              ? plannedRealization.scope
              : null,
          ) +
          remediationInstruction(
            plannedRealization && "realization" in plannedRealization
              ? (plannedRealization.remediation?.context ?? null)
              : null,
          ) +
          acceptanceInstruction(
            phaseDef.acceptanceVerification,
            plannedAcceptance?.proposalId ?? null,
            plannedAcceptance?.required ?? [],
          ) +
          memoryInstruction(memoryPolicy) +
          (knowledgeContext && "resolved" in knowledgeContext
            ? knowledgeContextInstruction(knowledgeContext.resolved.supplied)
            : "") +
          noteSuffix,
        cwd,
        status: "running",
        trigger: "scheduled",
        queuedAt: startedAt,
        startedAt,
        endedAt: null,
        durationMs: null,
        pid: null,
        exitCode: null,
        sessionId: runtimeFor(runtime).capabilities.presetSessionId ? deps.newId() : null,
        model: variant?.model ?? stepDef.model ?? def.model,
        reasoningEffort: variant?.reasoningEffort ?? stepDef.reasoningEffort ?? def.reasoningEffort,
        runtime,
        project: encodeProject(cwd),
        resultSummary: null,
        error: null,
        instanceId: inst.id,
        phaseId: phaseDef.id,
        // The deadline is set at spawn, not here: a step may wait for a
        // concurrency slot first, and waiting is not running.
        deadlineAt: null,
        stallSeconds,
      };
      planned.push({
        stepDef,
        run,
        publishes,
        timeoutSeconds,
        candidate,
        artifactDir: own,
        workspace,
        contextFiles: rendered.contextFiles,
        knowledgeContext,
        changeIntent,
        changeContext,
        realization: plannedRealization,
        acceptance: plannedAcceptance,
      });
    }
    // Record the runIds on the instance up front, then persist once (no write races).
    progress.steps = planned.map(({ stepDef, run, candidate, workspace }) => ({
      name: stepDef.name,
      runId: run.id,
      status: "running" as const,
      ...(candidate === undefined ? {} : { candidate }),
      ...(candidate === undefined ? {} : { workspace }),
    }));
    progress.status = "running";
    // A fresh attempt starts with no discovery summary: the previous
    // attempt's counts describe candidates that are already superseded, and
    // leaving them on the board would say "1 rule waiting on you" about a
    // proposal nobody can accept any more.
    delete progress.discovery;
    // Same for the verification summary: an abandoned attempt's outcomes
    // describe results that can never become durable.
    delete progress.ruleVerification;
    // And the change-intent summary: a superseded attempt's proposal describes
    // a transition nobody can accept any more.
    delete progress.changeIntent;
    // And the acceptance summary: an abandoned attempt's criterion outcomes
    // describe an implementation that is no longer the one being judged.
    delete progress.acceptanceVerification;
    await saveInstance(inst);
    void journal(inst.id, {
      at: startedAt,
      kind: "phase.started",
      phaseId: phaseDef.id,
      attempt: progress.attempt,
      detail: candidates
        ? `${planned.length} candidates`
        : `${planned.length} step${planned.length === 1 ? "" : "s"}`,
    });
    // Every attempt starts with an empty artifact directory: a file left by a
    // previous attempt must never satisfy this attempt's checks or mislead the
    // agent about what it has already done.
    await rm(artifactDir, { recursive: true, force: true });
    await mkdir(artifactDir, { recursive: true });
    for (const unit of planned) {
      if (unit.artifactDir !== artifactDir) await mkdir(unit.artifactDir, { recursive: true });
    }

    // Launch each run: acquire a slot, spawn, and persist the pid. Callers on
    // the HTTP request path (start/approve/revise) await these launches so the
    // spawn is observable when they return. The concurrency cap still applies —
    // a launch past the cap waits for a slot, which is fine here because these
    // callers hold no slot of their own. Candidates are ordinary runs in that
    // respect: `count` of them take `count` slots, and queue when the cap is
    // smaller than the count.
    const unlaunchable: { run: Run; reason: string }[] = [];
    for (const unit of planned) {
      const { stepDef, run, publishes, timeoutSeconds, candidate } = unit;
      // A working-tree baseline for `changed-files` checks, kept out of the
      // agent's reach (beside the invocation records, not in the artifact dir).
      // Per candidate, because each candidate has a tree of its own and is
      // judged on what *it* changed.
      let baseline: WorkingTreeSnapshot | null = null;
      if (phaseDef.checks?.some((c) => c.kind === "changed-files")) {
        baseline = await snapshotWorkingTree(run.cwd);
        const file = phaseBaselinePath(
          paths.invocationsDir(),
          inst.id,
          phaseDef.id,
          progress.attempt,
          candidate,
        );
        if (baseline) await atomicWriteJson(file, baseline);
        else await rm(file, { force: true });
      }
      const gitHead = baseline?.head ?? (await readGitHead(run.cwd));
      const launched = await launchStep(run, {
        def,
        phaseDef,
        stepDef,
        inst,
        publishes,
        artifactDir: unit.artifactDir,
        timeoutSeconds,
        gitHead,
        workspace: unit.workspace,
        memoryDir,
        contextFiles: unit.contextFiles,
        knowledgeContext: unit.knowledgeContext,
        changeIntent: unit.changeIntent,
        changeContext: unit.changeContext,
        realization: unit.realization,
        acceptance: unit.acceptance,
      });
      void journal(inst.id, {
        at: nowISO(),
        kind: "step.spawned",
        phaseId: phaseDef.id,
        runId: run.id,
        detail:
          ("handle" in launched
            ? `pid ${run.pid ?? "unknown"}`
            : launched.failure === "configuration"
              ? `not launched: ${launched.reason}`
              : "spawn failed") + (candidate === undefined ? "" : ` (c${candidate})`),
      });
      if ("handle" in launched) trackStep(run, launched.handle, startedAt, inst.id, phaseDef.id);
      else if (launched.failure === "configuration")
        unlaunchable.push({ run, reason: launched.reason });
    }

    // A step Argus refused to launch as declared fails its phase now, under the
    // `configuration` class — never retried, because the definition is what is
    // wrong. (A spawn *error* keeps its existing path: the run record says
    // failed and the reconcile pass classes it as `spawn`.)
    const readyAfterFailure: number[] = [];
    for (const { run, reason } of unlaunchable) {
      if (inst.status !== "running") break;
      readyAfterFailure.push(
        ...failStepInPlace(def, inst, phaseDef.id, run.id, "configuration", reason).startPhases,
      );
    }
    if (unlaunchable.length > 0) {
      await saveInstance(inst);
      if (candidates) {
        // A candidate Argus would not launch as declared is one candidate lost,
        // not a phase lost: the others may still win, and the phase only fails
        // when none of them can.
        await settleCandidates(def, inst, phaseDef.id);
      } else {
        // Siblings that did launch belong to a phase that has already failed.
        await killPhaseRuns(inst, [phaseDef.id], "stopped: phase failed");
        queueReadyPhases(inst.id, def, inst, readyAfterFailure);
        if (inst.status === "failed") deps.onFailure?.(inst);
      }
    }
    deps.onChange?.();
  }

  /**
   * A phase the instance has but the definition no longer names. Nothing was
   * spawned for this attempt (its steps carry no runId), so there is nothing
   * to kill; the phase fails under `configuration`, the instance settles, and
   * whatever that makes ready is queued exactly as after any other failure.
   */
  // ── Change realization (Phase 8) ──────────────────────────────────────────
  //
  // The loop the whole phase exists for:
  //
  //   accepted ChangeProposal
  //     ↓ deterministic scope from provenance Argus already holds
  //   implementation run       (KnowledgeContext + ChangeContext + scope)
  //     ↓ Argus's own PhaseChecks
  //   verification run         (RuleVerification + AcceptanceVerification)
  //     ↓ the completion invariant, evaluated from Argus's records alone
  //   succeeded  |  targeted remediation  |  a terminal, explained failure
  //
  // Four separate dimensions decide it and none of them is an agent's word
  // about its own work. `ARGUS_OUTCOME: succeeded` decides one of them.

  /**
   * `${instanceId}:${phaseId}:${attempt}` for every implementation attempt
   * whose repository state this process has already snapshotted. In memory
   * only, and deliberately: it prevents a repeat within one process, and a
   * restart legitimately takes a fresh reading.
   */
  const implementationSnapshots = new Set<string>();

  /** Phase statuses from which a phase never moves again. */
  const TERMINAL_PHASE: PhaseProgress["status"][] = ["succeeded", "failed", "skipped", "aborted"];

  /** The largest `maxAttempts` an author may configure, and the default. */
  const REALIZATION_ATTEMPT_CAP = 8;
  const DEFAULT_REALIZATION_ATTEMPTS = 2;

  /**
   * Open (or continue) the realization an implementation phase attempt belongs
   * to, and derive everything its runs receive.
   *
   * Three things refuse the launch here rather than after an agent has run:
   *
   * - **a stale semantic target** — the accepted proposal's revisions are no
   *   longer the domain's active ones, so implementing them would realize
   *   intent the business has already moved past (§preflight). Configurable
   *   off for a deliberately historical operation;
   * - **an exhausted attempt budget** — the loop's bound, checked before the
   *   spawn so an exhausted realization terminates rather than looping;
   * - **an unusable proposal** — no accepted intent resolved at all, which the
   *   `changeContext` error already says.
   */
  async function planRealization(
    def: PipelineDefinition,
    inst: PipelineInstance,
    phaseDef: PhaseDef,
    progress: PhaseProgress,
    changeContext: PlannedChangeContext | null,
    ledger: Awaited<ReturnType<typeof readLedger>> | null,
    now: string,
  ): Promise<PlannedRealization | null> {
    const policy = phaseDef.implementation;
    if (!policy) return null;
    if (!changeContext || "error" in changeContext) {
      // The changeContext error is already the launch refusal; saying it twice
      // would only make the failure reason worse.
      return null;
    }
    if (!ledger) return { error: "change realization: the ledger could not be read" };
    const accepted = changeContext.accepted;
    const maxAttempts = Math.min(
      REALIZATION_ATTEMPT_CAP,
      Math.max(1, policy.maxAttempts ?? DEFAULT_REALIZATION_ATTEMPTS),
    );

    // Preflight: is the intent this proposal carries still the current intent?
    if (policy.requireCurrentIntent !== false) {
      const currency = realizationIntentCurrency(ledger, accepted.semanticChanges);
      if (!currency.current) {
        return {
          error:
            `change realization: the accepted proposal ${accepted.id} targets ` +
            `${currency.superseded.map((x) => formatClaimRef(x.from)).join(", ")}, which ` +
            `${currency.superseded.length === 1 ? "is" : "are"} no longer the active revision` +
            `${currency.superseded.length === 1 ? "" : "s"} (now ` +
            `${currency.superseded.map((x) => formatClaimRef(x.to)).join(", ")}). The domain has ` +
            "moved past this intent; a new change decision is required, not an implementation of " +
            "the old one",
        };
      }
    }

    const existing = changeRealizationOfPhase(ledger, inst.id, phaseDef.id);
    const scope =
      existing?.scope ??
      deriveImplementationScope(ledger, accepted, {
        includePreserved: policy.includePreserved ?? true,
        now,
      });
    // The scope is derived once and frozen on the realization: a remediation
    // realizes the same accepted intent as attempt 1, against the same
    // provenance, and a scope that drifted between attempts would make the
    // history unreadable.
    let realization: ChangeRealization;
    try {
      realization = (
        await openChangeRealization(
          {
            proposalId: accepted.id,
            target: accepted.semanticChanges,
            instanceId: inst.id,
            phaseId: phaseDef.id,
            ...(realizationVerifierOf(def, phaseDef.id)
              ? { verificationPhaseId: realizationVerifierOf(def, phaseDef.id)! }
              : {}),
            maxAttempts,
            scope,
          },
          deps.now(),
        )
      ).realization;
    } catch (e) {
      return { error: `change realization: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (realization.outcome) {
      return {
        error: `change realization ${realization.id} already ended as ${realization.outcome.status}: ${realization.outcome.reason}`,
      };
    }
    const attempt = realization.attempts.length + 1;
    if (attempt > realization.maxAttempts) {
      return {
        error:
          `change realization ${realization.id} has used all ${realization.maxAttempts} configured ` +
          "attempts; autonomous remediation is bounded and this one is exhausted",
      };
    }
    const kind: "implementation" | "remediation" = attempt === 1 ? "implementation" : "remediation";
    let remediation: { context: RemediationContext; text: string } | null = null;
    if (kind === "remediation") {
      const previous = realization.attempts[realization.attempts.length - 1];
      const verdict: CompletionVerdict = {
        outcome: previous.outcome,
        reason: previous.reason ?? previous.outcome,
        ruleResults: previous.ruleResults,
        acceptanceResults: previous.acceptanceResults,
        remediable: true,
      };
      const runs = previous.verification.map((v) => v.runId);
      const context = buildRemediationContext({
        realization,
        proposal: accepted,
        ledger,
        attempt,
        previous: verdict,
        ruleVerifications: ledger.verifications.filter((v) => runs.includes(v.execution.runId)),
        acceptanceVerifications: ledger.acceptanceVerifications.filter((v) =>
          runs.includes(v.execution.runId),
        ),
        now,
      });
      remediation = { context, text: remediationContextText(context) };
    }
    void journal(inst.id, {
      at: now,
      kind: attempt === 1 ? "realization.started" : "realization.remediation-started",
      phaseId: phaseDef.id,
      attempt: progress.attempt,
      detail: `${realization.id} → ${accepted.id} (attempt ${attempt}/${realization.maxAttempts}; ${describeScope(scope)})`,
    });
    return {
      realization,
      attempt,
      kind,
      scope,
      scopeText: implementationScopeText(scope),
      remediation,
    };
  }

  /** The phase that verifies one implementation phase's realization, from the
   *  definition alone: the one whose `acceptanceVerification` names it. */
  function realizationVerifierOf(def: PipelineDefinition, phaseId: string): string | null {
    return (
      def.phases.find((p) => p.acceptanceVerification?.implementationPhase === phaseId)?.id ?? null
    );
  }

  async function failUnlaunchable(
    def: PipelineDefinition,
    inst: PipelineInstance,
    phaseId: string,
  ): Promise<void> {
    log.warn("phase cannot be launched: not in the pipeline definition", {
      instanceId: inst.id,
      pipelineId: def.id,
      phaseId,
    });
    await failPhaseConfiguration(
      def,
      inst,
      phaseId,
      `phase "${phaseId}" no longer exists in pipeline "${def.name}"`,
    );
  }

  /**
   * A phase that cannot be launched at all: nothing was spawned for this
   * attempt, so there is nothing to kill. The phase fails under
   * `configuration` — never retried, because what is wrong is the definition,
   * not the weather — the instance settles, and whatever that makes ready is
   * queued exactly as after any other failure.
   */
  async function failPhaseConfiguration(
    def: PipelineDefinition,
    inst: PipelineInstance,
    phaseId: string,
    reason: string,
  ): Promise<void> {
    const res = applyUnlaunchable(def, inst, phaseId, reason, nowISO());
    const phase = res.instance.phases.find((p) => p.id === phaseId);
    if (phase?.status === "failed") {
      void journal(inst.id, {
        at: nowISO(),
        kind: "phase.failed",
        phaseId,
        attempt: phase.attempt,
        detail: `configuration: ${reason}`,
      });
    }
    noteRouting(def, res.instance, res.routing);
    await saveInstance(res.instance);
    if (res.instance.status === "succeeded" || res.instance.status === "failed") {
      void journal(inst.id, { at: nowISO(), kind: "instance.ended", detail: res.instance.status });
    }
    queueReadyPhases(inst.id, def, res.instance, res.startPhases);
    if (res.instance.status === "failed") deps.onFailure?.(res.instance);
    deps.onChange?.();
  }

  /**
   * Fail one step of a running phase from inside a transition that already
   * holds the instance (in memory, under the lock): the failure signal, its
   * class, the retry decision and the journal entries, in one place.
   */
  function failStepInPlace(
    def: PipelineDefinition,
    inst: PipelineInstance,
    phaseId: string,
    runId: string,
    failureClass: PhaseFailureClass,
    reason: string,
    extra: Record<string, unknown> = {},
  ): TransitionResult {
    const res = advance(
      def,
      inst,
      {
        instanceId: inst.id,
        phaseId,
        runId,
        type: "failed",
        token: inst.signalToken,
        payload: { reason, ...extra },
      },
      nowISO(),
      failureClass,
    );
    const phase = res.instance.phases.find((p) => p.id === phaseId);
    if (phase?.status === "failed") {
      phase.payload = withFailureClass(phase.payload, failureClass);
      if (failureClass !== "configuration") {
        noteFailure(def, res.instance, phaseId, failureClass, reason);
      } else {
        void journal(inst.id, {
          at: nowISO(),
          kind: "phase.failed",
          phaseId,
          attempt: phase.attempt,
          detail: `configuration: ${reason}`,
        });
      }
    }
    noteRouting(def, res.instance, res.routing);
    void journal(inst.id, {
      at: nowISO(),
      kind: "phase.signalled",
      phaseId,
      runId,
      detail: `harness: ${failureClass}`,
    });
    if (res.instance.status === "succeeded" || res.instance.status === "failed") {
      void journal(inst.id, { at: nowISO(), kind: "instance.ended", detail: res.instance.status });
    }
    return res;
  }

  interface LaunchContext {
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
  }

  /**
   * The {@link ChangeRequest} one change-intent phase attempt answers.
   *
   * Two sources, in a fixed precedence, and no third:
   *
   * - the **instance's trigger payload**, when it carries a `changeRequest`.
   *   A request supplied when this particular run was started is more specific
   *   than the pipeline's default, so it wins;
   * - the phase's authored `changeIntent.request`.
   *
   * An error when neither resolves, or when a supplied one is malformed —
   * which fails the step as `configuration` before any process starts. Argus
   * never invents a request, and never silently falls back from a malformed
   * supplied one to the pipeline's default: the run would then answer a
   * different question from the one somebody asked.
   *
   * The request is given an identity here when its author gave it none, keyed
   * to the phase attempt so both runs of one attempt answer the same request.
   */
  function resolveChangeRequest(
    phaseDef: PhaseDef,
    inst: PipelineInstance,
    attempt: number,
    now: string,
  ): { request: ChangeRequest } | { error: string } {
    const fromTrigger = (inst.triggerPayload as { changeRequest?: unknown } | undefined)
      ?.changeRequest;
    let request: ChangeRequest | null = null;
    if (fromTrigger !== undefined && fromTrigger !== null) {
      try {
        request = validateChangeRequest(fromTrigger, "triggerPayload.changeRequest");
      } catch (e) {
        return {
          error: `change intent: the ChangeRequest supplied with this instance is invalid: ${
            e instanceof Error ? e.message : String(e)
          }`,
        };
      }
    }
    request ??= phaseDef.changeIntent?.request ?? null;
    if (!request) {
      return {
        error:
          `change intent: phase "${phaseDef.id}" declares changeIntent but no ChangeRequest ` +
          "was supplied — author one on the phase, or start the instance with a " +
          "triggerPayload carrying `changeRequest`",
      };
    }
    return {
      request: requestWithIdentity(request, `CR-${inst.id}-${phaseDef.id}-${attempt}`, now),
    };
  }

  type Launched =
    { handle: PipelineProcessHandle } | { failure: "spawn" | "configuration"; reason: string };

  /**
   * Prepare, record and spawn one step, persisting its pid.
   *
   * Preparation decides everything before the process exists: the runtime maps
   * the step's capability profile onto flags and config files, the environment
   * policy is applied, and the invocation record is written — so even a step
   * that never launches leaves a record of what Argus would have run and why it
   * refused. Under strict enforcement a profile the runtime cannot honour is a
   * `configuration` failure; the step does not launch with more capability than
   * its author declared.
   */
  async function launchStep(run: Run, ctx: LaunchContext): Promise<Launched> {
    await sem.acquire();
    const env: Record<string, string> = {
      ARGUS_SIGNAL_URL: `${deps.signalUrlBase}/api/instances/${ctx.inst.id}/signal`,
      ARGUS_INSTANCE_ID: ctx.inst.id,
      ARGUS_PHASE_ID: ctx.phaseDef.id,
      ARGUS_RUN_ID: run.id,
      ARGUS_STEP_NAME: run.scheduleName,
      ARGUS_SIGNAL_TOKEN: ctx.inst.signalToken,
      // Which CLI the hook is running under. One hook file serves both, and the
      // two deliver slightly different Stop payloads; this removes the guess.
      ARGUS_RUNTIME: resolveRuntimeId(run.runtime),
      // Where this phase's file artifacts go; later phases read them from here.
      ARGUS_ARTIFACT_DIR: ctx.artifactDir,
    };
    // The isolated worktree the step is already running in, named so a script
    // (or a nested tool) does not have to derive it from `pwd`. Per-invocation,
    // and therefore stripped from the inherited environment by buildChildEnv.
    if (ctx.workspace) env.ARGUS_WORKSPACE = ctx.workspace.path;
    // This pipeline's durable-notes directory, when `memory` is enabled.
    if (ctx.memoryDir) env.ARGUS_MEMORY_DIR = ctx.memoryDir;
    // The result file is named for every runtime, hook or no hook: the agent
    // writes the same file either way, and a runtime without a command hook has
    // it read off disk on the next reconcile tick instead.
    let resultFile: string | null = null;
    if (ctx.publishes) {
      resultFile = runResultPath(run.id);
      await mkdir(path.dirname(resultFile), { recursive: true });
      env.ARGUS_RESULT_FILE = resultFile;
    }
    // Where this run may propose semantic knowledge (docs/KNOWLEDGE-LEDGER.md
    // § KnowledgeDelta protocol). Named for every run, like the result file:
    // an agent that has nothing to propose writes nothing, and the engine
    // reads the file — or its absence — when the run completes.
    //
    // The one exception (Phase 8 §protocol channels match phase
    // responsibilities): a change-intent run's semantic half travels inside
    // its ChangeProposal, and a run that writes both files is refused
    // outright — so it is not told a path whose use would fail the step. The
    // refusal itself does not depend on the variable: the engine reads the
    // per-run path either way, so an agent that writes there unbidden is
    // still caught.
    const offersDelta = ctx.phaseDef.changeIntent === undefined;
    const deltaFile = offersDelta ? knowledgeDeltaFile(run.id) : null;
    if (deltaFile) env.ARGUS_KNOWLEDGE_DELTA_FILE = deltaFile;
    const invocationDir = runInvocationDir(run.id);
    // A semantic context the planning snapshot could not resolve refuses the
    // step here, as a `configuration` failure: the definition names knowledge
    // the ledger does not hold, and running again cannot change that. The two
    // change-intent inputs (Phase 7) refuse it the same way and for the same
    // reason: a change phase with no request, or an implementation phase whose
    // intent is unapproved or unfinished, must not launch an agent at all.
    const plannedError =
      (ctx.knowledgeContext && "error" in ctx.knowledgeContext
        ? ctx.knowledgeContext.error
        : null) ??
      (ctx.changeIntent && "error" in ctx.changeIntent ? ctx.changeIntent.error : null) ??
      (ctx.changeContext && "error" in ctx.changeContext ? ctx.changeContext.error : null) ??
      // Phase 8's two preconditions: the accepted intent this realization
      // targets must still be the domain's current intent, and the attempt
      // budget must not be spent. Both refuse the launch as `configuration`
      // rather than starting an agent against work that cannot count.
      (ctx.realization && "error" in ctx.realization ? ctx.realization.error : null);
    if (plannedError) {
      sem.release();
      const reason = plannedError;
      await writeRun({
        ...run,
        status: "failed",
        termination: "spawn-failed",
        error: reason,
        endedAt: nowISO(),
      });
      return { failure: "configuration", reason };
    }
    // The read-only KnowledgeContext (docs/KNOWLEDGE-LEDGER.md § KnowledgeContext
    // protocol): materialized in the run's own invocation directory before the
    // process exists, named to the agent by the variable, and recorded on the
    // invocation — exact refs and the file's hash — as what Argus supplied.
    const resolvedContext =
      ctx.knowledgeContext && "resolved" in ctx.knowledgeContext
        ? ctx.knowledgeContext.resolved
        : null;
    const contextFile = resolvedContext ? knowledgeContextFile(run.id) : null;
    if (contextFile) env.ARGUS_KNOWLEDGE_CONTEXT_FILE = contextFile;
    // Where a verification phase's run must leave its conformance results
    // (docs/KNOWLEDGE-LEDGER.md § Phase 6). Its own Argus-owned sidecar,
    // deliberately not the KnowledgeDelta: a conformance result is not a
    // knowledge mutation, and sharing the channel would invite an agent to
    // express "the code violates this rule" as opposing evidence on the rule.
    const verificationFile = ctx.phaseDef.ruleVerification ? ruleVerificationFile(run.id) : null;
    if (verificationFile) env.ARGUS_RULE_VERIFICATION_FILE = verificationFile;
    // The change-intent channels (docs/KNOWLEDGE-LEDGER.md § Phase 7): the
    // request Argus materializes for the run to read, and the proposal file it
    // must answer with. Its own sidecar, deliberately not the KnowledgeDelta:
    // a proposal carries what is preserved, how success is judged and what is
    // unresolved, none of which are claims.
    const plannedIntent =
      ctx.changeIntent && "request" in ctx.changeIntent ? ctx.changeIntent : null;
    const requestFile = plannedIntent ? changeRequestFile(run.id) : null;
    const proposalFile = plannedIntent ? changeProposalFile(run.id) : null;
    if (requestFile) env.ARGUS_CHANGE_REQUEST_FILE = requestFile;
    if (proposalFile) env.ARGUS_CHANGE_PROPOSAL_FILE = proposalFile;
    // And the downstream half: the accepted intent an implementation run acts
    // on, read-only, naming exact canonical revisions.
    const plannedChange =
      ctx.changeContext && "accepted" in ctx.changeContext ? ctx.changeContext : null;
    const changeFile = plannedChange ? changeContextFile(run.id) : null;
    if (changeFile) env.ARGUS_CHANGE_CONTEXT_FILE = changeFile;
    // The Phase 8 channels: the deterministic scope of the change this run is
    // realizing, the exact failures a remediation is fixing, and the file an
    // acceptance-verification run answers in. All three are Argus-owned, and
    // the two read ones are hashed at launch and re-hashed at completion.
    const plannedRealization =
      ctx.realization && "realization" in ctx.realization ? ctx.realization : null;
    const scopeFile = plannedRealization ? implementationScopeFile(run.id) : null;
    if (scopeFile) env.ARGUS_IMPLEMENTATION_SCOPE_FILE = scopeFile;
    const remediationFile = plannedRealization?.remediation ? remediationContextFile(run.id) : null;
    if (remediationFile) env.ARGUS_REMEDIATION_CONTEXT_FILE = remediationFile;
    const acceptanceFile = ctx.acceptance ? acceptanceVerificationFile(run.id) : null;
    if (acceptanceFile) env.ARGUS_ACCEPTANCE_VERIFICATION_FILE = acceptanceFile;
    let prepared: PreparedInvocation;
    const suppliedInputs: { kind: InvocationChannelKind; path: string; sha256: string }[] = [];
    try {
      await mkdir(invocationDir, { recursive: true });
      await ensureKnowledgeDeltaDir(run.id);
      if (verificationFile) await ensureRuleVerificationDir(run.id);
      if (contextFile && resolvedContext) {
        await writeKnowledgeContextFile(contextFile, resolvedContext.text);
      }
      if (proposalFile) await ensureChangeProposalDir(run.id);
      if (requestFile && plannedIntent) await writeReadOnlyInput(requestFile, plannedIntent.text);
      if (acceptanceFile) await ensureAcceptanceDir(run.id);
      // Every Argus-owned read-only input, written and hashed in one place, so
      // the completion can prove the bytes the agent read are the bytes Argus
      // supplied (Phase 8 §ChangeContext integrity). The KnowledgeContext is
      // not here: its hash is durable in the ledger, which is stronger.
      if (changeFile && plannedChange) {
        await writeReadOnlyInput(changeFile, plannedChange.text);
        suppliedInputs.push({
          kind: "change-context",
          path: changeFile,
          sha256: sha256Hex(plannedChange.text),
        });
      }
      if (scopeFile && plannedRealization) {
        await writeReadOnlyInput(scopeFile, plannedRealization.scopeText);
        suppliedInputs.push({
          kind: "implementation-scope",
          path: scopeFile,
          sha256: sha256Hex(plannedRealization.scopeText),
        });
      }
      if (remediationFile && plannedRealization?.remediation) {
        await writeReadOnlyInput(remediationFile, plannedRealization.remediation.text);
        suppliedInputs.push({
          kind: "remediation-context",
          path: remediationFile,
          sha256: sha256Hex(plannedRealization.remediation.text),
        });
      }
      // The clock the deadline runs from: now, with the slot held and the
      // process about to start.
      run.startedAt = nowISO();
      prepared = prepareInvocation({
        run,
        def: ctx.def,
        phaseDef: ctx.phaseDef,
        stepDef: ctx.stepDef,
        instanceId: ctx.inst.id,
        attempt: ctx.inst.phases.find((p) => p.id === ctx.phaseDef.id)?.attempt ?? 0,
        systemPrompt: STEP_CONTRACT,
        argusEnv: env,
        invocationDir,
        artifactDir: ctx.artifactDir,
        memoryDir: ctx.memoryDir,
        workspace: ctx.workspace,
        resultFile,
        knowledgeDeltaFile: deltaFile,
        ruleVerificationFile: verificationFile,
        changeRequestFile: requestFile,
        changeProposalFile: proposalFile,
        changeContextFile: changeFile,
        implementationScopeFile: scopeFile,
        remediationContextFile: remediationFile,
        acceptanceVerificationFile: acceptanceFile,
        suppliedInputs,
        knowledgeContext:
          contextFile && resolvedContext
            ? {
                file: contextFile,
                record: {
                  schemaVersion: 1,
                  claims: resolvedContext.supplied,
                  sha256: resolvedContext.sha256,
                },
              }
            : null,
        timeoutSeconds: ctx.timeoutSeconds,
        gitHead: ctx.gitHead,
        parentEnv: parentEnv(),
        now: new Date(run.startedAt),
      });
      run.deadlineAt = prepared.record.deadlineAt;
      await writeInvocation(prepared.record);
      // Durable supplied provenance (Phase 4.1, docs/KNOWLEDGE-LEDGER.md
      // §13.10): the identity of the context — exact refs, hash, when — goes
      // into `knowledge.json` *before* the process exists, so the answer to
      // "what did this run receive?" outlives the invocation directory that
      // is pruned with the run. Idempotent on the run id, so a retried
      // preparation or a reconcile re-observing the launch adds nothing; a
      // *different* context for the same run throws, and the throw is caught
      // below as a launch failure rather than rewriting history.
      if (resolvedContext) {
        await registerSuppliedContext(
          { runId: run.id, instanceId: ctx.inst.id, phaseId: ctx.phaseDef.id },
          {
            claims: resolvedContext.supplied,
            sha256: resolvedContext.sha256,
            attempt: prepared.record.attempt,
            schemaVersion: 1,
          },
          new Date(run.startedAt),
        );
        void journal(ctx.inst.id, {
          at: run.startedAt,
          kind: "knowledge.supplied",
          phaseId: ctx.phaseDef.id,
          runId: run.id,
          detail: `${resolvedContext.supplied.map(formatClaimRef).join(", ")} (sha256 ${resolvedContext.sha256.slice(0, 12)})`,
        });
      }
      for (const file of prepared.files) await writeFile(file.path, file.contents, "utf8");
      // Any placeholder {@link interpolate} trimmed for this run's prompt: the
      // full value, so the agent can still read the whole thing if it needs to.
      for (const file of ctx.contextFiles) {
        await mkdir(path.dirname(file.path), { recursive: true });
        await writeFile(file.path, file.contents, "utf8");
      }
    } catch (e) {
      sem.release();
      await writeRun({
        ...run,
        status: "failed",
        termination: "spawn-failed",
        error: String(e),
        endedAt: nowISO(),
      });
      return { failure: "spawn", reason: String(e) };
    }
    if (prepared.blocking.length > 0) {
      sem.release();
      const reason = `capability profile cannot be enforced by ${resolveRuntimeId(run.runtime)}: ${prepared.blocking.join("; ")}`;
      await writeRun({
        ...run,
        status: "failed",
        termination: "spawn-failed",
        error: reason,
        endedAt: nowISO(),
      });
      return { failure: "configuration", reason };
    }
    let handle: PipelineProcessHandle;
    try {
      const logPath = runLogPath(run.id);
      await mkdir(path.dirname(logPath), { recursive: true });
      handle = await Promise.resolve(deps.spawn(run, logPath, env, prepared));
    } catch (e) {
      sem.release();
      await writeRun({
        ...run,
        status: "failed",
        termination: "spawn-failed",
        error: String(e),
        endedAt: nowISO(),
      });
      return { failure: "spawn", reason: String(e) };
    }
    run.pid = handle.pid;
    await writeRun(run);
    deps.tailer?.track(run.id, ctx.inst.id, run.runtime);
    return { handle };
  }

  /** Await a launched step's completion off the request path, release its slot,
   *  and record the terminal state. Never throws. */
  function trackStep(
    run: Run,
    handle: { done: Promise<{ code: number | null }> },
    startedAt: string,
    instanceId: string,
    phaseId: string,
  ): void {
    let released = false;
    live.add(run.id);
    const release = () => {
      if (!released) {
        released = true;
        live.delete(run.id);
        sem.release();
      }
    };
    // The deadline is enforced from here while this process lives; after a
    // restart the reconcile pass enforces it from the persisted `deadlineAt`.
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (run.deadlineAt) {
      const wait = Math.max(0, Date.parse(run.deadlineAt) - deps.now().getTime());
      timer = setTimeout(() => {
        timer = null;
        void track(
          expireStep(run.id, instanceId, phaseId).catch((e) =>
            log.error("step deadline handler failed", { runId: run.id, err: e }),
          ),
        );
      }, wait);
    }
    void handle.done
      .then(async (res) => {
        release();
        if (timer) clearTimeout(timer);
        // The CLI's JSON result envelope is the last line of the log; harvest
        // cost/tokens/result from it so every completed step reports its spend
        // (not only runs finalized by the adopted-run reconcile path).
        const got = await readRun(run.id);
        const envelope = got
          ? parseEnvelopeFor(run.runtime, got.log, { model: got.run.model })
          : null;
        // A run Argus itself ended (deadline, abort) keeps the reason Argus
        // wrote; the exit code of a killed process explains nothing.
        const endedByArgus =
          got?.run.termination === "timed-out" ||
          got?.run.termination === "stalled" ||
          got?.run.termination === "killed";
        await patchRun(run.id, {
          status: res.code === 0 && !endedByArgus ? "succeeded" : "failed",
          endedAt: nowISO(),
          durationMs: deps.now().getTime() - new Date(startedAt).getTime(),
          exitCode: res.code,
          // Codex names its own thread; the id only becomes knowable once the
          // stream has reported it, which by now the log has.
          sessionId: got?.run.sessionId ?? envelope?.sessionId ?? null,
          resultSummary: envelope?.result ?? got?.run.resultSummary ?? null,
          costUsd: envelope?.costUsd ?? got?.run.costUsd ?? null,
          tokens: envelope?.tokens ?? got?.run.tokens ?? null,
          error: endedByArgus
            ? (got?.run.error ?? "stopped by Argus")
            : res.code === 0
              ? null
              : `exit code ${res.code}`,
        });
        await accumulateRun(run.id, deps.now);
        // The completion signal is authoritative and has already advanced the
        // phase; a process that then exits non-zero contradicts its own report.
        // Argus does not unwind downstream work over it, but it must not be
        // silent either: the journal names it, and the run record carries both
        // the outcome and the exit code for anyone reconciling the two.
        if (res.code !== 0 && !endedByArgus && got?.run.outcome === "succeeded") {
          void journal(instanceId, {
            at: nowISO(),
            kind: "step.exit-mismatch",
            phaseId,
            runId: run.id,
            detail: `signalled completed, then exited ${res.code ?? "on a signal"}`,
          });
        }
        deps.tailer?.untrack(run.id);
        deps.onChange?.();
      })
      .catch((e) => {
        release();
        if (timer) clearTimeout(timer);
        deps.tailer?.untrack(run.id);
        log.error("step run completion handler failed", { runId: run.id, err: e });
      });
  }

  /**
   * Kill a run's process tree, escalating to SIGKILL after a grace period if
   * it ignores the request. The escalation is best-effort and unawaited: the
   * transition that follows must not wait on a process that may never answer.
   */
  async function stopRun(pid: number | null): Promise<void> {
    if (!pid) return;
    try {
      await kill(pid);
    } catch {
      /* already gone */
    }
    const grace = deps.killGraceMs ?? 5000;
    const t = setTimeout(() => {
      // Sent to the group regardless of the leader: a child that outlived an
      // exited leader is exactly the process this exists to reach. Killing a
      // group that is already gone is a harmless error.
      void Promise.resolve(kill(pid, "SIGKILL")).catch(() => {});
    }, grace);
    // Never keep the server alive just to escalate a kill.
    if (typeof t === "object" && "unref" in t) t.unref();
  }

  /**
   * A step has reached its deadline while its process is still alive: record
   * why it is being ended (before the close handler can read the exit code),
   * stop it, and fail the phase under the `timeout` class. The phase's sibling
   * steps are stopped too — a failed phase has no use for their work, and a
   * process nobody is waiting for is a process that keeps spending.
   */
  async function expireStep(runId: string, instanceId: string, phaseId: string): Promise<void> {
    const got = await readRun(runId);
    if (!got || got.run.status !== "running") return;
    const seconds =
      got.run.deadlineAt && got.run.startedAt
        ? Math.round((Date.parse(got.run.deadlineAt) - Date.parse(got.run.startedAt)) / 1000)
        : null;
    const reason = seconds != null ? `timed out after ${seconds}s` : "timed out";
    // Nothing is written until the step is known to still be running: a step
    // whose completion signal already landed is not timed out, whatever its
    // process is still doing, and must not be stamped as if it were.
    await failStep(
      instanceId,
      phaseId,
      runId,
      "timeout",
      reason,
      { kind: "timed-out" },
      async () => {
        await patchRun(runId, { termination: "timed-out", error: reason });
        await stopRun(got.run.pid);
        void journal(instanceId, {
          at: nowISO(),
          kind: "step.timed-out",
          phaseId,
          runId,
          detail: reason,
        });
      },
    );
  }

  /**
   * A step's process is still alive, but its transcript has gone quiet for at
   * least its `stallSeconds` (§D, harness/stall.ts) — killed the same way a
   * hard timeout is, under the same `timeout` retry class (a stall is a
   * timeout that noticed sooner), with its own termination and reason so the
   * two are distinguishable in the record.
   */
  async function expireStalledStep(
    runId: string,
    instanceId: string,
    phaseId: string,
    stallSeconds: number,
  ): Promise<void> {
    const got = await readRun(runId);
    if (!got || got.run.status !== "running") return;
    const reason = `stalled: no output for ${stallSeconds}s`;
    await failStep(instanceId, phaseId, runId, "timeout", reason, { kind: "stalled" }, async () => {
      await patchRun(runId, { termination: "stalled", error: reason });
      await stopRun(got.run.pid);
      void journal(instanceId, {
        at: nowISO(),
        kind: "step.stalled",
        phaseId,
        runId,
        detail: reason,
      });
    });
  }

  /**
   * Fail a running step from outside the signal path (deadline, or any other
   * harness-side verdict), under the instance lock. Only a step still tracked
   * as running is failed: a completion signal that landed first has already
   * decided, and a late failure must not overturn it.
   */
  async function failStep(
    instanceId: string,
    phaseId: string,
    runId: string,
    failureClass: PhaseFailureClass,
    reason: string,
    extra: Record<string, unknown> = {},
    /** Runs under the lock once the failure is known to apply, before the transition. */
    beforeTransition?: () => Promise<void>,
  ): Promise<void> {
    await locks.withLock(instanceId, async () => {
      const inst = await readInstance(instanceId);
      if (!inst || inst.status !== "running") return;
      const phase = inst.phases.find((p) => p.id === phaseId);
      const step = phase?.steps.find((s) => s.runId === runId);
      if (!phase || phase.status !== "running" || step?.status !== "running") return;
      const def = await defFor(inst);
      if (!def) return;
      if (beforeTransition) await beforeTransition();
      const res = failStepInPlace(def, inst, phaseId, runId, failureClass, reason, extra);
      await patchRun(runId, { outcome: "failed" });
      await saveInstance(res.instance);
      if (res.candidatesMoved) {
        // One candidate timed out. Its siblings are the point of running
        // several, so they are left alone and the selection is re-asked.
        await settleCandidates(def, res.instance, res.candidatesMoved);
        deps.onChange?.();
        return;
      }
      await killPhaseRuns(res.instance, [phaseId], "stopped: phase failed");
      queueReadyPhases(instanceId, def, res.instance, res.startPhases);
      if (res.instance.status === "failed") deps.onFailure?.(res.instance);
      deps.onChange?.();
    });
  }

  /**
   * Kill any still-alive process spawned for the named phases, so a straggler
   * run can't keep executing (or later signal) against them.
   *
   * The phase ids are explicit rather than derived from "what is live" for two
   * reasons that pull in opposite directions, and both matter with a DAG:
   * aborting must reach phases the abort has *already* marked terminal, while
   * revising must **not** reach a sibling branch that is legitimately still
   * running.
   */
  async function killPhaseRuns(
    inst: PipelineInstance,
    phaseIds: string[],
    reason = "stopped by Argus",
  ): Promise<void> {
    const wanted = new Set(phaseIds);
    const steps = inst.phases.filter((p) => wanted.has(p.id)).flatMap((p) => p.steps);
    for (const s of steps) {
      if (!s.runId) continue;
      const got = await readRun(s.runId);
      if (got && got.run.status === "running" && isAlive(got.run.pid)) {
        // Written before the kill so the close handler reads the reason Argus
        // gave rather than inventing one from the exit code.
        if (!got.run.termination) {
          await patchRun(s.runId, { termination: "killed", error: reason });
        }
        await stopRun(got.run.pid);
      }
      deps.tailer?.untrack(s.runId);
    }
  }

  /**
   * Note the failure in the journal and, if the phase's policy allows it,
   * schedule another attempt.
   *
   * The retry is *scheduled* (a timestamp on the phase, persisted) rather than
   * awaited with a timer. A `setTimeout` would lose the retry on restart and
   * would hold the instance lock across the backoff; a stored `retryAt` that
   * the reconcile tick picks up survives a crash and costs nothing while it
   * waits. The trade is that backoff resolution is one scheduler tick, which
   * for a policy measured in seconds-to-minutes is not a trade at all.
   */
  function noteFailure(
    def: PipelineDefinition,
    inst: PipelineInstance,
    phaseId: string,
    failure: RetryableClass,
    reason: string,
  ): boolean {
    const phase = inst.phases.find((p) => p.id === phaseId);
    if (!phase || phase.status !== "failed") return false;
    phase.payload = withFailureClass(phase.payload, failure);
    void journal(inst.id, {
      at: nowISO(),
      kind: "phase.failed",
      phaseId,
      attempt: phase.attempt,
      detail: `${failure}: ${reason}`,
    });

    const policy = def.phases.find((p) => p.id === phaseId)?.retry;
    if (!shouldRetry(policy, phase.retries ?? 0, failure)) return false;

    const at = new Date(deps.now().getTime() + retryDelayMs(policy!, phase.retries ?? 0));
    phase.retryAt = at.toISOString();
    // The instance is no longer terminal: something is still going to happen.
    inst.status = "running";
    inst.endedAt = null;
    void journal(inst.id, {
      at: nowISO(),
      kind: "phase.retry-scheduled",
      phaseId,
      attempt: phase.attempt,
      detail: `attempt ${(phase.retries ?? 0) + 2} of ${policy!.attempts} at ${phase.retryAt}`,
    });
    return true;
  }

  /**
   * Journal what a transition did to the graph's routes, and put any route or
   * result failure through the same policy an ordinary failure gets.
   *
   * Returns true when a retry was scheduled, so the caller re-persists the
   * instance. Nothing here decides anything: settle already did, and this only
   * writes down what it decided.
   */
  function noteRouting(
    def: PipelineDefinition,
    inst: PipelineInstance,
    routing: RouteOutcome | undefined,
  ): boolean {
    if (!routing) return false;
    for (const decision of routing.decisions) {
      void journal(inst.id, {
        at: nowISO(),
        kind: "route.selection",
        phaseId: decision.sourcePhase,
        detail: `${decision.artifact} ${JSON.stringify(decision.value)} → ${decision.reason}`,
      });
    }
    for (const phaseId of routing.skipped) {
      void journal(inst.id, {
        at: nowISO(),
        kind: "route.skip",
        phaseId,
        detail: "not selected by an upstream route",
      });
    }
    let rescheduled = false;
    for (const failure of routing.failures) {
      void journal(inst.id, {
        at: nowISO(),
        kind: "route.failure",
        phaseId: failure.phaseId,
        detail: failure.reason,
      });
      // A result that never arrived, or arrived unusable, is an operational
      // signal failure: the agent reported, and what it reported cannot be
      // routed on. It gets the phase's own retry policy, never a branch.
      if (noteFailure(def, inst, failure.phaseId, "signal", failure.reason)) rescheduled = true;
    }
    return rescheduled;
  }

  /** Start every retry whose backoff has elapsed. Called from reconcile. */
  async function runDueRetries(now: Date): Promise<void> {
    for (const candidate of await readInstances()) {
      if (candidate.status !== "running" && candidate.status !== "failed") continue;
      if (!candidate.phases.some((p) => p.retryAt)) continue;
      const def = await defFor(candidate);
      if (!def) continue;
      await locks.withLock(candidate.id, async () => {
        const inst = await readInstance(candidate.id);
        if (!inst) return;
        const due = inst.phases.filter(
          (p) => p.status === "failed" && p.retryAt && Date.parse(p.retryAt) <= now.getTime(),
        );
        for (const phase of due) {
          const note = await buildRetryNote(def, phase);
          const res = applyRetry(inst, phase.id, nowISO());
          if (res.startPhases.length === 0) continue;
          await saveInstance(res.instance);
          void journal(inst.id, {
            at: nowISO(),
            kind: "phase.retrying",
            phaseId: phase.id,
            attempt: phase.attempt,
          });
          await startPhases(def, res.instance, res.startPhases, note);
          deps.onChange?.();
        }
      });
    }
  }

  async function adopt(): Promise<void> {
    for (const inst of await readInstances()) {
      if (inst.status !== "running") continue;
      // Every live phase, not just one: a fan-out has several in flight, and an
      // unadopted run is a process nobody is tracking.
      for (const s of livePhases(inst).flatMap((i) => inst.phases[i].steps)) {
        if (s.status !== "running" || !s.runId || adopted.has(s.runId)) continue;
        const got = await readRun(s.runId);
        if (!got || got.run.status !== "running" || !isAlive(got.run.pid)) continue;
        await sem.acquire();
        adopted.set(s.runId, { instanceId: inst.id });
        deps.tailer?.track(s.runId, inst.id, got.run.runtime);
      }
    }
  }

  async function start(
    pipelineId: string,
    trigger: PipelineInstance["trigger"] = "manual",
    firing?: { triggerPayload?: unknown; chainedFrom?: string },
  ) {
    const def = await loadDef(pipelineId);
    if (!def) throw new Error("pipeline not found");
    if (def.overlapPolicy === "skip") {
      const busy = (await readInstances({ pipelineId })).some(
        (i) => i.status === "running" || i.status === "awaiting-approval",
      );
      if (busy) return null;
    }
    if (deps.preflight) {
      const pf = await deps.preflight();
      if (!pf.ok) throw new PreflightError(pf.reasons);
    }
    const { instance, startPhases: ready } = initInstance(
      def,
      trigger,
      { instanceId: deps.newId(), token: deps.newId() },
      nowISO(),
      firing,
    );
    await saveInstance(instance);
    await markPipelineStarted(def.id, instance.createdAt);
    void journal(instance.id, {
      at: instance.createdAt,
      kind: "instance.started",
      detail: `${def.name} (${trigger})`,
    });
    // Under the lock like every other launch, so a reconcile tick that sees
    // the new instance cannot mistake a step still being prepared for one
    // whose launch was lost.
    await locks.withLock(instance.id, () => startPhases(def, instance, ready));
    await pruneInstances(def.id, INSTANCE_KEEP);
    deps.onChange?.();
    return instance;
  }

  /**
   * Launch phases exposed by a transition after the caller releases the
   * instance lock. Signal handlers must answer the child before waiting for a
   * concurrency slot, and reconciliation uses the same path so fallback and a
   * delayed hook have one idempotency boundary.
   */
  function queueReadyPhases(
    instanceId: string,
    def: PipelineDefinition,
    transitioned: PipelineInstance,
    ready: number[],
  ): void {
    if (ready.length === 0) return;
    const wantIds = ready.map((i) => transitioned.phases[i].id);
    void track(
      locks
        .withLock(instanceId, async () => {
          const fresh = await readInstance(instanceId);
          if (!fresh || fresh.status !== "running") return;
          // Re-resolve by phase id: an abort/revise landing in the transition
          // window may have changed which work is live.
          const stillWanted = wantIds
            .map((id) => fresh.phases.findIndex((p) => p.id === id))
            .filter((i) => i >= 0 && fresh.phases[i].status === "running");
          await startPhases(def, fresh, stillWanted);
        })
        .catch((e: unknown) => log.error("deferred phase start failed", { instanceId, err: e })),
    );
  }

  /**
   * Run a phase's declared checks off the lock, then record the verdict under
   * it.
   *
   * The checks are Argus's own work — a test command, a required artifact, the
   * set of files the agent touched — and can take as long as a test suite. They
   * run outside the instance lock so signals for sibling branches keep flowing,
   * and the verdict is applied by {@link applyVerification}, which refuses a
   * report for any phase attempt that is no longer waiting on one. Keyed by
   * attempt so a crash mid-verification is re-run by reconcile, and a revise
   * during the checks makes the stale report a no-op rather than a decision.
   */
  function queueVerification(
    instanceId: string,
    def: PipelineDefinition,
    phaseId: string,
    attempt: number,
  ): void {
    const key = `${instanceId}:${phaseId}:${attempt}`;
    if (verifying.has(key)) return;
    verifying.add(key);
    const phaseDef = def.phases.find((p) => p.id === phaseId);
    void track(
      (async () => {
        if (!phaseDef) return;
        const inst = await readInstance(instanceId);
        const phase = inst?.phases.find((p) => p.id === phaseId);
        if (!inst || !phase) return;
        void journal(instanceId, {
          at: nowISO(),
          kind: "phase.verifying",
          phaseId,
          attempt,
          detail: `${phaseDef.checks?.length ?? 0} check${phaseDef.checks?.length === 1 ? "" : "s"}`,
        });
        let baseline: WorkingTreeSnapshot | null = null;
        try {
          baseline = JSON.parse(
            await readFile(
              phaseBaselinePath(paths.invocationsDir(), instanceId, phaseId, attempt),
              "utf8",
            ),
          ) as WorkingTreeSnapshot;
        } catch {
          /* no baseline recorded (not a git repository, or no changed-files check) */
        }
        const report = await runChecks(phaseDef.checks ?? [], {
          // The checks look at the work, so they look where the work happened:
          // the phase's worktree when it had one, its own cwd otherwise.
          cwd: phase.workspace?.path ?? phaseDef.cwd,
          artifactDir: phase.artifactDir ?? null,
          baseline,
          now: deps.now,
          // The checks run under the phase's own environment policy: a command
          // check is a script in the repository the agent just edited, and must
          // not see what the agent was not allowed to see.
          env: buildChildEnv(parentEnv(), resolveCapabilities(def, phaseDef, {})?.env).env,
        });
        await locks.withLock(instanceId, async () => {
          const fresh = await readInstance(instanceId);
          if (!fresh || fresh.status !== "running") return;
          const current = fresh.phases.find((p) => p.id === phaseId);
          if (!current || current.attempt !== attempt) return;
          let res = applyVerification(def, fresh, phaseId, report, nowISO());
          if (!res.verificationApplied) return;
          const failed = report.status === "failed";
          void journal(instanceId, {
            at: nowISO(),
            kind: "phase.verified",
            phaseId,
            attempt,
            detail: failed
              ? `failed: ${report.checks
                  .filter((c) => c.status === "failed")
                  .map((c) => c.label)
                  .join(", ")}`
              : `passed: ${report.checks.length} check${report.checks.length === 1 ? "" : "s"}`,
          });
          if (failed) {
            const reason =
              (res.instance.phases.find((p) => p.id === phaseId)?.payload as PhaseFailurePayload)
                ?.reason ?? "verification failed";
            noteFailure(def, res.instance, phaseId, "verification", reason);
          }
          res = await settleKnowledge(def, res);
          res = await settleRealizations(def, res);
          noteRouting(def, res.instance, res.routing);
          await saveInstance(res.instance);
          if (res.instance.status === "succeeded" || res.instance.status === "failed") {
            void journal(instanceId, {
              at: nowISO(),
              kind: "instance.ended",
              detail: res.instance.status,
            });
          }
          queueReadyPhases(instanceId, def, res.instance, res.startPhases);
          if (res.instance.status === "failed") deps.onFailure?.(res.instance);
          deps.onChange?.();
        });
      })()
        .catch((e: unknown) =>
          log.error("phase verification failed to run", { instanceId, phaseId, err: e }),
        )
        .finally(() => verifying.delete(key)),
    );
  }

  // ── Knowledge deltas ───────────────────────────────────────────────────────
  //
  // The engine's side of docs/KNOWLEDGE-LEDGER.md § KnowledgeDelta protocol.
  // Three moments, none of which touch `knowledge.json` except the middle one:
  //
  //   intake   — a run completed; its delta file is read, validated against
  //              the ledger as it stands, and staged beside the run (or
  //              refused, failing the step under `knowledge-delta`);
  //   commit   — the phase crossed every acceptance condition; every staged
  //              delta of *this attempt* is applied as one ledger transition,
  //              or none is, and the phase succeeds or fails on the verdict;
  //   retire   — an attempt failed, was revised, was aborted, or lost a
  //              selection; its staged deltas are superseded and can never
  //              become canonical.

  /** The phase and step a completion signal would drive, when both are live. */
  function liveStep(inst: PipelineInstance, phaseId: string, runId: string): boolean {
    const phase = inst.phases.find((p) => p.id === phaseId);
    if (!phase || phase.status !== "running") return false;
    const step = phase.steps.find((s) => s.runId === runId);
    return step?.status === "running";
  }

  type Intake =
    | { ok: true; staged: StepKnowledgeDelta | null }
    | { ok: false; reason: string; failure: RetryableClass };

  /**
   * The context-integrity gate (Phase 4.1, docs/KNOWLEDGE-LEDGER.md §13.11).
   *
   * Argus hashed the KnowledgeContext file when it materialized it and wrote
   * that hash into the ledger. Before a completion is accepted, the file is
   * re-hashed: the bytes the agent was given must be the bytes Argus supplied,
   * or the provenance record is a promise Argus cannot keep. A mismatch — or a
   * file that has disappeared — refuses the completion deterministically, so
   * nothing the run proposed reaches the ledger.
   *
   * Three things it deliberately is not:
   *
   * - **Not a currency check.** A claim revised in the ledger while the agent
   *   ran leaves the file untouched; the run continues on the historical
   *   revision it was given. Only changed *bytes* fail here.
   * - **Not a check on legacy runs.** No durable supplied record (the run was
   *   launched without a semantic context, or predates Phase 4.1) means
   *   nothing to verify, and the completion proceeds exactly as before.
   * - **Not a read of the contents.** The refusal names the run, the two
   *   hashes and the path — never a byte of the context.
   *
   * Returns the refusal, or null when the completion may proceed.
   */
  async function checkContextIntegrity(
    inst: PipelineInstance,
    phaseId: string,
    runId: string,
  ): Promise<Intake | null> {
    const ledger = await readLedger();
    const supplied = suppliedContextOf(ledger, runId);
    if (!supplied) return null;
    const invocation = await readInvocation(runId);
    const file = invocation?.knowledgeContextFile ?? knowledgeContextFile(runId);
    const result = await verifyKnowledgeContextIntegrity(file, supplied.sha256);
    if (result.status === "unchanged") return null;
    const reason = describeIntegrityFailure(runId, result);
    void journal(inst.id, {
      at: nowISO(),
      kind: "knowledge.integrity",
      phaseId,
      runId,
      detail: `${result.status}: expected sha256 ${result.expected?.slice(0, 12)}${
        result.actual ? `, found ${result.actual.slice(0, 12)}` : ""
      }`,
    });
    return { ok: false, reason, failure: "knowledge-context-integrity" };
  }

  /**
   * The same gate for the Argus-owned read-only inputs Phase 8 added: the
   * ChangeContext, the ImplementationScope and the RemediationContext
   * (docs/KNOWLEDGE-LEDGER.md §Phase 8, context integrity).
   *
   * Phase 7 materialized the ChangeContext read-only but never checked it
   * again, so an implementation could have been driven by bytes nobody could
   * vouch for. This closes that, by exactly the Phase 4.1 model: hash at
   * launch, re-hash at completion, deterministic failure on a mismatch or a
   * missing file.
   *
   * It asks **one** question — *did the bytes supplied to this invocation
   * change?* — and deliberately not *is this still the newest proposal?*. An
   * accepted ChangeProposal's identity is immutable, so a newer proposal
   * accepted while the agent ran is never tampering; a realization that has
   * been overtaken is a `stale` realization, decided at close-out from the
   * ledger, not an integrity failure here.
   *
   * A record with no `suppliedInputs` (written before Phase 8, or a run that
   * received none) has nothing to verify and passes, exactly as a
   * pre-Phase-4.1 context does.
   */
  async function checkSuppliedInputs(
    inst: PipelineInstance,
    phaseId: string,
    runId: string,
  ): Promise<Intake | null> {
    const invocation = await readInvocation(runId);
    const inputs = invocation?.suppliedInputs ?? [];
    for (const input of inputs) {
      const result = await verifyKnowledgeContextIntegrity(input.path, input.sha256);
      if (result.status === "unchanged") continue;
      const reason =
        result.status === "missing"
          ? `change context integrity: run ${runId}'s ${input.kind} file is missing at ${input.path} (expected sha256 ${input.sha256})`
          : `change context integrity: run ${runId}'s ${input.kind} file changed during execution at ${input.path} (expected sha256 ${input.sha256}, found ${result.actual})`;
      void journal(inst.id, {
        at: nowISO(),
        kind: "knowledge.integrity",
        phaseId,
        runId,
        detail: `${input.kind} ${result.status}: expected sha256 ${input.sha256.slice(0, 12)}${
          result.actual ? `, found ${result.actual.slice(0, 12)}` : ""
        }`,
      });
      return { ok: false, reason, failure: "change-context-integrity" };
    }
    return null;
  }

  /**
   * Everything Argus checks before a step's completion — and the semantic
   * output it carries — is accepted: the context it was given is unchanged
   * (above), then its KnowledgeDelta is read, validated and staged (below).
   * Order matters: a run whose input Argus cannot vouch for never gets its
   * proposal staged, so a tampered context can never become canonical
   * knowledge.
   */
  async function acceptCompletion(
    def: PipelineDefinition,
    inst: PipelineInstance,
    phaseId: string,
    runId: string,
  ): Promise<Intake> {
    const refused = await checkContextIntegrity(inst, phaseId, runId);
    if (refused) return refused;
    // The Phase 8 inputs, under the same rule and before anything is staged: a
    // run whose accepted intent Argus cannot vouch for must not have its
    // conformance or acceptance results become durable.
    const tampered = await checkSuppliedInputs(inst, phaseId, runId);
    if (tampered) return tampered;
    // Change intent (Phase 7) is read *before* the delta, because on a
    // change-intent phase the proposal carries the delta: the semantic half of
    // a ChangeProposal is staged through exactly the KnowledgeDelta machinery,
    // so there is still one path by which anything becomes canonical.
    const proposal = await intakeChangeProposal(def, inst, phaseId, runId);
    if (!proposal.ok) return proposal;
    const delta = await intakeKnowledgeDelta(def, inst, phaseId, runId, proposal.semanticDelta);
    if (!delta.ok) return delta;
    if (proposal.recordRunId) {
      await bindProposalDelta(def, inst, phaseId, proposal.recordRunId, delta.staged?.id);
    }
    // Business-rule verification (Phase 6) rides the same boundary: a
    // conformance proposal is read, validated and staged exactly as a delta
    // is, and refused the same way. Its own channel, its own record, its own
    // failure class — and the same rule that nothing becomes durable before
    // the phase is accepted.
    const verification = await intakeRuleVerification(def, inst, phaseId, runId);
    if (!verification.ok) return verification;
    // Acceptance verification (Phase 8) rides the same boundary again, on its
    // own channel and its own record. Independent of the rule results by
    // construction: neither can rewrite the other, and a phase that answers
    // both writes two files.
    const acceptance = await intakeAcceptance(def, inst, phaseId, runId);
    return acceptance.ok ? delta : acceptance;
  }

  /**
   * The exact revisions Argus supplied to a run, from the two sources that can
   * answer, in a fixed precedence (docs/KNOWLEDGE-LEDGER.md §13.7): the
   * ledger's **durable** supplied record first — written before the process
   * starts and surviving every pruning path — and the invocation record only
   * when there is none. They cannot disagree (the durable record is registered
   * from the same resolution that produced the invocation record's, and a
   * conflicting registration is refused), so the precedence matters only for
   * availability: a recovery path where the invocation directory is gone still
   * answers correctly.
   *
   * `undefined` (not empty) when neither can be read: no claim either way. A
   * run launched *with* no context has an invocation record saying so, which
   * is positive evidence of an empty supply — never the same as unknown.
   */
  async function suppliedFor(runId: string): Promise<ClaimRef[] | undefined> {
    const durable = suppliedContextOf(await readLedger(), runId);
    if (durable) return durable.claims.map((c) => ({ id: c.id, revision: c.revision }));
    const invocation = await readInvocation(runId);
    if (!invocation) return undefined;
    return (invocation.knowledgeContext?.claims ?? []).map((c) => ({
      id: c.id,
      revision: c.revision,
    }));
  }

  /**
   * Read, validate, preflight and stage the delta a completed run may have
   * written. Sets `step.knowledgeDelta` on the in-memory instance when one
   * was staged, so the transition that follows sees it. Never touches the
   * ledger: `preflightKnowledgeDeltas` is a dry run against the current
   * snapshot, there so a proposal that is already refusable — an unknown
   * revision, a precondition that no longer holds, a cycle — fails the step
   * at once rather than after a gate has waited on a person. The proposal is
   * checked again, against the snapshot of that moment, at commit.
   */
  async function intakeKnowledgeDelta(
    def: PipelineDefinition,
    inst: PipelineInstance,
    phaseId: string,
    runId: string,
    /** The semantic half of a ChangeProposal (Phase 7), when this run is a
     *  change-intent run. Supplied instead of the agent's delta file, which a
     *  change-intent run may not write: one run, one account of what it
     *  proposes. */
    provided?: KnowledgeDelta,
  ): Promise<Intake> {
    const phase = inst.phases.find((p) => p.id === phaseId);
    const step = phase?.steps.find((s) => s.runId === runId);
    if (!phase || !step) return { ok: true, staged: null };
    const at = nowISO();

    // Staged already (a restart between the record write and the instance
    // write): the record decides, exactly as it did the first time.
    const existing = await readDeltaRecord(runId);
    if (existing && existing.attempt === phase.attempt) {
      if (existing.status === "rejected") {
        return {
          ok: false,
          reason: existing.reason ?? "KnowledgeDelta was rejected",
          failure: "knowledge-delta",
        };
      }
      step.knowledgeDelta = { id: existing.id, status: existing.status };
      return { ok: true, staged: step.knowledgeDelta };
    }

    const file = await readAgentDelta(runId);
    if (provided === undefined && file.kind === "none") return { ok: true, staged: null };

    // What Argus supplied to this run ({@link suppliedFor}). Copied onto the
    // staged record so the commit can classify each consumed entry as
    // supplied or agent-discovered (ClaimConsumption.source), and so the two
    // lists sit side by side for a reader. Absent (not empty) = unknown, and
    // every consumption is then recorded without a `source`.
    const supplied = await suppliedFor(runId);

    const base: Omit<KnowledgeDeltaRecord, "status"> = {
      id: `KD-${deps.newId()}`,
      runId,
      instanceId: inst.id,
      phaseId,
      attempt: phase.attempt,
      step: step.name,
      receivedAt: at,
      updatedAt: at,
      ...(supplied !== undefined ? { supplied } : {}),
    };
    const reject = async (
      reason: string,
      delta?: KnowledgeDeltaRecord["delta"],
    ): Promise<Intake> => {
      const full = `KnowledgeDelta rejected: ${reason}`;
      await writeDeltaRecord({
        ...base,
        status: "rejected",
        reason: full,
        ...(delta ? { delta } : {}),
      });
      void journal(inst.id, {
        at,
        kind: "knowledge.rejected",
        phaseId,
        runId,
        attempt: phase.attempt,
        detail: `${base.id}: ${reason}`,
      });
      return { ok: false, reason: full, failure: "knowledge-delta" };
    };

    let delta: KnowledgeDeltaRecord["delta"];
    if (provided !== undefined) {
      // A change-intent run proposes semantics only through its proposal. A
      // delta file beside it would be a second, unreviewed account of what the
      // change means, so it refuses the step rather than being ignored.
      if (file.kind !== "none") {
        return reject(
          "this is a change-intent run: propose semantics through the ChangeProposal's " +
            "semanticDelta, not through a separate KnowledgeDelta file",
        );
      }
      delta = provided;
    } else {
      if (file.kind === "none") return { ok: true, staged: null };
      if (file.kind === "unreadable") return reject(file.reason);
      try {
        delta = parseKnowledgeDelta(file.text);
      } catch (e) {
        return reject(
          e instanceof KnowledgeDeltaError
            ? `${e.code}: ${e.message}`
            : e instanceof Error
              ? e.message
              : String(e),
        );
      }
    }
    // A document that proposes nothing is the same as no document.
    if (isEmptyDelta(delta)) return { ok: true, staged: null };

    // Artifacts the agent claims to have produced must exist where the run
    // could have produced them — its artifact directory, or its working tree.
    // Checked now, while the worktree the run used still exists, and again at
    // the commit boundary, so nothing that vanished in between is recorded.
    const missing = await verifyDeltaArtifacts(def, phase, runId, delta);
    if (missing) return reject(missing, delta);

    // Business-rule discovery (Phase 5): the deterministic half of the
    // discovery contract. Every business rule must carry evidence, and every
    // source-code evidence path must be safe, in the declared scope, at the
    // commit Argus recorded for this run, and actually there. Fail-closed:
    // a rule nobody can go and check is worse than no rule. What the checks
    // deliberately do NOT decide is whether the rule the agent read out of
    // the code is the rule the business has — that is what the gate is for.
    const phaseDef = def.phases.find((pd) => pd.id === phaseId);

    // Business-rule verification (Phase 6): the one thing a verification
    // phase's delta may not do is express "the code is in breach" as doubt
    // about the rule. Structural and narrow — opposing evidence or an
    // opposing justification aimed at one of the exact rules this run was
    // supplied to verify — and it closes the single path by which a failing
    // test could turn a supported rule `contested`.
    if (phaseDef?.ruleVerification) {
      const contamination = verificationDeltaRefusal(
        delta,
        selectedRules(await readLedger(), supplied, phaseDef.ruleVerification),
      );
      if (contamination) return reject(contamination, delta);
    }

    if (phaseDef?.discovery) {
      const verdict = await checkDiscoveryDelta(
        delta,
        await readLedger(),
        await discoveryContextFor(def, phase, runId, phaseDef.discovery),
        supplied,
      );
      if (verdict.refusal) return reject(verdict.refusal, delta);
    }

    const proposal: DeltaProposal = {
      id: base.id,
      delta,
      execution: { runId, instanceId: inst.id, phaseId },
      attempt: phase.attempt,
      ...(supplied !== undefined ? { supplied } : {}),
    };
    try {
      await preflightKnowledgeDeltas([proposal], deps.now());
    } catch (e) {
      return reject(
        e instanceof KnowledgeDeltaError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e),
        delta,
      );
    }
    await writeDeltaRecord({ ...base, status: "staged", delta });
    step.knowledgeDelta = { id: base.id, status: "staged" };
    if (phaseDef?.discovery) await refreshDiscoverySummary(def, phase);
    void journal(inst.id, {
      at,
      kind: "knowledge.staged",
      phaseId,
      runId,
      attempt: phase.attempt,
      detail: `${base.id}: ${describeDelta(delta)}`,
    });
    return { ok: true, staged: step.knowledgeDelta };
  }

  /**
   * What a discovery check needs to know about the run: the tree it worked in
   * and the commit Argus recorded for it.
   *
   * Read from the invocation record, with the phase definition as the
   * fallback — the same precedence {@link verifyDeltaArtifacts} uses for the
   * `repository` root, and for the same reason: the record is what the run
   * actually got, the definition is only where it would have gone. A run with
   * no recorded head leaves `gitHead` null, which makes an agent-supplied
   * commit unverifiable rather than wrong: Argus refuses what it can
   * disprove, never what it merely cannot confirm.
   */
  async function discoveryContextFor(
    def: PipelineDefinition,
    phase: PhaseProgress,
    runId: string,
    policy: NonNullable<PhaseDef["discovery"]>,
  ): Promise<DiscoveryContext> {
    const invocation = await readInvocation(runId);
    const phaseDef = def.phases.find((p) => p.id === phase.id);
    return {
      policy,
      repoRoot: invocation?.workspace?.path ?? invocation?.cwd ?? phaseDef?.cwd ?? null,
      gitHead: invocation?.gitHead ?? null,
    };
  }

  /**
   * Recompute a discovery phase's {@link DiscoverySummary} from the attempt's
   * staged deltas (Phase 5 §17).
   *
   * Counts only — routing, status and observability. The candidates
   * themselves stay in the staged KnowledgeDelta, which is the one
   * authoritative form of the proposal; duplicating them onto the instance
   * would create a second copy that could drift from it.
   *
   * `requiresReview` is true exactly while the candidates are not canonical,
   * so the board can say "4 candidates, waiting on you" and then "4
   * candidates, committed" without anyone reading the ledger.
   */
  async function refreshDiscoverySummary(
    def: PipelineDefinition,
    phase: PhaseProgress,
  ): Promise<void> {
    const ledger = await readLedger();
    const previews = [];
    const deltas = [];
    for (const step of phase.steps) {
      if (!step.runId || !step.knowledgeDelta) continue;
      const record = await readDeltaRecord(step.runId);
      if (!record?.delta || record.attempt !== phase.attempt) continue;
      const phaseDef = def.phases.find((p) => p.id === phase.id);
      const warnings = phaseDef?.discovery
        ? (
            await checkDiscoveryDelta(
              record.delta,
              ledger,
              await discoveryContextFor(def, phase, step.runId, phaseDef.discovery),
              record.supplied,
            )
          ).warnings
        : undefined;
      previews.push(previewKnowledgeDelta(record, ledger, warnings));
      deltas.push(record.delta);
    }
    phase.discovery = summarizeDiscovery(
      previews,
      deltas,
      phase.knowledge?.status !== "applied" && previews.some((p) => p.status === "staged"),
    );
  }

  // ── Rule verification (Phase 6) ────────────────────────────────────────────
  //
  // The same three moments as a KnowledgeDelta, on their own channel:
  //
  //   intake   — a verification run completed; its report is read, validated
  //              against the rules Argus supplied it, and staged beside the
  //              run (or refused, failing the step under `rule-verification`);
  //   commit   — the phase crossed every acceptance condition; every staged
  //              proposal of *this attempt* is written into `knowledge.json`
  //              in the same transition as the attempt's deltas, or none is;
  //   retire   — an attempt failed, was revised, was aborted, or lost a
  //              selection; its staged proposals are superseded and can never
  //              become durable.
  //
  // What a verification never does, at any of the three: touch claim support.

  /** What a verification check needs to know about the run: the rules it was
   *  accountable for, the tree it worked in, the commit Argus recorded for it,
   *  and the checks its phase declares. */
  async function verificationContextFor(
    def: PipelineDefinition,
    phase: PhaseProgress,
    runId: string,
    policy: NonNullable<PhaseDef["ruleVerification"]>,
  ): Promise<VerificationContext> {
    const invocation = await readInvocation(runId);
    const phaseDef = def.phases.find((p) => p.id === phase.id);
    const ledger = await readLedger();
    return {
      policy,
      selected: selectedRules(ledger, await suppliedFor(runId), policy),
      repoRoot: invocation?.workspace?.path ?? invocation?.cwd ?? phaseDef?.cwd ?? null,
      gitHead: invocation?.gitHead ?? null,
      checkLabels: declaredCheckLabels(phaseDef?.checks, checkLabel),
    };
  }

  /**
   * Read, validate and stage the conformance results a completed verification
   * run wrote. Sets `step.ruleVerification` on the in-memory instance when one
   * was staged, so the transition that follows sees it. Never touches the
   * ledger.
   *
   * The one asymmetry with a KnowledgeDelta, and it is deliberate: **no file
   * is not "nothing proposed"**. A run supplied rules and asked to verify them
   * has an obligation, so an absent report with a non-empty selection refuses
   * the step rather than letting the phase succeed as though the rules had
   * been considered. A verification phase whose context supplied no rules at
   * all has nothing to answer for, and proceeds.
   */
  async function intakeRuleVerification(
    def: PipelineDefinition,
    inst: PipelineInstance,
    phaseId: string,
    runId: string,
  ): Promise<Intake> {
    const phaseDef = def.phases.find((pd) => pd.id === phaseId);
    const policy = phaseDef?.ruleVerification;
    if (!policy) return { ok: true, staged: null };
    const phase = inst.phases.find((p) => p.id === phaseId);
    const step = phase?.steps.find((sp) => sp.runId === runId);
    if (!phase || !step) return { ok: true, staged: null };
    const at = nowISO();

    // Staged already (a restart between the record write and the instance
    // write): the record decides, exactly as it did the first time.
    const existing = await readVerificationRecord(runId);
    if (existing && existing.attempt === phase.attempt) {
      if (existing.status === "rejected") {
        return {
          ok: false,
          reason: existing.reason ?? "rule verification was rejected",
          failure: "rule-verification",
        };
      }
      step.ruleVerification = { id: existing.id, status: existing.status };
      return { ok: true, staged: null };
    }

    const ctx = await verificationContextFor(def, phase, runId, policy);
    // The exact repository state this run examined, snapshotted at completion
    // (Phase 8). Recorded beside `gitHead` rather than instead of it: the head
    // still answers a head-scoped conformance question, and this answers the
    // stricter one a realization has to ask — *was it this implementation?*
    const verifiedState = repositoryStateFrom(
      await snapshotWorkingTree(await runCwd(def, phase, runId)),
    );
    const base: Omit<RuleVerificationRecord, "status"> = {
      id: `RV-${deps.newId()}`,
      runId,
      instanceId: inst.id,
      phaseId,
      attempt: phase.attempt,
      step: step.name,
      receivedAt: at,
      updatedAt: at,
      selected: ctx.selected,
      ...(ctx.gitHead ? { gitHead: ctx.gitHead } : {}),
      ...(verifiedState ? { repository: verifiedState } : {}),
    };
    const reject = async (
      reason: string,
      report?: RuleVerificationRecord["report"],
    ): Promise<Intake> => {
      const full = `rule verification rejected: ${reason}`;
      await writeVerificationRecord({
        ...base,
        status: "rejected",
        reason: full,
        ...(report ? { report } : {}),
      });
      void journal(inst.id, {
        at,
        kind: "verification.rejected",
        phaseId,
        runId,
        attempt: phase.attempt,
        detail: `${base.id}: ${reason}`,
      });
      return { ok: false, reason: full, failure: "rule-verification" };
    };

    const file = await readAgentVerification(runId);
    if (file.kind === "none") {
      if (ctx.selected.length === 0) return { ok: true, staged: null };
      return reject(
        `this phase supplied ${ctx.selected.length} rule${ctx.selected.length === 1 ? "" : "s"} (${ctx.selected
          .map(formatClaimRef)
          .join(
            ", ",
          )}) but the run wrote no rule-verification file; every selected rule must receive an outcome`,
      );
    }
    if (file.kind === "unreadable") return reject(file.reason);
    let report: RuleVerificationRecord["report"];
    try {
      report = parseRuleVerificationReport(file.text);
    } catch (e) {
      return reject(
        e instanceof RuleVerificationError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e),
      );
    }
    const refusal = await checkRuleVerification(report, await readLedger(), ctx);
    if (refusal) return reject(`${refusal.code}: ${refusal.message}`, report);

    await writeVerificationRecord({ ...base, status: "staged", report });
    step.ruleVerification = { id: base.id, status: "staged" };
    await refreshVerificationSummary(phase);
    void journal(inst.id, {
      at,
      kind: "verification.staged",
      phaseId,
      runId,
      attempt: phase.attempt,
      detail: `${base.id}: ${describeReport(report)}`,
    });
    return { ok: true, staged: null };
  }

  /** Recompute a verification phase's {@link RuleVerificationSummary} from the
   *  attempt's staged records. Counts only; the results themselves stay in the
   *  staged record, which is the one authoritative form of the proposal. */
  async function refreshVerificationSummary(phase: PhaseProgress): Promise<void> {
    const ledger = await readLedger();
    const previews = [];
    for (const step of phase.steps) {
      if (!step.runId || !step.ruleVerification) continue;
      const record = await readVerificationRecord(step.runId);
      if (!record?.report || record.attempt !== phase.attempt) continue;
      previews.push(previewRuleVerification(record, ledger));
    }
    phase.ruleVerification = summarizeRuleVerification(
      previews,
      phase.knowledge?.status !== "applied" && previews.some((p) => p.status === "staged"),
    );
  }

  /**
   * The verification proposals a held phase would commit, resolved into the
   * durable records they become — or a refusal.
   *
   * This is where the agent's citation of a deterministic check meets Argus's
   * own report: every `check` evidence record is bound to the
   * {@link VerificationReport} of the phase (or, on a candidates phase, of the
   * winning step), so `status`, `exitCode` and `detail` come from the run
   * Argus performed rather than from the document the agent wrote. A cited
   * check missing from the report refuses the commit, and under
   * `holds: "deterministic-check"` a `holds` outcome whose checks did not pass
   * refuses it too.
   */
  async function verificationProposalsOf(
    def: PipelineDefinition,
    inst: PipelineInstance,
    phase: PhaseProgress,
  ): Promise<{ ok: true; proposals: VerificationProposal[] } | { ok: false; reason: string }> {
    const wanted = phase.knowledge?.verifications ?? [];
    if (wanted.length === 0) return { ok: true, proposals: [] };
    const policy = def.phases.find((pd) => pd.id === phase.id)?.ruleVerification;
    const proposals: VerificationProposal[] = [];
    for (const step of phase.steps) {
      const id = step.ruleVerification?.id;
      if (!id || !wanted.includes(id) || !step.runId) continue;
      const record = await readVerificationRecord(step.runId);
      if (!record || record.id !== id || !record.report) {
        return { ok: false, reason: `rule verification ${id} is not staged for run ${step.runId}` };
      }
      if (record.attempt !== phase.attempt) {
        return {
          ok: false,
          reason: `rule verification ${id} was staged for attempt ${record.attempt}, not ${phase.attempt}`,
        };
      }
      // The checks Argus actually ran for this attempt: the phase's report,
      // or this candidate's own when the phase ran candidates.
      const results = (step.verification ?? phase.verification)?.checks ?? [];
      for (const v of record.report.verifications) {
        const bound = bindCheckEvidence(v.evidence, results);
        if (bound.missing.length > 0) {
          return {
            ok: false,
            reason: `rule verification ${id}: ${formatClaimRef(v.rule)} cites check${
              bound.missing.length === 1 ? "" : "s"
            } ${bound.missing.map((l) => `"${l}"`).join(", ")}, which this phase's verification report does not contain`,
          };
        }
        const policyRefusal = holdsPolicyRefusal(v.rule, v.outcome, bound.evidence, policy);
        if (policyRefusal) {
          return { ok: false, reason: `rule verification ${id}: ${policyRefusal}` };
        }
        proposals.push({
          execution: { runId: step.runId, instanceId: inst.id, phaseId: phase.id },
          rule: v.rule,
          outcome: v.outcome,
          evidence: bound.evidence,
          attempt: phase.attempt,
          ...(record.gitHead ? { gitHead: record.gitHead } : {}),
          ...(record.repository ? { repositoryState: record.repository } : {}),
          ...(v.reason !== undefined ? { reason: v.reason } : {}),
          ...(v.note !== undefined ? { note: v.note } : {}),
          policy: holdsPolicy(policy),
        });
      }
    }
    return { ok: true, proposals };
  }

  // ── Acceptance verification (Phase 8) ─────────────────────────────────────
  //
  // The same three moments as every other semantic output, on a fourth
  // channel: intake stages what the run wrote, the commit makes it durable in
  // the phase's one ledger transition, and a retired attempt supersedes it.
  //
  // What is deliberately *not* shared with rule verification: the record, the
  // read model, the completeness rule, and the failure class. A criterion is
  // bound to `CP-12/AC-1` and a rule to a `ClaimRef`, and "every rule holds
  // and AC-3 is violated" must remain something Argus can say.

  /** What an acceptance check needs to know about the run that wrote the
   *  report: which accepted change it answers for, every criterion of it, and
   *  the run's own world. */
  async function acceptanceContextFor(
    def: PipelineDefinition,
    phase: PhaseProgress,
    runId: string,
    policy: NonNullable<PhaseDef["acceptanceVerification"]>,
    proposalId: string,
  ): Promise<AcceptanceContext> {
    const invocation = await readInvocation(runId);
    const phaseDef = def.phases.find((p) => p.id === phase.id);
    const ledger = await readLedger();
    const proposal = changeProposalById(ledger, proposalId);
    return {
      policy,
      proposalId,
      required: proposal?.acceptanceCriteria ?? [],
      repoRoot: invocation?.workspace?.path ?? invocation?.cwd ?? phaseDef?.cwd ?? null,
      gitHead: invocation?.gitHead ?? null,
      checkLabels: acceptanceCheckLabels(phaseDef?.checks, checkLabel),
    };
  }

  /**
   * Which accepted proposal a run was answering for, read back from the
   * ChangeContext Argus materialized for it.
   *
   * Deliberately read from that file rather than re-resolved from the ledger:
   * the file *is* the record of what this run was given, it survives a restart
   * between the launch and the completion, and re-resolving would let a
   * proposal accepted while the agent ran retarget a finished run.
   */
  async function acceptanceProposalOf(runId: string): Promise<string | null> {
    const invocation = await readInvocation(runId);
    const file = invocation?.changeContextFile ?? changeContextFile(runId);
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as { proposalId?: string };
      return typeof parsed.proposalId === "string" ? parsed.proposalId : null;
    } catch {
      return null;
    }
  }

  /**
   * Read, validate and stage the acceptance results a completed run wrote.
   *
   * The same asymmetry with a KnowledgeDelta as a verification report has:
   * **no file is not "nothing proposed"**. A run given an accepted change with
   * criteria has an obligation to answer them, so an absent report refuses the
   * step rather than letting the phase succeed as though the criteria had been
   * considered. A proposal that declares no criteria has nothing to answer.
   */
  async function intakeAcceptance(
    def: PipelineDefinition,
    inst: PipelineInstance,
    phaseId: string,
    runId: string,
  ): Promise<Intake> {
    const phaseDef = def.phases.find((pd) => pd.id === phaseId);
    const policy = phaseDef?.acceptanceVerification;
    if (!policy) return { ok: true, staged: null };
    const phase = inst.phases.find((p) => p.id === phaseId);
    const step = phase?.steps.find((sp) => sp.runId === runId);
    if (!phase || !step) return { ok: true, staged: null };
    const at = nowISO();

    const existing = await readAcceptanceRecord(runId);
    if (existing && existing.attempt === phase.attempt) {
      if (existing.status === "rejected") {
        return {
          ok: false,
          reason: existing.reason ?? "acceptance verification was rejected",
          failure: "acceptance-verification",
        };
      }
      step.acceptanceVerification = { id: existing.id, status: existing.status };
      return { ok: true, staged: null };
    }

    const proposalId = await acceptanceProposalOf(runId);
    if (!proposalId) {
      return {
        ok: false,
        reason:
          "acceptance verification rejected: this phase declares acceptanceVerification but the run received no ChangeContext naming an accepted change to answer for",
        failure: "acceptance-verification",
      };
    }
    const ctx = await acceptanceContextFor(def, phase, runId, policy, proposalId);
    const state = repositoryStateFrom(await snapshotWorkingTree(await runCwd(def, phase, runId)));
    const base: Omit<AcceptanceVerificationRecord, "status"> = {
      id: `AVR-${deps.newId()}`,
      runId,
      instanceId: inst.id,
      phaseId,
      attempt: phase.attempt,
      step: step.name,
      receivedAt: at,
      updatedAt: at,
      proposalId,
      required: ctx.required,
      ...(state ? { repository: state } : {}),
    };
    const reject = async (
      reason: string,
      report?: AcceptanceVerificationRecord["report"],
    ): Promise<Intake> => {
      const full = `acceptance verification rejected: ${reason}`;
      await writeAcceptanceRecord({
        ...base,
        status: "rejected",
        reason: full,
        ...(report ? { report } : {}),
      });
      void journal(inst.id, {
        at,
        kind: "acceptance.rejected",
        phaseId,
        runId,
        attempt: phase.attempt,
        detail: `${base.id}: ${reason}`,
      });
      return { ok: false, reason: full, failure: "acceptance-verification" };
    };

    const file = await readAgentAcceptance(runId);
    if (file.kind === "none") {
      if (ctx.required.length === 0) return { ok: true, staged: null };
      return reject(
        `the accepted change ${proposalId} declares ${ctx.required.length} acceptance criteri${
          ctx.required.length === 1 ? "on" : "a"
        } (${ctx.required.map((c) => c.id).join(", ")}) but the run wrote no acceptance-verification file; every one must receive an outcome`,
      );
    }
    if (file.kind === "unreadable") return reject(file.reason);
    let report: AcceptanceVerificationRecord["report"];
    try {
      report = parseAcceptanceReport(file.text);
    } catch (e) {
      return reject(
        e instanceof AcceptanceVerificationError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e),
      );
    }
    const refusal = await checkAcceptanceReport(report, ctx);
    if (refusal) return reject(`${refusal.code}: ${refusal.message}`, report);

    await writeAcceptanceRecord({ ...base, status: "staged", report });
    step.acceptanceVerification = { id: base.id, status: "staged" };
    await refreshAcceptanceSummary(phase, proposalId);
    void journal(inst.id, {
      at,
      kind: "acceptance.staged",
      phaseId,
      runId,
      attempt: phase.attempt,
      detail: `${base.id}: ${describeAcceptanceReport(report)} @ ${formatRepositoryState(state ?? undefined)}`,
    });
    return { ok: true, staged: null };
  }

  /** Where one run's work actually happened: its worktree, else the phase's
   *  own directory. The tree a repository-state snapshot must be taken of. */
  async function runCwd(
    def: PipelineDefinition,
    phase: PhaseProgress,
    runId: string,
  ): Promise<string> {
    const invocation = await readInvocation(runId);
    return (
      invocation?.workspace?.path ??
      invocation?.cwd ??
      phase.workspace?.path ??
      def.phases.find((p) => p.id === phase.id)?.cwd ??
      process.cwd()
    );
  }

  /** Recompute an acceptance phase's summary from the attempt's staged
   *  records. Counts only; the results stay in the staged record. */
  async function refreshAcceptanceSummary(phase: PhaseProgress, proposalId: string): Promise<void> {
    const previews = [];
    for (const step of phase.steps) {
      if (!step.runId || !step.acceptanceVerification) continue;
      const record = await readAcceptanceRecord(step.runId);
      if (!record?.report || record.attempt !== phase.attempt) continue;
      previews.push(previewAcceptance(record));
    }
    phase.acceptanceVerification = summarizeAcceptance(
      proposalId,
      previews,
      phase.knowledge?.status !== "applied" && previews.some((p) => p.status === "staged"),
    );
  }

  /**
   * The acceptance proposals a held phase would commit, resolved into the
   * durable records they become — or a refusal.
   *
   * This is where an agent's citation of a deterministic check meets Argus's
   * own report, exactly as it does for rule verification: every `check`
   * evidence record is bound to the phase's {@link VerificationReport}, and a
   * `satisfied` outcome citing a check Argus observed **failing** refuses the
   * commit. An agent can cite a test; it cannot claim one passed.
   */
  async function acceptanceProposalsOf(
    inst: PipelineInstance,
    phase: PhaseProgress,
  ): Promise<{ ok: true; proposals: AcceptanceProposal[] } | { ok: false; reason: string }> {
    const wanted = phase.knowledge?.acceptanceVerifications ?? [];
    if (wanted.length === 0) return { ok: true, proposals: [] };
    const ledger = await readLedger();
    const proposals: AcceptanceProposal[] = [];
    for (const step of phase.steps) {
      const id = step.acceptanceVerification?.id;
      if (!id || !wanted.includes(id) || !step.runId) continue;
      const record = await readAcceptanceRecord(step.runId);
      if (!record || record.id !== id || !record.report) {
        return {
          ok: false,
          reason: `acceptance verification ${id} is not staged for run ${step.runId}`,
        };
      }
      if (record.attempt !== phase.attempt) {
        return {
          ok: false,
          reason: `acceptance verification ${id} was staged for attempt ${record.attempt}, not ${phase.attempt}`,
        };
      }
      const missingProposal = acceptanceProposalMissing(ledger, record.proposalId);
      if (missingProposal) {
        return { ok: false, reason: `acceptance verification ${id}: ${missingProposal}` };
      }
      const results = (step.verification ?? phase.verification)?.checks ?? [];
      for (const c of record.report.criteria) {
        const bound = bindAcceptanceChecks(c.evidence, results);
        if (bound.missing.length > 0) {
          return {
            ok: false,
            reason: `acceptance verification ${id}: ${formatCriterionRef(
              record.proposalId,
              c.criterionId,
            )} cites check${bound.missing.length === 1 ? "" : "s"} ${bound.missing
              .map((l) => `"${l}"`)
              .join(", ")}, which this phase's verification report does not contain`,
          };
        }
        const forged = acceptanceCheckRefusal(
          record.proposalId,
          c.criterionId,
          c.outcome,
          bound.evidence,
        );
        if (forged) return { ok: false, reason: `acceptance verification ${id}: ${forged}` };
        proposals.push({
          proposalId: record.proposalId,
          criterionId: c.criterionId,
          outcome: c.outcome,
          execution: { runId: step.runId, instanceId: inst.id, phaseId: phase.id },
          evidence: bound.evidence,
          attempt: phase.attempt,
          ...(record.repository ? { repository: record.repository } : {}),
          ...(c.reason !== undefined ? { reason: c.reason } : {}),
          ...(c.note !== undefined ? { note: c.note } : {}),
        });
      }
    }
    return { ok: true, proposals };
  }

  /**
   * The deterministic facts Argus can establish about the artifacts a delta
   * declares: that the run *has* the root the location names (its artifact
   * directory; its worktree or working directory), that the path stays inside
   * that root, and that something exists there. Nothing about contents — the
   * agent's claim about what the file *is* stays the agent's.
   *
   * Run at intake and again at commit, against the same roots (the invocation
   * record's, which do not change between the two). A staged delta whose
   * artifact was removed while checks ran or a gate waited is refused at the
   * commit boundary rather than persisted as provenance for a file that is not
   * there. Returns the refusal, or null when every artifact still holds.
   */
  async function verifyDeltaArtifacts(
    def: PipelineDefinition,
    phase: PhaseProgress,
    runId: string,
    delta: NonNullable<KnowledgeDeltaRecord["delta"]>,
  ): Promise<string | null> {
    if (!delta.artifacts?.length) return null;
    const invocation = await readInvocation(runId);
    const phaseDef = def.phases.find((p) => p.id === phase.id);
    const roots = {
      "artifact-dir": invocation?.artifactDir ?? phase.artifactDir ?? null,
      repository: invocation?.workspace?.path ?? invocation?.cwd ?? phaseDef?.cwd ?? null,
    };
    for (const a of delta.artifacts) {
      const root = roots[a.location];
      if (!root) return `artifact ${a.location}:${a.path}: the run has no ${a.location}`;
      // The same containment rule the ledger enforces on write, applied to
      // the resolved path as well as the declared one: a path that escapes its
      // root is refused here even if the declared form slipped past validation.
      const resolvedRoot = path.resolve(root);
      const resolved = path.resolve(resolvedRoot, ...a.path.split("/"));
      if (
        !validArtifactPath(a.path) ||
        (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep))
      ) {
        return `artifact ${a.location}:${a.path} is not inside the run's ${a.location}`;
      }
      try {
        await stat(resolved);
      } catch {
        return `artifact ${a.location}:${a.path} does not exist in the run's ${a.location}`;
      }
    }
    return null;
  }

  function describeDelta(delta: NonNullable<KnowledgeDeltaRecord["delta"]>): string {
    const parts = [
      [delta.claims?.length ?? 0, "claim"],
      [delta.revisions?.length ?? 0, "revision"],
      [delta.evidence?.length ?? 0, "evidence"],
      [delta.justifications?.length ?? 0, "justification"],
      [delta.consumed?.length ?? 0, "consumed"],
      [delta.artifacts?.length ?? 0, "artifact"],
    ] as const;
    return parts
      .filter(([n]) => n > 0)
      .map(
        ([n, what]) =>
          `${n} ${what}${n === 1 || what === "evidence" || what === "consumed" ? "" : "s"}`,
      )
      .join(", ");
  }

  /**
   * Apply a held phase's staged deltas as one ledger transition and return
   * the verdict. Reads each step's staged record (refusing one staged for
   * another attempt — the instance says which attempt this is), commits them
   * in step order under the ledger mutex, and moves the records to `applied`
   * or `rejected`. Any refusal — a stale precondition, a conflict between two
   * steps, an unreadable ledger — is a verdict, never a thrown error: the
   * phase fails with the reason, and nothing was written.
   */
  async function commitPhaseKnowledge(
    def: PipelineDefinition,
    inst: PipelineInstance,
    phase: PhaseProgress,
  ): Promise<KnowledgeCommitVerdict> {
    const wanted = phase.knowledge?.deltas ?? [];
    const proposals: DeltaProposal[] = [];
    for (const step of phase.steps) {
      const id = step.knowledgeDelta?.id;
      if (!id || !wanted.includes(id) || !step.runId) continue;
      const record = await readDeltaRecord(step.runId);
      if (!record || record.id !== id || !record.delta) {
        return { ok: false, reason: `KnowledgeDelta ${id} is not staged for run ${step.runId}` };
      }
      if (record.attempt !== phase.attempt) {
        return {
          ok: false,
          reason: `KnowledgeDelta ${id} was staged for attempt ${record.attempt}, not ${phase.attempt}`,
        };
      }
      proposals.push({
        id,
        delta: record.delta,
        execution: { runId: step.runId, instanceId: inst.id, phaseId: phase.id },
        attempt: phase.attempt,
        ...(record.supplied !== undefined ? { supplied: record.supplied } : {}),
      });
    }
    const at = nowISO();
    // The declared artifacts, checked again now: intake proved they existed
    // when the run finished, not that they still do after checks ran and a
    // gate waited. One missing artifact refuses the whole attempt's commit
    // before the ledger is touched, so no sibling's delta lands without it.
    const phaseDef = def.phases.find((pd) => pd.id === phase.id);
    // Every refusal refuses the *whole* attempt: a phase that revises a rule,
    // verifies one and answers four criteria leaves all of it durable or none
    // of it. `failureClass` names which half was refused, so a retry policy
    // that opted into one class is not triggered by another.
    const refuseAll = async (
      reason: string,
      failureClass?: RetryableClass,
    ): Promise<KnowledgeCommitVerdict> => {
      for (const q of proposals) {
        await updateDeltaStatus(q.execution.runId, "rejected", { at, reason });
      }
      await refuseChangeProposals(phase, reason, at);
      await refuseAcceptance(phase, reason, at);
      return { ok: false, reason, ...(failureClass ? { failureClass } : {}) };
    };
    for (const p of proposals) {
      const missing = await verifyDeltaArtifacts(def, phase, p.execution.runId, p.delta);
      if (missing) {
        return refuseAll(
          `KnowledgeDelta commit refused: delta ${p.id} (run ${p.execution.runId}): artifact: ${missing}`,
          "knowledge-delta",
        );
      }
      // The discovery evidence, checked again at the commit boundary. Intake
      // proved the source files existed when the run finished, not that they
      // still do after checks ran and a person deliberated at the gate. A
      // rule whose evidence has gone missing in the meantime is refused
      // rather than committed as provenance for a file that is not there —
      // the same discipline the artifact check above applies, for the same
      // reason. One refusal refuses the whole attempt's commit, so no
      // sibling's delta lands without it.
      if (phaseDef?.discovery) {
        const verdict = await checkDiscoveryDelta(
          p.delta,
          await readLedger(),
          await discoveryContextFor(def, phase, p.execution.runId, phaseDef.discovery),
          p.supplied,
        );
        if (verdict.refusal) {
          return refuseAll(
            `KnowledgeDelta commit refused: delta ${p.id} (run ${p.execution.runId}): ${verdict.refusal}`,
            "knowledge-delta",
          );
        }
      }
    }
    // The attempt's conformance results (Phase 6), resolved against the checks
    // Argus itself ran. Gathered before the write so a forged or unsatisfied
    // check reference refuses the whole attempt rather than landing half of it.
    const verifications = await verificationProposalsOf(def, inst, phase);
    if (!verifications.ok) {
      const reason = `rule-verification commit refused: ${verifications.reason}`;
      await refuseVerifications(phase, reason, at);
      await refuseChangeProposals(phase, reason, at);
      return refuseAll(reason, "rule-verification");
    }
    // The attempt's accepted change intent (Phase 7). Gathered before the write
    // so the request that caused a revision, and the revision itself, are one
    // transition: a ledger holding RULE-42:v2 with no record of why it exists
    // is exactly the provenance gap this phase closes.
    const changes = await changeAcceptancesOf(inst, phase);
    if (!changes.ok) {
      const reason = `change-proposal commit refused: ${changes.reason}`;
      await refuseVerifications(phase, reason, at);
      await refuseChangeProposals(phase, reason, at);
      return refuseAll(reason, "change-proposal");
    }
    // The attempt's acceptance results (Phase 8), resolved against the checks
    // Argus itself ran. Gathered before the write for the same reason as the
    // conformance results: a forged or failing check reference refuses the
    // whole attempt rather than landing half of it.
    const acceptance = await acceptanceProposalsOf(inst, phase);
    if (!acceptance.ok) {
      const reason = `acceptance-verification commit refused: ${acceptance.reason}`;
      await refuseVerifications(phase, reason, at);
      await refuseChangeProposals(phase, reason, at);
      await refuseAcceptance(phase, reason, at);
      return refuseAll(reason, "acceptance-verification");
    }
    try {
      const results = await commitPhaseSemantics(
        proposals,
        verifications.proposals,
        deps.now(),
        changes.acceptances,
        acceptance.proposals,
      );
      for (const [i, p] of proposals.entries()) {
        await updateDeltaStatus(p.execution.runId, "applied", { at, result: results.deltas[i] });
      }
      // Each run's staged record keeps the durable records its proposal
      // became, so "what did this attempt make canonical?" is answerable from
      // the sidecar as well as from the ledger.
      for (const step of phase.steps) {
        if (!step.runId || !step.ruleVerification) continue;
        if (!(phase.knowledge?.verifications ?? []).includes(step.ruleVerification.id)) continue;
        await updateVerificationStatus(step.runId, "applied", {
          at,
          result: {
            verifications: results.verifications.filter((v) => v.execution.runId === step.runId),
          },
        });
      }
      // And the acceptance sidecar keeps the durable results it became.
      for (const step of phase.steps) {
        if (!step.runId || !step.acceptanceVerification) continue;
        if (
          !(phase.knowledge?.acceptanceVerifications ?? []).includes(step.acceptanceVerification.id)
        ) {
          continue;
        }
        await updateAcceptanceStatus(step.runId, "applied", {
          at,
          result: {
            criteria: results.acceptanceVerifications.filter(
              (v) => v.execution.runId === step.runId,
            ),
          },
        });
      }
      // And the change-intent sidecar keeps the durable proposal it became, so
      // "what did this attempt make canonical, and why?" is answerable from the
      // record beside the run as well as from the ledger.
      for (const step of phase.steps) {
        if (!step.runId || !step.changeProposal) continue;
        if (!(phase.knowledge?.changeProposals ?? []).includes(step.changeProposal.id)) continue;
        const accepted = results.changeProposals.find((c) => c.execution.runId === step.runId);
        await updateProposalStatus(step.runId, "accepted", {
          at,
          ...(accepted ? { result: { proposal: accepted } } : {}),
        });
      }
      return { ok: true };
    } catch (e) {
      // The ledger itself refused the transition. Which half it was about is
      // not decidable from the throw, so the reason names the half that was
      // the *only* thing at stake when there was one, and the class falls back
      // to what the attempt staged.
      const half =
        proposals.length > 0
          ? "KnowledgeDelta"
          : verifications.proposals.length > 0
            ? "rule-verification"
            : acceptance.proposals.length > 0
              ? "acceptance-verification"
              : "KnowledgeDelta";
      const reason = `${half} commit refused: ${
        e instanceof KnowledgeDeltaError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e)
      }`;
      for (const p of proposals) {
        await updateDeltaStatus(p.execution.runId, "rejected", { at, reason });
      }
      await refuseVerifications(phase, reason, at);
      await refuseChangeProposals(phase, reason, at);
      await refuseAcceptance(phase, reason, at);
      return { ok: false, reason };
    }
  }

  /** Mark this attempt's staged acceptance records rejected, so the refusal is
   *  readable beside the run as well as on the phase. */
  async function refuseAcceptance(phase: PhaseProgress, reason: string, at: string): Promise<void> {
    for (const step of phase.steps) {
      if (!step.runId || !step.acceptanceVerification) continue;
      if (
        !(phase.knowledge?.acceptanceVerifications ?? []).includes(step.acceptanceVerification.id)
      ) {
        continue;
      }
      await updateAcceptanceStatus(step.runId, "rejected", { at, reason });
    }
  }

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

  type ProposalIntake =
    | {
        ok: true;
        /** The proposal's semantic half, for the delta intake. Absent when the
         *  phase is not a change-intent phase. */
        semanticDelta?: KnowledgeDelta;
        /** The run whose staged proposal must be bound to the delta. */
        recordRunId?: string;
      }
    | { ok: false; reason: string; failure: RetryableClass };

  /**
   * What the run was actually given, read back from the document Argus
   * materialized for it (`ARGUS_CHANGE_REQUEST_FILE`).
   *
   * Deliberately read from the file rather than recomputed from the definition:
   * that file *is* the record of what this run was asked, frozen at launch, and
   * it survives a restart between the launch and the completion. Recomputing it
   * would let a pipeline edited mid-flight change what a finished run is held
   * to.
   */
  async function changeIntentOf(
    runId: string,
  ): Promise<{ request: ChangeRequest; selected: ClaimRef[]; gitHead: string | null } | null> {
    const invocation = await readInvocation(runId);
    const file = invocation?.changeRequestFile ?? changeRequestFile(runId);
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as {
        schemaVersion?: number;
        request?: ChangeRequest;
        relevant?: ChangeRuleState[];
        gitHead?: string;
      };
      if (parsed.schemaVersion !== 1 || !parsed.request) return null;
      return {
        request: parsed.request,
        selected: (parsed.relevant ?? []).map((r) => r.claim),
        gitHead: parsed.gitHead ?? null,
      };
    } catch {
      return null;
    }
  }

  /**
   * Read, validate and stage the ChangeProposal a completed change-intent run
   * wrote. Sets `step.changeProposal` on the in-memory instance when one was
   * staged, so the transition that follows sees it. Never touches the ledger.
   *
   * The same asymmetry with a KnowledgeDelta as a verification report has, and
   * it is deliberate: **no file is not "nothing proposed"**. A run given an
   * explicit requested change has an obligation to answer it, so an absent
   * proposal refuses the step rather than letting the phase succeed as though
   * the change had been considered.
   */
  async function intakeChangeProposal(
    def: PipelineDefinition,
    inst: PipelineInstance,
    phaseId: string,
    runId: string,
  ): Promise<ProposalIntake> {
    const phaseDef = def.phases.find((pd) => pd.id === phaseId);
    const policy = phaseDef?.changeIntent;
    if (!policy) return { ok: true };
    const phase = inst.phases.find((p) => p.id === phaseId);
    const step = phase?.steps.find((sp) => sp.runId === runId);
    if (!phase || !step) return { ok: true };
    const at = nowISO();

    // Staged already (a restart between the record write and the instance
    // write): the record decides, exactly as it did the first time.
    const existing = await readProposalRecord(runId);
    if (existing && existing.attempt === phase.attempt) {
      if (existing.status === "rejected") {
        return {
          ok: false,
          reason: existing.reason ?? "the change proposal was rejected",
          failure: "change-proposal",
        };
      }
      step.changeProposal = { id: existing.id, status: existing.status };
      return {
        ok: true,
        semanticDelta: existing.proposal?.semanticDelta ?? { schemaVersion: 1 },
        recordRunId: runId,
      };
    }

    const given = await changeIntentOf(runId);
    const supplied = await suppliedFor(runId);
    const base: Omit<ChangeProposalRecord, "status" | "request" | "selected"> = {
      id: `CP-${deps.newId()}`,
      runId,
      instanceId: inst.id,
      phaseId,
      attempt: phase.attempt,
      step: step.name,
      receivedAt: at,
      updatedAt: at,
      ...(supplied !== undefined ? { supplied } : {}),
      ...(given?.gitHead ? { gitHead: given.gitHead } : {}),
    };
    const reject = async (
      reason: string,
      extra: Partial<ChangeProposalRecord> = {},
    ): Promise<ProposalIntake> => {
      const full = `change proposal rejected: ${reason}`;
      await writeProposalRecord({
        ...base,
        request: given?.request ?? { id: "CR-unknown", summary: "(unrecorded)" },
        selected: given?.selected ?? [],
        status: "rejected",
        reason: full,
        ...extra,
      });
      void journal(inst.id, {
        at,
        kind: "change.rejected",
        phaseId,
        runId,
        attempt: phase.attempt,
        detail: `${base.id}: ${reason}`,
      });
      return { ok: false, reason: full, failure: "change-proposal" };
    };

    // Argus cannot hold a run to a request it cannot read back. Refusing is
    // the only honest option: accepting would credit the proposal with
    // answering whatever the definition says *now*.
    if (!given) {
      return reject(
        `the change-intent input Argus materialized for run ${runId} could not be read back, so what this run was asked cannot be established`,
      );
    }

    const file = await readAgentProposal(runId);
    if (file.kind === "none") {
      return reject(
        `the run wrote no change proposal; a change-intent phase must answer the requested change "${given.request.summary}" with a structured proposal`,
      );
    }
    if (file.kind === "unreadable") return reject(file.reason);
    let proposal: ChangeProposalRecord["proposal"];
    try {
      proposal = parseChangeProposal(file.text);
    } catch (e) {
      return reject(
        e instanceof ChangeProposalError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e),
      );
    }

    const ctx: ChangeIntentContext = {
      policy,
      request: given.request,
      selected: given.selected,
      gitHead: given.gitHead,
    };
    const verdict = checkChangeProposal(proposal, await readLedger(), ctx);
    if (verdict.refusal) {
      return reject(`${verdict.refusal.code}: ${verdict.refusal.message}`, { proposal });
    }

    await writeProposalRecord({
      ...base,
      request: given.request,
      selected: given.selected,
      status: "staged",
      proposal,
      readiness: verdict.readiness,
    });
    step.changeProposal = { id: base.id, status: "staged" };
    void journal(inst.id, {
      at,
      kind: "change.staged",
      phaseId,
      runId,
      attempt: phase.attempt,
      detail: `${base.id}: ${describeChangeProposal(proposal)} (${verdict.readiness})`,
    });
    return {
      ok: true,
      semanticDelta: proposal.semanticDelta ?? { schemaVersion: 1 },
      recordRunId: runId,
    };
  }

  /**
   * Bind the staged proposal to the staged delta that carries its semantic
   * half, and recompute the phase's summary.
   *
   * The two records are written separately — the delta by the Phase 3 intake,
   * the proposal by Phase 7's — and this is what ties them together, so the
   * commit knows which apply result to resolve the proposal's local references
   * against. A proposal whose semantic delta was empty gets no `deltaId`, which
   * is the honest record of a change that proposed no canonical mutation.
   */
  async function bindProposalDelta(
    def: PipelineDefinition,
    inst: PipelineInstance,
    phaseId: string,
    runId: string,
    deltaId: string | undefined,
  ): Promise<void> {
    const record = await readProposalRecord(runId);
    if (record && record.status === "staged" && record.deltaId !== deltaId) {
      await writeProposalRecord({
        ...record,
        ...(deltaId ? { deltaId } : {}),
        updatedAt: nowISO(),
      });
    }
    const phase = inst.phases.find((p) => p.id === phaseId);
    if (phase) await refreshChangeIntentSummary(def, phase);
  }

  /** Recompute a change-intent phase's {@link ChangeIntentSummary} from the
   *  attempt's staged proposal. Counts only; the proposal itself stays in the
   *  staged record, which is the one authoritative form of it. */
  async function refreshChangeIntentSummary(
    def: PipelineDefinition,
    phase: PhaseProgress,
  ): Promise<void> {
    const phaseDef = def.phases.find((p) => p.id === phase.id);
    const ledger = await readLedger();
    let preview = null;
    let staged = false;
    for (const step of phase.steps) {
      if (!step.runId || !step.changeProposal) continue;
      const record = await readProposalRecord(step.runId);
      if (!record?.proposal || record.attempt !== phase.attempt) continue;
      const deltaRecord = record.deltaId ? await readDeltaRecord(step.runId) : null;
      preview = previewChangeProposal(
        record,
        ledger,
        deltaRecord?.id === record.deltaId ? deltaRecord : null,
        phaseDef?.changeIntent,
      );
      staged = record.status === "staged";
    }
    const summary = summarizeChangeIntent(preview, phase.knowledge?.status !== "applied" && staged);
    if (summary) phase.changeIntent = summary;
  }

  /**
   * The change proposals a held phase would accept, resolved into the durable
   * records they become — or a refusal.
   *
   * Everything here was already decided at intake; what is gathered now is the
   * material the ledger transition needs, and the one thing that can still have
   * changed: a staged record that belongs to another attempt, or is no longer
   * staged at all.
   */
  async function changeAcceptancesOf(
    inst: PipelineInstance,
    phase: PhaseProgress,
  ): Promise<
    { ok: true; acceptances: ChangeProposalAcceptance[] } | { ok: false; reason: string }
  > {
    const wanted = phase.knowledge?.changeProposals ?? [];
    if (wanted.length === 0) return { ok: true, acceptances: [] };
    const acceptances: ChangeProposalAcceptance[] = [];
    for (const step of phase.steps) {
      const id = step.changeProposal?.id;
      if (!id || !wanted.includes(id) || !step.runId) continue;
      const record = await readProposalRecord(step.runId);
      if (!record || record.id !== id || !record.proposal) {
        return { ok: false, reason: `change proposal ${id} is not staged for run ${step.runId}` };
      }
      if (record.attempt !== phase.attempt) {
        return {
          ok: false,
          reason: `change proposal ${id} was staged for attempt ${record.attempt}, not ${phase.attempt}`,
        };
      }
      acceptances.push({
        id,
        request: record.request,
        execution: { runId: step.runId, instanceId: inst.id, phaseId: phase.id },
        attempt: phase.attempt,
        ...(record.deltaId ? { deltaId: record.deltaId } : {}),
        readiness: record.readiness ?? "needs-input",
        preserved: record.proposal.preserved ?? [],
        acceptanceCriteria: record.proposal.acceptanceCriteria ?? [],
        unresolved: record.proposal.unresolved ?? [],
        classification: record.proposal.classification ?? [],
      });
    }
    return { ok: true, acceptances };
  }

  /** Mark every staged change proposal of a held phase as rejected: the commit
   *  is one transition, so one refusal refuses all of it. */
  async function refuseChangeProposals(
    phase: PhaseProgress,
    reason: string,
    at: string,
  ): Promise<void> {
    for (const step of phase.steps) {
      if (!step.runId || !step.changeProposal) continue;
      if (!(phase.knowledge?.changeProposals ?? []).includes(step.changeProposal.id)) continue;
      await updateProposalStatus(step.runId, "rejected", { at, reason });
    }
  }

  /** Mark every staged verification of a held phase as rejected: the commit is
   *  one transition, so one refusal refuses all of it. */
  async function refuseVerifications(
    phase: PhaseProgress,
    reason: string,
    at: string,
  ): Promise<void> {
    for (const step of phase.steps) {
      if (!step.runId || !step.ruleVerification) continue;
      if (!(phase.knowledge?.verifications ?? []).includes(step.ruleVerification.id)) continue;
      await updateVerificationStatus(step.runId, "rejected", { at, reason });
    }
  }

  /**
   * Take a transition through the knowledge commit it asked for.
   *
   * A transition that met every other acceptance condition of a phase with
   * staged deltas has held it `running` under `knowledge.status: "pending"`
   * and named it in `commitKnowledge`. The held state is persisted *first*
   * — so a crash after the ledger write is healed by committing again, which
   * is idempotent — then the deltas are committed and the verdict applied.
   * Returns the transition the caller should continue with: what the verdict
   * settled (the successors it made ready, the routes it decided), merged
   * with what the original transition had already settled.
   */
  async function settleKnowledge(
    def: PipelineDefinition,
    res: TransitionResult,
  ): Promise<TransitionResult> {
    if (!res.commitKnowledge?.length) return res;
    let out: TransitionResult = { ...res };
    delete out.commitKnowledge;
    for (const phaseId of res.commitKnowledge) {
      const phase = out.instance.phases.find((p) => p.id === phaseId);
      if (!phase || phase.knowledge?.status !== "pending") continue;
      await saveInstance(out.instance);
      const verdict = await commitPhaseKnowledge(def, out.instance, phase);
      const next = applyKnowledgeCommit(def, out.instance, phaseId, verdict, nowISO());
      if (!next.knowledgeApplied) continue;
      // The candidates are canonical now (or refused): the phase's discovery
      // summary is recomputed so `requiresReview` stops saying a decision is
      // outstanding once it has been made.
      const settledPhase = next.instance.phases.find((p) => p.id === phaseId);
      if (settledPhase?.discovery) await refreshDiscoverySummary(def, settledPhase);
      if (settledPhase?.ruleVerification) await refreshVerificationSummary(settledPhase);
      if (settledPhase?.changeIntent) await refreshChangeIntentSummary(def, settledPhase);
      // One commit, two journals — each written only when that half had
      // something at stake, so a verification-only phase never logs "0 deltas"
      // and a delta-only phase never logs a verification.
      const verifications = phase.knowledge.verifications ?? [];
      if (verifications.length > 0) {
        void journal(out.instance.id, {
          at: nowISO(),
          kind: verdict.ok ? "verification.applied" : "verification.rejected",
          phaseId,
          attempt: phase.attempt,
          detail: verdict.ok
            ? `${verifications.length} verification proposal${verifications.length === 1 ? "" : "s"}`
            : verdict.reason,
        });
      }
      const changes = phase.knowledge.changeProposals ?? [];
      if (changes.length > 0) {
        void journal(out.instance.id, {
          at: nowISO(),
          kind: verdict.ok ? "change.accepted" : "change.rejected",
          phaseId,
          attempt: phase.attempt,
          detail: verdict.ok ? changes.join(", ") : verdict.reason,
        });
      }
      if (phase.knowledge.deltas.length > 0) {
        void journal(out.instance.id, {
          at: nowISO(),
          kind: verdict.ok ? "knowledge.applied" : "knowledge.rejected",
          phaseId,
          attempt: phase.attempt,
          detail: verdict.ok
            ? `${phase.knowledge.deltas.length} delta${phase.knowledge.deltas.length === 1 ? "" : "s"}: ${phase.knowledge.deltas.join(", ")}`
            : verdict.reason,
        });
      }
      // The failure class matches what `applyKnowledgeCommit` already wrote on
      // the phase: a commit that carried only conformance results failed as
      // `rule-verification`, not as a knowledge delta.
      if (!verdict.ok) {
        // The same class the transition wrote onto the phase: derived from
        // what the attempt staged unless the commit said which half it was.
        noteFailure(
          def,
          next.instance,
          phaseId,
          verdict.failureClass ?? commitFailureClass(phase.knowledge),
          verdict.reason,
        );
      }
      out = {
        ...next,
        startPhases: [...new Set([...out.startPhases, ...next.startPhases])],
        routing: mergeRouting(out.routing, next.routing),
      };
    }
    return out;
  }

  /**
   * Drive every change realization of this instance through whatever the
   * transition just settled (Phase 8).
   *
   * Called immediately after {@link settleKnowledge}, inside the same instance
   * lock, so it sees the phases in exactly the state the transition left them
   * and its own writes are saved with them. Idempotent: an attempt already
   * recorded on the realization is never recorded twice, and a realization
   * that already has an outcome is left alone — so a restart, a reconcile or a
   * second transition in the same window heals rather than duplicating.
   */
  async function settleRealizations(
    def: PipelineDefinition,
    res: TransitionResult,
  ): Promise<TransitionResult> {
    let out = res;
    for (const phaseDef of def.phases) {
      if (!phaseDef.implementation) continue;
      out = await settleRealization(def, out, phaseDef);
    }
    return out;
  }

  /** The phases that must run again for a remediation: the verifier, and every
   *  phase between the implementation and it. Earlier accepted work —
   *  discovery, change intent, the human approval — is historical input and is
   *  never re-run. */
  function realizationPhases(
    def: PipelineDefinition,
    implId: string,
    verifierId: string,
  ): string[] {
    const needs = resolveNeeds(def.phases);
    const ancestors = (id: string): Set<string> => {
      const seen = new Set<string>();
      const queue = [...(needs.get(id) ?? [])];
      while (queue.length) {
        const next = queue.shift()!;
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(...(needs.get(next) ?? []));
      }
      return seen;
    };
    const verifierAncestors = ancestors(verifierId);
    return def.phases
      .map((p) => p.id)
      .filter(
        (id) =>
          id !== implId &&
          (id === verifierId || (verifierAncestors.has(id) && ancestors(id).has(implId))),
      );
  }

  async function settleRealization(
    def: PipelineDefinition,
    res: TransitionResult,
    implPhaseDef: PhaseDef,
  ): Promise<TransitionResult> {
    const inst = res.instance;
    const impl = inst.phases.find((p) => p.id === implPhaseDef.id);
    if (!impl) return res;
    const ledger = await readLedger();
    const link = impl.realization;
    // A phase that ended without carrying its link — an abort, a launch the
    // preflight refused after the realization was opened, a crash between the
    // ledger write and the instance write — must not leave a realization
    // reading `running` forever. It is closed with what actually happened.
    if (!link) {
      const orphan = changeRealizationOfPhase(ledger, inst.id, implPhaseDef.id);
      if (orphan && !orphan.outcome && TERMINAL_PHASE.includes(impl.status)) {
        await closeRealization(orphan.id, {
          status: "failed",
          reason: `the implementation phase ended ${impl.status} without completing an attempt`,
          unmetRules: [],
          unmetCriteria: [],
          completedAt: nowISO(),
        });
      }
      return res;
    }
    const realization = changeRealizationById(ledger, link.id);
    if (!realization || realization.outcome) return res;
    const attempt = realization.attempts.length + 1;
    if (link.attempt !== attempt) return res;
    const proposal = changeProposalById(ledger, realization.proposalId);
    if (!proposal) return res;
    const verifierId = realizationVerifierOf(def, implPhaseDef.id);
    const verifier = verifierId ? inst.phases.find((p) => p.id === verifierId) : undefined;
    const at = nowISO();

    // The implementation's own repository state, taken the moment the phase
    // concludes and before the verification phase is queued — so what the
    // verifier is asked about and what the implementation produced are the
    // same tree, and a verifier that modified it is caught rather than
    // credited.
    //
    // Once per (phase, attempt): a transition may reach here several times
    // while the verification runs, and re-snapshotting would both cost a
    // `git status` each time and, on a tree an agent is still writing to,
    // answer differently. A restart re-snapshots, which is the honest
    // behaviour when the in-memory note is gone.
    let repository = link.repository;
    const snapshotKey = `${inst.id}:${implPhaseDef.id}:${attempt}`;
    if (impl.status === "succeeded" && !repository && !implementationSnapshots.has(snapshotKey)) {
      implementationSnapshots.add(snapshotKey);
      repository =
        repositoryStateFrom(await snapshotWorkingTree(implCwd(def, implPhaseDef, impl))) ??
        undefined;
      impl.realization = { ...link, ...(repository ? { repository } : {}) };
      void journal(inst.id, {
        at,
        kind: "realization.implementation-completed",
        phaseId: implPhaseDef.id,
        attempt: impl.attempt,
        detail: `${realization.id} attempt ${attempt} @ ${formatRepositoryState(repository)}`,
      });
    }

    // Which half, if either, has ended? Every terminal status counts, not just
    // `failed`: an aborted or routed-out phase ends the attempt as surely as a
    // failed one, and leaving the realization `running` would be a completion
    // question nothing would ever answer.
    if (!TERMINAL_PHASE.includes(impl.status)) return res;
    const verifierDone = !verifier || TERMINAL_PHASE.includes(verifier.status);
    if (impl.status === "succeeded" && !verifierDone) return res;

    const runsOf = (phase: PhaseProgress | undefined): RunExecutionRef[] =>
      (phase?.steps ?? []).flatMap((st) =>
        st.runId ? [{ runId: st.runId, instanceId: inst.id, phaseId: phase!.id }] : [],
      );
    const verificationRuns = runsOf(verifier);
    const verificationRunIds = verificationRuns.map((r) => r.runId);
    const ruleVerifications = ledger.verifications.filter((v) =>
      verificationRunIds.includes(v.execution.runId),
    );
    const acceptanceVerifications = ledger.acceptanceVerifications.filter((v) =>
      verificationRunIds.includes(v.execution.runId),
    );
    const verificationState = await verifiedRepositoryState(
      ruleVerifications,
      acceptanceVerifications,
    );

    const implementation: "succeeded" | "failed" | "blocked" =
      impl.status !== "succeeded"
        ? isBlocker(impl)
          ? "blocked"
          : "failed"
        : verifier && verifier.status !== "succeeded"
          ? "failed"
          : "succeeded";
    const verdict = evaluateCompletion({
      ledger,
      proposal,
      implementation,
      ...(technicalResultFrom([impl.verification, verifier?.verification])
        ? { technical: technicalResultFrom([impl.verification, verifier?.verification])! }
        : {}),
      implementationState: impl.status === "succeeded" ? (repository ?? null) : null,
      verificationState: impl.status === "succeeded" ? verificationState : null,
      ruleVerifications,
      acceptanceVerifications,
      ...(def.phases.find((p) => p.id === verifierId)?.acceptanceVerification
        ? {
            acceptancePolicy: def.phases.find((p) => p.id === verifierId)!.acceptanceVerification!,
          }
        : {}),
    });

    // The last precondition, and the one §stale intent exists for: the
    // implementation may be perfect and the business may have moved on while
    // it ran. The attempt's results stay historically true about the exact
    // revisions they named; what may not happen is presenting the realization
    // as *current* completion.
    const currency = realizationIntentCurrency(ledger, realization.target);
    const outcome = currency.current ? verdict.outcome : "stale-intent";
    const reason = currency.current
      ? verdict.reason
      : `the semantic target moved while this realization ran: ${currency.superseded
          .map((x) => `${formatClaimRef(x.from)} → ${formatClaimRef(x.to)}`)
          .join(
            ", ",
          )}. The implementation's own results stand for the revisions they named; this realization is not current completion`;

    const record: ChangeRealizationAttempt = {
      attempt,
      kind: link.kind,
      implementation: runsOf(impl),
      verification: verificationRuns,
      ...(repository ? { repository } : {}),
      ...(technicalResultFrom([impl.verification, verifier?.verification])
        ? { technical: technicalResultFrom([impl.verification, verifier?.verification])! }
        : {}),
      ruleResults: verdict.ruleResults,
      acceptanceResults: verdict.acceptanceResults,
      outcome,
      reason,
      startedAt: realization.createdAt,
      endedAt: at,
    };
    try {
      await recordRealizationAttempt(realization.id, record);
    } catch (e) {
      log.error("realization attempt could not be recorded", {
        instanceId: inst.id,
        realizationId: realization.id,
        err: e,
      });
      return res;
    }
    if (verifier) {
      void journal(inst.id, {
        at,
        kind: "realization.verification-completed",
        phaseId: verifier.id,
        attempt: verifier.attempt,
        detail: `${realization.id} attempt ${attempt}: ${outcome} — ${reason}`,
      });
    }

    // ── Succeeded ────────────────────────────────────────────────────────────
    if (outcome === "succeeded") {
      await closeRealization(realization.id, {
        status: "succeeded",
        ...(repository ? { repository } : {}),
        reason,
        unmetRules: [],
        unmetCriteria: [],
        completedAt: at,
      });
      void journal(inst.id, {
        at,
        kind: "realization.succeeded",
        phaseId: implPhaseDef.id,
        detail: `${realization.id} → ${proposal.id} @ ${formatRepositoryState(repository)} after ${attempt} attempt${attempt === 1 ? "" : "s"}`,
      });
      return res;
    }

    const unmetRules = verdict.ruleResults.filter((r) => r.outcome !== "holds");
    const unmetCriteria = verdict.acceptanceResults.filter((r) => r.outcome !== "satisfied");

    // ── Stale intent: stop, never remediate ─────────────────────────────────
    if (outcome === "stale-intent") {
      await closeRealization(realization.id, {
        status: "stale",
        ...(repository ? { repository } : {}),
        reason,
        unmetRules,
        unmetCriteria,
        completedAt: at,
      });
      void journal(inst.id, {
        at,
        kind: "realization.stale",
        phaseId: implPhaseDef.id,
        detail: `${realization.id}: ${reason}`,
      });
      return res;
    }

    // ── Another targeted attempt, or a terminal failure ─────────────────────
    const attemptsLeft = realization.maxAttempts - attempt;
    if (verdict.remediable && attemptsLeft > 0 && verifierId && inst.status !== "aborted") {
      const next = applyRemediation(
        inst,
        implPhaseDef.id,
        realizationPhases(def, implPhaseDef.id, verifierId),
        at,
      );
      void journal(inst.id, {
        at,
        kind: "realization.remediation-started",
        phaseId: implPhaseDef.id,
        detail: `${realization.id}: attempt ${attempt} ${outcome} (${reason}); ${attemptsLeft} attempt${attemptsLeft === 1 ? "" : "s"} left`,
      });
      return {
        ...res,
        instance: next.instance,
        startPhases: [...new Set([...res.startPhases, ...next.startPhases])],
      };
    }

    // Why no further attempt is taken, when one could otherwise have been. The
    // three reasons are different facts and the record says which: a spent
    // budget, an aborted instance, and a realization with no verifier at all.
    const blocked =
      inst.status === "aborted"
        ? "the instance was aborted"
        : !verifierId
          ? "this realization has no verification phase, so nothing can decide it"
          : attemptsLeft <= 0
            ? `the realization's ${realization.maxAttempts}-attempt budget is exhausted`
            : null;
    const terminal = verdict.remediable && blocked ? `${reason}; ${blocked}` : reason;
    await closeRealization(realization.id, {
      status: "failed",
      ...(repository ? { repository } : {}),
      reason: terminal,
      unmetRules,
      unmetCriteria,
      completedAt: at,
    });
    void journal(inst.id, {
      at,
      kind: "realization.failed",
      phaseId: implPhaseDef.id,
      detail: `${realization.id}: ${terminal}`,
    });
    return res;
  }

  /** Where an implementation phase's work happened: its worktree, else its own
   *  `cwd`. Synchronous, because the phase record already knows. */
  function implCwd(def: PipelineDefinition, phaseDef: PhaseDef, phase: PhaseProgress): string {
    return phase.workspace?.path ?? phaseDef.cwd;
  }

  /** Did the implementation phase fail because the agent reported a blocker?
   *  `ARGUS_OUTCOME: blocked` becomes a `signal` failure whose reason the hook
   *  prefixes with `blocked`, which is the existing mechanism Phase 8 reuses
   *  rather than inventing a second one. */
  function isBlocker(phase: PhaseProgress): boolean {
    const reason = (phase.payload as PhaseFailurePayload | null)?.reason ?? "";
    return /^blocked\b/i.test(reason.trim());
  }

  /**
   * The one repository state every result of this attempt's verification was
   * bound to, or null when they disagree (or none exists).
   *
   * Disagreement is not smoothed over: two verification runs that examined
   * different trees cannot jointly prove anything about one implementation, so
   * the completion check sees `null` and fails closed as `state-mismatch`.
   */
  async function verifiedRepositoryState(
    rules: RuleVerification[],
    acceptance: AcceptanceVerification[],
  ): Promise<RepositoryStateRef | null> {
    const states: (RepositoryStateRef | undefined)[] = [
      ...rules.map((r) => r.repositoryState),
      ...acceptance.map((a) => a.repository),
    ];
    const present = states.filter((x): x is RepositoryStateRef => x !== undefined);
    if (present.length === 0) return null;
    const first = present[0];
    return present.every((s) => sameRepositoryState(s, first)) ? first : null;
  }

  function mergeRouting(a?: RouteOutcome, b?: RouteOutcome): RouteOutcome | undefined {
    if (!a) return b;
    if (!b) return a;
    return {
      decisions: [...a.decisions, ...b.decisions],
      skipped: [...a.skipped, ...b.skipped],
      failures: [...a.failures, ...b.failures],
    };
  }

  /** Move the named steps' staged deltas, verification proposals and change
   *  proposals to `superseded`, on disk and on the instance. An `applied` or
   *  `accepted` record is never touched. */
  async function supersedeDeltas(
    inst: PipelineInstance,
    phase: PhaseProgress,
    steps: StepProgress[],
    reason: string,
  ): Promise<void> {
    for (const step of steps) {
      if (!step.runId) continue;
      if (step.knowledgeDelta?.status === "staged") {
        await updateDeltaStatus(step.runId, "superseded", { at: nowISO(), reason });
        step.knowledgeDelta = { ...step.knowledgeDelta, status: "superseded" };
        void journal(inst.id, {
          at: nowISO(),
          kind: "knowledge.superseded",
          phaseId: phase.id,
          runId: step.runId,
          attempt: phase.attempt,
          detail: `${step.knowledgeDelta.id}: ${reason}`,
        });
      }
      if (step.acceptanceVerification?.status === "staged") {
        await updateAcceptanceStatus(step.runId, "superseded", { at: nowISO(), reason });
        step.acceptanceVerification = { ...step.acceptanceVerification, status: "superseded" };
        void journal(inst.id, {
          at: nowISO(),
          kind: "acceptance.superseded",
          phaseId: phase.id,
          runId: step.runId,
          attempt: phase.attempt,
          detail: `${step.acceptanceVerification.id}: ${reason}`,
        });
      }
      if (step.ruleVerification?.status === "staged") {
        await updateVerificationStatus(step.runId, "superseded", { at: nowISO(), reason });
        step.ruleVerification = { ...step.ruleVerification, status: "superseded" };
        void journal(inst.id, {
          at: nowISO(),
          kind: "verification.superseded",
          phaseId: phase.id,
          runId: step.runId,
          attempt: phase.attempt,
          detail: `${step.ruleVerification.id}: ${reason}`,
        });
      }
      if (step.changeProposal?.status === "staged") {
        await updateProposalStatus(step.runId, "superseded", { at: nowISO(), reason });
        step.changeProposal = { ...step.changeProposal, status: "superseded" };
        void journal(inst.id, {
          at: nowISO(),
          kind: "change.superseded",
          phaseId: phase.id,
          runId: step.runId,
          attempt: phase.attempt,
          detail: `${step.changeProposal.id}: ${reason}`,
        });
      }
    }
  }

  /**
   * Every staged delta, verification proposal and change proposal on an
   * attempt that can no longer be accepted — a
   * failed, aborted or skipped phase, or a step that failed, was aborted (a
   * losing candidate) or was skipped — is superseded. Run on every instance
   * write, because an attempt can end from a dozen places and a hook on each
   * is a hook somebody forgets. Cheap when nothing is staged (the common case:
   * one pass over the steps, no I/O).
   */
  async function retireStagedDeltas(inst: PipelineInstance): Promise<void> {
    for (const phase of inst.phases) {
      const phaseOver =
        phase.status === "failed" || phase.status === "aborted" || phase.status === "skipped";
      const doomed = phase.steps.filter(
        (s) =>
          (s.knowledgeDelta?.status === "staged" ||
            s.ruleVerification?.status === "staged" ||
            s.acceptanceVerification?.status === "staged" ||
            s.changeProposal?.status === "staged") &&
          (phaseOver || s.status === "failed" || s.status === "aborted" || s.status === "skipped"),
      );
      if (doomed.length === 0) continue;
      await supersedeDeltas(
        inst,
        phase,
        doomed,
        phaseOver
          ? `phase attempt ${phase.attempt} ${phase.status}`
          : `step ${doomed.map((s) => `${s.name} ${s.status}`).join(", ")}`,
      );
    }
  }

  // ── Candidates ─────────────────────────────────────────────────────────────

  /**
   * Every candidate of a phase, as the selectors need to read it: what the
   * instance persisted, joined with what the run records say it cost.
   *
   * The join lives here rather than in the transitions because cost and
   * duration are not on the instance — they are read off the run at display
   * time — and `cheapest-verified` is precisely a rule about them.
   */
  async function candidateRecordsFor(phase: PhaseProgress): Promise<CandidateRecord[]> {
    const records: CandidateRecord[] = [];
    for (const step of phase.steps) {
      if (step.candidate === undefined) continue;
      const got = step.runId ? await readRun(step.runId) : null;
      records.push({
        ...candidateRecordOf(step),
        costUsd: got?.run.costUsd ?? null,
        durationMs: got?.run.durationMs ?? null,
        runtime: got?.run.runtime ?? null,
        model: got?.run.model ?? null,
      });
    }
    return records;
  }

  /** Remove the worktrees of the candidates that did not win. The branches
   *  survive, as everywhere else: a losing draft is still evidence, and a
   *  `keep` policy keeps its directory too. */
  async function removeCandidateTrees(
    def: PipelineDefinition,
    inst: PipelineInstance,
    phaseDef: PhaseDef,
    phase: PhaseProgress,
    keptCandidate: number | null,
  ): Promise<void> {
    if (workspacePolicyFor(def, phaseDef)?.keep === true) return;
    for (const step of phase.steps) {
      if (step.candidate === undefined || step.candidate === keptCandidate) continue;
      if (!step.workspace) continue;
      const tree = step.workspace;
      // The record is only forgotten once the directory is: a tree the kill
      // raced (the agent still writing as git was asked to take it away) stays
      // on the step, and the instance's own cleanup collects it at settlement.
      if (await removeWorkspace(inst.id, phaseDef.cwd, tree.path, tree.branch)) {
        step.workspace = null;
      }
    }
  }

  /**
   * Ask a candidates phase whether it has an answer yet, and act on it.
   *
   * Called after anything that could move a candidate — a signal, a report from
   * its checks, a deadline, a run found dead after a restart — always under the
   * instance lock, with the in-memory instance. Three outcomes, and the first is
   * the common one:
   *
   *  - nothing decided yet, so nothing happens;
   *  - a winner, whose worktree, payload, result and verification become the
   *    phase's; the siblings still running are killed (`first-verified` exists
   *    to stop paying for them) and their trees removed;
   *  - nobody left who could win, so the phase fails once, with every
   *    candidate's fate in the reason and the retry policy applied as usual.
   */
  async function settleCandidates(
    def: PipelineDefinition,
    inst: PipelineInstance,
    phaseId: string,
  ): Promise<void> {
    const phase = inst.phases.find((p) => p.id === phaseId);
    const phaseDef = def.phases.find((p) => p.id === phaseId);
    if (!phase || !phaseDef?.candidates || phase.status !== "running") return;
    const records = await candidateRecordsFor(phase);
    const decision = selectCandidate(phaseDef.candidates, records);
    if (decision.kind === "pending") return;
    const outcomes = toCandidateOutcomes(records);

    let res: TransitionResult;
    if (decision.kind === "selected") {
      const winner = decision.candidate;
      // Kill first, transition second: the reason is written onto the run
      // record before the process dies, so the close handler reports "superseded
      // by candidate k" rather than inventing something from an exit code.
      for (const step of phase.steps) {
        if (step.candidate === undefined || step.candidate === winner || !step.runId) continue;
        const got = await readRun(step.runId);
        if (got && got.run.status === "running" && isAlive(got.run.pid)) {
          if (!got.run.termination) {
            await patchRun(step.runId, {
              termination: "killed",
              error: `superseded by candidate ${winner}`,
            });
          }
          await stopRun(got.run.pid);
        }
        deps.tailer?.untrack(step.runId);
      }
      await removeCandidateTrees(def, inst, phaseDef, phase, winner);
      res = applyCandidateSelection(def, inst, phaseId, winner, outcomes, nowISO());
      void journal(inst.id, {
        at: nowISO(),
        kind: "phase.candidate-selected",
        phaseId,
        attempt: phase.attempt,
        detail: `c${winner} of ${records.length} (${phaseDef.candidates.select})`,
      });
      res = await settleKnowledge(def, res);
      res = await settleRealizations(def, res);
    } else {
      const failureClass = candidateFailureClass(records);
      const reason = candidateFailureReason(records);
      await removeCandidateTrees(def, inst, phaseDef, phase, null);
      res = applyCandidatesExhausted(def, inst, phaseId, failureClass, reason, outcomes, nowISO());
      if (failureClass === "configuration") {
        // Every candidate was refused as declared, so the definition is what is
        // wrong and another attempt cannot help. Journalled, never retried.
        void journal(inst.id, {
          at: nowISO(),
          kind: "phase.failed",
          phaseId,
          attempt: phase.attempt,
          detail: `configuration: ${reason}`,
        });
      } else {
        // The class is already on the payload; this is what schedules the retry
        // and writes the `phase.failed` entry, exactly as for any other failure.
        noteFailure(def, res.instance, phaseId, failureClass, reason);
      }
    }

    noteRouting(def, res.instance, res.routing);
    await saveInstance(res.instance);
    if (res.instance.status === "succeeded" || res.instance.status === "failed") {
      void journal(inst.id, { at: nowISO(), kind: "instance.ended", detail: res.instance.status });
    }
    queueReadyPhases(inst.id, def, res.instance, res.startPhases);
    if (res.instance.status === "failed") deps.onFailure?.(res.instance);
    deps.onChange?.();
  }

  /**
   * Run one candidate's copy of the phase's checks, inside that candidate's own
   * worktree, against its own baseline and artifact directory.
   *
   * The same shape as {@link queueVerification} and for the same reasons — off
   * the lock because a test suite takes as long as a test suite, keyed so a
   * crash mid-verification is re-run by reconcile and a stale report is a no-op
   * — but keyed by candidate as well as attempt, because a candidates phase has
   * `count` independent verdicts rather than one.
   */
  function queueCandidateVerification(
    instanceId: string,
    def: PipelineDefinition,
    phaseId: string,
    attempt: number,
    candidate: number,
  ): void {
    const key = `${instanceId}:${phaseId}:${attempt}:c${candidate}`;
    if (verifying.has(key)) return;
    verifying.add(key);
    const phaseDef = def.phases.find((p) => p.id === phaseId);
    void track(
      (async () => {
        if (!phaseDef) return;
        const inst = await readInstance(instanceId);
        const phase = inst?.phases.find((p) => p.id === phaseId);
        const step = phase?.steps.find((s) => s.candidate === candidate);
        if (!inst || !phase || !step) return;
        const count = phaseDef.checks?.length ?? 0;
        void journal(instanceId, {
          at: nowISO(),
          kind: "phase.verifying",
          phaseId,
          attempt,
          detail: `c${candidate}: ${count} check${count === 1 ? "" : "s"}`,
        });
        let baseline: WorkingTreeSnapshot | null = null;
        try {
          baseline = JSON.parse(
            await readFile(
              phaseBaselinePath(paths.invocationsDir(), instanceId, phaseId, attempt, candidate),
              "utf8",
            ),
          ) as WorkingTreeSnapshot;
        } catch {
          /* no baseline recorded (not a git repository, or no changed-files check) */
        }
        const own = candidateArtifactDir(
          phase.artifactDir ?? phaseArtifactDir(paths.artifactsDir(), instanceId, phaseId),
          candidate,
        );
        const report = await runChecks(phaseDef.checks ?? [], {
          // This candidate's tree, not the phase's: the whole point is that each
          // draft is judged on what it alone did.
          cwd: step.workspace?.path ?? phase.workspace?.path ?? phaseDef.cwd,
          artifactDir: own,
          baseline,
          now: deps.now,
          env: buildChildEnv(parentEnv(), resolveCapabilities(def, phaseDef, {})?.env).env,
        });
        await locks.withLock(instanceId, async () => {
          const fresh = await readInstance(instanceId);
          if (!fresh || fresh.status !== "running") return;
          const current = fresh.phases.find((p) => p.id === phaseId);
          if (!current || current.attempt !== attempt) return;
          const res = applyCandidateVerification(fresh, phaseId, candidate, report, nowISO());
          if (!res.verificationApplied) return;
          void journal(instanceId, {
            at: nowISO(),
            kind: "phase.verified",
            phaseId,
            attempt,
            detail:
              report.status === "passed"
                ? `c${candidate} passed: ${report.checks.length} check${report.checks.length === 1 ? "" : "s"}`
                : `c${candidate} failed: ${report.checks
                    .filter((c) => c.status === "failed")
                    .map((c) => c.label)
                    .join(", ")}`,
          });
          await saveInstance(res.instance);
          await settleCandidates(def, res.instance, phaseId);
          deps.onChange?.();
        });
      })()
        .catch((e: unknown) =>
          log.error("candidate verification failed to run", {
            instanceId,
            phaseId,
            candidate,
            err: e,
          }),
        )
        .finally(() => verifying.delete(key)),
    );
  }

  /** Start the checks a transition asked for, by phase id. */
  function queueVerifications(
    instanceId: string,
    def: PipelineDefinition,
    inst: PipelineInstance,
    phaseIds: string[] | undefined,
  ): void {
    for (const id of phaseIds ?? []) {
      const phase = inst.phases.find((p) => p.id === id);
      if (phase) queueVerification(instanceId, def, id, phase.attempt);
    }
  }

  async function onSignal(instanceId: string, signal: PipelineSignal): Promise<ActionResult> {
    return locks.withLock(instanceId, async () => {
      const inst = await readInstance(instanceId);
      if (!inst) return { ok: false, code: 404 };
      if (signal.token !== inst.signalToken) return { ok: false, code: 403 };
      if (inst.status !== "running") return { ok: true, code: 200 }; // paused/terminal → idempotent ignore
      const def = await defFor(inst);
      if (!def) return { ok: false, code: 404 };
      // A completion is accepted only once Argus has re-verified the semantic
      // context it supplied (Phase 4.1) and read, validated and staged any
      // KnowledgeDelta the run wrote — both *before* the transition, so a
      // refusal fails the step under its own class instead of the step
      // succeeding with the proposal silently dropped, and a staged delta is
      // on the step by the time the transition decides whether the phase may
      // conclude.
      const intake =
        signal.type === "completed" && liveStep(inst, signal.phaseId, signal.runId)
          ? await acceptCompletion(def, inst, signal.phaseId, signal.runId)
          : null;
      let res =
        intake && !intake.ok
          ? failStepInPlace(def, inst, signal.phaseId, signal.runId, intake.failure, intake.reason)
          : advance(def, inst, signal, nowISO());
      const outcome: Run["outcome"] | undefined =
        intake && !intake.ok
          ? "failed"
          : signal.type === "failed"
            ? "failed"
            : signal.type === "completed"
              ? "succeeded"
              : undefined;
      if (res.ignored) {
        // The instance is untouched; say so where someone debugging will look,
        // instead of journalling the signal as if it had landed. The run did
        // report, so its own record keeps the outcome.
        const status = inst.phases.find((p) => p.id === signal.phaseId)?.status;
        const why =
          res.ignored === "unknown-phase"
            ? `no phase "${signal.phaseId}" on this instance`
            : res.ignored === "phase-not-running"
              ? `phase "${signal.phaseId}" is ${status}, not running`
              : `run ${signal.runId} is not a tracked step of phase "${signal.phaseId}"`;
        log.warn("pipeline signal ignored", {
          instanceId,
          phaseId: signal.phaseId,
          runId: signal.runId,
          type: signal.type,
          reason: res.ignored,
        });
        if (outcome) await patchRun(signal.runId, { outcome });
        void journal(instanceId, {
          at: nowISO(),
          kind: "phase.signalled",
          phaseId: signal.phaseId,
          runId: signal.runId,
          detail: `${signal.type} (ignored: ${why})`,
        });
        return { ok: true, code: 202 };
      }
      res = await settleKnowledge(def, res);
      res = await settleRealizations(def, res);
      const { instance, startPhases: ready, routing, verify, verifyCandidate } = res;
      noteRouting(def, instance, routing);
      // A candidate's failure is not the phase's: it loses, the phase carries
      // on, and `settleCandidates` below decides whether anything is left.
      if (signal.type === "failed" && !res.candidatesMoved) {
        // An agent that signalled failure has considered the work, so this
        // class is excluded from the default retry set — but an author who
        // opted into it gets it.
        noteFailure(def, instance, signal.phaseId, "signal", "the agent signalled failure");
      }
      // One write: the route decision, the skips it implies, the phase
      // statuses, the failure class and any scheduled retry land together or
      // not at all.
      await saveInstance(instance);
      queueVerifications(instanceId, def, instance, verify);
      if (verifyCandidate) {
        const phase = instance.phases.find((p) => p.id === verifyCandidate.phaseId);
        if (phase) {
          queueCandidateVerification(
            instanceId,
            def,
            verifyCandidate.phaseId,
            phase.attempt,
            verifyCandidate.candidate,
          );
        }
      }
      if (outcome) await patchRun(signal.runId, { outcome });
      void journal(instance.id, {
        at: nowISO(),
        kind: "phase.signalled",
        phaseId: signal.phaseId,
        runId: signal.runId,
        detail:
          intake && !intake.ok
            ? `${signal.type} (${
                intake.failure === "knowledge-context-integrity"
                  ? "knowledge context integrity"
                  : "knowledge delta refused"
              })`
            : signal.type,
      });
      if (res.candidatesMoved) {
        // Everything after this — the phase's own conclusion, its journal
        // entries, the next phases — is the selection's business, not the
        // signalling candidate's.
        await settleCandidates(def, instance, res.candidatesMoved);
        deps.onChange?.();
        return { ok: true, code: 202 };
      }
      if (instance.status === "succeeded" || instance.status === "failed") {
        void journal(instance.id, {
          at: nowISO(),
          kind: "instance.ended",
          detail: instance.status,
        });
      }
      // Start the next phase detached: this handler runs on the child's signal
      // POST, and that child may still hold its concurrency slot until its
      // process exits after we respond. Awaiting startPhase here (which acquires
      // a slot) would deadlock when all slots are held by children waiting on
      // their own signal responses. The detached continuation RE-ACQUIRES the
      // instance lock and re-verifies liveness before launching, so an abort/
      // revise landing in the transition window can't be clobbered and won't be
      // raced into spawning orphan children (it queues behind, then kills them).
      queueReadyPhases(instanceId, def, instance, ready);
      if (instance.status === "failed") deps.onFailure?.(instance);
      deps.onChange?.();
      return { ok: true, code: 202 };
    });
  }

  async function approve(
    instanceId: string,
    answers?: unknown,
    options: GateTarget = {},
  ): Promise<ActionResult> {
    return locks.withLock(instanceId, async () => {
      const inst = await readInstance(instanceId);
      if (!inst) return { ok: false, code: 404, error: "instance not found" };
      const def = await defFor(inst);
      if (!def) return { ok: false, code: 404, error: "pipeline not found" };
      let res: TransitionResult;
      try {
        res = applyApprove(def, inst, answers, nowISO(), options.phaseId);
      } catch (e) {
        return { ok: false, code: 409, error: e instanceof Error ? e.message : String(e) };
      }
      // The gate is the acceptance condition: a staged delta commits here,
      // after the human's approval, never when the agent finished.
      res = await settleKnowledge(def, res);
      res = await settleRealizations(def, res);
      await saveInstance(res.instance);
      if (res.instance.status === "succeeded" || res.instance.status === "failed") {
        void journal(inst.id, {
          at: nowISO(),
          kind: "instance.ended",
          detail: res.instance.status,
        });
      }
      if (res.instance.status === "failed") deps.onFailure?.(res.instance);
      if (noteRouting(def, res.instance, res.routing)) await saveInstance(res.instance);
      await startPhases(def, res.instance, res.startPhases);
      deps.onChange?.();
      return { ok: true, code: 200 };
    });
  }

  async function revise(
    instanceId: string,
    note?: string,
    options: GateTarget = {},
  ): Promise<ActionResult> {
    return locks.withLock(instanceId, async () => {
      const inst = await readInstance(instanceId);
      if (!inst) return { ok: false, code: 404, error: "instance not found" };
      const def = await defFor(inst);
      if (!def) return { ok: false, code: 404, error: "pipeline not found" };
      // Validate the transition BEFORE any destructive side effect: killing the
      // phase's straggler runs must not happen if the instance can't be revised
      // (e.g. it isn't awaiting approval), or a rejected 409 would still have
      // torn down live work.
      // The paused phase's staged deltas are the attempt a human is about to
      // discard: superseded now, while the steps that reference them still
      // exist, so they can never be committed by the attempt that follows.
      const target = options.phaseId
        ? inst.phases.find((p) => p.id === options.phaseId)
        : (inst.phases.find((p) => p.status === "awaiting-approval") ??
          inst.phases.find((p) => p.status === "failed"));
      if (target && (target.status === "awaiting-approval" || target.status === "failed")) {
        await supersedeDeltas(inst, target, target.steps, `attempt ${target.attempt} revised`);
      }
      let res;
      try {
        res = applyRevise(inst, nowISO(), options.phaseId);
      } catch (e) {
        return { ok: false, code: 409, error: e instanceof Error ? e.message : String(e) };
      }
      // Only the revised phase: a sibling branch that is legitimately running
      // is not part of this decision, and killing it would be a silent abort.
      await killPhaseRuns(
        inst,
        res.startPhases.map((i) => res.instance.phases[i].id),
        "superseded by a revise",
      );
      await saveInstance(res.instance);
      const suffix = note ? `\n\nRevision note: ${note}` : "";
      await startPhases(def, res.instance, res.startPhases, suffix);
      deps.onChange?.();
      return { ok: true, code: 200 };
    });
  }

  async function abort(instanceId: string): Promise<ActionResult> {
    return locks.withLock(instanceId, async () => {
      const inst = await readInstance(instanceId);
      if (!inst) return { ok: false, code: 404, error: "instance not found" };
      let aborted: PipelineInstance;
      try {
        aborted = applyAbort(inst, nowISO());
      } catch (e) {
        return { ok: false, code: 409, error: e instanceof Error ? e.message : String(e) };
      }
      // Everything: an abort stops the whole instance, including branches the
      // applyAbort above has already marked terminal.
      await killPhaseRuns(
        inst,
        inst.phases.map((p) => p.id),
        "aborted",
      );
      // An abort ends every realization this instance was driving: a
      // completion question nothing will ever answer is not left `running`.
      const def = await defFor(aborted);
      const settled = def
        ? await settleRealizations(def, { instance: aborted, startPhases: [] })
        : { instance: aborted };
      await saveInstance(settled.instance);
      deps.onChange?.();
      return { ok: true, code: 200 };
    });
  }

  async function reconcile() {
    const defs = await readPipelines();
    const grace = graceMsFor(deps.tickMs ?? 30000);
    const now = deps.now();

    // 0. Finalize adopted (reattached) runs whose detached process has ended.
    //    The in-memory done-handler was lost with the previous server process,
    //    so status/result come from the log's JSON envelope instead. Instance
    //    advancement is not done here — the healing pass below (under the
    //    instance lock) handles steps whose runs ended without signalling.
    for (const runId of [...adopted.keys()]) {
      try {
        const got = await readRun(runId);
        if (!got || got.run.status !== "running") {
          adopted.delete(runId);
          sem.release();
          deps.tailer?.untrack(runId);
          continue;
        }
        if (isAlive(got.run.pid)) {
          // The deadline outlives the process that set the timer: an adopted
          // run past its deadline is ended here, and finalized next tick.
          if (
            got.run.deadlineAt &&
            !got.run.termination &&
            Date.parse(got.run.deadlineAt) <= now.getTime()
          ) {
            const reason = `timed out after ${Math.round(
              (Date.parse(got.run.deadlineAt) - Date.parse(got.run.startedAt ?? got.run.queuedAt)) /
                1000,
            )}s`;
            await patchRun(runId, { termination: "timed-out", error: reason });
            await stopRun(got.run.pid);
            if (got.run.instanceId && got.run.phaseId) {
              void journal(got.run.instanceId, {
                at: nowISO(),
                kind: "step.timed-out",
                phaseId: got.run.phaseId,
                runId,
                detail: reason,
              });
            }
          }
          continue;
        }
        const envelope = parseEnvelopeFor(got.run.runtime, got.log, { model: got.run.model });
        const parsed = envelope.isError !== null || envelope.result !== null ? envelope : null;
        const ended = deps.now();
        // patchRun (not a full writeRun spread): the signal path patches
        // `outcome` concurrently, and a stale full-object write would drop it.
        const endedByArgus =
          got.run.termination === "timed-out" ||
          got.run.termination === "stalled" ||
          got.run.termination === "killed";
        await patchRun(runId, {
          status: parsed && parsed.isError === false && !endedByArgus ? "succeeded" : "failed",
          endedAt: ended.toISOString(),
          durationMs: got.run.startedAt
            ? ended.getTime() - new Date(got.run.startedAt).getTime()
            : null,
          exitCode: null,
          sessionId: got.run.sessionId ?? parsed?.sessionId ?? null,
          resultSummary: parsed?.result ?? got.run.resultSummary,
          costUsd: parsed?.costUsd ?? got.run.costUsd,
          tokens: parsed?.tokens ?? got.run.tokens,
          error: endedByArgus
            ? got.run.error
            : !parsed
              ? "ended while detached; no parseable result"
              : parsed.isError === false
                ? null
                : (parsed.result ?? "run reported is_error"),
        });
        await accumulateRun(runId, deps.now);
        adopted.delete(runId);
        sem.release();
        deps.tailer?.untrack(runId);
        deps.onChange?.();
      } catch (e) {
        // Keep the run adopted; retried next tick.
        log.error("finalize of adopted run failed", { err: e });
      }
    }

    // 1. Start clock-due pipeline definitions.
    for (const def of defs) {
      if (!def.enabled || !def.trigger) continue;
      const anchor = new Date(def.lastStartedAt ?? def.createdAt);
      const prev = previousFireTime(def.trigger, anchor, now);
      if (!prev) continue;
      // Don't backfill a slot from before the pipeline was created (mirrors
      // shouldFire): avoids an immediate fire on creation within the window.
      if (prev.getTime() < new Date(def.createdAt).getTime()) continue;
      if (def.lastStartedAt && new Date(def.lastStartedAt).getTime() >= prev.getTime()) continue;
      if (now.getTime() - prev.getTime() > grace) continue;
      await start(def.id, "scheduled");
    }

    // 2. Start any retry whose backoff has elapsed. Before healing, so a phase
    //    that just became due is retried rather than re-examined as an orphan.
    await runDueRetries(now);

    // 2.5 Stall detection (§D): a running step whose transcript has gone
    //     quiet longer than its declared `stallSeconds`, even though the
    //     process is still alive, is killed like a timeout. Reuses this same
    //     reconcile tick rather than a second timer system, and covers both
    //     this process's own runs and adopted ones — the run tailer's
    //     `latest()` only knows about runs *this* process is tailing, so
    //     `Run.lastActivityAt` (refreshed here, persisted) is what a restart
    //     falls back to until the tailer catches up.
    for (const candidate of await readInstances()) {
      if (candidate.status !== "running") continue;
      const def = candidate.definition ?? defs.find((d) => d.id === candidate.pipelineId);
      if (!def) continue;
      for (const i of livePhases(candidate)) {
        const phase = candidate.phases[i];
        if (phase.status !== "running") continue;
        const phaseDef = def.phases.find((p) => p.id === phase.id);
        if (!phaseDef) continue;
        for (const step of phase.steps) {
          if (step.status !== "running" || !step.runId) continue;
          const stepDef = phaseDef.candidates
            ? phaseDef.steps[0]
            : phaseDef.steps.find((s) => s.name === step.name);
          const stallSeconds = resolveStallSeconds(phaseDef, stepDef ?? {});
          if (!stallSeconds) continue;
          const got = await readRun(step.runId);
          if (!got || got.run.status !== "running" || got.run.termination) continue;
          const observed = deps.tailer?.latest?.().get(step.runId)?.at ?? null;
          if (observed && observed !== got.run.lastActivityAt) {
            await patchRun(step.runId, { lastActivityAt: observed });
          }
          const lastActivityAt = observed ?? got.run.lastActivityAt ?? null;
          if (isStalled({ stallSeconds, lastActivityAt, startedAt: got.run.startedAt, now })) {
            await expireStalledStep(step.runId, candidate.id, phase.id, stallSeconds);
          }
        }
      }
    }

    // 3. Heal running instances whose live-phase runs ended without signalling.
    //    Each instance is healed under its lock, re-reading fresh state inside,
    //    so a genuine completion signal landing mid-pass is never clobbered by a
    //    stale "failed" write (the TOCTOU the lock closes).
    //    Over the instances, not the definitions: an instance heals against its
    //    own snapshot, so one whose definition was edited — or deleted — under
    //    it is healed like any other rather than left running forever.
    for (const candidate of await readInstances()) {
      if (candidate.status !== "running") continue;
      const def = candidate.definition ?? defs.find((d) => d.id === candidate.pipelineId);
      if (!def) continue;
      await locks.withLock(candidate.id, async () => {
        const inst = await readInstance(candidate.id);
        if (!inst || inst.status !== "running") return;
        let current = inst;
        // A phase whose knowledge commit was pending when Argus stopped is
        // committed again: the commit is idempotent on delta id, so a ledger
        // already carrying the deltas simply concludes the phase.
        for (const i of livePhases(current)) {
          const phase = current.phases[i];
          if (phase.status !== "running" || phase.knowledge?.status !== "pending") continue;
          const res = await settleRealizations(
            def,
            await settleKnowledge(def, {
              instance: current,
              startPhases: [],
              commitKnowledge: [phase.id],
            }),
          );
          noteRouting(def, res.instance, res.routing);
          await saveInstance(res.instance);
          if (res.instance.status === "succeeded" || res.instance.status === "failed") {
            void journal(current.id, {
              at: nowISO(),
              kind: "instance.ended",
              detail: res.instance.status,
            });
          }
          queueReadyPhases(current.id, def, res.instance, res.startPhases);
          if (res.instance.status === "failed") deps.onFailure?.(res.instance);
          deps.onChange?.();
          current = res.instance;
        }
        if (current.status !== "running") return;
        // A phase whose checks were running when Argus stopped is verified
        // again: the checks are Argus's own and deterministic, and the
        // attempt key makes a duplicate report a no-op.
        for (const i of livePhases(current)) {
          const phase = current.phases[i];
          if (phase.status !== "running") continue;
          if (
            phase.verification?.status === "running" &&
            !verifying.has(`${current.id}:${phase.id}:${phase.attempt}`)
          ) {
            queueVerification(current.id, def, phase.id, phase.attempt);
          }
          // The same for each candidate that was being verified when Argus
          // stopped. Keyed by candidate as well as attempt, so a duplicate
          // report is the same no-op it is for an ordinary phase.
          for (const step of phase.steps) {
            if (step.candidate === undefined) continue;
            if (step.verification?.status !== "running") continue;
            if (verifying.has(`${current.id}:${phase.id}:${phase.attempt}:c${step.candidate}`)) {
              continue;
            }
            queueCandidateVerification(current.id, def, phase.id, phase.attempt, step.candidate);
          }
        }
        // Every live phase: with a fan-out, a died-without-signalling run can
        // be in any of them, and healing only one would leave the others
        // showing a working tile forever.
        const orphans = livePhases(current).flatMap((i) =>
          current.phases[i].steps.map((s) => ({ phaseId: current.phases[i].id, step: s })),
        );
        for (const { phaseId, step: s } of orphans) {
          if (s.status !== "running" || !s.runId) continue;
          let got = await readRun(s.runId);
          // A step recorded as running with no process behind it — no run
          // record at all, or one that never got a pid — and not being
          // launched by this process: Argus stopped between recording the
          // step and starting it. Nothing will ever signal for it, so it is
          // failed here as a spawn failure (retryable by default).
          if (
            !live.has(s.runId) &&
            (!got || (got.run.status === "running" && got.run.pid == null))
          ) {
            const stepDef = def.phases.find((p) => p.id === phaseId);
            const reason = "Argus stopped before the step's process was started";
            const stub: Run = got?.run ?? {
              id: s.runId,
              scheduleId: `pipeline:${current.pipelineId}`,
              scheduleName: `${current.pipelineName} · ${stepDef?.name ?? phaseId}`,
              prompt: "",
              cwd: stepDef?.cwd ?? "",
              status: "running",
              trigger: "scheduled",
              queuedAt: nowISO(),
              startedAt: null,
              endedAt: null,
              durationMs: null,
              pid: null,
              exitCode: null,
              sessionId: null,
              project: stepDef ? encodeProject(stepDef.cwd) : null,
              resultSummary: null,
              error: null,
              instanceId: current.id,
              phaseId,
            };
            await writeRun({
              ...stub,
              status: "failed",
              termination: "spawn-failed",
              error: reason,
              endedAt: nowISO(),
            });
            got = await readRun(s.runId);
          }
          // Reconcile only from a completed run record. A dead pid whose
          // record is still `running` can be racing the normal close handler;
          // guessing in that window would discard the agent's final message,
          // which is what distinguishes success, failure, and ambiguity.
          const ended =
            got &&
            (got.run.status === "failed" ||
              got.run.status === "succeeded" ||
              got.run.status === "interrupted" ||
              got.run.status === "cancelled");
          if (!ended) continue;
          const restarted = got?.run.status === "interrupted";
          const recovered =
            !restarted && got && runtimeFor(got.run.runtime).outcomeFromRecord
              ? recoverRunOutcome(got.run)
              : null;
          let signalType = recovered?.signalType ?? "failed";
          // A recovered *completion* may carry a declared result. Read it the
          // same way the stop hook would; this is the whole completion
          // protocol for a runtime with no hook to install.
          const recoveredResult = signalType === "completed" ? await readRunResult(s.runId) : {};
          // And it goes through the same acceptance the signal path applies:
          // the supplied context is re-verified and any KnowledgeDelta staged
          // — or refused, which turns the recovered completion into a
          // `knowledge-delta` or `knowledge-context-integrity` failure.
          const intake =
            signalType === "completed"
              ? await acceptCompletion(def, current, phaseId, s.runId)
              : null;
          const knowledgeRefused = intake && !intake.ok ? intake.reason : null;
          if (knowledgeRefused) signalType = "failed";
          const payload = knowledgeRefused
            ? { reason: knowledgeRefused }
            : recovered
              ? recovered.payload
              : restarted
                ? { reason: "Argus restarted mid-run — revise to retry", kind: "restarted" }
                : {
                    reason: got?.run.error ?? "run ended without emitting a completion signal",
                  };
          const recordClass: RetryableClass =
            intake && !intake.ok
              ? intake.failure
              : (recovered?.failureClass ?? (got ? failureClassOfRecord(got.run) : "spawn"));
          let res = advance(
            def,
            current,
            {
              instanceId: current.id,
              phaseId,
              runId: s.runId,
              type: signalType,
              token: current.signalToken,
              payload,
              ...(knowledgeRefused ? {} : recoveredResult),
            },
            nowISO(),
            signalType === "failed" ? recordClass : undefined,
          );
          if (recovered) {
            await patchRun(s.runId, { outcome: knowledgeRefused ? "failed" : recovered.outcome });
          }
          if (signalType === "failed" && !res.candidatesMoved) {
            // Class the failure from what the run record shows, so retry
            // policies keep distinguishing infrastructure from an agent's
            // considered failed/blocked conclusion.
            const reason =
              knowledgeRefused ??
              recovered?.failureReason ??
              (payload as { reason?: string }).reason ??
              "run ended without emitting a completion signal";
            noteFailure(def, res.instance, phaseId, recordClass, reason);
          }
          res = await settleKnowledge(def, res);
          res = await settleRealizations(def, res);
          const {
            instance,
            startPhases: ready,
            routing,
            verify,
            verifyCandidate,
            candidatesMoved,
          } = res;
          noteRouting(def, instance, routing);
          await saveInstance(instance);
          queueVerifications(instance.id, def, instance, verify);
          if (verifyCandidate) {
            const healed = instance.phases.find((p) => p.id === verifyCandidate.phaseId);
            if (healed) {
              queueCandidateVerification(
                instance.id,
                def,
                verifyCandidate.phaseId,
                healed.attempt,
                verifyCandidate.candidate,
              );
            }
          }
          void journal(instance.id, {
            at: nowISO(),
            kind: "phase.signalled",
            phaseId,
            runId: s.runId,
            detail: knowledgeRefused
              ? `harness: ${intake && !intake.ok ? intake.failure : "knowledge-delta"}`
              : recovered
                ? `run-record fallback: ${recovered.outcome}`
                : "reconcile: failed",
          });
          deps.tailer?.untrack(s.runId);
          if (candidatesMoved) await settleCandidates(def, instance, candidatesMoved);
          else queueReadyPhases(instance.id, def, instance, ready);
          if (instance.status === "failed") deps.onFailure?.(instance);
          deps.onChange?.();
          current = instance;
          if (current.status !== "running" && current.status !== "awaiting-approval") break;
        }
        // A restart can land between a candidate's last report and the
        // selection that report implied. The decision is a pure function of
        // what is on disk, so it is simply asked again — and answers `pending`,
        // harmlessly, for every phase still genuinely waiting.
        if (current.status === "running") {
          for (const i of livePhases(current)) {
            const phase = current.phases[i];
            if (phase.status !== "running") continue;
            if (!def.phases.find((p) => p.id === phase.id)?.candidates) continue;
            await settleCandidates(def, current, phase.id);
          }
        }
      });
    }
  }

  return { start, onSignal, approve, revise, abort, reconcile, adopt, drain };
}
