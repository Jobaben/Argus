import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWatchtowerWatcher } from "./watchtowerWatcher.js";
import type { Anomaly } from "./sources/watchtower.js";
import type { Run } from "./sources/scheduleTypes.js";

beforeEach(() => {
  const home = mkdtempSync(path.join(tmpdir(), "argus-wtw-"));
  mkdirSync(path.join(home, "argus"), { recursive: true });
  process.env.ARGUS_CLAUDE_HOME = home;
});

const NOW = new Date("2026-07-20T12:00:00.000Z");
let seq = 0;

function run(over: Partial<Run> = {}): Run {
  seq += 1;
  const at = new Date(NOW.getTime() - seq * 3_600_000).toISOString();
  return {
    id: `r${seq}`,
    scheduleId: "s1",
    scheduleName: "Nightly triage",
    prompt: "p",
    cwd: "/tmp",
    status: "succeeded",
    trigger: "scheduled",
    queuedAt: at,
    startedAt: at,
    endedAt: at,
    durationMs: 60_000 + (seq % 3) * 500,
    pid: 1,
    exitCode: 0,
    sessionId: null,
    project: null,
    resultSummary: null,
    error: null,
    costUsd: 0.1,
    tokens: 1000,
    ...over,
  };
}

const healthy = (n = 12) => Array.from({ length: n }, () => run());

test("the first pass after boot is a silent baseline", async () => {
  const runs = [...healthy(), run({ costUsd: 5 })];
  const seen: Anomaly[] = [];
  const watcher = createWatchtowerWatcher({
    now: () => NOW,
    readRuns: async () => runs,
    onAnomaly: (a) => seen.push(a),
  });

  await watcher.check();
  assert.equal(seen.length, 0, "a restart must not replay history into the bell");
});

test("only anomalies new since the previous pass are reported, and never twice", async () => {
  const runs = healthy();
  const seen: Anomaly[] = [];
  const watcher = createWatchtowerWatcher({
    now: () => NOW,
    readRuns: async () => runs,
    onAnomaly: (a) => seen.push(a),
  });

  await watcher.check(); // baseline
  runs.unshift(run({ costUsd: 5, durationMs: 60_000, tokens: 1000 }));
  await watcher.check();
  assert.ok(seen.length > 0, "the spike was reported");
  const first = seen.length;

  await watcher.check();
  assert.equal(seen.length, first, "the same run is not reported a second time");
});

test("regression: a handler that throws does not stop the remaining anomalies", async () => {
  const runs = healthy();
  const seen: string[] = [];
  const watcher = createWatchtowerWatcher({
    now: () => NOW,
    readRuns: async () => runs,
    onAnomaly: (a) => {
      seen.push(a.metric);
      if (seen.length === 1) throw new Error("bell exploded");
    },
  });

  await watcher.check();
  // One run that is anomalous on all three metrics at once.
  runs.unshift(run({ costUsd: 5, durationMs: 900_000, tokens: 500_000 }));
  await watcher.check();
  assert.equal(seen.length, 3, "all three metrics still reached the handler");
});

test("a read failure is swallowed rather than wedging the scheduler tick", async () => {
  const watcher = createWatchtowerWatcher({
    now: () => NOW,
    readRuns: () => Promise.reject(new Error("disk gone")),
    onAnomaly: () => assert.fail("nothing should be reported"),
  });
  await watcher.check();
  await watcher.check();
});
