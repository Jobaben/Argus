import type {
  AttemptRecord,
  CensusRecord,
  ConfigRecord,
  ExpiredRecord,
  LedgerView,
  ResultClass,
  ResultRecord,
  StartRecord,
} from "./ledger.js";

/**
 * One reading of the collection ledger, shared by the watcher and the report
 * so that "pending", "spent" and "terminal" mean the same thing to both
 * (RFC §P.4, §P.5).
 */

/** Classes whose provider call happened, or may have happened. They count against the limits. */
export const SPENT: ReadonlySet<ResultClass> = new Set<ResultClass>([
  "answered",
  "abstained",
  "provider-failed",
  "unrecorded",
  "unknown-outcome",
]);

/** Classes that close an item: it is never attempted again automatically. */
export const TERMINAL: ReadonlySet<ResultClass> = new Set<ResultClass>([
  ...SPENT,
  "construction-error",
]);

export const itemKey = (runId: string, q: { id: string; version: number }) =>
  `${runId}|${q.id}@${q.version}`;

export interface AttemptEntry {
  attempt: AttemptRecord;
  line: number;
  result: ResultRecord | null;
}

export interface Item {
  key: string;
  runId: string;
  question: { id: string; version: number };
  census: CensusRecord;
  attempts: AttemptEntry[];
  expired: ExpiredRecord | null;
}

export type ItemStatus = "pending" | "terminal" | "expired" | "abandoned";

export interface LedgerIndex {
  start: StartRecord | null;
  configs: ConfigRecord[];
  /** Every census line, by item key (the first one wins). */
  census: Map<string, CensusRecord>;
  attempts: AttemptEntry[];
  items: Map<string, Item>;
  /** Attempts naming an item that has no census line. */
  strayAttempts: AttemptEntry[];
}

export function indexLedger(view: LedgerView): LedgerIndex {
  const idx: LedgerIndex = {
    start: null,
    configs: [],
    census: new Map(),
    attempts: [],
    items: new Map(),
    strayAttempts: [],
  };
  const byAttempt = new Map<string, AttemptEntry>();
  const expired = new Map<string, ExpiredRecord>();
  for (const { line, record } of view.records) {
    switch (record.kind) {
      case "start":
        idx.start ??= record;
        break;
      case "config":
        idx.configs.push(record);
        break;
      case "census": {
        const key = itemKey(record.runId, record.question);
        if (!idx.census.has(key)) idx.census.set(key, record);
        break;
      }
      case "attempt": {
        const entry = { attempt: record, line, result: null };
        idx.attempts.push(entry);
        byAttempt.set(record.attemptId, entry);
        break;
      }
      case "result": {
        const entry = byAttempt.get(record.attemptId);
        if (entry && !entry.result) entry.result = record;
        break;
      }
      case "expired": {
        const key = itemKey(record.runId, record.question);
        if (!expired.has(key)) expired.set(key, record);
        break;
      }
    }
  }
  for (const [key, census] of idx.census) {
    if (census.verdict !== "selected") continue;
    idx.items.set(key, {
      key,
      runId: census.runId,
      question: { id: census.question.id, version: census.question.version },
      census,
      attempts: [],
      expired: expired.get(key) ?? null,
    });
  }
  for (const entry of idx.attempts) {
    const item = idx.items.get(itemKey(entry.attempt.runId, entry.attempt.question));
    if (item) item.attempts.push(entry);
    else idx.strayAttempts.push(entry);
  }
  return idx;
}

/** An attempt with no result is treated as spent until it is reconciled: its call may have happened. */
export const isSpent = (e: AttemptEntry) => e.result === null || SPENT.has(e.result.class);

export function itemStatus(item: Item, maxTries: number): ItemStatus {
  if (item.attempts.some((e) => e.result === null || TERMINAL.has(e.result.class))) {
    return "terminal";
  }
  if (item.expired) return "expired";
  if (item.attempts.length >= maxTries) return "abandoned";
  return "pending";
}

export const configByDigest = (idx: LedgerIndex, digest: string) =>
  idx.configs.find((c) => c.digest === digest) ?? null;

export const latestConfig = (idx: LedgerIndex) => idx.configs[idx.configs.length - 1] ?? null;
