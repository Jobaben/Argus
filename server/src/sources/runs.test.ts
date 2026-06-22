import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-runs-"));
  process.env.ARGUS_CLAUDE_HOME = home;
});

async function fresh() {
  return import(`./runs.js?${Math.random()}`);
}

const makeRun = (id: string, scheduleId: string, queuedAt: string) => ({
  id,
  scheduleId,
  scheduleName: "n",
  prompt: "p",
  cwd: "/tmp",
  status: "succeeded" as const,
  trigger: "scheduled" as const,
  queuedAt,
  startedAt: queuedAt,
  endedAt: queuedAt,
  durationMs: 10,
  pid: 123,
  exitCode: 0,
  sessionId: "sess-1",
  project: null,
  resultSummary: "ok",
  error: null,
});

test("encodeProject mirrors Claude Code's dir encoding", async () => {
  const m = await fresh();
  assert.equal(m.encodeProject("C:\\GIT\\argus"), "C--GIT-argus");
});

test("writeRun then readRun round-trips with a log tail", async () => {
  const m = await fresh();
  const run = makeRun("r1", "s1", new Date(2026, 5, 22, 10, 0).toISOString());
  await m.writeRun(run);
  writeFileSync(m.runLogPath("r1"), "hello log");
  const got = await m.readRun("r1");
  assert.equal(got?.run.id, "r1");
  assert.equal(got?.log, "hello log");
});

test("readRuns returns newest first and filters by schedule", async () => {
  const m = await fresh();
  await m.writeRun(makeRun("a", "s1", new Date(2026, 5, 22, 10, 0).toISOString()));
  await m.writeRun(makeRun("b", "s1", new Date(2026, 5, 22, 11, 0).toISOString()));
  await m.writeRun(makeRun("c", "s2", new Date(2026, 5, 22, 12, 0).toISOString()));
  const s1 = await m.readRuns({ scheduleId: "s1" });
  assert.deepEqual(s1.map((r: { id: string }) => r.id), ["b", "a"]);
});

test("pruneRuns keeps only the newest N of a schedule", async () => {
  const m = await fresh();
  for (let i = 0; i < 5; i++) {
    await m.writeRun(makeRun(`r${i}`, "s1", new Date(2026, 5, 22, 10, i).toISOString()));
  }
  await m.pruneRuns("s1", 2);
  const left = await m.readRuns({ scheduleId: "s1" });
  assert.deepEqual(left.map((r: { id: string }) => r.id), ["r4", "r3"]);
});
