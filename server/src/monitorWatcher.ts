import { buildMonitors } from "./sources/monitors.js";
import {
  detectMonitorAlerts,
  snapshotMonitorStatuses,
  type MonitorAlert,
  type MonitorSnapshot,
} from "./sources/monitorAlerts.js";
import type { Run, Schedule } from "./sources/scheduleTypes.js";

export interface MonitorWatcherDeps {
  now: () => Date;
  readSchedules: () => Promise<Schedule[]>;
  readRuns: () => Promise<Run[]>;
  onAlert: (alert: MonitorAlert) => void;
}

/**
 * Re-derives monitor health on every scheduler tick and diffs it against the
 * previous tick, surfacing down/failing/recovered transitions to `onAlert`
 * (webhook + WebSocket in production wiring). The first check after boot is a
 * silent baseline. A failing `onAlert` must never wedge the tick.
 */
export function createMonitorWatcher(deps: MonitorWatcherDeps): { check: () => Promise<void> } {
  let prev: MonitorSnapshot | null = null;

  return {
    async check(): Promise<void> {
      try {
        const [schedules, runs] = await Promise.all([deps.readSchedules(), deps.readRuns()]);
        const { monitors } = buildMonitors(schedules, runs, deps.now());
        const alerts = detectMonitorAlerts(prev, monitors, deps.now().toISOString());
        prev = snapshotMonitorStatuses(monitors);
        for (const alert of alerts) {
          try {
            deps.onAlert(alert);
          } catch (e) {
            console.error("[argus] monitor alert handler failed:", e);
          }
        }
      } catch (e) {
        console.error("[argus] monitor check failed:", e);
      }
    },
  };
}
