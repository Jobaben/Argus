import type { MonitorHealth, MonitorStatus } from "./monitors.js";

/**
 * Transition detection for monitor alerting. Monitor status is a pure
 * derivation computed on read, so nothing observes it changing — these
 * helpers diff one tick's derivation against the previous tick so a schedule
 * going down/failing can reach the webhook and the dashboard. Mirrors the
 * baseline-suppression rules of the web's agent `detectTransitions`: the
 * first observation after boot never alerts, and neither does a monitor
 * first seen already in a bad state — only a *watched* transition does.
 */

export type MonitorAlertEvent = "monitor.down" | "monitor.failing" | "monitor.recovered";

export interface MonitorAlert {
  event: MonitorAlertEvent;
  scheduleId: string;
  name: string;
  status: MonitorStatus;
  at: string;
  detail: string;
}

export type MonitorSnapshot = Map<string, MonitorStatus>;

export function snapshotMonitorStatuses(monitors: MonitorHealth[]): MonitorSnapshot {
  const snap: MonitorSnapshot = new Map();
  for (const m of monitors) snap.set(m.scheduleId, m.status);
  return snap;
}

const BAD: ReadonlySet<MonitorStatus> = new Set<MonitorStatus>(["down", "failing"]);

function alertFor(m: MonitorHealth, before: MonitorStatus, at: string): MonitorAlert | null {
  if (m.status === before) return null;
  if (m.status === "down") {
    return {
      event: "monitor.down",
      scheduleId: m.scheduleId,
      name: m.name,
      status: m.status,
      at,
      detail: m.expectedAt
        ? `no run covered the slot expected at ${m.expectedAt}`
        : "no run covered the expected slot",
    };
  }
  if (m.status === "failing") {
    return {
      event: "monitor.failing",
      scheduleId: m.scheduleId,
      name: m.name,
      status: m.status,
      at,
      detail: "the most recent completed run failed",
    };
  }
  if (m.status === "up" && BAD.has(before)) {
    return {
      event: "monitor.recovered",
      scheduleId: m.scheduleId,
      name: m.name,
      status: m.status,
      at,
      detail: `recovered from ${before}`,
    };
  }
  // late (grace still running), paused, pending: not alertable.
  return null;
}

/** Alerts for every watched transition between `prev` and `monitors`.
 *  `prev === null` (first tick) and first-seen schedules yield nothing. */
export function detectMonitorAlerts(
  prev: MonitorSnapshot | null,
  monitors: MonitorHealth[],
  at: string,
): MonitorAlert[] {
  if (prev === null) return [];
  const alerts: MonitorAlert[] = [];
  for (const m of monitors) {
    const before = prev.get(m.scheduleId);
    if (before === undefined) continue;
    const alert = alertFor(m, before, at);
    if (alert) alerts.push(alert);
  }
  return alerts;
}
