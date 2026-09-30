import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PipelineInstance } from "@argus/contracts";
import { paths } from "../../claudeHome.js";
import { createAnalysisRunner, type AnalysisSpawn } from "../../sources/analysis.js";
import { appendGateDecision } from "../../sources/gateDecisions.js";
import { writeInstance } from "../../sources/instances.js";
import { writeRun } from "../../sources/runs.js";
import { countAnalysisPasses, createShadowExperiments } from "../experiments.js";
import { endedRun, PROBE_P } from "../h2/testSupport.js";
import { RESIDUAL_P, transcript } from "../testSupport.js";
import { readH1ReportResponse } from "./entry.js";
import { gateInstance, gateRun, H1_ON, MIN } from "./testSupport.js";

/**
 * H1 and H2 together, as `index.ts` runs them (RFC §Q.8): real stores under a
 * temporary Argus home, the real gate review model and gate log, one runner,
 * one injected spawn. At most one provider invocation per tick; H1 first; one
 * combined allowance.
 */

const BOTH = {
  ...H1_ON,
  ARGUS_DECISIONS_H2_COLLECT: "on",
  ARGUS_DECISIONS_H2_PROBE_RATE: "1",
  ARGUS_DECISIONS_H2_RESIDUAL_RATE: "1",
};

async function world(env: Record<string, string>) {
  const home = mkdtempSync(path.join(tmpdir(), "argus-h1-exp-"));
  process.env.ARGUS_CLAUDE_HOME = home;
  mkdirSync(paths.argus(), { recursive: true });
  const T = Date.parse("2026-09-01T12:00:00.000Z");
  let t = T;
  const now = () => new Date(t);
  const spawns: Array<{ prompt: string; at: number }> = [];
  const spawn: AnalysisSpawn = (o) => {
    spawns.push({ prompt: o.prompt, at: t });
    const answer = o.prompt.includes("Will the operator send")
      ? { p: 0.3 }
      : { p: o.prompt.includes("how did this run end") ? PROBE_P : RESIDUAL_P };
    return {
      kill() {},
      done: Promise.resolve({
        code: 0,
        stdout: JSON.stringify({ result: JSON.stringify(answer), total_cost_usd: 0.002 }),
        error: null,
      }),
    };
  };
  const runner = countAnalysisPasses(
    createAnalysisRunner({ spawn, now, blocked: async () => false, meter: async () => {} }),
  );
  const x = createShadowExperiments({ runner, env, now });
  return {
    home,
    T,
    x,
    spawns,
    runner,
    advance(ms: number) {
      t += ms;
    },
    async tick(ms = MIN) {
      t += ms;
      const before = spawns.length;
      await x.check();
      return spawns.length - before;
    },
  };
}

async function gate(inst: PipelineInstance) {
  for (const s of inst.phases[0].steps) await writeRun(gateRun(s.runId!, { instanceId: inst.id }));
  await writeInstance(inst);
}

async function h2Run(id: string, endedAtMs: number) {
  const run = endedRun(id, 0, { endedAt: new Date(endedAtMs).toISOString(), project: "-repo" });
  await writeRun(run);
  const file = path.join(paths.projects(), "-repo", `${run.sessionId}.jsonl`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    transcript()
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n",
  );
}

test("at most one shadow invocation per tick across H1 and H2, H1 first, H2 next when H1 has nothing", async () => {
  const saved = process.env.ARGUS_CLAUDE_HOME;
  try {
    const w = await world(BOTH);
    await w.tick(0); // both record their starts; nothing is called on a first check
    await h2Run("run-h2", w.T + MIN);
    await gate(gateInstance());
    const perTick: number[] = [];
    perTick.push(await w.tick(12 * MIN)); // H1 captures and defers (its first check saw nothing new); H2 censuses
    for (let i = 0; i < 6; i++) perTick.push(await w.tick(16 * MIN));
    assert.ok(
      perTick.every((n) => n <= 1),
      `per tick: ${perTick.join(",")}`,
    );
    assert.ok(w.spawns.length >= 2);
    assert.ok(w.spawns[0].prompt.includes("Will the operator send"), "H1 goes first");
    assert.ok(
      w.spawns
        .slice(1)
        .some((s) => /how did this run end|did not accomplish its task/.test(s.prompt)),
      "then H2",
    );
    const gaps = w.spawns.slice(1).map((s, i) => s.at - w.spawns[i].at);
    assert.ok(
      gaps.every((g) => g >= 15 * MIN),
      "the shared 15-minute interval holds across both",
    );
  } finally {
    process.env.ARGUS_CLAUDE_HOME = saved;
  }
});

test("one combined daily allowance: H2 counts H1's calls, and H1 counts H2's", async () => {
  const saved = process.env.ARGUS_CLAUDE_HOME;
  try {
    const w = await world({ ...BOTH, ARGUS_DECISIONS_H2_MAX_CALLS_PER_DAY: "1" });
    await w.tick(0);
    await h2Run("run-h2", w.T + MIN);
    await gate(gateInstance());
    for (let i = 0; i < 6; i++) await w.tick(16 * MIN);
    // H1 made its call; H2's cap of 1 is then already spent by the pair.
    assert.equal(w.spawns.length, 1);
    assert.match(w.x.h2.status().watcher.detail ?? "", /H1 and H2 combined/);
  } finally {
    process.env.ARGUS_CLAUDE_HOME = saved;
  }
});

test("H2 behaves exactly as alone while the H1 ledger holds no invocation", async () => {
  const saved = process.env.ARGUS_CLAUDE_HOME;
  try {
    const trace = async (env: Record<string, string>) => {
      const w = await world(env);
      await w.tick(0);
      await h2Run("run-1", w.T + MIN);
      await h2Run("run-2", w.T + 2 * MIN);
      const out: string[] = [];
      for (let i = 0; i < 6; i++) {
        await w.tick(16 * MIN);
        out.push(
          `${w.spawns.length}|${w.x.h2.status().watcher.state}|${w.x.h2.status().watcher.detail}`,
        );
      }
      return out;
    };
    const alone = await trace({ ...BOTH, ARGUS_DECISIONS_H1_COLLECT: "off" });
    const beside = await trace(BOTH); // H1 on, with no gate to capture
    assert.deepEqual(beside, alone);
  } finally {
    process.env.ARGUS_CLAUDE_HOME = saved;
  }
});

test("real sources: a gate captured from the real review model settles from the real gate log", async () => {
  const saved = process.env.ARGUS_CLAUDE_HOME;
  try {
    const w = await world({ ...H1_ON });
    const inst = gateInstance();
    await gate(inst);
    await w.tick();
    await w.tick(16 * MIN);
    assert.equal(w.spawns.length, 1);
    // The operator approves: the engine's write-ahead record, then its link.
    await appendGateDecision({
      id: "GD-real",
      instanceId: inst.id,
      pipelineId: inst.pipelineId,
      decision: "approve",
      mechanism: "operator",
      channel: "http",
      principal: { kind: "session", username: "ops", role: "root" },
      phases: [{ phaseId: "publish", attempt: 0, status: "awaiting-approval", runIds: ["run-a"] }],
      recordedAt: new Date(w.T + 30 * MIN).toISOString(),
    });
    inst.gateDecisionIds = ["GD-real"];
    inst.phases[0].status = "succeeded";
    inst.status = "succeeded";
    await writeInstance(inst);
    await w.tick();
    const res = await readH1ReportResponse(() => w.x.h1.status());
    const m = res.report.models[0];
    assert.equal(m.agreement.scored, 1);
    assert.equal(
      m.agreement.agreementAnswered.k,
      1,
      "p = 0.3 predicts approve; the operator approved",
    );
    assert.equal(res.report.census[0].labeled.approve, 1);
    assert.equal(res.report.integrity.history, "complete");
  } finally {
    process.env.ARGUS_CLAUDE_HOME = saved;
  }
});

test("reading the report creates nothing and calls nothing, with collection on or off", async () => {
  const saved = process.env.ARGUS_CLAUDE_HOME;
  try {
    const w = await world(BOTH);
    const res = await readH1ReportResponse(() => w.x.h1.status());
    assert.equal(res.report.pending.total, 0);
    assert.equal(res.collection.enabled, true);
    const off = await readH1ReportResponse(undefined, {});
    assert.equal(off.collection.enabled, false);
    assert.equal(w.spawns.length, 0);
    assert.ok(!existsSync(path.join(paths.argus(), "decision-experiments")));
    assert.ok(!existsSync(path.join(paths.argus(), "decisions")));
  } finally {
    process.env.ARGUS_CLAUDE_HOME = saved;
  }
});
