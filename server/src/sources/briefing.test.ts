import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBriefing, clampSince, WINDOW_CAP_MS } from "./briefing.js";
import type { Run } from "./scheduleTypes.js";
import type { MonitorHealth } from "./monitors.js";
import type { Issue } from "./issues.js";
import type { PipelineInstance } from "./pipelineTypes.js";

const NOW = new Date(2026, 6, 11, 8, 0, 0); // Sat Jul 11 2026 08:00 local
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

function run(id: string, ended: Date | null, over: Partial<Run> = {}): Run {
  const iso = (ended ?? NOW).toISOString();
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
    endedAt: ended ? ended.toISOString() : null,
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

function monitor(over: Partial<MonitorHealth> = {}): MonitorHealth {
  return {
    scheduleId: "s1",
    name: "Nightly triage",
    enabled: true,
    status: "up",
    uptimePct: 100,
    lastRunAt: hoursAgo(1).toISOString(),
    lastRunStatus: "succeeded",
    expectedAt: hoursAgo(1).toISOString(),
    nextExpected: null,
    graceMs: 300_000,
    heartbeats: [],
    ...over,
  };
}

function issue(over: Partial<Issue> = {}): Issue {
  return {
    fingerprint: "f".repeat(16),
    title: "boom",
    count: 3,
    firstSeen: hoursAgo(2).toISOString(),
    lastSeen: hoursAgo(1).toISOString(),
    schedules: ["Nightly triage"],
    state: "open",
    lastRunId: "r9",
    ...over,
  };
}

function instance(over: Partial<PipelineInstance> = {}): PipelineInstance {
  return {
    id: "i1",
    pipelineId: "p1",
    pipelineName: "Release train",
    status: "succeeded",
    currentPhaseIndex: 0,
    phases: [
      {
        id: "ph1",
        name: "Plan",
        gated: true,
        status: "succeeded",
        steps: [],
        attempt: 1,
        payload: null,
      },
    ],
    trigger: "manual",
    signalToken: "t",
    createdAt: hoursAgo(3).toISOString(),
    updatedAt: hoursAgo(1).toISOString(),
    endedAt: hoursAgo(1).toISOString(),
    ...over,
  };
}

const EMPTY = { runs: [], monitors: [], issues: [], instances: [] };

test("clampSince: null ack defaults to 24h back", () => {
  assert.equal(clampSince(null, NOW).getTime(), NOW.getTime() - 24 * 3_600_000);
});

test("clampSince: recent ack is used verbatim; ancient ack clamps to 7d", () => {
  const recent = hoursAgo(5).toISOString();
  assert.equal(clampSince(recent, NOW).toISOString(), recent);
  const ancient = new Date(NOW.getTime() - 30 * 24 * 3_600_000).toISOString();
  assert.equal(clampSince(ancient, NOW).getTime(), NOW.getTime() - WINDOW_CAP_MS);
});

test("empty inputs produce a calm briefing", () => {
  const b = buildBriefing(EMPTY, hoursAgo(24), NOW);
  assert.equal(b.attentionCount, 0);
  assert.deepEqual(b.attention, []);
  assert.equal(b.window.totalRuns, 0);
  assert.equal(b.window.costUsd, 0);
  assert.equal(b.window.tokens, 0);
  assert.deepEqual(b.window.failures, []);
});

test("window filters runs by endedAt ?? startedAt ?? queuedAt", () => {
  const inside = run("in", hoursAgo(2));
  const outside = run("out", hoursAgo(30));
  const runningInside = run("live", null, {
    status: "running",
    startedAt: hoursAgo(1).toISOString(),
    queuedAt: hoursAgo(1).toISOString(),
  });
  const b = buildBriefing({ ...EMPTY, runs: [inside, outside, runningInside] }, hoursAgo(24), NOW);
  assert.equal(b.window.totalRuns, 2);
  assert.equal(b.window.byStatus.succeeded, 1);
  assert.equal(b.window.byStatus.running, 1);
});

test("failures use the issues predicate and cap at 10, newest first", () => {
  const runs: Run[] = [];
  for (let i = 0; i < 12; i++) {
    runs.push(run(`f${i}`, hoursAgo(12 - i), { status: "failed", error: "boom" }));
  }
  runs.push(run("blocked", hoursAgo(0.5), { status: "succeeded", outcome: "blocked" }));
  runs.push(run("ok", hoursAgo(0.25)));
  const b = buildBriefing({ ...EMPTY, runs }, hoursAgo(24), NOW);
  assert.equal(b.window.failures.length, 10);
  assert.equal(b.window.failures[0].id, "blocked"); // outcome-blocked counts, newest first
});

test("cost and tokens sum with missing values as 0", () => {
  const runs = [
    run("a", hoursAgo(1), { costUsd: 1.25, tokens: 1000 }),
    run("b", hoursAgo(2), { costUsd: null, tokens: null }),
    run("c", hoursAgo(3)),
  ];
  const b = buildBriefing({ ...EMPTY, runs }, hoursAgo(24), NOW);
  assert.equal(b.window.costUsd, 1.25);
  assert.equal(b.window.tokens, 1000);
});

test("attention: down monitors, waiting gates, failing monitors, open issues — in that order", () => {
  const b = buildBriefing(
    {
      runs: [],
      monitors: [
        monitor({ scheduleId: "s-fail", name: "Failing one", status: "failing" }),
        monitor({ scheduleId: "s-down", name: "Down one", status: "down" }),
        monitor({ scheduleId: "s-up", name: "Fine", status: "up" }),
      ],
      issues: [issue(), issue({ fingerprint: "a".repeat(16), state: "resolved" })],
      instances: [
        instance({
          id: "i-gate",
          status: "awaiting-approval",
          endedAt: null,
          phases: [
            {
              id: "ph1",
              name: "Ship",
              gated: true,
              status: "awaiting-approval",
              steps: [],
              attempt: 1,
              payload: null,
            },
          ],
        }),
      ],
    },
    hoursAgo(24),
    NOW,
  );
  assert.deepEqual(
    b.attention.map((a) => a.kind),
    ["monitor-down", "gate-waiting", "monitor-failing", "issue-open"],
  );
  assert.equal(b.attentionCount, 4);
  const gate = b.attention[1];
  assert.equal(gate.id, "i-gate");
  assert.match(gate.title, /Release train/);
  assert.match(gate.detail, /Ship/);
});

test("new issues and finished pipelines are windowed and capped", () => {
  const oldIssue = issue({ fingerprint: "b".repeat(16), firstSeen: hoursAgo(50).toISOString() });
  const freshIssue = issue({ fingerprint: "c".repeat(16), firstSeen: hoursAgo(3).toISOString() });
  const oldInst = instance({ id: "i-old", endedAt: hoursAgo(40).toISOString() });
  const freshInst = instance({ id: "i-new", endedAt: hoursAgo(2).toISOString() });
  const openEnded = instance({ id: "i-live", status: "running", endedAt: null });
  const b = buildBriefing(
    { ...EMPTY, issues: [oldIssue, freshIssue], instances: [oldInst, freshInst, openEnded] },
    hoursAgo(24),
    NOW,
  );
  assert.deepEqual(
    b.window.newIssues.map((i) => i.fingerprint),
    ["c".repeat(16)],
  );
  assert.deepEqual(
    b.window.finishedPipelines.map((i) => i.id),
    ["i-new"],
  );
});
