import {
  isAutopsyEligible,
  performAutopsy,
  readAutopsies,
  type AutopsyDeps,
} from "./sources/autopsy.js";
import type { Run } from "./sources/scheduleTypes.js";
import { log } from "./log.js";

/**
 * Queues postmortems for runs that failed and don't have one yet.
 *
 * Three bounds, each protecting against a different way this could become the
 * most expensive thing Argus does:
 *
 * **One pass per tick.** A machine that comes back from a week asleep can have
 * fifty failed runs waiting. Analysing all of them at once would be a spend
 * spike and a rate-limit event; one per tick drains the backlog over minutes
 * instead, newest first, because the newest failure is the one being looked at.
 *
 * **An age floor.** Runs that failed more than a day ago are not autopsied on
 * discovery. Nobody is triaging Tuesday's failure on Thursday from a toast, and
 * the on-demand route is still there for anyone who is.
 *
 * **Failures are recorded.** A pass that itself fails writes a `failed` autopsy
 * rather than nothing, so the run is not retried forever, and the operator can
 * see *that* it was attempted and why it didn't work.
 */

export interface AutopsyWatcherDeps extends AutopsyDeps {
  readRuns: () => Promise<Run[]>;
  onAutopsy?: (runId: string) => void;
}

/** Failures older than this are left for the on-demand route. */
export const AUTOPSY_MAX_AGE_MS = 24 * 3_600_000;

const runMoment = (r: Run): string => r.endedAt ?? r.startedAt ?? r.queuedAt;

export function createAutopsyWatcher(deps: AutopsyWatcherDeps): { check: () => Promise<void> } {
  return {
    async check(): Promise<void> {
      try {
        const [runs, existing] = await Promise.all([deps.readRuns(), readAutopsies()]);
        const done = new Set(existing.map((a) => a.runId));
        const floor = deps.now().getTime() - AUTOPSY_MAX_AGE_MS;

        const next = runs
          .filter((r) => isAutopsyEligible(r) && !done.has(r.id))
          .filter((r) => {
            const at = Date.parse(runMoment(r));
            return Number.isFinite(at) && at >= floor;
          })
          .sort((a, b) => runMoment(b).localeCompare(runMoment(a)))[0];

        if (!next) return;
        await performAutopsy(next, deps);
        deps.onAutopsy?.(next.id);
      } catch (e) {
        log.error("autopsy check failed", { err: e });
      }
    },
  };
}
