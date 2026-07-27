import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AUTOPSY_MAX_AGE_MS, createAutopsyWatcher } from "./autopsyWatcher.js";
import { readAutopsies } from "./sources/autopsy.js";
import { createAnalysisRunner, type AnalysisSpawn } from "./sources/analysis.js";
import type { Run } from "./sources/scheduleTypes.js";

beforeEach(() => {
  const home = mkdtempSync(path.join(tmpdir(), "argus-autopsyw-"));
  mkdirSync(path.join(home, "argus"), { recursive: true });
  process.env.ARGUS_CLAUDE_HOME = home;
  delete process.env.ARGUS_ANALYSIS;
});

const NOW = new Date("2026-07-20T12:00:00.000Z");

function run(id: string, over: Partial<Run> = {}): Run {
  const at = new Date(NOW.getTime() - 60_000).toISOString();
  return {
    id,
    scheduleId: "s1",
    scheduleName: "Nightly triage",
    prompt: "p",
    cwd: "/tmp",
    status: "failed",
    trigger: "scheduled",
    queuedAt: at,
    startedAt: at,
    endedAt: at,
    durationMs: 1000,
    pid: null,
    exitCode: 1,
    sessionId: null,
    project: null,
    resultSummary: null,
    error: "boom",
    ...over,
  };
}

const ANSWER = JSON.stringify({
  failureClass: "tool-error",
  confidence: 0.6,
  why: "The build step invoked a binary that is not installed in this environment.",
  span: null,
  promptDelta: null,
  deltaRationale: null,
});

const spawnOk: AnalysisSpawn = () => ({
  kill: () => {},
  done: Promise.resolve({
    code: 0,
    stdout: JSON.stringify({ result: ANSWER, total_cost_usd: 0.001 }),
    error: null,
  }),
});

function watcher(runs: Run[], spawn: AnalysisSpawn = spawnOk) {
  const seen: string[] = [];
  const w = createAutopsyWatcher({
    runner: createAnalysisRunner({ spawn, now: () => NOW, meter: async () => {} }),
    now: () => NOW,
    readLines: async () => [],
    readRuns: async () => runs,
    onAutopsy: (id) => seen.push(id),
  });
  return { w, seen };
}

test("regression: a backlog drains one per tick instead of spawning all at once", async () => {
  const runs = ["a", "b", "c"].map((id) => run(id));
  const { w, seen } = watcher(runs);

  await w.check();
  assert.equal(seen.length, 1, "one pass per tick");
  await w.check();
  await w.check();
  assert.equal(seen.length, 3);
  await w.check();
  assert.equal(seen.length, 3, "nothing left to analyse");
  assert.equal((await readAutopsies()).length, 3);
});

test("the newest failure is analysed first — it is the one being looked at", async () => {
  const older = run("older", {
    endedAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
  });
  const newer = run("newer", { endedAt: new Date(NOW.getTime() - 60_000).toISOString() });
  const { w, seen } = watcher([older, newer]);
  await w.check();
  assert.deepEqual(seen, ["newer"]);
});

test("successful runs are never autopsied", async () => {
  const { w, seen } = watcher([run("ok", { status: "succeeded", exitCode: 0, error: null })]);
  await w.check();
  assert.equal(seen.length, 0);
});

test("stale failures are left for the on-demand route", async () => {
  const ancient = new Date(NOW.getTime() - AUTOPSY_MAX_AGE_MS - 3_600_000).toISOString();
  const { w, seen } = watcher([
    run("old", { endedAt: ancient, startedAt: ancient, queuedAt: ancient }),
  ]);
  await w.check();
  assert.equal(seen.length, 0, "nobody triages Tuesday's failure from a Thursday toast");
});

test("regression: a pass that fails is recorded, so the run is not retried every tick", async () => {
  const badSpawn: AnalysisSpawn = () => ({
    kill: () => {},
    done: Promise.resolve({ code: 1, stdout: "", error: "spawn claude ENOENT" }),
  });
  const { w, seen } = watcher([run("a")], badSpawn);
  await w.check();
  await w.check();
  assert.equal(seen.length, 1, "the failed attempt was recorded, not retried");
  const stored = await readAutopsies();
  assert.equal(stored[0].status, "failed");
  assert.match(stored[0].error ?? "", /ENOENT/);
});

test("a read failure is swallowed rather than wedging the scheduler tick", async () => {
  const w = createAutopsyWatcher({
    runner: createAnalysisRunner({ spawn: spawnOk, now: () => NOW, meter: async () => {} }),
    now: () => NOW,
    readLines: async () => [],
    readRuns: () => Promise.reject(new Error("disk gone")),
  });
  await w.check();
});
