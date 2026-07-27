import { buildWatchtower, readResets, type Anomaly } from "./sources/watchtower.js";
import type { Run } from "./sources/scheduleTypes.js";
import { log } from "./log.js";

/**
 * Re-derives Watchtower on every scheduler tick and reports anomalies that are
 * new since the last pass.
 *
 * Anomaly ids are deterministic (`key|metric|runId`), so "new" needs nothing
 * more than a set of ids already seen — no persisted alert log, and no risk of
 * the same run alerting twice because a baseline shifted slightly underneath it.
 *
 * The first pass after boot is a silent baseline, matching the monitor and
 * budget watchers: a restart must not replay two weeks of anomalies into the
 * bell.
 */

export interface WatchtowerWatcherDeps {
  now: () => Date;
  readRuns: () => Promise<Run[]>;
  onAnomaly: (anomaly: Anomaly) => void;
}

/** Ids retained. Comfortably above ANOMALY_CAP so a report's whole contents can
 *  be remembered, bounded so a long uptime can't grow the set without limit. */
const SEEN_CAP = 500;

export function createWatchtowerWatcher(deps: WatchtowerWatcherDeps): {
  check: () => Promise<void>;
} {
  let seen: Set<string> | null = null;

  return {
    async check(): Promise<void> {
      try {
        const [runs, resets] = await Promise.all([deps.readRuns(), readResets()]);
        const report = buildWatchtower(runs, resets, deps.now());
        const ids = report.anomalies.map((a) => a.id);

        if (seen === null) {
          seen = new Set(ids.slice(0, SEEN_CAP));
          return; // silent baseline
        }

        const fresh = report.anomalies.filter((a) => !seen!.has(a.id));
        // Rebuild rather than accumulate: an id that has aged out of the report
        // window can never reappear (runs are immutable once terminal), so
        // holding it forever would only grow the set.
        const next = new Set(ids.slice(0, SEEN_CAP));
        for (const id of seen) {
          if (next.size >= SEEN_CAP) break;
          next.add(id);
        }
        seen = next;

        // Oldest first, so a burst reaches the bell in the order it happened.
        for (const anomaly of [...fresh].reverse()) {
          try {
            deps.onAnomaly(anomaly);
          } catch (e) {
            log.error("anomaly handler failed", { err: e });
          }
        }
      } catch (e) {
        log.error("watchtower check failed", { err: e });
      }
    },
  };
}
