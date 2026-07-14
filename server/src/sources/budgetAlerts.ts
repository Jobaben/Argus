import type { BudgetState, BudgetStatus, BudgetWindow } from "./budget.js";

/**
 * Transition detection for budget alerting, mirroring the monitor alerts:
 * budget state is a pure derivation, so the watcher diffs one tick against the
 * previous. The first observation after boot is a silent baseline — restarting
 * Argus never replays an already-known breach.
 */

export type BudgetAlertEvent = "budget.warning" | "budget.exceeded" | "budget.cleared";

export interface BudgetAlert {
  event: BudgetAlertEvent;
  state: BudgetState;
  at: string;
  detail: string;
}

const SEVERITY: Record<BudgetState, number> = { unset: 0, ok: 0, warning: 1, exceeded: 2 };

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function windowDetail(label: string, w: BudgetWindow): string | null {
  if (w.ratio === null || w.limitUsd === null) return null;
  return `${label} ${usd(w.spentUsd)} of ${usd(w.limitUsd)}`;
}

function describe(status: BudgetStatus): string {
  const parts = [
    windowDetail("today", status.today),
    windowDetail("this month", status.month),
  ].filter((p): p is string => p !== null);
  return parts.join(" · ") || "no limits set";
}

/** The alert for a watched state change, or null when nothing alertable moved. */
export function detectBudgetAlert(
  prev: BudgetState | null,
  status: BudgetStatus,
  at: string,
): BudgetAlert | null {
  if (prev === null) return null;
  const next = status.state;
  if (SEVERITY[next] === SEVERITY[prev]) return null;
  if (next === "exceeded") {
    const suffix = status.blockScheduled ? " — scheduled runs are paused" : "";
    return { event: "budget.exceeded", state: next, at, detail: describe(status) + suffix };
  }
  if (next === "warning" && SEVERITY[prev] < SEVERITY.warning) {
    return { event: "budget.warning", state: next, at, detail: describe(status) };
  }
  if (SEVERITY[next] === 0 && SEVERITY[prev] > 0) {
    return { event: "budget.cleared", state: next, at, detail: describe(status) };
  }
  // exceeded → warning: still in a warned state, nothing new to page about.
  return null;
}
