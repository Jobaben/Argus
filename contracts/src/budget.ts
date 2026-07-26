/** Spend guardrails: configured limits, current status, daily ledger. */

export interface BudgetConfig {
  /** USD ceiling per local calendar day; null = no daily limit. */
  dailyUsd: number | null;
  /** USD ceiling per local calendar month; null = no monthly limit. */
  monthlyUsd: number | null;
  /** When true, scheduled firings are skipped while a limit is exceeded. */
  blockScheduled: boolean;
  updatedAt: string | null;
}

export type BudgetState = "unset" | "ok" | "warning" | "exceeded";

export interface BudgetWindow {
  spentUsd: number;
  limitUsd: number | null;
  /** spent/limit, null when no limit is set. */
  ratio: number | null;
}

export interface BudgetStatus {
  state: BudgetState;
  today: BudgetWindow;
  month: BudgetWindow;
  blockScheduled: boolean;
}

/** One local calendar day of the spend ledger. */
export interface BudgetDay {
  date: string;
  usd: number;
  tokens: number;
  runs: number;
}

export interface BudgetResponse {
  config: BudgetConfig;
  status: BudgetStatus;
  days: BudgetDay[];
}
