export type AgentStatus =
  | "working"
  | "done"
  | "failed"
  | "idle"
  | "queued"
  | "unknown";

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
  live: boolean;
  pid: number | null;
}

export interface TimelineEntry {
  at: string;
  state?: AgentStatus;
  detail?: string;
  text?: string;
}
