export type AgentStatus =
  | "working"
  | "done"
  | "failed"
  | "idle"
  | "queued"
  | "unknown";

/** A background job's persisted state (`jobs/<short>/state.json`). */
export interface JobState {
  state?: AgentStatus;
  detail?: string;
  tempo?: string;
  name?: string;
  nameSource?: string;
  inFlight?: { tasks?: number; queued?: number; kinds?: string[] };
  output?: { result?: string };
  template?: string;
  sessionId?: string;
  daemonShort?: string;
  cliVersion?: string;
  cwd?: string;
  createdAt?: string;
  updatedAt?: string;
  firstTerminalAt?: string;
  backend?: string;
}

/** One entry in `jobs/<short>/timeline.jsonl`. */
export interface TimelineEntry {
  at: string;
  state?: AgentStatus;
  detail?: string;
  text?: string;
}

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
