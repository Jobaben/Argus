import { test } from "node:test";
import assert from "node:assert/strict";
import { createMonitorWatcher } from "./monitorWatcher.js";
import type { MonitorAlert } from "./sources/monitorAlerts.js";
import type { Run, Schedule } from "./sources/scheduleTypes.js";

// A daily 02:00 schedule whose slot was covered yesterday. At 01:00 today the
// monitor is up; by 09:00 today's 02:00 slot is uncovered and past grace → down.
const schedule: Schedule = {
  id: "s1",
  name: "Nightly",
  prompt: "p",
  cwd: "/tmp",
  trigger: { kind: "daily", time: "02:00" },
  enabled: true,
  overlapPolicy: "skip",
  createdAt: new Date(2026, 6, 1, 0, 0).toISOString(),
  updatedAt: new Date(2026, 6, 1, 0, 0).toISOString(),
  lastRunAt: new Date(2026, 6, 11, 2, 0, 30).toISOString(),
  lastRunId: "r1",
};

const run: Run = {
  id: "r1",
  scheduleId: "s1",
  scheduleName: "Nightly",
  prompt: "p",
  cwd: "/tmp",
  status: "succeeded",
  trigger: "scheduled",
  queuedAt: new Date(2026, 6, 11, 2, 0, 30).toISOString(),
  startedAt: new Date(2026, 6, 11, 2, 0, 30).toISOString(),
  endedAt: new Date(2026, 6, 11, 2, 1, 0).toISOString(),
  durationMs: 30000,
  pid: null,
  exitCode: 0,
  sessionId: null,
  project: null,
  resultSummary: null,
  error: null,
};

function watcherAt(clock: { now: Date }, alerts: MonitorAlert[], deps?: { onAlert?: () => void }) {
  return createMonitorWatcher({
    now: () => clock.now,
    readSchedules: async () => [schedule],
    readRuns: async () => [run],
    onAlert: deps?.onAlert ?? ((a) => alerts.push(a)),
  });
}

test("first check is a silent baseline; a later down transition alerts once", async () => {
  const clock = { now: new Date(2026, 6, 12, 1, 0) };
  const alerts: MonitorAlert[] = [];
  const watcher = watcherAt(clock, alerts);

  await watcher.check(); // baseline at 01:00 (monitor up)
  assert.equal(alerts.length, 0);

  clock.now = new Date(2026, 6, 12, 9, 0); // 02:00 slot missed, far past grace
  await watcher.check();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].event, "monitor.down");
  assert.equal(alerts[0].scheduleId, "s1");

  await watcher.check(); // unchanged state must not re-alert
  assert.equal(alerts.length, 1);
});

test("a throwing onAlert does not break check or the snapshot", async () => {
  const clock = { now: new Date(2026, 6, 12, 1, 0) };
  const watcher = watcherAt(clock, [], {
    onAlert: () => {
      throw new Error("boom");
    },
  });
  await watcher.check();
  clock.now = new Date(2026, 6, 12, 9, 0);
  await assert.doesNotReject(() => watcher.check());
});
