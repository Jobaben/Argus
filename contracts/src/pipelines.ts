/** Pipeline definitions, running instances, and the board overview. */

import type { AgentRuntimeId, ReasoningEffort } from "./runtimes.js";
import type { Trigger } from "./schedules.js";
import type { AutoApprove, Rubric } from "./verdict.js";
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
   * ImplementationScope, its RemediationContext — no longer hashes to what
   * Argus recorded at launch (Phase 8). The exact counterpart of
   * `knowledge-context-integrity`, and it asks the same question: *did the
   * bytes supplied to this invocation change?*, never *is this still the
   * newest proposal?* Accepted intent is immutable, so a newer proposal is
   * never tampering. The completion is refused and nothing the run proposed
   * becomes durable. Not retried by default.
   */
  | "change-context-integrity"
  /**
   * The run emitted an acceptance-verification proposal Argus refused:
   * malformed, a criterion the accepted proposal does not declare, a required
   * criterion left without an outcome, an outcome with no evidence, a check
   * reference naming no check of this phase, or a report written against a
   * different accepted change (Phase 8). Not retried by default.
   */
  | "acceptance-verification";

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
   * RemediationContext.
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
  /**
   * Every Argus-owned channel this invocation was offered, with the access it
   * needs and whether the runtime could honour it. A channel `unavailable`
   * here also appears in `limitations`. Absent on records written before the
   * channel model existed.
   */
  channels?: InvocationChannelRecord[];
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
  /** Default isolation policy for every phase that does not declare one.
   *  Absent = no isolation: every phase runs in its own `cwd`. */
  workspace?: WorkspacePolicy;
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
  workspace?: WorkspacePolicy;
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
   *  fired by an `after` trigger once a source pipeline instance ended. */
  trigger: "manual" | "scheduled" | "webhook" | "chained";
  /**
   * The firing payload, when the trigger carried one: the webhook's JSON body
   * (capped at 64 KiB; a larger body is rejected with 413 before an instance
   * is created) for `trigger: "webhook"`, or
   * `{ sourceInstanceId, sourcePipelineId, status }` for `trigger: "chained"`.
   * Absent for `"manual"`/`"scheduled"`.
   */
  triggerPayload?: unknown;
  /** `trigger: "chained"` only: the source instance this one was fired from. */
  chainedFrom?: string;
  signalToken: string;
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
