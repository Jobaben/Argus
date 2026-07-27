import {
  attachDiagnosis,
  readIncidents,
  readPolicy,
  reconcileIncidents,
  withIncidentLock,
  writeIncidents,
  type Condition,
  type IncidentAlert,
} from "./sources/sentinel.js";
import { performDiagnosis, type DiagnoseDeps } from "./sources/diagnose.js";
import { log } from "./log.js";

/**
 * Drives Sentinel on the scheduler tick: reconcile conditions into incidents,
 * emit the transitions, and optionally dispatch one read-only diagnostic.
 *
 * Unlike the other watchers, this one is **not** a diff against a snapshot in
 * memory — incidents are persisted, so the previous state is on disk and a
 * restart resumes mid-incident rather than re-opening everything. That also
 * means the whole read-modify-write has to be serialized, which it is: one
 * store lock around reconcile-and-persist, so two ticks (or a tick and a human
 * acknowledging) cannot lose each other's changes.
 */

export interface SentinelWatcherDeps {
  now: () => Date;
  /** Everything currently wrong, derived by the caller from its own reads. */
  conditions: () => Promise<Condition[]>;
  onAlert: (alert: IncidentAlert) => void;
  /** Present = the read-only diagnostic can be dispatched. */
  diagnose?: DiagnoseDeps;
}

export function createSentinelWatcher(deps: SentinelWatcherDeps): { check: () => Promise<void> } {
  return {
    async check(): Promise<void> {
      try {
        const policy = await readPolicy();
        if (!policy.enabled) return;

        const conditions = await deps.conditions();
        const { alerts, opened } = await withIncidentLock(async () => {
          const existing = await readIncidents();
          const res = reconcileIncidents(existing, conditions, policy, deps.now());
          await writeIncidents(res.incidents);
          return {
            alerts: res.alerts,
            opened: res.incidents.filter((i) =>
              res.alerts.some((a) => a.incidentId === i.id && a.event === "incident.opened"),
            ),
          };
        });

        for (const alert of alerts) {
          try {
            deps.onAlert(alert);
          } catch (e) {
            log.error("incident alert handler failed", { err: e });
          }
        }

        // One diagnostic per tick, and only for freshly-opened incidents: the
        // analysis runner is single-slot, and a burst of incidents must not
        // starve the postmortem and judge passes queued behind it.
        if (policy.autoDiagnose && deps.diagnose && opened.length > 0) {
          const target = opened[0];
          const diagnosis = await performDiagnosis(target, deps.diagnose);
          await withIncidentLock(async () => {
            // Re-read: a human may have acknowledged or resolved it while the
            // pass was running, and their edit must not be clobbered.
            const list = await readIncidents();
            const idx = list.findIndex((i) => i.id === target.id);
            if (idx === -1) return;
            list[idx] = attachDiagnosis(list[idx], diagnosis, deps.now());
            await writeIncidents(list);
          });
        }
      } catch (e) {
        log.error("sentinel check failed", { err: e });
      }
    },
  };
}
