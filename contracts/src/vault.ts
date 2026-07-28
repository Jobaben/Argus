/**
 * The Vault: an embedded analytical store that remembers what the JSON files
 * are forced to forget.
 *
 * Run records are pruned to the newest 50 per schedule, transcripts age out,
 * and the spend ledger keeps a year of days. That retention is correct for
 * files a human might open, and wrong for the question "how did this schedule
 * behave last quarter". The Vault ingests every run, transition, alert, cost
 * tick and score into a local SQLite database and answers the long-horizon
 * questions from there.
 *
 * It is a **cache of truth, never the source**. Every ingest is idempotent, the
 * JSON files remain authoritative for anything they still hold, and a Vault
 * that is missing, corrupt or unavailable degrades the long-horizon views to
 * their JSON-only behaviour rather than breaking anything.
 */

/** Why the Vault is not answering, when it is not. */
export type VaultUnavailableReason =
  /** This Node build has no `node:sqlite`. */
  | "no-sqlite"
  /** The database file could not be opened or created. */
  | "open-failed"
  /** Explicitly disabled with ARGUS_VAULT=off. */
  | "disabled";

export interface VaultRowCounts {
  runs: number;
  events: number;
  spendDays: number;
  scores: number;
}

export interface VaultStatus {
  available: boolean;
  /** Null when available. */
  reason: VaultUnavailableReason | null;
  /** Human-readable expansion of `reason`, always set. */
  detail: string;
  rows: VaultRowCounts;
  /** On-disk size of the database, or null when unavailable. */
  sizeBytes: number | null;
  /** ISO timestamps of the oldest and newest run the Vault holds. */
  oldestRunAt: string | null;
  newestRunAt: string | null;
  /** When the last ingest pass finished. */
  lastIngestAt: string | null;
  /**
   * Runs the Vault holds that the JSON files no longer do. This is the number
   * that justifies the feature, so it is reported rather than implied.
   */
  beyondRetention: number;
}

/** One quarter of history, for the Stats long view. */
export interface VaultQuarter {
  /** `2026-Q3`. */
  key: string;
  label: string;
  startAt: string;
  endAt: string;
  runs: number;
  succeeded: number;
  failed: number;
  costUsd: number;
  tokens: number;
  /** Median run duration in ms, or null when nothing finished. */
  medianDurationMs: number | null;
  /** Median Verdict score across scored runs, or null when nothing was scored. */
  medianScore: number | null;
}

export interface VaultQuartersReport {
  available: boolean;
  detail: string;
  quarters: VaultQuarter[];
}

/** What kind of record a search hit came from. */
export type VaultHitKind = "run" | "event";

export interface VaultSearchHit {
  kind: VaultHitKind;
  /** Run id or event id. */
  ref: string;
  at: string;
  title: string;
  snippet: string;
  /** Deep link into the app. */
  href: string;
  /**
   * True when this hit matched an expanded term rather than the query itself.
   * Kept separate so a related result can never be mistaken for a direct one.
   */
  related: boolean;
}

export interface VaultSearchResponse {
  available: boolean;
  detail: string;
  query: string;
  hits: VaultSearchHit[];
  /**
   * Terms the Vault added to the query because they co-occur with it in this
   * machine's own history. Not embeddings — reported as what they are so the
   * expansion is auditable.
   */
  relatedTerms: string[];
  limit: number;
  truncated: boolean;
}

/** The result of an ingest pass, surfaced so a stalled Vault is visible. */
export interface VaultIngestResult {
  ok: boolean;
  runs: number;
  events: number;
  spendDays: number;
  scores: number;
  ms: number;
  error: string | null;
}
