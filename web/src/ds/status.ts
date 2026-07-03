import type { AgentStatus, RunStatus } from "../types";

export type DsStatus =
  | "working"
  | "done"
  | "failed"
  | "queued"
  | "idle"
  | "await"
  | "stopped";

export type ColorToken = "run" | "ok" | "fail" | "queue" | "idle" | "await";

export interface StatusToken {
  /** Tailwind color token name (text-<token>, bg-<token>, etc.). */
  token: ColorToken;
  /** Human-facing label. */
  label: string;
  /** Whether this status emits a glow on rails/badges. */
  glow: boolean;
}

export const STATUS: Record<DsStatus, StatusToken> = {
  working: { token: "run", label: "Working", glow: true },
  done: { token: "ok", label: "Done", glow: false },
  failed: { token: "fail", label: "Failed", glow: true },
  queued: { token: "queue", label: "Queued", glow: false },
  idle: { token: "idle", label: "Idle", glow: false },
  await: { token: "await", label: "Needs approval", glow: true },
  stopped: { token: "idle", label: "Stopped", glow: false },
};

export function toDsStatus(s: AgentStatus): DsStatus {
  switch (s) {
    case "working":
    case "done":
    case "failed":
    case "queued":
    case "idle":
      return s;
    case "stopped":
    case "unknown":
      return "idle";
  }
}

export function runStatusToDsStatus(s: RunStatus): DsStatus {
  switch (s) {
    case "running":     return "working";
    case "succeeded":   return "done";
    case "failed":      return "failed";
    case "skipped":     return "idle";
    case "interrupted": return "idle";
  }
}
