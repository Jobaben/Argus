/** Background agents, their timelines, and the daemon roster snapshot. */

/**
 * The lifecycle state of a background job.
 *
 * Claude Code owns the `state` string inside `jobs/<short>/state.json`, so this
 * union is what Argus *guarantees to serve*, not a transcription of a foreign
 * enum: the server normalizes anything it does not recognise to `"unknown"`
 * (see `normalizeAgentStatus`). That keeps every client's exhaustive switch
 * provably total, instead of a value from a newer CLI silently falling through
 * every arm.
 */
export type AgentStatus = "working" | "done" | "failed" | "idle" | "queued" | "stopped" | "unknown";

/** A live worker as reported by `daemon/roster.json`. */
export interface DaemonWorker {
  pid?: number;
  sessionId?: string;
  cliVersion?: string;
  startedAt?: number;
  attempt?: number;
  cwd?: string;
}

/** The unified agent record Argus exposes to the UI. */
export interface Agent {
  short: string;
  sessionId: string | null;
  name: string;
  status: AgentStatus;
  tempo: string | null;
  detail: string | null;
  result: string | null;
  template: string | null;
  cwd: string | null;
  cliVersion: string | null;
  inFlight: { tasks: number; queued: number; kinds: string[] } | null;
  createdAt: string | null;
  updatedAt: string | null;
  firstTerminalAt: string | null;
  /** True when this job is currently present in the daemon roster. */
  live: boolean;
  pid: number | null;
}

/** One entry in `jobs/<short>/timeline.jsonl`. */
export interface TimelineEntry {
  at: string;
  state?: AgentStatus;
  detail?: string;
  text?: string;
}

export interface DaemonSnapshot {
  supervisorPid: number | null;
  updatedAt: number | null;
  workers: Record<string, DaemonWorker>;
}

/** One parsed line of a run's streamed JSON log, as surfaced by the tailer. */
export interface ActivityEvent {
  /** Arrival timestamp, stamped when Argus read the line (events carry none). */
  at: string;
  kind: "init" | "tool" | "text" | "done";
  label: string;
}
