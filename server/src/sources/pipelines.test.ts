import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-pipelines-"));
  process.env.ARGUS_CLAUDE_HOME = home;
});

async function fresh() {
  return import(`./pipelines.js?${Math.random()}`);
}

const goodInput = (over: Record<string, unknown> = {}) => ({
  name: "feature pipeline",
  phases: [
    { id: "brainstorm", name: "Brainstorm", cwd: home, gated: true, steps: [{ name: "bs", prompt: "go" }] },
    { id: "plan", name: "Plan", cwd: home, gated: false, steps: [{ name: "wp", prompt: "plan {{previous.payload}}" }] },
  ],
  trigger: null,
  ...over,
});

test("create then read round-trips a definition", async () => {
  const m = await fresh();
  const created = await m.createPipeline(m.validatePipelineInput(goodInput()), new Date(2026, 5, 30, 9, 0), "p1");
  assert.equal(created.id, "p1");
  assert.equal(created.phases.length, 2);
  assert.equal(created.enabled, true);
  assert.equal(created.lastStartedAt, null);
  const all = await m.readPipelines();
  assert.equal(all.length, 1);
  assert.equal(all[0].name, "feature pipeline");
});

test("validation rejects empty phases", async () => {
  const m = await fresh();
  assert.throws(() => m.validatePipelineInput(goodInput({ phases: [] })), /at least one phase/);
});

test("validation rejects a phase with no steps", async () => {
  const m = await fresh();
  const bad = goodInput({ phases: [{ id: "x", name: "X", cwd: home, gated: false, steps: [] }] });
  assert.throws(() => m.validatePipelineInput(bad), /at least one step/);
});

test("validation rejects a non-existent cwd", async () => {
  const m = await fresh();
  const bad = goodInput({ phases: [{ id: "x", name: "X", cwd: path.join(home, "nope"), gated: false, steps: [{ name: "s", prompt: "p" }] }] });
  assert.throws(() => m.validatePipelineInput(bad), /cwd does not exist/);
});

test("markPipelineStarted updates lastStartedAt", async () => {
  const m = await fresh();
  await m.createPipeline(m.validatePipelineInput(goodInput()), new Date(2026, 5, 30, 9, 0), "p1");
  await m.markPipelineStarted("p1", "2026-06-30T10:00:00.000Z");
  const all = await m.readPipelines();
  assert.equal(all[0].lastStartedAt, "2026-06-30T10:00:00.000Z");
});

test("deletePipeline removes it", async () => {
  const m = await fresh();
  await m.createPipeline(m.validatePipelineInput(goodInput()), new Date(2026, 5, 30, 9, 0), "p1");
  assert.equal(await m.deletePipeline("p1"), true);
  assert.equal((await m.readPipelines()).length, 0);
  assert.equal(await m.deletePipeline("p1"), false);
});
