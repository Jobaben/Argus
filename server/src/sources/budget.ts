import { paths } from "../claudeHome.js";
import { atomicWriteJson } from "./atomicWrite.js";
import { readJson } from "./readJson.js";
import { LedgerValidationError, enforcementFor, validateLadder } from "./ledger.js";
import type { BudgetConfig, BudgetState, BudgetStatus, BudgetWindow } from "@argus/contracts";

/**
 * Spend guardrails: Argus fires `claude -p` agents unattended, i.e. it spends
 * money while nobody is watching. The budget is a daily/monthly USD ceiling
 * over the per-day spend ledger, with an optional hard stop that pauses
 * *scheduled* firings while the ceiling is breached. Manual actions (Run now,
 * Launch, pipeline starts) always stay available — a human clicking a button
 * is its own authorization.
 *
 * Two Argus-owned files: `budget.json` (the limits) and `spend.json` (the
 * ledger). The ledger is written at the same serialized choke point that folds
 * run cost into the all-time totals, so every costed run — scheduled, manual,
 * one-off, pipeline step — lands in it exactly once. Run records get pruned
 * (RUN_KEEP per bucket); the ledger is what makes "spent today / this month"
 * survive that.
 */

export const WARN_RATIO = 0.8;
export const LEDGER_KEEP_DAYS = 366;

export class BudgetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetValidationError";
  }
}

export type {
  BudgetConfig,
  BudgetDay,
  BudgetResponse,
  BudgetState,
  BudgetStatus,
  BudgetWindow,
} from "@argus/contracts";

/** One day of the on-disk spend ledger (`spend.json`); the served shape is
 *  `BudgetDay`, which carries the date as a field rather than a map key. */
export interface SpendDay {
  usd: number;
  tokens: number;
  runs: number;
}

export interface SpendLedger {
  days: Record<string, SpendDay>;
}

/** Local calendar date key (YYYY-MM-DD) — budgets follow the user's wall
 * clock, like schedule triggers do. */
export function dayKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const DEFAULT_CONFIG: BudgetConfig = {
  dailyUsd: null,
  monthlyUsd: null,
  blockScheduled: false,
  updatedAt: null,
};

function asLimit(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

export async function readBudgetConfig(): Promise<BudgetConfig> {
  const raw = await readJson<Partial<BudgetConfig> | null>(paths.budgetFile(), null);
  if (!raw || typeof raw !== "object") return { ...DEFAULT_CONFIG };
  // A corrupt ladder on disk degrades to "no ladder" rather than failing every
  // read; the PUT path is where a bad one is rejected loudly.
  const ladder = safeLadder(raw.ladder);
  return {
    dailyUsd: asLimit(raw.dailyUsd),
    monthlyUsd: asLimit(raw.monthlyUsd),
    blockScheduled: raw.blockScheduled === true,
    ...(ladder ? { ladder } : {}),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
  };
}

/** Validates a PUT body: limits are positive numbers or null (= no limit). */
function safeLadder(raw: unknown) {
  try {
    return validateLadder(raw);
  } catch {
    return undefined;
  }
}

export function validateBudgetPatch(raw: unknown): Partial<BudgetConfig> {
  if (!raw || typeof raw !== "object") throw new BudgetValidationError("body required");
  const r = raw as Record<string, unknown>;
  const patch: Partial<BudgetConfig> = {};
  for (const key of ["dailyUsd", "monthlyUsd"] as const) {
    if (!(key in r)) continue;
    const v = r[key];
    if (v === null) {
      patch[key] = null;
    } else if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      patch[key] = v;
    } else {
      throw new BudgetValidationError(`${key} must be a positive number or null`);
    }
  }
  if ("blockScheduled" in r) {
    if (typeof r.blockScheduled !== "boolean") {
      throw new BudgetValidationError("blockScheduled must be a boolean");
    }
    patch.blockScheduled = r.blockScheduled;
  }
  if ("ladder" in r) {
    try {
      patch.ladder = validateLadder(r.ladder) ?? [];
    } catch (e) {
      throw new BudgetValidationError(e instanceof LedgerValidationError ? e.message : String(e));
    }
  }
  return patch;
}

export async function updateBudgetConfig(
  patch: Partial<BudgetConfig>,
  now: Date,
): Promise<BudgetConfig> {
  const current = await readBudgetConfig();
  const next: BudgetConfig = {
    ...current,
    ...patch,
    updatedAt: now.toISOString(),
  };
  await atomicWriteJson(paths.budgetFile(), next);
  return next;
}

export async function readSpendLedger(): Promise<SpendLedger> {
  const raw = await readJson<Partial<SpendLedger> | null>(paths.spendFile(), null);
  const days: Record<string, SpendDay> = {};
  if (raw && typeof raw === "object" && raw.days && typeof raw.days === "object") {
    for (const [key, val] of Object.entries(raw.days)) {
      const v = val as Partial<SpendDay>;
      days[key] = {
        usd: typeof v.usd === "number" && Number.isFinite(v.usd) ? v.usd : 0,
        tokens: typeof v.tokens === "number" && Number.isFinite(v.tokens) ? v.tokens : 0,
        runs: typeof v.runs === "number" && Number.isFinite(v.runs) ? v.runs : 0,
      };
    }
  }
  return { days };
}

/**
 * Fold one completed run's reported spend into the day bucket it ended in.
 * Called only from the totals accumulation chain, which is serialized and
 * gated by `countedInTotals`, so the read-modify-write here is single-flight
 * and exactly-once per run.
 */
export async function recordRunSpend(
  run: {
    endedAt: string | null;
    queuedAt: string;
    costUsd?: number | null;
    tokens?: number | null;
  },
  now: () => Date = () => new Date(),
): Promise<void> {
  const usd = typeof run.costUsd === "number" ? run.costUsd : 0;
  const tokens = typeof run.tokens === "number" ? run.tokens : 0;
  if (usd === 0 && tokens === 0) return;

  const endedAt = run.endedAt ? new Date(run.endedAt) : now();
  const key = dayKey(Number.isNaN(endedAt.getTime()) ? now() : endedAt);

  const ledger = await readSpendLedger();
  const day = ledger.days[key] ?? { usd: 0, tokens: 0, runs: 0 };
  ledger.days[key] = { usd: day.usd + usd, tokens: day.tokens + tokens, runs: day.runs + 1 };

  // Prune: keep the newest LEDGER_KEEP_DAYS day-keys (keys sort chronologically).
  const keys = Object.keys(ledger.days).sort();
  for (const stale of keys.slice(0, Math.max(0, keys.length - LEDGER_KEEP_DAYS))) {
    delete ledger.days[stale];
  }
  await atomicWriteJson(paths.spendFile(), ledger);
}

function windowStatus(spentUsd: number, limitUsd: number | null): BudgetWindow {
  return {
    spentUsd,
    limitUsd,
    ratio: limitUsd != null && limitUsd > 0 ? spentUsd / limitUsd : null,
  };
}

function stateOf(...windows: BudgetWindow[]): BudgetState {
  const ratios = windows.map((w) => w.ratio).filter((r): r is number => r !== null);
  if (ratios.length === 0) return "unset";
  const worst = Math.max(...ratios);
  if (worst >= 1) return "exceeded";
  if (worst >= WARN_RATIO) return "warning";
  return "ok";
}

export function buildBudgetStatus(
  config: BudgetConfig,
  ledger: SpendLedger,
  now: Date,
): BudgetStatus {
  const today = dayKey(now);
  const month = today.slice(0, 7);
  const todaySpend = ledger.days[today]?.usd ?? 0;
  let monthSpend = 0;
  for (const [key, day] of Object.entries(ledger.days)) {
    if (key.startsWith(month)) monthSpend += day.usd;
  }
  const todayWindow = windowStatus(todaySpend, config.dailyUsd);
  const monthWindow = windowStatus(monthSpend, config.monthlyUsd);
  return {
    state: stateOf(todayWindow, monthWindow),
    today: todayWindow,
    month: monthWindow,
    blockScheduled: config.blockScheduled,
  };
}

/** The last `n` local days (oldest first), zero-filled — chart-ready. */
export function recentDays(
  ledger: SpendLedger,
  now: Date,
  n: number,
): ({ date: string } & SpendDay)[] {
  const out: ({ date: string } & SpendDay)[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = dayKey(d);
    const day = ledger.days[key] ?? { usd: 0, tokens: 0, runs: 0 };
    out.push({ date: key, ...day });
  }
  return out;
}

/** True when the hard stop should hold back scheduled firings right now. */
export async function isSpendBlocked(now: Date): Promise<boolean> {
  const config = await readBudgetConfig();
  if (config.dailyUsd == null && config.monthlyUsd == null) return false;
  const ledger = await readSpendLedger();
  const status = buildBudgetStatus(config, ledger, now);
  // The ladder *adds* steps below the cliff; it never removes the cliff. Either
  // authority can stop a firing:
  //
  //   - the ladder's own `stop` step, which can sit above or below 1.0, and
  //   - the original `blockScheduled`, which stops everything once a limit is
  //     exceeded.
  //
  // Letting the ladder replace `blockScheduled` was the tempting reading, and
  // it is wrong: adding a warn-only ladder would then silently disarm a hard
  // stop the user had explicitly asked for. A new feature must not weaken an
  // existing safety setting by being configured at all.
  if (enforcementFor(config.ladder, status).action === "stop") return true;
  if (!config.blockScheduled) return false;
  return status.state === "exceeded";
}

/**
 * The graduated action in force right now.
 *
 * Read once per scheduler tick; every schedule due in that tick gets the same
 * verdict, which is both cheaper and more coherent than re-reading the ledger
 * between two firings a millisecond apart.
 */
export async function currentEnforcement(now: Date) {
  const config = await readBudgetConfig();
  const ledger = await readSpendLedger();
  return enforcementFor(config.ladder, buildBudgetStatus(config, ledger, now));
}
