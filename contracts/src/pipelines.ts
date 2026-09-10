/** Pipeline definitions, running instances, and the board overview. */

import type { AgentRuntimeId, ReasoningEffort } from "./runtimes.js";
import type { Trigger } from "./schedules.js";
import type { AutoApprove, Rubric } from "./verdict.js";

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
  /** Narrows or replaces the phase's capability profile for this one step. */
  capabilities?: CapabilityProfile;
}

/**
 * Which observable failures are worth another attempt.
 *
 * Deliberately not "any": an agent that *signalled* failure has considered the
 * work and reported on it, and running the same prompt again is unlikely to
 * change its mind — while a process that never started, or died on a non-zero
 * exit, plausibly hit something transient.
 */
export type RetryableClass = "spawn" | "exit-code" | "signal" | "timeout" | "verification";

/**
 * Every way a phase can fail. The retryable classes are the subset an author
 * may name in `retry.retryOn`; `configuration` (an invocation Argus could not
 * construct as declared — e.g. a capability the runtime cannot enforce under
 * strict enforcement) is never retried, because running it again cannot help.
 */
export type PhaseFailureClass = RetryableClass | "configuration";

export interface RetryPolicy {
  /** Total attempts including the first. 1 means no retry. */
  attempts: number;
  /** Delay before the first retry. Doubles each subsequent attempt. */
  backoffSeconds: number;
  /** Defaults to `["spawn", "exit-code"]` — the transient-looking ones. */
  retryOn?: RetryableClass[];
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
    };

export interface CheckResult {
  kind: PhaseCheck["kind"];
  label: string;
  status: "passed" | "failed";
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
  resultFile: string | null;
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
  /** Overrides the pipeline's runtime for every step in this phase. */
  runtime?: AgentRuntimeId;
  /** Wall-clock limit for each step's process. Absent = no limit. */
  timeoutSeconds?: number;
  /** What this phase's agents may do. Absent = the pipeline's profile, else the CLI's defaults. */
  capabilities?: CapabilityProfile;
  /** Deterministic checks that must pass before the phase counts as succeeded. */
  checks?: PhaseCheck[];
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
  /** Free-form: a gated phase carries whatever its agent signalled, a failed
   *  phase carries a {@link PhaseFailurePayload}. Narrow before reading. */
  payload: unknown | null;
  /** Validated structured outcome, intentionally separate from legacy payloads. */
  result?: unknown;
  /** Argus's own checks over the phase's work, once every step has reported. */
  verification?: VerificationReport;
  /** Where this attempt's steps were told to leave file artifacts. */
  artifactDir?: string | null;
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
  trigger: "manual" | "scheduled";
  signalToken: string;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
  /** Named payloads published by completed phases, for `{{artifacts.<name>}}`. */
  artifacts?: Record<string, unknown>;
  /** Immutable records for phase outcomes that selected conditional routes. */
  routeDecisions?: RouteDecision[];
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
}
