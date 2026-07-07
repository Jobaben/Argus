import type { AgentStatus, RunStatus } from "../types";

export type DsStatus = "working" | "done" | "failed" | "queued" | "idle" | "await" | "stopped";

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
    case "running":
      return "working";
    case "succeeded":
      return "done";
    case "failed":
      return "failed";
    case "skipped":
      return "idle";
    case "interrupted":
      return "idle";
    case "cancelled":
      return "idle";
  }
}

/** DS status for a run row, preferring a failing work-outcome over the
 *  exit-code-derived status so a run that exited 0 but signalled failure
 *  reads as failed — matching its phase. */
export function runDsStatus(run: {
  status: RunStatus;
  outcome?: "succeeded" | "failed" | "blocked" | null;
}): DsStatus {
  if (run.outcome === "failed" || run.outcome === "blocked") return "failed";
  return runStatusToDsStatus(run.status);
}
