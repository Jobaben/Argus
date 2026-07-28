import { statSync } from "node:fs";
import type {
  VaultQuarter,
  VaultQuartersReport,
  VaultSearchHit,
  VaultSearchResponse,
  VaultStatus,
} from "@argus/contracts";
import { openFailure, openVault, vaultDisabled, type VaultDb } from "./db.js";
import { lastIngestAt } from "./ingest.js";

/**
 * Reading the Vault.
 *
 * Every function here answers with an `available` flag and a `detail` sentence
 * rather than throwing, because the caller's job is to render a degraded view,
 * not to handle an exception. A missing Vault is an ordinary state of the
 * system, not an error in it.
 */

const SEARCH_LIMIT = 60;
const RELATED_TERMS = 5;
/** Documents scanned when mining related terms. Bounded so a common word
 *  cannot turn one search into a full-table read. */
const RELATED_SAMPLE = 40;

const UNAVAILABLE_ROWS = { runs: 0, events: 0, spendDays: 0, scores: 0 };

function unavailable(): { reason: VaultStatus["reason"]; detail: string } {
  const failure = openFailure();
  if (failure) return failure;
  if (vaultDisabled()) return { reason: "disabled", detail: "the Vault is off (ARGUS_VAULT=off)" };
  return { reason: "open-failed", detail: "the Vault could not be opened" };
}

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0)) || 0;
const str = (v: unknown): string | null => (v == null ? null : String(v));

function count(db: VaultDb, table: string): number {
  return num(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n);
}

/**
 * How many runs the Vault holds that the JSON files no longer do.
 *
 * Reported rather than implied, because it is the only number that says
 * whether the feature is earning its keep on *this* machine. Computed by
 * counting the overlap in chunks — a thousand-parameter `NOT IN` would be
 * slower and would hit SQLite's variable limit on a busy install.
 */
export function beyondRetention(db: VaultDb, liveRunIds: string[]): number {
  const total = count(db, "runs");
  if (total === 0) return 0;
  let overlap = 0;
  for (let i = 0; i < liveRunIds.length; i += 400) {
    const chunk = liveRunIds.slice(i, i + 400);
    const holes = chunk.map(() => "?").join(",");
    overlap += num(
      db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE id IN (${holes})`).get(...chunk)?.n,
    );
  }
  return Math.max(0, total - overlap);
}

export function vaultStatus(liveRunIds: string[]): VaultStatus {
  const handle = openVault();
  if (!handle) {
    const { reason, detail } = unavailable();
    return {
      available: false,
      reason,
      detail,
      rows: UNAVAILABLE_ROWS,
      sizeBytes: null,
      oldestRunAt: null,
      newestRunAt: null,
      lastIngestAt: null,
      beyondRetention: 0,
    };
  }
  const { db, file } = handle;
  const span = db.prepare("SELECT MIN(at_ms) AS lo, MAX(at_ms) AS hi FROM runs").get();
  const iso = (v: unknown): string | null => (v == null ? null : new Date(num(v)).toISOString());
  let sizeBytes: number | null = null;
  try {
    sizeBytes = statSync(file).size;
  } catch {
    // The database is open, so a stat failure is a curiosity, not a fault.
  }
  return {
    available: true,
    reason: null,
    detail: "the Vault is keeping history past what the JSON files retain",
    rows: {
      runs: count(db, "runs"),
      events: count(db, "events"),
      spendDays: count(db, "spend_days"),
      scores: count(db, "scores"),
    },
    sizeBytes,
    oldestRunAt: iso(span?.lo),
    newestRunAt: iso(span?.hi),
    lastIngestAt: lastIngestAt(db),
    beyondRetention: beyondRetention(db, liveRunIds),
  };
}

// ── Quarters ────────────────────────────────────────────────────────────────

/**
 * SQL for the quarter key.
 *
 * `localtime` on purpose: budgets, schedule triggers and the Stats day buckets
 * all follow the user's wall clock, and a quarter boundary that disagreed with
 * the rest of the app by a few hours would put the same run in two different
 * quarters depending on which page you asked.
 */
const QUARTER_KEY = `
  strftime('%Y', at_ms / 1000, 'unixepoch', 'localtime') || '-Q' ||
  ((CAST(strftime('%m', at_ms / 1000, 'unixepoch', 'localtime') AS INTEGER) - 1) / 3 + 1)
`;

/** Exact median via offset, one query per quarter — quarters are few. */
function medianOf(db: VaultDb, sql: string, key: string): number | null {
  const n = num(db.prepare(`SELECT COUNT(*) AS n FROM (${sql})`).get(key)?.n);
  if (n === 0) return null;
  const row = db.prepare(`${sql} ORDER BY v LIMIT 1 OFFSET ?`).get(key, Math.floor(n / 2));
  return row?.v == null ? null : num(row.v);
}

export function vaultQuarters(): VaultQuartersReport {
  const handle = openVault();
  if (!handle) return { available: false, detail: unavailable().detail, quarters: [] };
  const { db } = handle;

  const rows = db
    .prepare(
      `SELECT ${QUARTER_KEY} AS q,
              MIN(at_ms) AS lo, MAX(at_ms) AS hi,
              COUNT(*) AS runs,
              SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS ok,
              SUM(CASE WHEN status = 'failed' OR outcome = 'failed' THEN 1 ELSE 0 END) AS bad,
              COALESCE(SUM(cost_usd), 0) AS usd,
              COALESCE(SUM(tokens), 0) AS tok
         FROM runs
        GROUP BY q
        ORDER BY q DESC`,
    )
    .all();

  const durationSql = `SELECT duration_ms AS v FROM runs WHERE ${QUARTER_KEY} = ? AND duration_ms IS NOT NULL`;
  const scoreSql = `
    SELECT s.score AS v FROM scores s JOIN runs r ON r.id = s.run_id
     WHERE ${QUARTER_KEY.replace(/at_ms/g, "r.at_ms")} = ? AND s.score IS NOT NULL`;

  const quarters: VaultQuarter[] = rows.map((r) => {
    const key = String(r.q);
    return {
      key,
      label: key.replace("-", " "),
      startAt: new Date(num(r.lo)).toISOString(),
      endAt: new Date(num(r.hi)).toISOString(),
      runs: num(r.runs),
      succeeded: num(r.ok),
      failed: num(r.bad),
      costUsd: Math.round(num(r.usd) * 10000) / 10000,
      tokens: num(r.tok),
      medianDurationMs: medianOf(db, durationSql, key),
      medianScore: medianOf(db, scoreSql, key),
    };
  });

  return {
    available: true,
    detail:
      quarters.length > 0
        ? `${quarters.length} quarter${quarters.length === 1 ? "" : "s"} of history`
        : "no runs ingested yet — the Vault fills in as runs complete",
    quarters,
  };
}

// ── Search ──────────────────────────────────────────────────────────────────

/**
 * Words too common to carry meaning, plus the ones this corpus is made of.
 * Without the second group, every query on a run corpus expands to "run",
 * "failed", "error" — terms that describe the whole index rather than the
 * neighbourhood of the query.
 */
const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "was",
  "were",
  "are",
  "you",
  "your",
  "not",
  "but",
  "all",
  "any",
  "has",
  "have",
  "had",
  "its",
  "it's",
  "into",
  "out",
  "our",
  "run",
  "runs",
  "task",
  "claude",
  "error",
  "failed",
  "failure",
  "please",
  "when",
  "will",
  "one",
  "two",
  "use",
  "using",
  "used",
  "get",
  "set",
  "new",
  "now",
  "can",
  "may",
]);

/** Turns free text into an FTS5 expression that cannot inject operators. */
export function ftsQuery(raw: string): string | null {
  const tokens = tokenize(raw);
  if (tokens.length === 0) return null;
  // Prefix-matching the tokens keeps "spectac" finding "Spectacle" — which is
  // what a search box is expected to do — while the strip-to-alphanumeric above
  // means nothing the user types can reach FTS5's expression grammar.
  return tokens.map((t) => `${t}*`).join(" AND ");
}

export function tokenize(raw: string): string[] {
  return raw
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && t.length <= 40);
}

/**
 * Terms that co-occur with the query in this machine's own history.
 *
 * Pure, and exported so the ranking is testable without a database. The score
 * is a plain tf-idf: frequent among the documents the query actually matched,
 * rare across the corpus. This is not an embedding and is not described as one
 * anywhere in the UI — it finds neighbours in *your* vocabulary, which for a
 * corpus of your own runs is both cheaper and more honest than a general model
 * of English.
 */
export function relatedTerms(
  matchedBodies: string[],
  corpusDocFreq: Map<string, number>,
  exclude: Set<string>,
  limit = RELATED_TERMS,
): string[] {
  return scoreCandidates(candidateTerms(matchedBodies, exclude), corpusDocFreq, limit);
}

/**
 * Terms worth asking the corpus about, most locally frequent first.
 *
 * Split out from the scoring so the caller can look up document frequencies for
 * *these* terms only. Reading the whole `docs_vocab` table to score a handful
 * of candidates is a full scan of the vocabulary on every keystroke-debounced
 * search, and it grows with the corpus rather than with the query.
 */
export function candidateTerms(
  matchedBodies: string[],
  exclude: Set<string>,
  cap = 60,
): Map<string, number> {
  const local = new Map<string, number>();
  for (const body of matchedBodies) {
    for (const term of new Set(tokenize(body))) {
      if (term.length < 4 || exclude.has(term) || STOPWORDS.has(term)) continue;
      local.set(term, (local.get(term) ?? 0) + 1);
    }
  }
  // A term appearing in only one matched document is a coincidence, not a
  // neighbour; requiring two keeps a single verbose run from setting the
  // expansion for the whole query.
  return new Map(
    [...local.entries()]
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, cap),
  );
}

/** tf-idf: frequent among the matched documents, rare across the corpus. */
export function scoreCandidates(
  candidates: Map<string, number>,
  corpusDocFreq: Map<string, number>,
  limit = RELATED_TERMS,
): string[] {
  return [...candidates.entries()]
    .map(([term, n]) => ({ term, score: n / (1 + Math.log1p(corpusDocFreq.get(term) ?? 0)) }))
    .sort((a, b) => b.score - a.score || a.term.localeCompare(b.term))
    .slice(0, limit)
    .map((t) => t.term);
}

function hitsFor(db: VaultDb, expr: string, limit: number, related: boolean): VaultSearchHit[] {
  const rows = db
    .prepare(
      `SELECT kind, ref, at_ms, title, href, snippet(docs, 1, '', '', '…', 14) AS snip
         FROM docs WHERE docs MATCH ? ORDER BY rank LIMIT ?`,
    )
    .all(expr, limit);
  return rows.map((r) => ({
    kind: String(r.kind) === "event" ? "event" : "run",
    ref: String(r.ref),
    at: new Date(num(r.at_ms)).toISOString(),
    title: String(r.title ?? ""),
    snippet: String(r.snip ?? ""),
    href: str(r.href) ?? "#/schedules",
    related,
  }));
}

export function vaultSearch(query: string, limit = SEARCH_LIMIT): VaultSearchResponse {
  const base: VaultSearchResponse = {
    available: false,
    detail: "",
    query,
    hits: [],
    relatedTerms: [],
    limit,
    truncated: false,
  };
  const handle = openVault();
  if (!handle) return { ...base, detail: unavailable().detail };

  const expr = ftsQuery(query);
  if (!expr) {
    return { ...base, available: true, detail: "type at least two characters to search" };
  }

  const { db } = handle;
  let direct: VaultSearchHit[];
  try {
    direct = hitsFor(db, expr, limit, false);
  } catch (e) {
    // A malformed expression should be impossible after `ftsQuery`, but an FTS
    // error must not become a 500 on a search box.
    return { ...base, available: true, detail: `search failed: ${errText(e)}` };
  }

  const seen = new Set(direct.map((h) => `${h.kind}:${h.ref}`));
  const queryTokens = new Set(tokenize(query));
  let expanded: string[] = [];
  let relatedHits: VaultSearchHit[] = [];

  if (direct.length > 0 && direct.length < limit) {
    try {
      const sample = direct.slice(0, RELATED_SAMPLE).map((h) => h.ref);
      const holes = sample.map(() => "?").join(",");
      const bodies = db
        .prepare(`SELECT body FROM docs WHERE ref IN (${holes})`)
        .all(...sample)
        .map((r) => String(r.body ?? ""));
      // Candidates first, then one indexed lookup for exactly those terms. The
      // obvious alternative — read `docs_vocab` whole and score against it —
      // is a full vocabulary scan per search, and it grows with the corpus
      // instead of with the query.
      const candidates = candidateTerms(bodies, queryTokens);
      const freq = new Map<string, number>();
      if (candidates.size > 0) {
        const terms = [...candidates.keys()];
        const termHoles = terms.map(() => "?").join(",");
        for (const r of db
          .prepare(`SELECT term, doc FROM docs_vocab WHERE term IN (${termHoles})`)
          .all(...terms)) {
          freq.set(String(r.term), num(r.doc));
        }
      }
      expanded = scoreCandidates(candidates, freq);
      if (expanded.length > 0) {
        const orExpr = expanded.map((t) => `"${t}"`).join(" OR ");
        relatedHits = hitsFor(db, orExpr, limit, true).filter(
          (h) => !seen.has(`${h.kind}:${h.ref}`),
        );
      }
    } catch {
      // Expansion is a bonus. Losing it must never lose the direct hits.
      expanded = [];
      relatedHits = [];
    }
  }

  const hits = [...direct, ...relatedHits].slice(0, limit);
  return {
    available: true,
    detail:
      hits.length === 0
        ? "nothing in the Vault matches yet — it indexes runs and alerts, not transcripts"
        : `${direct.length} direct${relatedHits.length > 0 ? `, ${Math.min(relatedHits.length, limit - direct.length)} related` : ""}`,
    query,
    hits,
    relatedTerms: expanded,
    limit,
    truncated: direct.length >= limit,
  };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ── Chronicle, past retention ───────────────────────────────────────────────

export interface VaultRunRow {
  id: string;
  scheduleId: string;
  scheduleName: string;
  instanceId: string | null;
  phaseId: string | null;
  project: string | null;
  model: string | null;
  status: string;
  outcome: string | null;
  atMs: number;
  durationMs: number | null;
  costUsd: number | null;
  tokens: number | null;
  summary: string | null;
  error: string | null;
}

function toRow(r: Record<string, unknown>): VaultRunRow {
  return {
    id: String(r.id),
    scheduleId: String(r.schedule_id),
    scheduleName: String(r.schedule_name ?? ""),
    instanceId: str(r.instance_id),
    phaseId: str(r.phase_id),
    project: str(r.project),
    model: str(r.model),
    status: String(r.status),
    outcome: str(r.outcome),
    atMs: num(r.at_ms),
    durationMs: r.duration_ms == null ? null : num(r.duration_ms),
    costUsd: r.cost_usd == null ? null : num(r.cost_usd),
    tokens: r.tokens == null ? null : num(r.tokens),
    summary: str(r.summary),
    error: str(r.error),
  };
}

/**
 * Vault rows re-shaped as run records, for the Chronicle's long windows.
 *
 * Lossy on purpose: the Vault stores what it can answer questions about, not a
 * byte-for-byte copy of the run file. The fields the Chronicle actually reads
 * are all here; the ones it does not are filled with the honest empty value
 * rather than a plausible-looking guess, so a Vault-sourced span can never
 * claim a pid or an exit code it never knew.
 */
export function runsAsRecords(rows: VaultRunRow[]): VaultBackedRun[] {
  return rows.map((r) => ({
    id: r.id,
    scheduleId: r.scheduleId,
    scheduleName: r.scheduleName,
    prompt: "",
    cwd: "",
    status: r.status as VaultBackedRun["status"],
    trigger: "scheduled" as const,
    queuedAt: new Date(r.atMs - (r.durationMs ?? 0)).toISOString(),
    startedAt: new Date(r.atMs - (r.durationMs ?? 0)).toISOString(),
    endedAt: r.status === "running" ? null : new Date(r.atMs).toISOString(),
    durationMs: r.durationMs,
    pid: null,
    exitCode: null,
    sessionId: null,
    project: r.project,
    resultSummary: r.summary,
    error: r.error,
    costUsd: r.costUsd,
    tokens: r.tokens,
    ...(r.instanceId ? { instanceId: r.instanceId } : {}),
    ...(r.phaseId ? { phaseId: r.phaseId } : {}),
    ...(r.model ? { model: r.model } : {}),
    ...(r.outcome ? { outcome: r.outcome as "succeeded" | "failed" | "blocked" } : {}),
  }));
}

type VaultBackedRun = {
  id: string;
  scheduleId: string;
  scheduleName: string;
  prompt: string;
  cwd: string;
  status: "running" | "succeeded" | "failed" | "skipped" | "interrupted" | "cancelled";
  trigger: "scheduled" | "manual";
  queuedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  pid: number | null;
  exitCode: number | null;
  sessionId: string | null;
  project: string | null;
  resultSummary: string | null;
  error: string | null;
  costUsd?: number | null;
  tokens?: number | null;
  instanceId?: string;
  phaseId?: string;
  model?: string;
  outcome?: "succeeded" | "failed" | "blocked";
};

/** Runs in a time window, newest first. Empty when the Vault is unavailable. */
export function runsBetween(fromMs: number, toMs: number, limit = 500): VaultRunRow[] {
  const handle = openVault();
  if (!handle) return [];
  return handle.db
    .prepare(`SELECT * FROM runs WHERE at_ms >= ? AND at_ms <= ? ORDER BY at_ms DESC LIMIT ?`)
    .all(fromMs, toMs, limit)
    .map(toRow);
}
