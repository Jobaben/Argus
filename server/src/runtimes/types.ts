/**
 * The seam between Argus and whichever agent CLI is doing the work.
 *
 * Four call sites spawn an agent — the scheduler's batch run, the pipeline
 * engine's streaming step, the bounded analysis pass, and the setup probe — and
 * every one of them used to spell `claude` and its flags out inline. Adding a
 * second CLI that way would have meant four sets of branches, each of which
 * could drift, plus a fifth for the log parser and a sixth for the tailer.
 *
 * Instead each runtime answers the same small set of questions:
 *
 *   * **How do I invoke you?** — a {@link SpawnPlan}: binary, argv, the text to
 *     put on stdin (never argv, so no shell parses a user's prompt), and any
 *     env the CLI needs. Three flavours, because a batch run, a live-tailed
 *     step and a bounded analysis pass want different output formats.
 *   * **What did you say?** — {@link AgentRuntime.parseEnvelope} turns whatever
 *     the CLI printed into the one shape the run record stores.
 *   * **What are you doing right now?** — {@link AgentRuntime.deriveActivity}
 *     turns one line of the streaming log into Command Center activity.
 *   * **What can't you do?** — capabilities, so a gap is reported rather than
 *     silently producing a null the UI can't explain.
 */

import type {
  ActivityEvent,
  AgentRuntimeCapabilities,
  AgentRuntimeId,
  CapabilityProfile,
  ReasoningEffort,
} from "@argus/contracts";

/** The normalized result of a finished run, however the CLI reported it. */
export interface RunEnvelope {
  /** The agent's final message. */
  result: string | null;
  /** Reported USD, or a token-price estimate when enough usage detail exists. */
  costUsd: number | null;
  /** Input + output tokens. */
  tokens: number | null;
  /** The CLI's own verdict, when it states one. Null = it didn't say. */
  isError: boolean | null;
  /**
   * The session/thread id the CLI assigned itself.
   *
   * Only runtimes without {@link AgentRuntimeCapabilities.presetSessionId} fill
   * this in: Argus can't tell them which id to use, so it learns the id back
   * out of the transcript and patches the run record, which is what keeps the
   * "open this run's transcript" link working.
   */
  sessionId: string | null;
}

/** A file the engine must write before spawning; paths are absolute, inside
 *  `CapabilityRequest.invocationDir`. */
export interface MaterializedFile {
  path: string;
  contents: string;
}

export interface CapabilityRequest {
  profile: CapabilityProfile;
  /** Per-invocation directory Argus created for config files (absolute, exists). */
  invocationDir: string;
  /** The run's working directory (absolute). */
  cwd: string;
  /** Where the agent may write artifacts (absolute), or null. Must remain
   *  writable even under `filesystem: "read-only"`. */
  artifactDir: string | null;
  /**
   * Shell command lines for Argus's own completion hooks, so a runtime that can
   * carry hooks per invocation can register them itself instead of relying on
   * the operator's global config. `stop` fires when the agent finishes; `gate`
   * fires before the agent asks the user a question (Claude Code's
   * AskUserQuestion).
   */
  hooks?: { stop: string; gate: string };
}

/** Everything needed to start one run, with nothing runtime-specific left over. */
export interface SpawnPlan {
  bin: string;
  args: string[];
  /** Delivered on stdin. Never argv: a prompt is user-authored text. */
  stdin: string;
  /** Extra environment for the child, merged over `process.env` by the caller. */
  env: Record<string, string>;
  /** Files to write before spawning (invocation-specific config). Absent/empty
   *  when no capabilities were requested. */
  files?: MaterializedFile[];
  /** Declared capabilities this runtime could not enforce (human-readable, one
   *  per item). Empty when fully enforced. */
  limitations?: string[];
}

export interface RunPlanOptions {
  prompt: string;
  /** Ignored by runtimes that assign their own. */
  sessionId?: string | null;
  model?: string | null;
  /** Codex-only inline configuration override. */
  reasoningEffort?: ReasoningEffort | null;
  /**
   * Instructions that belong to Argus rather than the pipeline author (the
   * outcome contract). Passed as a system-prompt flag where the CLI has one and
   * prepended to the prompt where it doesn't — the run must behave the same
   * either way.
   */
  systemPrompt?: string;
  /** The capability profile for this invocation, when the phase declares one. */
  capabilities?: CapabilityRequest;
}

export interface AnalysisPlanOptions {
  prompt: string;
  /** Empty string means "let the CLI use its configured default". */
  model?: string | null;
}

export interface AgentRuntime {
  id: AgentRuntimeId;
  label: string;
  /** The executable, honouring any `ARGUS_*_BIN` override. */
  bin(): string;
  /** Args used to probe the CLI's presence. */
  versionArgs: string[];
  /** Where this runtime keeps the state Argus reads. */
  home(): string;
  /** Model aliases worth offering in a picker. Empty = free-text only. */
  models(): string[];
  /** Supported per-run reasoning overrides. Empty for runtimes without one. */
  reasoningEfforts(): ReasoningEffort[];
  capabilities: AgentRuntimeCapabilities;
  /** The default analysis model for this runtime; empty = the CLI's own default. */
  defaultAnalysisModel(): string;
  /**
   * Whether a terminal run's own final message may stand in for a completion
   * signal that never arrived.
   *
   * The `ARGUS_OUTCOME` marker is written by the agent either way; this decides
   * whether the pipeline engine is allowed to *read it off the run record* when
   * reconciling a phase whose run has ended without signalling. For a runtime
   * with no command hook to register it is the completion protocol; for one
   * whose hook Argus installs it would only second-guess a signal that already
   * arrived, and a hook that failed to fire should surface as a failure rather
   * than be quietly papered over.
   */
  outcomeFromRecord: boolean;
  /** One-shot batch run — the scheduler and the Launch tab. */
  batchPlan(opts: RunPlanOptions): SpawnPlan;
  /** Streaming run whose log is an NDJSON transcript — pipeline steps. */
  streamPlan(opts: RunPlanOptions): SpawnPlan;
  /** Bounded, tool-light pass whose stdout *is* the answer. */
  analysisPlan(opts: AnalysisPlanOptions): SpawnPlan;
  parseEnvelope(text: string, context?: { model?: string | null }): RunEnvelope;
  /** Zero or more Command Center events for one line of the streaming log. */
  deriveActivity(line: string, at: string): ActivityEvent[];
}

export const EMPTY_ENVELOPE: RunEnvelope = {
  result: null,
  costUsd: null,
  tokens: null,
  isError: null,
  sessionId: null,
};

const LABEL_MAX = 80;

/** One-line, length-capped label text. Shared by both runtimes' derivations. */
export function clip(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > LABEL_MAX ? `${t.slice(0, LABEL_MAX - 1)}…` : t;
}

export function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/** Splits an `ARGUS_*_ARGS` escape hatch into argv, honouring simple quoting. */
export function extraArgs(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return [];
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/**
 * The `CapabilityProfile` keys a runtime maps onto its own invocation, in a
 * fixed order so a runtime's limitations list is deterministic. `env` and
 * `enforcement` are excluded: both are engine-owned (the engine applies the
 * env policy itself and decides strict vs. best-effort), never a runtime's to
 * enforce or report on.
 */
const PROFILE_KEYS: (keyof CapabilityProfile)[] = [
  "filesystem",
  "tools",
  "mcpServers",
  "additionalDirectories",
  "settingSources",
  "permissionMode",
  "maxTurns",
];

/**
 * One limitation string for every key present in `profile` (mcpServers counts
 * as present even when it is `{}`) that isn't in `supported` — phrased
 * `${runtimeLabel} cannot enforce "${key}" for this invocation` so a gap is
 * reported rather than silently producing a null the UI can't explain.
 */
export function unsupportedCapabilities(
  profile: CapabilityProfile,
  runtimeLabel: string,
  supported: (keyof CapabilityProfile)[],
): string[] {
  const supportedSet = new Set(supported);
  const out: string[] = [];
  for (const key of PROFILE_KEYS) {
    if (profile[key] === undefined) continue;
    if (supportedSet.has(key)) continue;
    out.push(`${runtimeLabel} cannot enforce "${key}" for this invocation`);
  }
  return out;
}
