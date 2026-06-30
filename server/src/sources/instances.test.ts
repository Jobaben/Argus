import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-instances-"));
  process.env.ARGUS_CLAUDE_HOME = home;
});

async function fresh() {
  return import(`./instances.js?${Math.random()}`);
}

const makeInstance = (id: string, pipelineId: string, createdAt: string) => ({
  id,
  pipelineId,
  pipelineName: "feature pipeline",
  status: "running" as const,
  currentPhaseIndex: 0,
  phases: [{ id: "p0", name: "P0", gated: false, status: "running" as const, steps: [], attempt: 0, payload: null }],
  trigger: "manual" as const,
  signalToken: "tok",
  createdAt,
  updatedAt: createdAt,
  endedAt: null,
});

test("writeInstance then readInstance round-trips", async () => {
  const m = await fresh();
  await m.writeInstance(makeInstance("i1", "p1", new Date(2026, 5, 30, 9, 0).toISOString()));
  const got = await m.readInstance("i1");
  assert.equal(got?.id, "i1");
  assert.equal(got?.signalToken, "tok");
});

test("readInstances filters by pipeline, newest first", async () => {
  const m = await fresh();
  await m.writeInstance(makeInstance("a", "p1", new Date(2026, 5, 30, 9, 0).toISOString()));
  await m.writeInstance(makeInstance("b", "p1", new Date(2026, 5, 30, 10, 0).toISOString()));
  await m.writeInstance(makeInstance("c", "p2", new Date(2026, 5, 30, 11, 0).toISOString()));
  const p1 = await m.readInstances({ pipelineId: "p1" });
  assert.deepEqual(p1.map((i: { id: string }) => i.id), ["b", "a"]);
});

test("pruneInstances keeps only newest N of a pipeline", async () => {
  const m = await fresh();
  for (let i = 0; i < 5; i++) {
    await m.writeInstance(makeInstance(`r${i}`, "p1", new Date(2026, 5, 30, 9, i).toISOString()));
  }
  await m.pruneInstances("p1", 2);
  const left = await m.readInstances({ pipelineId: "p1" });
  assert.deepEqual(left.map((i: { id: string }) => i.id), ["r4", "r3"]);
});

test("readInstance rejects path-traversal ids", async () => {
  const m = await fresh();
  assert.equal(await m.readInstance("../../../etc/passwd"), null);
  assert.equal(await m.readInstance("a/b"), null);
});
