import { mkdirSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { paths } from "../claudeHome.js";
import { log } from "../log.js";
import type { VaultUnavailableReason } from "@argus/contracts";

/**
 * Opening (and, when needed, creating) the Vault's SQLite database.
 *
 * Three things are load-bearing here.
 *
 * **Zero configuration, zero dependencies.** The engine is `node:sqlite`, which
 * ships with Node 22 — no native build step, no package to install, no server
 * to run. Argus refuses to make a monitoring tool require an operations story
 * of its own.
 *
 * **Failure is a degraded feature, never a broken app.** Every entry point
 * returns `null` rather than throwing, and each caller answers with
 * `available: false` and a reason. A Node build without `node:sqlite`, a
 * read-only home directory, a database corrupted by a full disk — all of them
 * cost you the long-horizon views and nothing else.
 *
 * **SQLite is not written through the atomic writer, deliberately.** That
 * writer exists to give JSON files the crash-safety a database already has
 * natively; wrapping a live SQLite file in tmp+rename would *remove* the
 * guarantee, not add it. WAL mode plus SQLite's own journalling is the stronger
 * primitive, and it is safe to prefer it precisely because the Vault holds no
 * authoritative state: losing it costs history, never correctness.
 */

/** Bumped whenever the schema below changes; `migrate()` is the only writer. */
const SCHEMA_VERSION = 1;

/** The subset of `node:sqlite`'s DatabaseSync that the Vault uses. */
export interface VaultStatement {
  all(...params: unknown[]): Record<string, unknown>[];
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): unknown;
}
export interface VaultDb {
  exec(sql: string): void;
  prepare(sql: string): VaultStatement;
  close(): void;
}

export interface VaultHandle {
  db: VaultDb;
  file: string;
}

type OpenFailure = { reason: VaultUnavailableReason; detail: string };

let cached: VaultHandle | null = null;
let failure: OpenFailure | null = null;

/** Test seam: point the Vault at a different engine, or none at all. */
let engineOverride: ((file: string) => VaultDb) | null = null;
export function setVaultEngine(fn: ((file: string) => VaultDb) | null): void {
  engineOverride = fn;
  closeVault();
}

/** Drops the cached handle so the next call re-opens. Used by tests and reset. */
export function closeVault(): void {
  try {
    cached?.db.close();
  } catch {
    // A close that fails still means "stop using this handle".
  }
  cached = null;
  failure = null;
}

const nodeRequire = createRequire(import.meta.url);

function loadEngine(file: string): VaultDb {
  if (engineOverride) return engineOverride(file);
  // Resolved lazily and by name so a Node build without the module fails here,
  // as a catchable error, rather than at import time for the whole server. A
  // static `import` would take the process down on exactly the runtimes this
  // feature is supposed to degrade gracefully on.
  return withoutSqliteExperimentalWarning(() => {
    const sqlite = nodeRequire("node:sqlite") as { DatabaseSync: new (p: string) => VaultDb };
    return new sqlite.DatabaseSync(file);
  });
}

/**
 * Swallow Node's "SQLite is an experimental feature" notice, and nothing else.
 *
 * A monitoring tool that prints an alarming warning about its own cache on
 * every boot teaches its users to ignore warnings, which is the opposite of
 * what it exists for. The interception is as narrow as it can be — one exact
 * message, restored in a `finally`, so every other warning Node has to say
 * still reaches the log.
 */
function withoutSqliteExperimentalWarning<T>(fn: () => T): T {
  const original = process.emitWarning;
  process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
    const text =
      typeof warning === "string" ? warning : ((warning as Error | undefined)?.message ?? "");
    if (/SQLite is an experimental feature/i.test(text)) return;
    return (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return fn();
  } finally {
    process.emitWarning = original;
  }
}

export function vaultDisabled(): boolean {
  return (process.env.ARGUS_VAULT ?? "").toLowerCase() === "off";
}

/**
 * The open handle, or null with a recorded reason.
 *
 * Memoized: SQLite handles are cheap to keep and expensive to churn, and the
 * ingest pass runs on every scheduler tick.
 */
export function openVault(): VaultHandle | null {
  if (cached) return cached;
  if (failure) return null;

  if (vaultDisabled()) {
    failure = { reason: "disabled", detail: "the Vault is off (ARGUS_VAULT=off)" };
    return null;
  }

  const file = paths.vaultFile();
  try {
    mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    // Fall through: the open below will produce the real error.
  }

  let db: VaultDb;
  try {
    db = loadEngine(file);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const missing = /Cannot find module|not supported|ERR_UNKNOWN_BUILTIN_MODULE/i.test(message);
    failure = missing
      ? {
          reason: "no-sqlite",
          detail: "this Node build has no node:sqlite — the Vault needs Node 22 or newer",
        }
      : { reason: "open-failed", detail: `could not open the Vault: ${message}` };
    log.warn("vault unavailable", { detail: failure.detail });
    return null;
  }

  try {
    migrate(db);
  } catch (e) {
    // A schema step that fails on an existing file means the file is not a
    // Vault we understand. Move it aside and start clean rather than refusing
    // to run: the Vault is rebuildable by construction, so the cost of a fresh
    // start is bounded by what the JSON files no longer hold — and the cost of
    // *not* starting is every long-horizon view broken until a human notices.
    log.warn("vault schema unusable, starting a fresh database", { err: e });
    try {
      db.close();
    } catch {
      /* already unusable */
    }
    try {
      renameSync(file, `${file}.corrupt-${Date.now()}`);
      db = loadEngine(file);
      migrate(db);
    } catch (e2) {
      const message = e2 instanceof Error ? e2.message : String(e2);
      failure = { reason: "open-failed", detail: `could not rebuild the Vault: ${message}` };
      return null;
    }
  }

  cached = { db, file };
  return cached;
}

function migrate(db: VaultDb): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  const version = Number(row?.user_version ?? 0);
  if (version >= SCHEMA_VERSION) return;
  db.exec(SCHEMA);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

/**
 * The schema.
 *
 * Every table is keyed by the identity the source already has (a run id, an
 * event id derived from its content, a calendar day) so ingest is an upsert and
 * re-running a pass is a no-op. That is what lets the ingest watermark be an
 * optimisation rather than a correctness requirement — a lost or reset
 * watermark costs time, never accuracy.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,
  schedule_id   TEXT NOT NULL,
  schedule_name TEXT NOT NULL,
  pipeline_id   TEXT,
  instance_id   TEXT,
  phase_id      TEXT,
  project       TEXT,
  model         TEXT,
  trigger       TEXT,
  status        TEXT NOT NULL,
  outcome       TEXT,
  at_ms         INTEGER NOT NULL,
  duration_ms   INTEGER,
  cost_usd      REAL,
  tokens        INTEGER,
  budget_action TEXT,
  prompt        TEXT,
  summary       TEXT,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS runs_at      ON runs (at_ms);
CREATE INDEX IF NOT EXISTS runs_sched   ON runs (schedule_id, at_ms);
CREATE INDEX IF NOT EXISTS runs_model   ON runs (model, at_ms);
CREATE INDEX IF NOT EXISTS runs_inst    ON runs (instance_id);

CREATE TABLE IF NOT EXISTS events (
  id       TEXT PRIMARY KEY,
  at_ms    INTEGER NOT NULL,
  kind     TEXT NOT NULL,
  severity TEXT,
  subject  TEXT,
  detail   TEXT,
  href     TEXT
);
CREATE INDEX IF NOT EXISTS events_at   ON events (at_ms);
CREATE INDEX IF NOT EXISTS events_kind ON events (kind, at_ms);

CREATE TABLE IF NOT EXISTS spend_days (
  day    TEXT PRIMARY KEY,
  usd    REAL NOT NULL,
  tokens INTEGER NOT NULL,
  runs   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scores (
  run_id TEXT PRIMARY KEY,
  at_ms  INTEGER NOT NULL,
  score  REAL,
  goal   TEXT
);
CREATE INDEX IF NOT EXISTS scores_at ON scores (at_ms);

CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
  title, body, kind UNINDEXED, ref UNINDEXED, at_ms UNINDEXED, href UNINDEXED,
  tokenize = 'unicode61'
);

CREATE VIRTUAL TABLE IF NOT EXISTS docs_vocab USING fts5vocab('docs', 'row');

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function readMeta(db: VaultDb, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row ? String(row.value) : null;
}

export function writeMeta(db: VaultDb, key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

/** The recorded reason the Vault is unavailable, for the status route. */
export function openFailure(): OpenFailure | null {
  return failure;
}
