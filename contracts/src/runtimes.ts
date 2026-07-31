/**
 * Agent runtimes — which CLI actually executes a run.
 *
 * Argus was built around `claude -p`. Codex is a second, equally capable
 * headless agent CLI, and the two differ in ways that are visible all the way
 * up to the dashboard: Codex assigns its own thread id rather than accepting
 * one, reports tokens but not dollars, and has no per-invocation
 * system-prompt flag. Rather than let those differences leak into the engine as
 * `if (codex)` branches, every one of them is declared here as a capability and
 * answered by the runtime implementation on the server.
 *
 * The id is persisted on schedules, pipelines, phases, steps and run records,
 * so a run remains explicable long after the default has changed: "which agent
 * produced this" is answered by the record, not by today's configuration.
 */

/** Which agent CLI executes a run. Absent anywhere = `"claude"`. */
export type AgentRuntimeId = "claude" | "codex";

/** What a runtime can and cannot do, so the UI explains gaps instead of hiding them. */
export interface AgentRuntimeCapabilities {
  /** Accepts a caller-chosen session id, so the transcript link is known before the run starts. */
  presetSessionId: boolean;
  /** Has a per-invocation system-prompt flag (otherwise the contract is prepended to the prompt). */
  appendSystemPrompt: boolean;
  /** Reports a USD cost in its result envelope. */
  reportsCost: boolean;
  /** Reports token counts in its result envelope. */
  reportsTokens: boolean;
  /** Supports the Stop hook Argus installs to signal pipeline outcomes. */
  signalHook: boolean;
  /** Emits a streaming NDJSON transcript the Command Center can follow live. */
  liveActivity: boolean;
  /** Writes transcripts Argus can read back into the Sessions view. */
  transcripts: boolean;
}

/** One installed (or missing) runtime, as reported by `GET /api/runtimes`. */
export interface AgentRuntimeInfo {
  id: AgentRuntimeId;
  label: string;
  /** Executable Argus spawns for this runtime. */
  bin: string;
  /** Directory Argus reads this runtime's state from. */
  home: string;
  /** Whether the CLI answered a version probe. */
  available: boolean;
  /** Why it isn't available, when it isn't. */
  detail?: string;
  /** True for the process-wide default (`ARGUS_AGENT`). */
  isDefault: boolean;
  /** Model aliases worth offering in a picker. Empty = free-text only. */
  models: string[];
  capabilities: AgentRuntimeCapabilities;
}

export interface RuntimesResponse {
  /** The id used when nothing names one. */
  default: AgentRuntimeId;
  runtimes: AgentRuntimeInfo[];
}
