import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMonitors, monitorFor, monitorGraceMs, HEARTBEAT_KEEP } from "./monitors.js";
import type { Run, Schedule } from "./scheduleTypes.js";

const T0 = new Date(2026, 6, 1, 8, 0, 0); // Wed Jul 1 2026 08:00 local

function schedule(over: Partial<Schedule> = {}): Schedule {
  return {
    id: "s1",
    name: "Nightly triage",
    prompt: "p",
    cwd: "/tmp",
    trigger: { kind: "interval", everyMinutes: 60 },
    enabled: true,
    overlapPolicy: "skip",
    createdAt: T0.toISOString(),
    updatedAt: T0.toISOString(),
    lastRunAt: null,
    lastRunId: null,
    ...over,
  };
}

function run(id: string, queuedAt: Date, over: Partial<Run> = {}): Run {
  const iso = queuedAt.toISOString();
  return {
    id,
    scheduleId: "s1",
    scheduleName: "Nightly triage",
    prompt: "p",
    cwd: "/tmp",
    status: "succeeded",
    trigger: "scheduled",
    queuedAt: iso,
    startedAt: iso,
    endedAt: iso,
    durationMs: 1000,
    pid: null,
    exitCode: 0,
    sessionId: null,
    project: null,
    resultSummary: null,
    error: null,
    ...over,
  };
}

const at = (minsAfterT0: number) => new Date(T0.getTime() + minsAfterT0 * 60_000);

test("grace is 10% of period clamped to [5min, 60min]", () => {
  assert.equal(monitorGraceMs({ kind: "interval", everyMinutes: 10 }), 5 * 60_000);
  assert.equal(monitorGraceMs({ kind: "interval", everyMinutes: 120 }), 12 * 60_000);
  assert.equal(monitorGraceMs({ kind: "daily", time: "09:00" }), 60 * 60_000);
  assert.equal(monitorGraceMs({ kind: "weekly", time: "09:00", weekday: 1 }), 60 * 60_000);
});

test("disabled schedule is paused", () => {
  const m = monitorFor(schedule({ enabled: false }), [], at(500));
  assert.equal(m.status, "paused");
  assert.equal(m.nextExpected, null);
});

test("new schedule with no elapsed slot and no runs is pending", () => {
  const m = monitorFor(schedule(), [], at(30)); // first slot at +60min
  assert.equal(m.status, "pending");
  assert.equal(m.expectedAt, null);
  assert.ok(m.nextExpected);
});

test("run covering the last slot means up", () => {
  const s = schedule({ lastRunAt: at(60).toISOString() });
  const m = monitorFor(s, [run("r1", at(60))], at(90));
  assert.equal(m.status, "up");
});

test("slot missed but inside grace is late, past grace is down", () => {
  // 60-min interval anchored at last run (T0+60): next slot T0+120.
  const s = schedule({ lastRunAt: at(60).toISOString() });
  const runs = [run("r1", at(60))];
  // grace for 60min period = clamp(6min, 5, 60) = 6min
  assert.equal(monitorFor(s, runs, at(125)).status, "late");
  assert.equal(monitorFor(s, runs, at(127)).status, "down");
  assert.equal(monitorFor(s, runs, at(127)).expectedAt, at(120).toISOString());
});

test("skipped run covers its slot without counting toward uptime", () => {
  const s = schedule({ lastRunAt: at(120).toISOString() });
  const runs = [run("r2", at(120), { status: "skipped" }), run("r1", at(60))];
  const m = monitorFor(s, runs, at(130));
  assert.equal(m.status, "up");
  assert.equal(m.uptimePct, 100); // only r1 (succeeded) counts
});

test("ran on time but last completed run failed means failing", () => {
  const s = schedule({ lastRunAt: at(120).toISOString() });
  const runs = [run("r2", at(120), { status: "failed", error: "boom" }), run("r1", at(60))];
  assert.equal(monitorFor(s, runs, at(125)).status, "failing");
});

test("outcome failed counts as failing even when exit status succeeded", () => {
  const s = schedule({ lastRunAt: at(120).toISOString() });
  const runs = [run("r2", at(120), { outcome: "failed" })];
  const m = monitorFor(s, runs, at(125));
  assert.equal(m.status, "failing");
  assert.equal(m.uptimePct, 0);
});

test("slots before the schedule existed are not owed (daily created after today's slot)", () => {
  // Created 08:00, daily slot 07:00 — that slot predates the schedule.
  const s = schedule({ trigger: { kind: "daily", time: "07:00" } });
  const m = monitorFor(s, [], new Date(2026, 6, 1, 12, 0, 0));
  assert.equal(m.status, "pending");
});

test("daily slot missed past grace is down", () => {
  const s = schedule({
    trigger: { kind: "daily", time: "09:00" },
    createdAt: T0.toISOString(), // 08:00, so today's 09:00 slot is owed
  });
  const m = monitorFor(s, [], new Date(2026, 6, 1, 10, 30, 0)); // grace 60min, 90min late
  assert.equal(m.status, "down");
});

test("uptime is succeeded/(succeeded+failed) over retained heartbeats", () => {
  const s = schedule({ lastRunAt: at(180).toISOString() });
  const runs = [run("r3", at(180)), run("r2", at(120), { status: "failed" }), run("r1", at(60))];
  const m = monitorFor(s, runs, at(190));
  assert.equal(m.uptimePct, 66.7);
  assert.equal(m.heartbeats.length, 3);
  // oldest → newest for display
  assert.deepEqual(
    m.heartbeats.map((h) => h.runId),
    ["r1", "r2", "r3"],
  );
});

test("heartbeats cap at HEARTBEAT_KEEP", () => {
  const runs = Array.from({ length: 40 }, (_, i) => run(`r${40 - i}`, at((40 - i) * 60)));
  const s = schedule({ lastRunAt: at(40 * 60).toISOString() });
  const m = monitorFor(s, runs, at(40 * 60 + 5));
  assert.equal(m.heartbeats.length, HEARTBEAT_KEEP);
  assert.equal(m.heartbeats[HEARTBEAT_KEEP - 1].runId, "r40"); // newest kept
});

test("buildMonitors groups runs per schedule, sorts by severity, and counts", () => {
  const s1 = schedule({ id: "s1", name: "alpha", lastRunAt: at(60).toISOString() });
  const s2 = schedule({ id: "s2", name: "beta", enabled: false });
  const runs = [run("r1", at(60))];
  const { monitors, summary } = buildMonitors([s2, s1], runs, at(90));
  assert.deepEqual(
    monitors.map((m) => [m.scheduleId, m.status]),
    [
      ["s1", "up"],
      ["s2", "paused"],
    ],
  );
  assert.equal(summary.up, 1);
  assert.equal(summary.paused, 1);
  assert.equal(summary.down, 0);
});
