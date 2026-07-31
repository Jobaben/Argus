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

import type { ActivityEvent, AgentRuntimeCapabilities, AgentRuntimeId } from "@argus/contracts";

/** The normalized result of a finished run, however the CLI reported it. */
export interface RunEnvelope {
  /** The agent's final message. */
  result: string | null;
  /** USD, when the runtime reports money. Null when it only reports tokens. */
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

/** Everything needed to start one run, with nothing runtime-specific left over. */
export interface SpawnPlan {
  bin: string;
  args: string[];
  /** Delivered on stdin. Never argv: a prompt is user-authored text. */
  stdin: string;
  /** Extra environment for the child, merged over `process.env` by the caller. */
  env: Record<string, string>;
}

export interface RunPlanOptions {
  prompt: string;
  /** Ignored by runtimes that assign their own. */
  sessionId?: string | null;
  model?: string | null;
  /**
   * Instructions that belong to Argus rather than the pipeline author (the
   * outcome contract). Passed as a system-prompt flag where the CLI has one and
   * prepended to the prompt where it doesn't — the run must behave the same
   * either way.
   */
  systemPrompt?: string;
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
  capabilities: AgentRuntimeCapabilities;
  /** The default analysis model for this runtime; empty = the CLI's own default. */
  defaultAnalysisModel(): string;
  /** One-shot batch run — the scheduler and the Launch tab. */
  batchPlan(opts: RunPlanOptions): SpawnPlan;
  /** Streaming run whose log is an NDJSON transcript — pipeline steps. */
  streamPlan(opts: RunPlanOptions): SpawnPlan;
  /** Bounded, tool-light pass whose stdout *is* the answer. */
  analysisPlan(opts: AnalysisPlanOptions): SpawnPlan;
  parseEnvelope(text: string): RunEnvelope;
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
