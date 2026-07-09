import type { Agent, AgentStatus } from "../types";

/** The terminal states a completion/failure notification fires on. */
const TERMINAL: ReadonlySet<AgentStatus> = new Set<AgentStatus>(["done", "failed"]);

export interface TerminalEvent {
  short: string;
  name: string;
  status: "done" | "failed";
  /** Best-effort transition time for display; null when the agent carries none. */
  at: string | null;
}

/** Snapshot of the statuses we have already observed, keyed by agent short. */
export type StatusSnapshot = Map<string, AgentStatus>;

export function snapshotStatuses(agents: Agent[]): StatusSnapshot {
  const snap: StatusSnapshot = new Map();
  for (const a of agents) snap.set(a.short, a.status);
  return snap;
}

/**
 * Detect agents that have just entered a terminal state (done/failed) since the
 * previous snapshot. Pure so it can be asserted without a socket or the DOM —
 * mirrors the pure payload builders in the server's `notify.ts`.
 *
 * Baseline suppression: a null `prev` means "first observation" and yields
 * nothing, so opening the dashboard while agents are already finished does not
 * fire a storm of notifications. An agent first seen *already* terminal (not in
 * `prev`) is likewise skipped — only an observed transition notifies.
 */
export function detectTransitions(prev: StatusSnapshot | null, next: Agent[]): TerminalEvent[] {
  if (prev === null) return [];
  const events: TerminalEvent[] = [];
  for (const a of next) {
    if (!TERMINAL.has(a.status)) continue;
    const before = prev.get(a.short);
    if (before === undefined || before === a.status) continue;
    events.push({
      short: a.short,
      name: a.name,
      status: a.status as "done" | "failed",
      at: a.updatedAt ?? a.firstTerminalAt ?? null,
    });
  }
  return events;
}
