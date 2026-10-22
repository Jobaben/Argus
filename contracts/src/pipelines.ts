/** Pipeline definitions, running instances, and the board overview. */
import type {
  AbortCause,
  GateDecisionKind,
  GateDecisionMechanism,
  PendingGateOperation,
} from "./gates.js";

import type { AgentRuntimeId, ReasoningEffort } from "./runtimes.js";
import type { Run, RunOutcome, RunStatus, Trigger } from "./schedules.js";
import type { InstanceTransitionLogState } from "./transitions.js";
import type { AutoApprove, Rubric, TrajectorySignalKind } from "./verdict.js";
import type {
  AcceptanceVerificationPolicy,
  AcceptanceVerificationPreview,
  AcceptanceVerificationSummary,
  ChangeContextSpec,
  ChangeIntentPolicy,
  ChangeIntentSummary,
  ChangeProposalPreview,
  ChangeProposalStatus,
  DiscoveryPolicy,
  DiscoverySummary,
  ImplementationPolicy,
  InvocationKnowledgeContext,
  KnowledgeContextSpec,
  KnowledgeScope,
  KnowledgeDeltaPreview,
  KnowledgeDeltaStatus,
  RuleVerificationPolicy,
  RuleVerificationPreview,
  RuleVerificationStatus,
  RepositoryStateRef,
  RuleVerificationSummary,
  StepAcceptanceVerification,
} from "./knowledge.js";

export interface PhaseStep {
  name: string;
  prompt: string;
  model?: string;
  /** Codex-only override; absent inherits the pipeline/CLI setting. */
  reasoningEffort?: ReasoningEffort;
  /** Overrides the phase's (and pipeline's) runtime for this one step. */
  runtime?: AgentRuntimeId;
  /** Wall-clock limit for this step's process; overrides the phase's. */
  timeoutSeconds?: number;
  /** Kill this step if its transcript goes this many seconds without new
   *  activity, even though the process is still alive. Overrides the phase's.
   *  Absent = off. Minimum 30. */
  stallSeconds?: number;
  /** Narrows or replaces the phase's capability profile for this one step. */
  capabilities?: CapabilityProfile;
  /**
   * The canonical knowledge this step's run receives as a read-only
   * KnowledgeContext (`ARGUS_KNOWLEDGE_CONTEXT_FILE`). Replaces the phase's
   * `knowledgeContext` for this one step. Absent on both = no semantic
   * context: no file, no channel, exactly as before Phase 4.
   */
  knowledgeContext?: KnowledgeContextSpec;
}

/**
 * Which observable failures are worth another attempt.
 *
 * Deliberately not "any": an agent that *signalled* failure has considered the
 * work and reported on it, and running the same prompt again is unlikely to
 * change its mind — while a process that never started, or died on a non-zero
 * exit, plausibly hit something transient.
 */
export type RetryableClass =
  | "spawn"
  | "exit-code"
  | "signal"
  | "timeout"
  | "verification"
  /**
   * The run emitted a KnowledgeDelta Argus refused: malformed, an unresolved
   * or inexact reference, a stale revision precondition, a cycle, or a
   * conflict with a sibling step's delta at the phase commit. Not retried by
   * default — the agent considered its proposal — but retryable on opt-in,
   * because the retry note carries the exact refusal (e.g. the revision that
   * moved) and a second attempt can propose from the current ledger.
   */
  | "knowledge-delta"
  /**
   * The KnowledgeContext Argus materialized for the run no longer hashes to
   * what it recorded at launch — the file was modified, or removed, while the
   * agent ran (Phase 4.1). The completion is refused and nothing the run
   * proposed becomes canonical: an input Argus cannot vouch for cannot back a
   * consumption edge. Not retried by default — a tampered context is a
   * harness or sandbox problem, not a transient one — but retryable on
   * opt-in, since a fresh attempt materializes a fresh file.
   */
  | "knowledge-context-integrity"
  /**
   * The run emitted a rule-verification proposal Argus refused: malformed, a
   * rule it was not supplied, a supplied rule left without an outcome, an
   * outcome with no evidence, or a check reference naming no check of this
   * phase (Phase 6). Not retried by default — the agent reported what it
   * concluded — but retryable on opt-in, since the refusal names exactly
   * what was missing.
   */
  | "rule-verification"
  /**
   * The run emitted a ChangeProposal Argus refused: malformed, a rule it was
   * supplied left unclassified, a claim both preserved and revised, an
   * acceptance criterion naming a local id the semantic delta does not
   * declare, or a business-rule change with no acceptance criteria under a
   * `required` policy (Phase 7). Not retried by default — the agent reported
   * its reasoning — but retryable on opt-in, since the refusal names exactly
   * what was missing.
   */
  | "change-proposal"
  /**
   * An Argus-owned read-only input the run was given — its ChangeContext, its
   * ImplementationScope, its RemediationContext (Phase 8), its children
   * manifest (DL-A2b) — no longer hashes to what Argus recorded at launch.
   * The exact counterpart of `knowledge-context-integrity`, and it asks the
   * same question: *did the bytes supplied to this invocation change?*, never
   * *is this still the newest proposal?* Accepted intent is immutable, so a
   * newer proposal is never tampering. The completion is refused and nothing
   * the run proposed becomes durable. Not retried by default.
   */
  | "change-context-integrity"
  /**
   * The run emitted an acceptance-verification proposal Argus refused:
   * malformed, a criterion the accepted proposal does not declare, a required
   * criterion left without an outcome, an outcome with no evidence, a check
   * reference naming no check of this phase, or a report written against a
   * different accepted change (Phase 8). Not retried by default.
   */
  | "acceptance-verification"
  /**
   * A completion Argus could not accept on the agent's own word: the run's
   * final message carried no `ARGUS_OUTCOME` marker under a `required`
   * completion policy, carried conflicting markers, or the stop hook's own
   * reading of the marker disagreed with the message it delivered. Nothing
   * the run proposed is staged. Retried by default, like `exit-code`: an
   * absent or ambiguous report is a protocol failure, not a considered
   * verdict, and the retry note says exactly which marker was expected. A
   * marker that says `failed`/`blocked` is the agent's verdict and is classed
   * `signal`, wherever it is read.
   */
  | "unverified";

/**
 * Every way a phase can fail. The retryable classes are the subset an author
 * may name in `retry.retryOn`; `configuration` (an invocation Argus could not
 * construct as declared — e.g. a capability the runtime cannot enforce under
 * strict enforcement) is never retried, because running it again cannot help.
 * Neither is `approval-condition`: the gate's `approveWhen` command exited
 * with its `failOnExit` code (DL-A3). It said this work cannot pass the gate,
 * and running the agent again cannot change that; a person revises or aborts.
 */
export type PhaseFailureClass = RetryableClass | "configuration" | "approval-condition";

export interface RetryPolicy {
  /** Total attempts including the first. 1 means no retry. */
  attempts: number;
  /** Delay before the first retry. Doubles each subsequent attempt. */
  backoffSeconds: number;
  /** Defaults to `["spawn", "exit-code", "unverified"]` — the transient-looking
   *  ones, and a completion that reported nothing Argus could accept. */
  retryOn?: RetryableClass[];
}

// ── Signal authentication ────────────────────────────────────────────────────

/**
 * How one run's signals are authenticated.
 *
 * `run-token-v1`: the run was handed its own random token (in its
 * environment), and Argus keeps only a SHA-256 digest of it bound to this
 * instance, phase, attempt and run. A signal is accepted only for exactly that
 * run, so one run's token cannot complete, fail or pause a sibling, another
 * attempt or another instance. The digest is not a secret; the token never
 * reaches a persisted record.
 *
 * `none`: the run's runtime has no signal hook, so it was given no credential
 * at all, and no signal for it is ever accepted — it completes from its run
 * record instead.
 *
 * Absent on a step or run recorded before per-run tokens existed: its signals
 * are authenticated by the instance's legacy `signalToken`, exactly as before.
 *
 * This limits what a leaked token can do; it is not a boundary between an
 * agent and its own hook, which share an OS user and an environment.
 */
export type SignalAuthRecord =
  { scheme: "run-token-v1"; sha256: string; phaseId: string; attempt: number } | { scheme: "none" };

// ── Completion: the agent's own outcome marker ───────────────────────────────

/**
 * Whether a step's `completed` signal must carry an unambiguous
 * `ARGUS_OUTCOME: succeeded` marker in the run's final message.
 *
 * - `required` (the effective default when nothing is declared): a completion
 *   whose final message has no marker, conflicting markers, or a
 *   `failed`/`blocked` marker is refused before anything the run proposed is
 *   staged.
 * - `lenient`: an explicit opt-out restoring the pre-policy behaviour for a
 *   *missing* marker only — the completion is accepted and its provenance
 *   says no marker was seen. Conflicting or `failed`/`blocked` markers are
 *   refused under either policy: lenient never means "ignore what the agent
 *   wrote".
 *
 * A marker is the agent's own report. It is never independent verification:
 * checks, the result schema, the gate and the knowledge commit remain separate
 * authorities, and a `succeeded` marker satisfies none of them.
 */
export type CompletionMarkerPolicy = "required" | "lenient";

export interface CompletionPolicy {
  marker: CompletionMarkerPolicy;
}

/**
 * What Argus's own classifier read in a run's final message. `missing` = no
 * marker line at all; `conflicting` = more than one distinct outcome.
 */
export type OutcomeMarkerKind = "succeeded" | "failed" | "blocked" | "missing" | "conflicting";

/**
 * Additive metadata a stop hook (version 2 and later) sends beside a signal:
 * its own version and its own reading of the marker. Untrusted — Argus
 * re-classifies the message itself and only compares. Older servers ignore it;
 * older hooks do not send it.
 */
export interface SignalCompletionMeta {
  hookVersion: number;
  marker: OutcomeMarkerKind;
}

/**
 * How one run's completion reached Argus and what Argus decided about it.
 * Recorded per step, so a multi-step or candidates phase keeps every run's
 * own account rather than one stamped from whichever signal arrived last.
 */
export interface StepCompletion {
  /** What was reported: a completion, or the agent's own failure. */
  signal: "completed" | "failed";
  /** `signal` — a stop hook (or another caller) posted it; `run-record` —
   *  Argus read the outcome off the finished run record (runtimes without a
   *  reliable hook). */
  source: "signal" | "run-record";
  /** The policy in force for this phase when the completion arrived. */
  policy: CompletionMarkerPolicy;
  /** Argus's classification of the final message it actually received. */
  marker: OutcomeMarkerKind;
  /**
   * The hook's own account, when it sent one. Absent = no metadata (a hook
   * older than version 2, or the run-record path). `agrees` compares the
   * hook's marker to Argus's; malformed metadata is recorded as
   * `{ version: null, marker: null, agrees: false }`.
   */
  hook?: { version: number | null; marker: OutcomeMarkerKind | null; agrees: boolean };
  /** `accepted` — the step completes on this report; `refused` — the
   *  completion was turned into a failure; `reported-failure` — the agent
   *  itself reported failure. */
  verdict: "accepted" | "refused" | "reported-failure";
  /** Why it was refused, when it was. */
  reason?: string;
  at: string;
}

// ── Harness: capabilities, verification ──────────────────────────────────────

/** One MCP server an invocation may talk to. Mirrors the CLIs' own config shape. */
export interface McpServerSpec {
  type?: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/**
 * Which of Argus's own environment reaches the agent process.
 *
 * `inherit: "all"` (the default, and the pre-harness behaviour) passes the
 * server's environment through; `"minimal"` passes only a safe baseline (PATH,
 * HOME, locale, temp dirs, the agent CLIs' own variables) plus `allow`. Argus's
 * own secrets — its admin bearer token and webhook URL — are removed under
 * either policy: an agent must never be able to administer the harness that
 * runs it. Values are never recorded; the invocation record lists names only.
 */
export interface EnvPolicy {
  inherit?: "all" | "minimal";
  /** Variable names or `PREFIX_*` patterns to pass through (or to keep despite `deny`). */
  allow?: string[];
  /** Variable names or `PREFIX_*` patterns removed from the child environment. */
  deny?: string[];
  /** Values set for this invocation only. */
  set?: Record<string, string>;
}

/**
 * What an agent invocation may do. Runtime-neutral: each runtime maps it onto
 * its own flags and config files, and reports anything it cannot enforce as a
 * limitation. Under `enforcement: "strict"` (the default) a limitation is a
 * configuration failure — the step does not launch with more capability than
 * the author declared. `"best-effort"` records the limitation and launches.
 */
export interface CapabilityProfile {
  /**
   * `read-only` — no file edits (Codex: OS sandbox; Claude Code: Edit/Write
   * tools denied, and Bash denied unless `tools.allow` names specific commands).
   * `workspace-write` — edits inside the working directory and
   * `additionalDirectories`. `unrestricted` — the CLI's own default.
   */
  filesystem?: "read-only" | "workspace-write" | "unrestricted";
  /** Tool permission rules in the runtime's own grammar (Claude Code: `Bash(npm test:*)`, `Edit`, `mcp__docs__search`, `Skill(name)`). */
  tools?: { allow?: string[]; deny?: string[] };
  /**
   * The MCP servers this invocation may use. Absent = whatever the CLI is
   * configured with (legacy). Present — even empty — means exactly these and no
   * others, where the runtime can enforce it.
   */
  mcpServers?: Record<string, McpServerSpec>;
  /** Directories beyond the working directory the agent may access. */
  additionalDirectories?: string[];
  /**
   * Which settings files the CLI loads (Claude Code). Absent = the CLI's
   * default (user, project and local). Naming only `project` and `local` cuts
   * the operator's global settings — and their MCP servers, hooks and
   * permission grants — out of the invocation.
   */
  settingSources?: ("user" | "project" | "local")[];
  /** Claude Code permission mode for the run. */
  permissionMode?: "default" | "acceptEdits" | "plan" | "bypassPermissions" | "dontAsk";
  /** Cap on agentic turns, where the runtime supports one. */
  maxTurns?: number;
  env?: EnvPolicy;
  enforcement?: "strict" | "best-effort";
}

/**
 * One isolated working tree a phase's steps run in, instead of the phase's own
 * `cwd`.
 *
 * A pipeline that edits a repository has every phase editing the *same* checkout:
 * two branches of a fan-out overwrite each other, and a failed attempt leaves its
 * half-done edits behind for the next one. Declaring a workspace gives the work a
 * git worktree of its own — a real directory on a branch of the repository at
 * `cwd`, created before the phase's first step launches and removed when the
 * instance ends. The deliverable is the branch: the directory is disposable.
 */
export interface WorkspacePolicy {
  /** "instance": one worktree per pipeline instance, shared by every phase that
   *  opts in. "attempt": a fresh worktree per phase attempt. "none": this phase
   *  opts out of a pipeline-wide policy and runs in its own `cwd` — the only
   *  reason `scope` is ever read on a phase that inherited a policy it does not
   *  want. */
  scope: "instance" | "attempt" | "none";
  /** Ref the worktree is created from. Default: HEAD of the repository at `cwd`. */
  base?: string;
  /** Keep the worktree directory after the instance ends. Default false: the
   *  directory is removed, the branch is kept. */
  keep?: boolean;
}

/** The worktree a phase attempt actually got, written down as evidence: where
 *  it is, the branch its work lands on, and the ref (and the commit that ref
 *  named) it was cut from. */
export interface WorkspaceRecord {
  path: string;
  branch: string;
  base: string;
  /** resolved base commit */
  baseHead: string;
}

/**
 * One candidate's deviation from the step it is a copy of.
 *
 * Absent fields inherit exactly what the step would have used, so a policy
 * with no `variants` runs `count` identical attempts and differs only in the
 * sampling. A variant that names a `runtime` is the interesting case: the same
 * step drafted on Claude Code and on Codex, with the phase's own checks
 * deciding which draft the pipeline keeps.
 */
export interface CandidateVariant {
  runtime?: AgentRuntimeId;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}

/**
 * Best-of-N for one phase: run the step several times at once and let the
 * phase's own `checks` pick the winner.
 *
 * The evidence for this is the strongest single lever in the harness
 * literature — repeated sampling raises coverage, but only a real verifier
 * turns coverage into a result, and selection without one plateaus. Argus
 * already has both halves: deterministic `checks`, and a fresh git worktree
 * per attempt. A candidate is one attempt-scoped worktree per draft, verified
 * on its own, and the losers are thrown away.
 *
 * Requires a phase with exactly one step and an effective
 * `workspace.scope: "attempt"` (declared on the phase or inherited from the
 * pipeline); without isolation the candidates would be editing each other's
 * files, which is not sampling but corruption.
 */
export interface CandidatePolicy {
  /** How many independent attempts of the step run at once. 2..8. */
  count: number;
  /**
   * `first-verified` — the first candidate whose checks pass wins and the rest
   * are killed. `cheapest-verified` — every candidate runs to its checks; among
   * the verified, the lowest cost (then the shortest duration) wins.
   */
  select: "first-verified" | "cheapest-verified";
  /** Per-candidate overrides, cycled when shorter than `count`. Absent = identical candidates. */
  variants?: CandidateVariant[];
}

/** How one candidate of a phase ended, kept on the phase once it settles so
 *  the board can explain a selection after the losers' runs are gone. */
export interface CandidateOutcome {
  candidate: number;
  status: StepStatus;
  /** Whether this candidate's checks passed. Null = it never reached them. */
  verified: boolean | null;
  costUsd: number | null;
  durationMs: number | null;
  runtime: AgentRuntimeId | null;
  model: string | null;
  /** One line: why it lost, when it did. */
  reason?: string;
}

/** Why one candidate step ended the way it did — per candidate, because a
 *  phase's own payload can only carry one story and a candidate phase has
 *  `count` of them. */
export interface StepFailure {
  class: PhaseFailureClass;
  reason: string;
}

// ── Spawn phases (one child instance per task) ───────────────────────────────

/**
 * Where a spawn phase reads a value from: the validated `result` of an earlier
 * phase of the same instance, and a path of property names into it (`[]` =
 * the whole result). The phase must be a transitive `needs` dependency of the
 * spawn phase and declare a `result` whose schema declares the path, all
 * checked when the pipeline is saved.
 */
export interface SpawnSource {
  phase: string;
  path: string[];
}

/**
 * Turns a phase into a **spawn phase**: instead of running steps, it starts one
 * instance of another pipeline (a *child*) per element of a task list an
 * earlier phase produced, in dependency order, and succeeds once every child
 * has succeeded. A child that fails or is aborted stops new spawns and, once
 * the running children have finished, pauses the phase for a person
 * (`pause: "children"`).
 *
 * Exactly one child per task: each child's instance id is minted and saved on
 * the parent before the child is started, and starting it again with that id
 * returns the existing instance.
 */
export interface SpawnPolicy {
  /** The pipeline every child runs. It must exist, be another pipeline, have
   *  no trigger or a webhook trigger, and have no spawn phase of its own (one
   *  level deep). Checked when either pipeline is saved. */
  pipelineId: string;
  /** The task list: an array of objects at `items.path` in `items.phase`'s
   *  result. The result schema must declare it as one. */
  items: SpawnSource;
  /** The task property that names each task: a required string in the item
   *  schema. Each value must be unique and 1-64 letters, digits, ".", "-" or
   *  "_", starting with a letter or digit. */
  key: string;
  /** The task property listing the keys of the tasks it waits for: an array of
   *  strings in the item schema. A task starts only when every task it names
   *  has succeeded. Absent = no ordering beyond `maxParallel`. */
  dependsOn?: string;
  /** The task property shown as its title: a string in the item schema,
   *  clipped to 60 characters on the parent (the child gets it whole). Absent =
   *  the key is the title. */
  title?: string;
  /** How many children may be live at once. Default 1. Above 1 is refused
   *  until parallel Claude sessions are safe (reliability WS13). */
  maxParallel?: number;
  /** The most tasks the list may hold. Default 20, at most 50. A longer list
   *  fails the phase that produced it. */
  maxItems?: number;
  /** The git ref every child's worktrees are cut from, instead of the child
   *  definition's `workspace.base` (`PipelineInstance.workspaceBase`). Also in
   *  the child's payload. Argus does not fetch it. */
  base?: string;
  /** Values from earlier phases' results copied into every child's payload
   *  under `include.<name>`: the approved spec's path and commit, say. Up to
   *  16 names of 1-40 letters, digits, "-" or "_". A path the result does not
   *  hold is copied as null. */
  include?: Record<string, SpawnSource>;
}

/**
 * Where one task stands, as its spawn phase last saw it:
 * - `pending`: not started; waiting for its dependencies or a free slot;
 * - `planned`: its child's instance id is minted and saved; the start is owed;
 * - `reviving`: its failed child is being revised in place (a revise of the
 *   spawn phase); the revise is owed;
 * - `running`, `awaiting-approval`: the child's own status;
 * - `succeeded`, `failed`, `aborted`: the child ended so (`failed` also for a
 *   start Argus refused for good, see `reason`);
 * - `blocked`: a task it depends on, directly or through others, failed or
 *   was aborted, so it will not start unless that task is re-run.
 */
export type SpawnTaskState =
  | "pending"
  | "planned"
  | "reviving"
  | "running"
  | "awaiting-approval"
  | "succeeded"
  | "failed"
  | "aborted"
  | "blocked";

/**
 * One task of a spawn phase, and the child that runs it. Kept small on
 * purpose: the parent's transition log records it, one line at most 16 KiB.
 * Its position in `PhaseChildren.tasks` is its index everywhere
 * (`InstanceParentRef.index`, the `child:<phaseId>#<i>` status key).
 */
export interface SpawnTask {
  /** The task's `spawn.key` value. */
  key: string;
  /** The task's `spawn.title` value, clipped to 60 characters. */
  title?: string;
  /** Positions in `PhaseChildren.tasks` of the tasks this one waits for.
   *  Absent = none. */
  dependsOn?: number[];
  state: SpawnTaskState;
  /** The current child's instance id: minted when the task is planned, kept
   *  through a revive. Absent while the task has no child. */
  instanceId?: string;
  /** Earlier children of this task that a fresh child replaced (an aborted
   *  child, a refused start), oldest first. */
  previousInstanceIds?: string[];
  /** While `awaiting-approval`: the child's phase that waits at a gate. */
  waitingPhaseId?: string;
  /** While `failed` or `aborted`: one line (at most 200 characters) saying why. */
  reason?: string;
  /** The latest start or revive of a `planned` or `reviving` task that was
   *  put off (a read error, the spend budget, a busy target pipeline).
   *  Cleared once the child is seen to move. */
  deferred?: { reason: string; at: string };
  /** While `reviving`: the parent's revise decision (`GD-…`) the revive
   *  carries out. The child's own decision record names it as
   *  `parentDecisionId`. */
  reviveDecisionId?: string;
}

/**
 * A spawn phase's task list and the state of each task's child. Built once,
 * when the phase first starts, and kept across a revise of the spawn phase:
 * tasks that succeeded are not re-run.
 */
export interface PhaseChildren {
  /** The pipeline every child runs (`spawn.pipelineId`), frozen when the list
   *  was built. */
  pipelineId: string;
  /** The phase attempt whose result the tasks were read from. */
  source: { phaseId: string; attempt: number };
  /** `spawn.maxParallel` in force, frozen with the list. */
  maxParallel: number;
  tasks: SpawnTask[];
}

/** A spawned child's link to the parent task it runs. */
export interface InstanceParentRef {
  instanceId: string;
  pipelineId: string;
  /** The parent's spawn phase. */
  phaseId: string;
  /** The task's position in that phase's `PhaseChildren.tasks`. */
  index: number;
  key: string;
}

/**
 * A spawned child's `triggerPayload`, which its prompts read as
 * `{{trigger.payload}}` (capped like any placeholder, 16 KiB by default; the
 * whole payload is at most 64 KiB).
 */
export interface SpawnTriggerPayload {
  /** The task, exactly as the parent's validated result held it. */
  task: Record<string, unknown>;
  /** The task's key. */
  key: string;
  /** `spawn.base`, when the spawn phase names one. */
  base?: string;
  /** `spawn.include`, resolved: each name's value from the parent's results. */
  include?: Record<string, unknown>;
  parent: InstanceParentRef;
}

/** What a spawn phase publishes as its payload (and under its `produces`
 *  name) when it succeeds, and holds as its payload while paused at
 *  `children`. */
export interface SpawnChildrenSummary {
  pipelineId: string;
  /** Every task, in list order. */
  tasks: Array<{ key: string; title?: string; state: SpawnTaskState; instanceId?: string }>;
  /** Task counts by state; a state with no task is absent. */
  counts: Partial<Record<SpawnTaskState, number>>;
  /** Keys of the tasks that did not succeed, in list order: what approving the
   *  phase at its `children` pause drops. Empty on a join. */
  notSucceeded: string[];
}

/** A spawned child as a parent's gate review shows it, read per request. */
export interface SpawnChildView {
  status: InstanceStatus;
  /**
   * The child phase that waits on a person, or else its failed phase: where
   * the drawer links, and the `{ phaseId, attempt }` a revise of that child
   * names. Absent when no phase of the child waits or failed.
   */
  decisionPhase?: {
    phaseId: string;
    phaseName: string;
    attempt: number;
    status: "awaiting-approval" | "failed";
  };
}

/** One task of a spawn phase, with its child as read for a review. */
export interface SpawnTaskReview extends SpawnTask {
  /** Absent while the task has no child, or when its record is gone. */
  child?: SpawnChildView;
}

/**
 * A spawn phase's children as a person deciding on it sees them: the phase's
 * own record of each task, plus each child as it is now. Derived per read;
 * nothing here is stored.
 */
export interface PhaseChildrenReview extends PhaseChildren {
  tasks: SpawnTaskReview[];
  /** Keys of the tasks that did not succeed, in task order: what approving at a
   *  `children` pause drops, and what revising the spawn phase re-runs. */
  notSucceeded: string[];
}

// ── Children context (the parent's view of its children) ─────────────────────

/**
 * `PhaseDef.childrenContext`: give every step of this phase a read-only
 * {@link ChildrenManifest} of the children an earlier spawn phase started
 * (`ARGUS_CHILDREN_FILE`), and each child's artifact folder as a read channel.
 */
export interface ChildrenContextSpec {
  /** A spawn phase of the same pipeline that this phase depends on, directly
   *  or through other phases, so its children have settled before this phase
   *  starts. Checked when the pipeline is saved. */
  fromPhase: string;
}

/**
 * The cost of a set of runs: each run record's `costUsd` and `tokens` as
 * recorded, summed. The manifest adds no estimate of its own, but for a
 * supported Codex model `Run.costUsd` is itself Argus's public token-price
 * estimate, and it is summed like any other.
 * Superseded attempts count: a phase retried twice cost all three runs.
 */
export interface ChildrenManifestCost {
  runs: number;
  /** `Run.costUsd` summed, rounded to 4 decimals. Null when no run recorded a cost. */
  costUsd: number | null;
  /** `Run.tokens` (input + output) summed. Null when no run recorded any. */
  tokens: number | null;
  /** Runs with no recorded cost, and so not in `costUsd`. */
  unpricedRuns: number;
  /** Recorded run durations, summed, in milliseconds. */
  durationMs: number;
}

/** One run of a phase, as its record says. Superseded attempts included. */
export interface ChildrenManifestRun {
  runId: string;
  status: RunStatus;
  queuedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  costUsd: number | null;
  tokens: number | null;
  model: string | null;
  runtime: AgentRuntimeId;
  /** The agent's own report (`ARGUS_OUTCOME`), when it gave one. */
  outcome?: RunOutcome;
  /** How the process ended, when Argus knows more than the exit code. */
  termination?: NonNullable<Run["termination"]>;
  /** The run's recorded error, clipped to 500 characters. */
  error?: string;
}

/** One gate decision that took effect on an instance. Who made it is not
 *  included: the decision record keeps that, and a step has no use for it. */
export interface ChildrenManifestDecision {
  /** `GD-…`, the id `GET /api/instances/:id/gate-decisions` shows. */
  id: string;
  decision: GateDecisionKind;
  /** A person (`operator`), an automated rule (`verdict-auto-approve`,
   *  `approval-condition`), the parent's own decision carried out on a child
   *  (`parent-decision`), or `unspecified`. */
  mechanism: GateDecisionMechanism;
  /** The phase attempt(s) it acted on: one for approve and revise, every
   *  phase still going for abort. */
  phases: Array<{ phaseId: string; attempt: number }>;
  /** A revise note, as recorded (clipped to 2,000 characters). */
  note?: string;
  recordedAt: string;
  /** `incomplete` while its effects are still being applied. */
  effect: "applied" | "incomplete";
  /** Mechanism `parent-decision`: the parent's decision this one carried out. */
  parentDecisionId?: string;
}

/** One phase of an instance in the manifest. */
export interface ChildrenManifestPhase {
  id: string;
  name: string;
  status: PhaseStatus;
  /** The current attempt, 0-based. */
  attempt: number;
  gated: boolean;
  pause?: PhaseProgress["pause"];
  /** Automatic retries the current attempt chain used. */
  retries?: number;
  /** The validated structured result. */
  result?: unknown;
  /** Why the phase failed, on a failed phase. `reason` clipped to 2,000 characters. */
  failure?: { failureClass?: PhaseFailureClass; reason?: string };
  /** Argus's checks over the latest attempt. */
  verification?: VerificationReport;
  /** The latest attempt's artifact folder — emptied at every attempt, so it
   *  holds that attempt's files only. On a child whose folder is offered
   *  (`artifactsDir`) only. */
  artifactDir?: string;
  /** The worktree's branch and the commit it was cut from. */
  workspace?: { branch: string; base: string; baseHead: string };
  /** Every run of the phase, oldest first, superseded attempts included. */
  runs: ChildrenManifestRun[];
  cost: ChildrenManifestCost;
}

/** One instance in the manifest: a child, or the parent itself. */
export interface ChildrenManifestInstance {
  instanceId: string;
  /** Null when Argus could not read the record (never created, removed, or
   *  unreadable); every field below is then absent and `warnings` says why. */
  status: InstanceStatus | null;
  pipelineId?: string;
  createdAt?: string;
  endedAt?: string | null;
  abortCause?: AbortCause;
  /** `<artifacts>/<instanceId>`: the folder holding every phase folder of
   *  this child, offered to the run as a read channel. Absent on the parent,
   *  on a child that has no folder, and past the per-run channel limit. */
  artifactsDir?: string;
  phases?: ChildrenManifestPhase[];
  /** Gate decisions that took effect, oldest first. */
  decisions?: ChildrenManifestDecision[];
  cost?: ChildrenManifestCost;
}

/** One task of the spawn phase and the children that ran it. */
export interface ChildrenManifestTask {
  /** The task's position in the list (`InstanceParentRef.index`). */
  index: number;
  key: string;
  /** The task's title, clipped to 60 characters; `task` holds it whole. */
  title?: string;
  /** The keys of the tasks it waited for. */
  dependsOn: string[];
  /** The task's state as the spawn phase last saw it. */
  state: SpawnTaskState;
  reason?: string;
  /** The task object as the current child received it
   *  (`triggerPayload.task`). Absent when that record cannot be read. */
  task?: Record<string, unknown>;
  /** The child that runs (or ran) the task. Absent while the task has none:
   *  never planned, or its child replaced and the new one not planned yet. */
  child?: ChildrenManifestInstance;
  /** Children a fresh child replaced (after an abort or a refused start),
   *  oldest first. */
  earlierChildren?: ChildrenManifestInstance[];
}

/**
 * The document at `ARGUS_CHILDREN_FILE`: what a phase that declares
 * `childrenContext` knows about the children of an earlier spawn phase, and
 * about its own instance. Built once per phase attempt, so every run of the
 * attempt reads the same bytes, and re-hashed when a run completes.
 */
export interface ChildrenManifest {
  schemaVersion: 1;
  /** When the attempt was planned. */
  generatedAt: string;
  /** The phase attempt this manifest was built for. */
  for: { instanceId: string; phaseId: string; attempt: number };
  /** The spawn phase it describes (`childrenContext.fromPhase`). */
  spawnPhase: {
    id: string;
    name: string;
    status: PhaseStatus;
    attempt: number;
    /** The pipeline every child runs; null when the phase never built a task
     *  list (it was skipped). */
    childPipelineId: string | null;
    /** Tasks by state; a state with no task is absent. */
    counts: Partial<Record<SpawnTaskState, number>>;
  };
  /** Every task, in list order. Empty when the spawn phase built no list. */
  tasks: ChildrenManifestTask[];
  /** The instance this manifest belongs to: its phases, decisions and cost. */
  parent: ChildrenManifestInstance;
  /** Every child's runs, earlier children included. The parent's own cost is
   *  `parent.cost`. */
  childrenCost: ChildrenManifestCost;
  /** What Argus could not read or offer while building this, one line each. */
  warnings: string[];
}

/**
 * A deterministic check Argus runs itself once every step of a phase has
 * reported success — the difference between "the agent said the tests pass"
 * and "the tests pass". A failing check fails the phase under the
 * `verification` failure class.
 */
export type PhaseCheck =
  | {
      kind: "command";
      /** Run through the shell in the phase's cwd (or `cwd`); exit 0 passes. */
      run: string;
      label?: string;
      cwd?: string;
      timeoutSeconds?: number;
    }
  | {
      /** A file the phase was required to leave in its artifact directory. */
      kind: "artifact";
      path: string;
      label?: string;
      minBytes?: number;
    }
  | {
      /** A file relative to the phase's working directory. */
      kind: "file";
      path: string;
      label?: string;
      minBytes?: number;
    }
  | {
      /**
       * The working tree's changed paths (git) must all match `allow` and none
       * match `deny`. `requireChanges` fails a phase that changed nothing.
       */
      kind: "changed-files";
      label?: string;
      allow?: string[];
      deny?: string[];
      requireChanges?: boolean;
    }
  | {
      /**
       * Deterministic trajectory signals over the attempt's recorded runs
       * (the selected candidate's, when one is selected; the candidate's own
       * when a candidate is verified). No model is involved.
       *
       * `thresholds` names each signal it checks and the largest count it
       * allows; a run whose count exceeds one is an observed violation and
       * fails the check — on a truncated recording too, since what was kept
       * is real. A run with no readable recording, or a truncated one with no
       * violation in what was kept, cannot show the thresholds were met: the
       * check then fails as insufficient input when `requireTranscript` is
       * set, and is reported `not-evaluated` (never `passed`) when it is not.
       */
      kind: "trajectory";
      label?: string;
      thresholds: Partial<Record<TrajectorySignalKind, number>>;
      requireTranscript?: boolean;
    };

/**
 * A condition Argus polls while a gated phase waits at its gate (DL-A3): a
 * command Argus runs itself, on the scheduler tick, in the phase's worktree
 * (its `cwd` when it has none), with the phase's environment policy and the
 * attempt's inputs (`ARGUS_INSTANCE_ID`, `ARGUS_PHASE_ID`,
 * `ARGUS_PHASE_ATTEMPT`, `ARGUS_ARTIFACT_DIR`, `ARGUS_WORKSPACE`,
 * `ARGUS_TRIGGER_PAYLOAD_FILE`). Nothing in it is interpolated.
 *
 * Exit 0 approves the gate, recorded as a gate decision with mechanism
 * `approval-condition`. An exit equal to `failOnExit` fails the phase under
 * the `approval-condition` class, which is never retried. Anything else — a
 * timeout included — keeps the gate waiting. Allowed on gated phases only,
 * and refused on a phase whose gate commits knowledge. A person can approve,
 * revise or abort at any time. The command must be read-only: a shutdown cuts
 * it, and a restart runs it again.
 */
export interface ApprovalCondition {
  kind: "command";
  /** Run through the platform shell. Up to 4,000 characters. */
  run: string;
  /** Resolved against the phase's worktree (or `cwd`); an absolute path stands. */
  cwd?: string;
  /** How the journal and the gate decision name it. Default: `command: ` and
   *  the first 71 characters of `run`, as a command check's label. */
  label?: string;
  /** Seconds from one poll's start to the next's, 30–86400. Resolution: one scheduler tick. */
  everySeconds: number;
  /** Wall-clock limit for one poll, 1–600. Absent = 60. */
  timeoutSeconds?: number;
  /** An exit code, 1–255, that fails the phase instead of waiting. */
  failOnExit?: number;
}

export interface CheckResult {
  kind: PhaseCheck["kind"];
  label: string;
  /**
   * `not-evaluated`: the check could not be evaluated from the input it had
   * and was not configured to require it (a `trajectory` check without
   * `requireTranscript`). It neither passed nor failed, and it does not fail
   * the report. No other kind produces it.
   */
  status: "passed" | "failed" | "not-evaluated";
  /** One line: why it passed or failed. */
  detail: string;
  exitCode?: number | null;
  durationMs: number;
  /** Bounded tail of a command's combined output. */
  output?: string;
}

export interface VerificationReport {
  status: "running" | "passed" | "failed";
  startedAt: string;
  endedAt?: string | null;
  checks: CheckResult[];
}

/**
 * What Argus actually launched, written beside the run so a failure can be
 * reproduced: the exact executable and argv, the environment by *name*, the
 * capability profile as applied and what could not be enforced, the config
 * files materialized for the invocation, and the repository state it started
 * against. No values of environment variables, ever.
 */
export interface AgentInvocationRecord {
  runId: string;
  instanceId: string;
  phaseId: string;
  step: string;
  attempt: number;
  runtime: AgentRuntimeId;
  bin: string;
  args: string[];
  cwd: string;
  /** Names of the environment variables passed to the child, sorted. */
  envNames: string[];
  /** Names Argus removed from its own environment before spawning, sorted. */
  envStripped: string[];
  capabilities: CapabilityProfile | null;
  /** What the runtime could not enforce of the declared profile. */
  limitations: string[];
  /** Files Argus wrote for this invocation (settings, MCP config). */
  materializedFiles: string[];
  artifactDir: string | null;
  /** The isolated worktree this invocation ran in, when the phase declared one. */
  workspace?: WorkspaceRecord | null;
  resultFile: string | null;
  /** Where this run may leave its KnowledgeDelta (`ARGUS_KNOWLEDGE_DELTA_FILE`).
   *  Absent on records written before the protocol existed. */
  knowledgeDeltaFile?: string | null;
  /** Where this run's read-only KnowledgeContext was materialized
   *  (`ARGUS_KNOWLEDGE_CONTEXT_FILE`). Null when the step declared no
   *  semantic context; absent on records written before Phase 4. */
  knowledgeContextFile?: string | null;
  /**
   * Exactly what Argus supplied: the exact revisions in the context and the
   * SHA-256 of the file as written. Independent of the agent's later
   * `consumed` declaration, and stable however the ledger changes afterwards.
   * Null when no context was supplied; absent on pre-Phase-4 records.
   */
  knowledgeContext?: InvocationKnowledgeContext | null;
  /** Where this run must leave its rule-verification report
   *  (`ARGUS_RULE_VERIFICATION_FILE`). Null on a phase that is not a
   *  verification phase; absent on records written before Phase 6. */
  ruleVerificationFile?: string | null;
  /** Where this run's read-only {@link ChangeIntentInput} was materialized
   *  (`ARGUS_CHANGE_REQUEST_FILE`). Null on a phase that is not a
   *  change-intent phase; absent on records written before Phase 7. */
  changeRequestFile?: string | null;
  /** Where this run must leave its {@link ChangeProposal}
   *  (`ARGUS_CHANGE_PROPOSAL_FILE`). Null on a phase that is not a
   *  change-intent phase; absent on records written before Phase 7. */
  changeProposalFile?: string | null;
  /** Where this run's read-only {@link ChangeContext} was materialized
   *  (`ARGUS_CHANGE_CONTEXT_FILE`). Null when the phase declared no
   *  `changeContext`; absent on records written before Phase 7. */
  changeContextFile?: string | null;
  /**
   * Every Argus-owned **read-only input** materialized for this invocation
   * besides the KnowledgeContext, with the SHA-256 of the bytes as written
   * (Phase 8): the ChangeContext, the ImplementationScope, the
   * RemediationContext, and the children manifest (DL-A2b).
   *
   * The integrity counterpart of {@link knowledgeContext}'s hash, and there
   * for the same reason: at completion the bytes must still hash to this, or
   * the step fails before anything it proposed is staged. Absent on records
   * written before Phase 8, which is not a failure — there is nothing to
   * verify, exactly as for a pre-Phase-4.1 context.
   */
  suppliedInputs?: Array<{ kind: InvocationChannelKind; path: string; sha256: string }>;
  /** Where this run's read-only {@link ImplementationScope} was materialized
   *  (`ARGUS_IMPLEMENTATION_SCOPE_FILE`). Null on a phase that is not an
   *  implementation phase; absent on records written before Phase 8. */
  implementationScopeFile?: string | null;
  /** Where this run's read-only {@link RemediationContext} was materialized
   *  (`ARGUS_REMEDIATION_CONTEXT_FILE`). Null on a first attempt, which has no
   *  failures to remediate; absent on records written before Phase 8. */
  remediationContextFile?: string | null;
  /** Where this run must leave its {@link AcceptanceVerificationReport}
   *  (`ARGUS_ACCEPTANCE_VERIFICATION_FILE`). Null on a phase that is not an
   *  acceptance-verification phase; absent on records before Phase 8. */
  acceptanceVerificationFile?: string | null;
  /** Where every revise note of the phase was written in full
   *  (`ARGUS_REVISION_NOTES_FILE`), when the prompt could not carry them all.
   *  Absent otherwise. */
  revisionNotesFile?: string;
  /** Where this run's children manifest was written (`ARGUS_CHILDREN_FILE`),
   *  when its phase declares `childrenContext`. The children's artifact
   *  folders it was offered are in `channels` (`child-artifacts`). Absent
   *  otherwise. */
  childrenFile?: string;
  /**
   * Every Argus-owned channel this invocation was offered, with the access it
   * needs and whether the runtime could honour it. A channel `unavailable`
   * here also appears in `limitations`. Absent on records written before the
   * channel model existed.
   */
  channels?: InvocationChannelRecord[];
  /** The Claude configuration folder the CLI loaded instead of the operator's
   *  own (`CLAUDE_CONFIG_DIR`), from the pipeline's `claudeConfigDir`. Absent
   *  when the step ran on the operator's setup, or on another runtime. */
  claudeConfigDir?: string;
  timeoutSeconds: number | null;
  deadlineAt: string | null;
  /** `git rev-parse HEAD` in cwd at launch, when cwd is a repository. */
  gitHead: string | null;
  startedAt: string;
}

/** A dependency can preserve the legacy phase-id shorthand or describe a route. */
export type Dependency = string | DependencyEdge;

/** The object form of a dependency edge. */
export interface DependencyEdge {
  phase: string;
  when?: RouteCondition;
  /** Accept a source phase that was intentionally skipped by routing. */
  allowSkipped?: boolean;
}

export interface RouteCondition {
  group?: string;
  exclusive?: boolean;
  required?: boolean;
  default?: true;
  predicate?: RoutePredicate;
}

export interface RoutePredicate {
  path: string[];
  operator: "equals" | "not-equals" | "one-of" | "exists";
  value?: string | number | boolean | null | Array<string | number | boolean | null>;
}

/** A deliberately small recursive schema for a JSON phase result. */
export interface ResultSchema {
  type: "object" | "array" | "string" | "number" | "boolean" | "null";
  properties?: Record<string, ResultSchema>;
  required?: string[];
  items?: ResultSchema;
  enum?: Array<string | number | boolean | null>;
}

/** Opt-in structured outcome a completed phase may publish. */
export interface PhaseResult {
  artifact: string;
  resultStep?: string;
  schema: ResultSchema;
}

/** Immutable outcome of evaluating a result-producing phase's routes. */
export interface RouteDecision {
  sourcePhase: string;
  artifact: string;
  value: unknown;
  selected: string[];
  skipped: string[];
  reason: string;
}

export interface PhaseDef {
  id: string;
  name: string;
  cwd: string;
  /** Empty only on a spawn phase. */
  steps: PhaseStep[];
  gated: boolean;
  /**
   * Phase ids this one waits for.
   *
   * Absent on **every** phase means the pipeline is linear and each phase
   * implicitly needs the one before it — which is how every pipeline authored
   * before Weave keeps working, unchanged, as a degenerate DAG.
   */
  needs?: Dependency[];
  /** Opt-in structured result used by conditional outgoing dependencies. */
  result?: PhaseResult;
  /** Retry policy for this phase's steps. Absent = one attempt. */
  retry?: RetryPolicy;
  /** Overrides the pipeline's completion policy for this phase's steps.
   *  Absent = the pipeline's, else `{ marker: "required" }`. */
  completion?: CompletionPolicy;
  /**
   * Publish this phase's payload under a name later phases can interpolate as
   * `{{artifacts.<name>}}`. Absent = the payload is only visible to the
   * immediately following phase, as `{{previous.payload}}`.
   */
  produces?: string;
  /** Opt-in quality rubric for this phase's output. */
  rubric?: Rubric;
  /** On a gated phase: let the gate open itself when the verdict clears the
   *  bar. Requires `rubric`; without one there is nothing to clear. */
  autoApprove?: AutoApprove;
  /** On a gated phase: a command Argus polls while the gate waits, which
   *  approves it on exit 0 or fails the phase on `failOnExit`. May sit beside
   *  `autoApprove`; whichever qualifies first opens the gate. */
  approveWhen?: ApprovalCondition;
  /** Overrides the pipeline's runtime for every step in this phase. */
  runtime?: AgentRuntimeId;
  /** Wall-clock limit for each step's process. Absent = no limit. */
  timeoutSeconds?: number;
  /** Kill a step of this phase if its transcript goes this many seconds
   *  without new activity, even though the process is still alive — a
   *  process can be alive and silent forever, and a hard timeout sized for
   *  the worst case is a poor stand-in for noticing that nothing is
   *  happening. A step that declares its own `stallSeconds` uses that
   *  instead. Absent = off. Minimum 30. */
  stallSeconds?: number;
  /** What this phase's agents may do. Absent = the pipeline's profile, else the CLI's defaults. */
  capabilities?: CapabilityProfile;
  /** Deterministic checks that must pass before the phase counts as succeeded. */
  checks?: PhaseCheck[];
  /** Run this phase's steps in an isolated git worktree of the repository at
   *  `cwd`. Overrides the pipeline's policy; absent = the pipeline's, else the
   *  phase's own `cwd` exactly as before workspaces existed. */
  workspace?: WorkspacePolicy;
  /** Which project and repository *this phase's* knowledge belongs to, when it
   *  works in a different repository from the rest of the pipeline. Overrides
   *  the pipeline's policy entirely (no merging); absent = the pipeline's. */
  knowledgeScope?: KnowledgeScopePolicy;
  /** Run this phase's single step as N competing candidates and let `checks`
   *  select one. Requires exactly one step and attempt-scoped isolation. */
  candidates?: CandidatePolicy;
  /**
   * Whether this phase's runs *depend on* being able to write a KnowledgeDelta.
   *
   * The delta channel is offered to every run (`ARGUS_KNOWLEDGE_DELTA_FILE`),
   * and emitting one stays optional either way — this says nothing about
   * whether the agent must write a file. `"required"` makes the *channel* a
   * precondition of the launch: a runtime that cannot make the path writable
   * refuses the step under strict enforcement instead of launching an agent
   * whose proposals could never arrive. Absent = `"optional"`: an unwritable
   * channel is recorded as an invocation limitation and the step still runs.
   */
  knowledgeDelta?: "optional" | "required";
  /**
   * The canonical knowledge every step of this phase receives as a read-only
   * KnowledgeContext, unless a step declares its own. Selectors are resolved
   * against one ledger snapshot when the phase attempt is prepared; the exact
   * revisions each run received are on its invocation record.
   */
  knowledgeContext?: KnowledgeContextSpec;
  /**
   * Turn this phase into a **business-rule discovery phase** (Phase 5): its
   * steps are instructed to read a bounded repository scope and propose the
   * business rules the code appears to enforce, and the KnowledgeDelta they
   * write is held to the discovery invariants (evidence for every rule,
   * source paths that exist inside the declared scope at the run's commit).
   *
   * Absent = an ordinary phase, behaving in every respect exactly as before
   * Phase 5 existed. Discovery adds no new commit path: the candidates are
   * staged and become canonical only when the phase is accepted, which is why
   * a discovery phase is normally `gated: true`.
   */
  discovery?: DiscoveryPolicy;
  /**
   * Turn this phase into a **business-rule verification phase** (Phase 6): its
   * steps are instructed to decide, for every business rule Argus supplied
   * them as KnowledgeContext, whether the implementation at the run's
   * repository revision conforms — and to write the answer as a structured
   * {@link RuleVerificationReport} rather than as prose or as knowledge.
   *
   * The rules are not selected here: they are exactly the ones the phase's
   * (or step's) `knowledgeContext` supplied. Every one of them must receive
   * an outcome and nothing else may, which gives Argus a deterministic
   * completeness check over the agent's answer.
   *
   * Absent = an ordinary phase, behaving in every respect exactly as before
   * Phase 6 existed. Verification adds no new commit path: the results are
   * staged and become durable only when the phase is accepted.
   */
  ruleVerification?: RuleVerificationPolicy;
  /**
   * Turn this phase into a **change-intent phase** (Phase 7): its steps are
   * given an explicit {@link ChangeRequest} plus the current conformance of
   * the rules they were supplied, and must answer with a structured
   * {@link ChangeProposal} — what semantics would change, what stays, what
   * follows, how success is judged and what is still unknown.
   *
   * Nothing it proposes becomes canonical before the gate. A change-intent
   * phase must be `gated`, which is enforced when the pipeline is saved.
   *
   * Absent = an ordinary phase, behaving in every respect exactly as before
   * Phase 7 existed.
   */
  changeIntent?: ChangeIntentPolicy;
  /**
   * Give every step of this phase the accepted {@link ChangeProposal} of an
   * earlier phase of the same instance, as a read-only
   * {@link ChangeContext} (`ARGUS_CHANGE_CONTEXT_FILE`).
   *
   * The downstream half of Phase 7: an implementation run receives *what the
   * domain currently says* through its `knowledgeContext` and *what this
   * change intends to make true* through this. Only an accepted proposal
   * resolves — a staged one refuses the launch.
   */
  changeContext?: ChangeContextSpec;
  /**
   * Turn this phase into the **implementation half of a change realization**
   * (Phase 8): its runs receive the deterministic {@link ImplementationScope}
   * of the accepted change they were handed as a `changeContext`, and Argus
   * opens a durable {@link ChangeRealization} that the matching verification
   * phase closes out.
   *
   * Requires `changeContext` on the same phase — the proposal this realizes is
   * the one that selector resolves, and there is no second selection
   * mechanism. Absent = an ordinary phase, including one that declares
   * `changeContext` alone, which is Phase 7's handoff unchanged.
   */
  implementation?: ImplementationPolicy;
  /**
   * Turn this phase into the **acceptance-verification half of a change
   * realization** (Phase 8): its runs must decide, for every acceptance
   * criterion of the accepted proposal, whether the implementation satisfies
   * it — and write the answer as a structured
   * {@link AcceptanceVerificationReport}.
   *
   * Independent of `ruleVerification`, and normally declared beside it: rule
   * conformance and acceptance satisfaction are different questions, and a
   * realization needs both.
   */
  acceptanceVerification?: AcceptanceVerificationPolicy;
  /**
   * Turn this phase into a **spawn phase**: one child instance of
   * `spawn.pipelineId` per task in an earlier phase's result, joined before
   * the phases that need this one (see {@link SpawnPolicy}). A spawn phase runs
   * no agent: it declares only `id`, `name`, `cwd`, `needs`, `produces` and
   * `spawn`, with `steps: []` and `gated: false`. Its payload is the
   * {@link SpawnChildrenSummary}.
   */
  spawn?: SpawnPolicy;
  /**
   * Give every step of this phase a read-only {@link ChildrenManifest} of the
   * children an earlier spawn phase started (`ARGUS_CHILDREN_FILE`), and each
   * child's artifact folder as a read channel. `fromPhase` must be a spawn
   * phase this phase depends on. Absent = an ordinary phase.
   */
  childrenContext?: ChildrenContextSpec;
}

// ── Harness: Argus-owned invocation channels ─────────────────────────────────

/**
 * The structured files and directories Argus itself owns for one invocation,
 * each named to the agent by an environment variable. They are the protocol
 * between the agent process and Argus — a result decision, a KnowledgeDelta
 * proposal, file artifacts — and unlike the working tree they live outside the
 * repository, so a filesystem restriction must not cut the agent off from them.
 */
export type InvocationChannelKind =
  | "result"
  | "knowledge-delta"
  | "knowledge-context"
  | "rule-verification"
  | "change-request"
  | "change-proposal"
  | "change-context"
  | "implementation-scope"
  | "remediation-context"
  | "acceptance-verification"
  | "revision-notes"
  | "children-manifest"
  | "child-artifacts"
  | "artifact-dir"
  | "memory-dir";

/** What the agent process needs to be able to do with a channel's path. */
export type InvocationChannelAccess = "read" | "write";

/**
 * One channel as the invocation record shows it: what was offered, what
 * access it needs, whether the launch depended on it, and whether the runtime
 * could honour it.
 *
 * `status`:
 * - `granted` — the runtime maps the path into its sandbox, or runs no sandbox
 *   the path could fall outside of;
 * - `unavailable` — the runtime's effective filesystem mode cannot reach the
 *   path; `reason` says why. Under strict enforcement a `required` channel in
 *   this state refuses the launch; an optional one is recorded and the step
 *   runs (its protocol is offered but cannot be fulfilled);
 * - `unmanaged` — no capability profile was declared, so Argus does not shape
 *   the runtime's filesystem at all and makes no claim: the CLI's own defaults
 *   decide, exactly as before capability profiles existed.
 */
export interface InvocationChannelRecord {
  kind: InvocationChannelKind;
  /** The variable the agent learns the path from (`ARGUS_RESULT_FILE`, …). */
  envVar: string;
  /** The path as the agent sees it: a file for `result`/`knowledge-delta`/
   *  `knowledge-context`/`rule-verification`/`change-*`, a directory otherwise. */
  path: string;
  access: InvocationChannelAccess;
  /** Whether the launch depends on this channel being available. */
  required: boolean;
  status: "granted" | "unavailable" | "unmanaged";
  /** Why the channel is unavailable. Absent otherwise. */
  reason?: string;
}

/**
 * **Which project and repository this pipeline's knowledge belongs to.**
 *
 * Declared once, on the pipeline (a phase may override it when it works in a
 * different repository), and resolved to a {@link KnowledgeScope} at each
 * phase attempt — then *frozen* on the phase record, so editing the pipeline
 * mid-instance can never retarget knowledge that has already been written.
 *
 * Absent = unscoped, and everything behaves exactly as it did before scopes
 * existed: the pipeline reads and writes the ledger's unscoped records.
 */
export interface KnowledgeScopePolicy {
  /**
   * The durable project (or system/domain) identity. Author-declared, because
   * only a person knows that two repositories belong to one product — Argus
   * will not infer it.
   */
  projectId: string;
  /**
   * The durable repository identity. Absent = derived from the phase's working
   * tree: the normalized remote identity (`git:github.com/acme/kobra`), else
   * the root-commit identity (`commit:<sha>`). Both are identical across
   * clones, machines and git worktrees, and neither is a filesystem path. A
   * working tree that yields neither refuses the launch with a `configuration`
   * failure rather than inventing an identity from the directory name.
   */
  repositoryId?: string;
  /**
   * Scopes this pipeline may additionally **read**. The explicit, authorized
   * form of cross-project reasoning: without an entry here a run can neither
   * be supplied, nor declare consumption of, knowledge outside its own scope.
   * Writes are never affected — a run always writes into its own scope.
   */
  alsoRead?: KnowledgeScope[];
}

export interface PipelineDefinition {
  id: string;
  name: string;
  phases: PhaseDef[];
  trigger: Trigger | null;
  enabled: boolean;
  overlapPolicy: "skip" | "allow";
  model?: string;
  /** Default Codex reasoning effort for steps that do not override it. */
  reasoningEffort?: ReasoningEffort;
  /**
   * Which agent CLI runs this pipeline's steps, unless a phase or step names
   * another. Absent = the server default, so every pipeline authored before
   * runtimes existed keeps running on Claude Code exactly as it did.
   */
  runtime?: AgentRuntimeId;
  /** Default capability profile for every phase that does not declare one. */
  capabilities?: CapabilityProfile;
  /**
   * The Claude Code configuration folder every Claude step of this pipeline
   * loads instead of the operator's own `~/.claude` (`CLAUDE_CONFIG_DIR`): its
   * `CLAUDE.md`, `settings.json`, skills, agents and commands, and where the
   * CLI files the runs' session logs (`<folder>/projects/`). Absolute, and an
   * existing directory. Pipeline-level only, so no phase's capability profile
   * can drop it. Argus also denies agents `Read` on `<folder>/settings.json`
   * (it holds the sign-in token) and edits under the folder. Absent = the
   * operator's own setup, exactly as before. Other runtimes ignore it, and
   * their invocation records say so.
   */
  claudeConfigDir?: string;
  /**
   * Whether a completion must carry an `ARGUS_OUTCOME: succeeded` marker, for
   * every phase that does not declare its own. Absent = `required` — an
   * intentional change from the original permissive behaviour; declare
   * `{ marker: "lenient" }` to accept a completion with no marker.
   */
  completion?: CompletionPolicy;
  /** Default isolation policy for every phase that does not declare one.
   *  Absent = no isolation: every phase runs in its own `cwd`. */
  workspace?: WorkspacePolicy;
  /** Which project and repository this pipeline's knowledge belongs to.
   *  Absent = unscoped, exactly as before knowledge scopes existed. */
  knowledgeScope?: KnowledgeScopePolicy;
  /**
   * Caps on what an interpolated placeholder value may cost the prompt.
   * Absent = the 16 KiB default for every placeholder.
   */
  contextLimits?: ContextLimits;
  /**
   * Durable notes this pipeline's own runs may read and append to, across
   * instances. Absent/disabled = `{{memory}}` interpolates to empty and no
   * `ARGUS_MEMORY_DIR` is set. See `NOTES.md` under `harness/memory.ts`.
   */
  memory?: MemoryPolicy;
  /**
   * Bearer credential for `POST /api/hooks/pipelines/:id`, minted once this
   * pipeline's `trigger` first becomes `kind: "webhook"` and kept stable
   * across later edits — regenerated only via
   * `POST /api/pipelines/:id/hook-token/rotate`. This is a single-user control
   * plane behind `ARGUS_TOKEN`; the token is returned in GET responses rather
   * than hashed, the way `ARGUS_TOKEN` itself is a plaintext shared secret.
   */
  hookToken?: string;
  lastStartedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The client-authored half of a pipeline (POST/PUT body). */
export interface PipelineInput {
  name: string;
  phases: PhaseDef[];
  trigger: Trigger | null;
  enabled?: boolean;
  overlapPolicy?: "skip" | "allow";
  model?: string;
  reasoningEffort?: ReasoningEffort;
  runtime?: AgentRuntimeId;
  capabilities?: CapabilityProfile;
  claudeConfigDir?: string;
  completion?: CompletionPolicy;
  workspace?: WorkspacePolicy;
  knowledgeScope?: KnowledgeScopePolicy;
  contextLimits?: ContextLimits;
  memory?: MemoryPolicy;
}

/** Per-placeholder byte cap on interpolated prompt text (§ dag.ts `interpolate`). */
export interface ContextLimits {
  /** Bytes a single `{{placeholder}}` value may contribute before Argus trims
   *  it (head 2/3, tail 1/3, with a marker naming where the full value is on
   *  disk). Default 16 KiB (16384). Range 1 KiB (1024) – 256 KiB (262144). */
  placeholderBytes?: number;
}

/**
 * Durable, cross-instance notes for one pipeline (`NOTES.md`), opt-in.
 *
 * Off by default: most pipelines have nothing worth remembering between runs,
 * and a file every instance can write to is a shared-mutable-state surface
 * that should be asked for, not assumed.
 */
export interface MemoryPolicy {
  enabled: boolean;
  /** Bytes `NOTES.md` may grow to before Argus trims its head (oldest
   *  content) back down to this cap, on a line boundary. Default 8 KiB
   *  (8192). Range 1 KiB (1024) – 64 KiB (65536). */
  maxBytes?: number;
}

export type InstanceStatus = "running" | "awaiting-approval" | "failed" | "succeeded" | "aborted";

export type PhaseStatus =
  "pending" | "running" | "awaiting-approval" | "succeeded" | "skipped" | "failed" | "aborted";

export type StepStatus = "pending" | "running" | "succeeded" | "skipped" | "failed" | "aborted";

export interface StepProgress {
  name: string;
  runId: string | null;
  status: StepStatus;
  /** USD cost of the step's run, joined from the run record at read time. */
  costUsd?: number | null;
  /** Total tokens of the step's run, joined from the run record at read time. */
  tokens?: number | null;
  /** Model the step's run was started with, joined from the run record. */
  model?: string | null;
  /** Runtime the step's run was started with, joined from the run record. */
  runtime?: AgentRuntimeId | null;
  /** Latest activity label from the run tailer; only set while running. */
  currentActivity?: string | null;
  /** Arrival timestamp of that activity. */
  activityAt?: string | null;
  /** Run start time, joined from the run record. */
  startedAt?: string | null;
  /** Final run duration, joined from the run record when it ended. */
  durationMs?: number | null;
  /**
   * The structured result this step delivered, exactly as it was submitted.
   *
   * Held per-step because a phase's result arrives with one step's completion
   * signal while its siblings may still be running, and it is the phase — not
   * the step — that publishes a decision once every step is in.
   */
  result?: unknown;
  /** Why the step's declared result could not be read (e.g. a torn file). */
  resultError?: string;
  /**
   * The agent's own closing payload for this run.
   *
   * Ordinarily a phase keeps one payload, because ordinarily one step's report
   * is the phase's report. A candidate phase has `count` of them and may
   * publish only the winner's, so each candidate's is held here until selection
   * copies one onto the phase.
   */
  payload?: unknown;
  /** Why this step ended badly, when it did. Held per step for the same reason
   *  as {@link StepProgress.payload}. */
  failure?: StepFailure;
  /** Which candidate of a `candidates` phase this run is (0-based). Absent on
   *  an ordinary step. */
  candidate?: number;
  /** This candidate's own verification report: the phase's `checks` run inside
   *  this candidate's worktree, against its own baseline and artifact
   *  directory. Absent on an ordinary step, which is verified phase-wide. */
  verification?: VerificationReport;
  /** The worktree this candidate ran in. Absent on an ordinary step, whose
   *  phase records the one tree they shared. */
  workspace?: WorkspaceRecord | null;
  /**
   * The KnowledgeDelta this step's run emitted, as Argus staged it. Held per
   * step because each run may propose at most one delta and the phase commits
   * every eligible one of its attempt atomically. Absent when the run wrote no
   * delta file. Lives on the step so a new attempt (fresh steps) starts clean.
   */
  knowledgeDelta?: StepKnowledgeDelta;
  /**
   * The rule-verification proposal this step's run emitted, as Argus staged
   * it (Phase 6). A separate sidecar from {@link StepProgress.knowledgeDelta}
   * because a conformance result is not a knowledge mutation: it describes the
   * relationship between an implementation and rules that already exist.
   * Absent when the run wrote no verification file.
   */
  ruleVerification?: StepRuleVerification;
  /**
   * The ChangeProposal this step's run emitted, as Argus staged it (Phase 7).
   * Its own sidecar beside {@link StepProgress.knowledgeDelta}: the semantic
   * half of a proposal *is* a delta and is staged as one, and this record is
   * everything the delta has no place for — what is preserved, how success is
   * judged, what is unresolved. Absent when the run wrote no proposal.
   */
  changeProposal?: StepChangeProposal;
  /**
   * The acceptance-verification proposal this step's run emitted, as Argus
   * staged it (Phase 8). Its own sidecar beside
   * {@link StepProgress.ruleVerification} because the two answer different
   * questions: a rule result is bound to a `ClaimRef`, a criterion result to
   * `CP-12/AC-1`. Absent when the run wrote no acceptance file.
   */
  acceptanceVerification?: StepAcceptanceVerification;
  /** How this run's signals are authenticated — see {@link SignalAuthRecord}.
   *  Absent on a step planned before per-run tokens existed. */
  signalAuth?: SignalAuthRecord;
  /**
   * How this run's completion (or reported failure) reached Argus and what
   * Argus decided, recorded when it arrived. Absent on a step that never
   * reported, and on steps recorded before completion provenance existed.
   */
  completion?: StepCompletion;
}

/** A staged delta as the instance record sees it; the full record lives
 *  beside the run (`GET /api/knowledge/deltas/:id`). */
export interface StepKnowledgeDelta {
  id: string;
  status: KnowledgeDeltaStatus;
}

/** A staged verification proposal as the instance record sees it; the full
 *  record lives beside the run. */
export interface StepRuleVerification {
  id: string;
  status: RuleVerificationStatus;
}

/** A staged change proposal as the instance record sees it; the full record
 *  lives beside the run (`GET /api/knowledge/change-proposals/:id`). */
export interface StepChangeProposal {
  id: string;
  status: ChangeProposalStatus;
}

/**
 * The commit of a phase attempt's staged KnowledgeDeltas — the last rung of
 * the acceptance ladder. `pending` while Argus applies them (the phase stays
 * `running`, exactly as it does under `verification.status: "running"`, and
 * a restart re-runs the commit, which is idempotent); `applied` on a phase
 * that succeeded with new canonical knowledge; `rejected` on one that failed
 * under the `knowledge-delta` class because the ledger refused the commit.
 */
export interface PhaseKnowledgeCommit {
  status: "pending" | "applied" | "rejected";
  /** The delta ids this attempt commits, in step order. */
  deltas: string[];
  /**
   * The rule-verification record ids this attempt commits, in step order
   * (Phase 6). Committed in the *same* ledger transition as `deltas`, so a
   * phase that both revises a rule and verifies one leaves the two facts
   * either both durable or neither. Absent on a phase that staged none.
   */
  verifications?: string[];
  /**
   * The change-proposal record ids this attempt accepts (Phase 7). Committed
   * in the *same* ledger transition as `deltas`, so a proposal's canonical
   * semantics and the durable record of the request that caused them are
   * either both there or neither is. Absent on a phase that staged none.
   */
  changeProposals?: string[];
  /**
   * The acceptance-verification record ids this attempt commits (Phase 8).
   * Committed in the *same* ledger transition as the rest, so a realization's
   * three rule verifications and four acceptance verifications are all durable
   * or none of them are. Absent on a phase that staged none.
   */
  acceptanceVerifications?: string[];
  startedAt: string;
  endedAt?: string | null;
  /** Why the commit was refused. */
  reason?: string;
}

export interface PhaseProgress {
  id: string;
  name: string;
  gated: boolean;
  status: PhaseStatus;
  steps: StepProgress[];
  /** Which attempt of this phase is in flight. Bumped by a revise *and* by an
   *  automatic retry, so the two read the same on the board. */
  attempt: number;
  /** Phase ids this one waited for, resolved (so a linear phase shows its
   *  implicit predecessor). Lets the board draw the graph without the def. */
  needs?: string[];
  /** Retries already consumed by the current attempt chain. */
  retries?: number;
  /** When the next automatic retry is due, while one is pending. */
  retryAt?: string | null;
  /**
   * The first attempt of the current automatic retry chain, set by a retry and
   * cleared by a revise or a remediation (which ask for new work). While the
   * tree carries over, a `changed-files` check is measured from that attempt's
   * baseline, so a retry is judged on what the phase changed, not only on what
   * the retry did. Absent: the attempt is measured from its own baseline.
   */
  baselineAttempt?: number;
  /**
   * Why the phase is (or last was) `awaiting-approval`: `gate` — every step
   * finished, its result validated and its checks passed, and the phase is
   * gated; `needs-input` — an agent asked a question, which pauses the phase
   * before any of that ran; `children` — a spawn phase whose children stopped
   * short (a child failed or was aborted, nothing more spawns, and no child is
   * still live). Approving a `children` pause accepts the tasks that succeeded
   * and drops the rest; revising it re-runs every task that did not succeed.
   * Set when the pause begins, cleared on a fresh attempt. Absent on pauses
   * written before it was recorded: unknown. Only a `gate` pause may be opened
   * by an automated rule — a question put to a person is not answered by a
   * score, and a spawn phase's children are not judged by one.
   */
  pause?: "gate" | "needs-input" | "children";
  /** Free-form: a gated phase carries whatever its agent signalled, a failed
   *  phase carries a {@link PhaseFailurePayload}. Narrow before reading. */
  payload: unknown | null;
  /** Validated structured outcome, intentionally separate from legacy payloads. */
  result?: unknown;
  /** Argus's own checks over the phase's work, once every step has reported. */
  verification?: VerificationReport;
  /** Where this attempt's steps were told to leave file artifacts. */
  artifactDir?: string | null;
  /** The isolated worktree this attempt's steps ran in, when the phase declared
   *  a policy. Null = the phase ran in its own `cwd`. On a `candidates` phase
   *  this becomes the *winning* candidate's tree once one is selected. */
  workspace?: WorkspaceRecord | null;
  /** Which candidate won, on a `candidates` phase that settled. Null while the
   *  selection is still open, or when no candidate could win. */
  selectedCandidate?: number | null;
  /** How every candidate ended, written once the phase settles — the losers'
   *  runs are the evidence for a selection, and they outlive their processes. */
  candidateOutcomes?: CandidateOutcome[];
  /**
   * The {@link KnowledgeScope} this attempt resolved to, frozen at planning.
   *
   * Every claim the attempt commits is owned by it, and every claim its runs
   * were supplied came from it (or from an explicitly authorized `alsoRead`
   * scope). Frozen rather than re-derived at commit time so that editing the
   * pipeline, or moving the checkout, while the instance runs can never change
   * who owns the knowledge it produced. Absent on an unscoped phase.
   */
  knowledgeScope?: KnowledgeScope;
  /** The `alsoRead` scopes in force for this attempt, frozen with the scope. */
  knowledgeAlsoRead?: KnowledgeScope[];
  /** The atomic commit of this attempt's staged KnowledgeDeltas, when it had
   *  any. Absent on a phase whose runs proposed no knowledge. */
  knowledge?: PhaseKnowledgeCommit;
  /** What this attempt's discovery run proposed, in counts (Phase 5). Derived
   *  from the attempt's staged deltas when they were staged, and rewritten
   *  when the commit settles. Absent on a phase without `discovery`. */
  discovery?: DiscoverySummary;
  /** What this attempt's verification runs concluded, in counts (Phase 6).
   *  Absent on a phase without `ruleVerification`. */
  ruleVerification?: RuleVerificationSummary;
  /** What this attempt's change-intent run proposed, in counts (Phase 7).
   *  Absent on a phase without `changeIntent`. */
  changeIntent?: ChangeIntentSummary;
  /** What this attempt's acceptance-verification run concluded, in counts
   *  (Phase 8). Absent on a phase without `acceptanceVerification`. */
  acceptanceVerification?: AcceptanceVerificationSummary;
  /**
   * The change realization this phase's attempt belongs to (Phase 8): which
   * durable {@link ChangeRealization} it is an attempt of, which attempt, and
   * what that attempt was launched to do. Written on both halves of a
   * realization — the implementation phase and the verification phase — so the
   * board can draw the loop without reading the ledger. Absent on a phase
   * that is not part of one.
   */
  realization?: PhaseRealizationRef;
  /** A spawn phase's tasks and their children. Absent until the phase first
   *  starts, and on every other phase. */
  children?: PhaseChildren;
}

/** A phase attempt's link into the durable realization it belongs to. */
export interface PhaseRealizationRef {
  id: string;
  proposalId: string;
  /** 1-based; the same number as the {@link ChangeRealizationAttempt}. */
  attempt: number;
  kind: "implementation" | "remediation";
  /** Attempts allowed in total, so the board can say "2 of 3". */
  maxAttempts: number;
  /**
   * The repository state this attempt's implementation produced, snapshotted
   * when the implementation phase concluded. Carried on the live instance
   * because the verification that follows must be proven to have examined
   * *this* state; it becomes durable on the realization attempt at close-out.
   */
  repository?: RepositoryStateRef;
}

/** What the engine writes into `PhaseProgress.payload` when a phase fails.
 *  `kind: "restarted"` means the run was orphaned by an Argus restart rather
 *  than having genuinely failed, which the UI offers to retry instead of revise. */
export interface PhaseFailurePayload {
  reason?: string;
  kind?: "restarted" | string;
  /** How the failure was classed for the retry policy. */
  failureClass?: PhaseFailureClass;
}

export interface PipelineInstance {
  id: string;
  pipelineId: string;
  pipelineName: string;
  status: InstanceStatus;
  currentPhaseIndex: number;
  phases: PhaseProgress[];
  /** `"webhook"` — fired by `POST /api/hooks/pipelines/:id`. `"chained"` —
   *  fired by an `after` trigger once a source pipeline instance ended.
   *  `"spawned"` — started by a parent's spawn phase (`parent`). */
  trigger: "manual" | "scheduled" | "webhook" | "chained" | "spawned";
  /**
   * The firing payload, when the trigger carried one: the webhook's JSON body
   * (capped at 64 KiB; a larger body is rejected with 413 before an instance
   * is created) for `trigger: "webhook"`,
   * `{ sourceInstanceId, sourcePipelineId, status }` for `trigger: "chained"`,
   * or the {@link SpawnTriggerPayload} for `trigger: "spawned"`.
   * Absent for `"manual"`/`"scheduled"`. The instance's command checks read a
   * JSON copy through `ARGUS_TRIGGER_PAYLOAD_FILE` (HARNESS.md §6).
   */
  triggerPayload?: unknown;
  /** `trigger: "chained"` only: the source instance this one was fired from. */
  chainedFrom?: string;
  /** `trigger: "spawned"` only: the parent instance, spawn phase and task this
   *  child runs. Retention keeps a child while its parent's record exists. */
  parent?: InstanceParentRef;
  /** The ref this instance's worktrees are cut from instead of the
   *  definition's `workspace.base`: a spawned child's `spawn.base`. Absent =
   *  the definition's. Argus does not fetch it. */
  workspaceBase?: string;
  /**
   * The instance-wide signal credential every run of an instance used to
   * share. Accepted only for a step recorded without its own
   * {@link StepProgress.signalAuth} on an instance without
   * {@link PipelineInstance.signalScheme} — runs launched before per-run tokens
   * existed. Never handed to a run launched since.
   */
  signalToken: string;
  /**
   * `run-token-v1` on every instance created since per-run signal tokens: its
   * legacy {@link PipelineInstance.signalToken} is never accepted for any
   * signal. Absent on older instances, whose pre-upgrade runs keep working.
   */
  signalScheme?: "run-token-v1";
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
  /** Named payloads published by completed phases, for `{{artifacts.<name>}}`. */
  artifacts?: Record<string, unknown>;
  /** Immutable records for phase outcomes that selected conditional routes. */
  routeDecisions?: RouteDecision[];
  /**
   * The definition exactly as it was when this instance started.
   *
   * Every later launch — a retry, a revise, the phase after a gate, a
   * verification, a run healed after a restart — reads this copy, never the
   * live definition, so editing (or deleting) the pipeline cannot change what
   * an instance that is already running does. What ran is what this says ran.
   * Absent on instances written before the snapshot existed; the engine falls
   * back to the live definition for those.
   */
  definition?: PipelineDefinition;
  /**
   * The worktree shared by every phase of this instance that declared
   * `scope: "instance"`, created on its first use. Null/absent = no phase asked
   * for one. An `attempt`-scoped phase records its own on `PhaseProgress`.
   */
  workspace?: WorkspaceRecord | null;
  /**
   * The gate decisions (`GD-…`) that took effect on this instance, in order.
   * Written in the same instance save as the transition each one caused, after
   * the decision record itself was made durable — so a transition on disk
   * always names a record that exists, and a record this list does not name
   * did not take effect. Absent on instances decided before decisions were
   * recorded: their provenance is unknown, not implied.
   */
  gateDecisionIds?: string[];
  /** A gate decision whose effects are under way — see `PendingGateOperation`. */
  pendingGateOperation?: PendingGateOperation;
  /** Set in the save that aborted the instance, when the abort had a cause
   *  beyond the operator stopping it — see {@link AbortCause}. */
  abortCause?: AbortCause;
  /**
   * Where this saved state stands in the instance's transition log
   * (`contracts/src/transitions.ts`). Absent on an instance that has not been
   * saved since the log existed.
   */
  transitionLog?: InstanceTransitionLogState;
}

export type SignalType = "completed" | "needs-input" | "failed";

export interface PipelineSignal {
  instanceId: string;
  phaseId: string;
  runId: string;
  type: SignalType;
  token: string;
  payload?: unknown;
  /**
   * The structured result the run wrote to its result file, parsed by the stop
   * hook. Never derived from the agent's prose: routing reads declared JSON or
   * it fails the phase.
   */
  result?: unknown;
  /** Set instead of `result` when the result file existed but could not be read. */
  resultError?: string;
  /**
   * The stop hook's own version and reading of the outcome marker (hook v2+).
   * Untrusted and additive: Argus classifies the final message itself and
   * only compares the two; a server that predates it ignores it.
   */
  completion?: SignalCompletionMeta;
}

/** Aggregated spend for one instance. Null field = no run reported that metric. */
export interface OverviewCost {
  usd: number | null;
  tokens: number | null;
}

export interface OverviewEntry {
  definition: PipelineDefinition;
  latest: PipelineInstance | null;
  /** Total spend of the latest instance across all its runs (including
   *  superseded revise attempts). Null when there is no instance. */
  cost: OverviewCost | null;
  /** Instances sharing the board, newest-first: every non-terminal one
   *  (running / awaiting-approval) plus terminal ones whose lifetime
   *  overlapped the latest instance, so a just-stopped sibling stays visible
   *  beside its peers. Empty when only the lone `latest` instance remains. */
  active: { instance: PipelineInstance; cost: OverviewCost }[];
  /**
   * The pipeline was deleted while these instances were still live. `definition`
   * is then the latest instance's snapshot, or (for an instance written before
   * snapshots) a stand-in with no phases; the only action left is abort.
   */
  orphaned?: true;
}

// ── Gated artifact review ────────────────────────────────────────────────────

/** One file a gated (or failed) phase left in its artifact directory. */
export interface PhaseArtifact {
  /** Path relative to the phase's artifact directory, POSIX separators. */
  path: string;
  bytes: number;
  modifiedAt: string;
  /** A `kind: "artifact"` check on the phase's snapshotted definition names this path. */
  required: boolean;
  /** UTF-8 text with no NUL bytes: only these can be viewed. */
  text: boolean;
}

/**
 * Everything a human needs to decide on one paused phase. Derived per read
 * from the instance record and the phase's artifact directory; nothing is
 * stored for it.
 */
export interface PhaseReview {
  instanceId: string;
  phaseId: string;
  phaseName: string;
  pipelineName: string;
  /** `awaiting-approval` → Approve + Revise. `failed` → Revise only. */
  status: "awaiting-approval" | "failed";
  /** The attempt this review describes. */
  attempt: number;
  /** Whether Approve is offered at all (false for a failed phase). */
  canApprove: boolean;
  /** The agent's own closing payload — read-only context for the decision. */
  payload: unknown | null;
  /** The phase's validated structured result, when it declared one. */
  result?: unknown;
  /** Argus's own checks over this attempt, when the phase declared any. */
  verification?: VerificationReport;
  artifactDir: string | null;
  artifacts: PhaseArtifact[];
  /** The listing hit its cap; more files exist on disk. */
  truncated?: boolean;
  /**
   * The candidate knowledge this attempt staged, one preview per step that
   * wrote a KnowledgeDelta (Phase 5). Derived per read from the staged
   * records and the ledger; nothing here is canonical, and approving is what
   * makes it so. Absent when no step of the attempt proposed knowledge.
   */
  knowledge?: KnowledgeDeltaPreview[];
  /** The counts for a discovery phase's candidates. Absent otherwise. */
  discovery?: DiscoverySummary;
  /**
   * The conformance results this attempt staged, one preview per step that
   * wrote a verification report (Phase 6). Nothing here is durable yet, and
   * each row shows the rule's own support beside the outcome so a reviewer
   * can see that a violated implementation leaves a supported rule supported.
   * Absent when no step of the attempt proposed a verification.
   */
  ruleVerifications?: RuleVerificationPreview[];
  /** The counts for a verification phase's results. Absent otherwise. */
  ruleVerification?: RuleVerificationSummary;
  /**
   * The change proposals this attempt staged, one preview per step that wrote
   * one (Phase 7). Nothing here is canonical: the requested change, the
   * current rules with their conformance, the proposed transition, what is
   * preserved, the acceptance criteria and what is still unresolved — so the
   * decision can be made without opening a transcript. Absent when no step of
   * the attempt proposed a change.
   */
  changeProposals?: ChangeProposalPreview[];
  /** The counts for a change-intent phase's proposal. Absent otherwise. */
  changeIntent?: ChangeIntentSummary;
  /**
   * The acceptance-verification results this attempt staged, one preview per
   * step that wrote one (Phase 8) — grouped by outcome, each row naming the
   * criterion and the exact revisions it is evidence for. Shown beside
   * `ruleVerifications` and never merged with them: a reviewer must be able to
   * see "every rule holds, and AC-3 is violated", which is not a complete
   * change.
   */
  acceptanceVerifications?: AcceptanceVerificationPreview[];
  /** The counts for an acceptance-verification phase's results. */
  acceptanceVerification?: AcceptanceVerificationSummary;
  /**
   * The change realization this phase attempt belongs to (Phase 8), so a
   * reviewer at a gate can see *which* accepted change is being realized and
   * *which attempt* they are looking at — a remediation's results are not the
   * first attempt's, and approving them is not the same decision.
   */
  realization?: PhaseRealizationRef;
  /** On a spawn phase: every task, its child and the child phase a person
   *  would act on. Absent on any other phase, and on a spawn phase whose task
   *  list was never built. */
  children?: PhaseChildrenReview;
}

/** One artifact's bytes, for the read-only viewer. */
export interface PhaseArtifactContent {
  path: string;
  bytes: number;
  modifiedAt: string;
  text: boolean;
  /** Present only when `text`. Clipped at the server's read cap. */
  content?: string;
  /** `content` is a head, not the whole file. */
  truncated: boolean;
}

/** The body of `POST /api/instances/:id/approve`. Every field optional — a
 *  bare POST stays a valid approval of the single paused phase. */
export interface ApproveRequest {
  /** What a person answered to a phase that asked (`needs-input`). Refused
   *  with 400 `answers-not-accepted` at a `children` pause. */
  answers?: unknown;
  /** Which paused phase to approve when more than one is waiting. */
  phaseId?: string;
}

/** The body of `POST /api/instances/:id/revise`. */
export interface ReviseRequest {
  /** The human's revision, handed to the agent when the phase runs again. */
  note?: string;
  /** Which paused phase to revise when more than one is waiting. */
  phaseId?: string;
}

/**
 * Why `POST /api/instances/:id/approve` or `/revise` was refused, for the
 * refusals a client acts on:
 * - `parent-decided` (409): the instance is a spawned child whose parent no
 *   longer waits for it (the parent ended, its spawn phase moved on, or a newer
 *   child replaced this one). Abort the child, or start a follow-up instead;
 * - `answers-not-accepted` (400): `answers` was sent to a spawn phase paused
 *   at `children`, which asked no question;
 * - `children-running` (409): approving a `children` pause while a child a
 *   person re-ran is live again, or its revise is still being applied. Wait
 *   for it, or abort it, then decide.
 */
export type GateActionRefusal = "parent-decided" | "answers-not-accepted" | "children-running";

/** The reply of approve, revise and abort. */
export interface GateActionReply {
  ok: boolean;
  /** Why it was refused, for a person. */
  error?: string;
  /** Why it was refused, for a client; set only for a {@link GateActionRefusal}. */
  code?: GateActionRefusal;
}
