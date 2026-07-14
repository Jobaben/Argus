import {
  buildBudgetStatus,
  readBudgetConfig,
  readSpendLedger,
  type BudgetState,
} from "./sources/budget.js";
import { detectBudgetAlert, type BudgetAlert } from "./sources/budgetAlerts.js";

export interface BudgetWatcherDeps {
  now: () => Date;
  onAlert: (alert: BudgetAlert) => void;
}

/**
 * Re-derives the budget state on every scheduler tick and surfaces
 * warning/exceeded/cleared transitions to `onAlert` (webhook + WebSocket in
 * production wiring). First check after boot is a silent baseline; a failing
 * `onAlert` must never wedge the tick.
 */
export function createBudgetWatcher(deps: BudgetWatcherDeps): { check: () => Promise<void> } {
  let prev: BudgetState | null = null;

  return {
    async check(): Promise<void> {
      try {
        const now = deps.now();
        const [config, ledger] = await Promise.all([readBudgetConfig(), readSpendLedger()]);
        const status = buildBudgetStatus(config, ledger, now);
        const alert = detectBudgetAlert(prev, status, now.toISOString());
        prev = status.state;
        if (alert) {
          try {
            deps.onAlert(alert);
          } catch (e) {
            console.error("[argus] budget alert handler failed:", e);
          }
        }
      } catch (e) {
        console.error("[argus] budget check failed:", e);
      }
    },
  };
}
