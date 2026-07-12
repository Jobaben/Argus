import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectMonitorAlerts,
  snapshotMonitorStatuses,
  type MonitorSnapshot,
} from "./monitorAlerts.js";
import type { MonitorHealth, MonitorStatus } from "./monitors.js";

const NOW = "2026-07-12T08:00:00.000Z";

const monitor = (scheduleId: string, status: MonitorStatus): MonitorHealth => ({
  scheduleId,
  name: `sched ${scheduleId}`,
  enabled: status !== "paused",
  status,
  uptimePct: null,
  lastRunAt: null,
  lastRunStatus: status === "failing" ? "failed" : null,
  expectedAt: status === "down" || status === "late" ? "2026-07-12T07:00:00.000Z" : null,
  nextExpected: null,
  graceMs: 300000,
  heartbeats: [],
});

const snap = (entries: [string, MonitorStatus][]): MonitorSnapshot => new Map(entries);

test("first observation (null prev) yields no alerts even for down monitors", () => {
  assert.deepEqual(detectMonitorAlerts(null, [monitor("a", "down")], NOW), []);
});

test("a monitor first seen already down (not in prev) does not alert", () => {
  assert.deepEqual(detectMonitorAlerts(snap([]), [monitor("a", "down")], NOW), []);
});

test("up -> down alerts monitor.down with the missed slot in the detail", () => {
  const alerts = detectMonitorAlerts(snap([["a", "up"]]), [monitor("a", "down")], NOW);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].event, "monitor.down");
  assert.equal(alerts[0].scheduleId, "a");
  assert.equal(alerts[0].at, NOW);
  assert.match(alerts[0].detail, /2026-07-12T07:00:00.000Z/);
});

test("up -> failing alerts monitor.failing", () => {
  const alerts = detectMonitorAlerts(snap([["a", "up"]]), [monitor("a", "failing")], NOW);
  assert.deepEqual(
    alerts.map((a) => a.event),
    ["monitor.failing"],
  );
});

test("down -> up and failing -> up alert monitor.recovered", () => {
  const alerts = detectMonitorAlerts(
    snap([
      ["a", "down"],
      ["b", "failing"],
    ]),
    [monitor("a", "up"), monitor("b", "up")],
    NOW,
  );
  assert.deepEqual(
    alerts.map((a) => a.event),
    ["monitor.recovered", "monitor.recovered"],
  );
});

test("late is the grace period working: up -> late and late -> up stay silent", () => {
  assert.deepEqual(detectMonitorAlerts(snap([["a", "up"]]), [monitor("a", "late")], NOW), []);
  assert.deepEqual(detectMonitorAlerts(snap([["a", "late"]]), [monitor("a", "up")], NOW), []);
});

test("late -> down still alerts monitor.down", () => {
  const alerts = detectMonitorAlerts(snap([["a", "late"]]), [monitor("a", "down")], NOW);
  assert.deepEqual(
    alerts.map((a) => a.event),
    ["monitor.down"],
  );
});

test("pausing a down monitor is silent, not a recovery", () => {
  assert.deepEqual(detectMonitorAlerts(snap([["a", "down"]]), [monitor("a", "paused")], NOW), []);
});

test("unchanged statuses stay silent", () => {
  assert.deepEqual(detectMonitorAlerts(snap([["a", "down"]]), [monitor("a", "down")], NOW), []);
});

test("snapshotMonitorStatuses captures every monitor's status", () => {
  const s = snapshotMonitorStatuses([monitor("a", "up"), monitor("b", "down")]);
  assert.equal(s.get("a"), "up");
  assert.equal(s.get("b"), "down");
});
