import type { Anomaly, Incident, Verdict, VaultIngestResult } from "@argus/contracts";
import type { Run } from "./sources/scheduleTypes.js";
import type { SpendLedger } from "./sources/budget.js";
import { ingest } from "./vault/ingest.js";
import { vaultDisabled } from "./vault/db.js";
import { log } from "./log.js";

/**
 * The ingest loop.
 *
 * Runs on the scheduler tick, like the other watchers, and for the same reason:
 * the material it ingests is produced by that tick, so there is nothing to gain
 * from a second timer and something to lose — two clocks that drift apart make
 * "why is this run missing" a question about scheduling rather than about data.
 *
 * Three bounds keep it from being felt:
 *
 * - **It never throws.** An ingest failure is logged once and retried next
 *   tick. The Vault is a cache; a broken cache must not break the tick that
 *   feeds the scheduler.
 * - **It skips its own tick when the last pass was slow.** SQLite writes are
 *   synchronous, so a very large first pass would otherwise stall the event
 *   loop on every tick until it caught up.
 * - **It backs off when the Vault is unavailable**, rather than re-attempting
 *   an open that has already failed for a structural reason.
 */

export interface VaultWatcherDeps {
  now: () => Date;
  readRuns: () => Promise<Run[]>;
  readIncidents: () => Promise<Incident[]>;
  readAnomalies: () => Promise<Anomaly[]>;
  readVerdicts: () => Promise<Verdict[]>;
  readSpend: () => Promise<SpendLedger>;
  onIngest?: (result: VaultIngestResult) => void;
  /** Test seam. Defaults to the real, SQLite-backed pass. */
  ingest?: typeof ingest;
}

/** A pass slower than this makes the next tick a no-op, once. */
export const SLOW_PASS_MS = 750;

export function createVaultWatcher(deps: VaultWatcherDeps) {
  let cooldown = 0;
  let reportedFailure = false;

  async function check(): Promise<VaultIngestResult | null> {
    if (vaultDisabled()) return null;
    if (cooldown > 0) {
      cooldown--;
      return null;
    }

    let result: VaultIngestResult;
    try {
      const [runs, incidents, anomalies, verdicts, spend] = await Promise.all([
        deps.readRuns(),
        deps.readIncidents(),
        deps.readAnomalies(),
        deps.readVerdicts(),
        deps.readSpend(),
      ]);
      result = (deps.ingest ?? ingest)({
        runs,
        incidents,
        anomalies,
        verdicts,
        spend,
        now: deps.now(),
      });
    } catch (e) {
      // A read that fails is the source's problem, not the Vault's; skip the
      // pass rather than writing a partial history that looks complete.
      log.warn("vault ingest could not read its sources", { err: e });
      cooldown = 2;
      return null;
    }

    if (!result.ok) {
      // Logged once per failure streak: a Vault that cannot open would
      // otherwise write a line every tick, forever.
      if (!reportedFailure) log.warn("vault ingest failed", { error: result.error });
      reportedFailure = true;
      cooldown = 4;
    } else {
      reportedFailure = false;
      if (result.ms > SLOW_PASS_MS) cooldown = 1;
    }

    deps.onIngest?.(result);
    return result;
  }

  return { check };
}
