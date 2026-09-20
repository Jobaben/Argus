import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { retryNote, failureClassOfRecord } from "./pipelineEngine.js";
import { phaseArtifactDir } from "./harness/invocation.js";
import { paths } from "./claudeHome.js";
import { isAlive } from "./scheduler.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-engine-harness-"));
  process.env.ARGUS_CLAUDE_HOME = home;
});

// Static imports: every module resolves its paths lazily from the per-test
// home, so a fresh module instance per test buys nothing — and a cache-busting
// query string makes the coverage tool see only one instance's execution.
import * as engineMod from "./pipelineEngine.js";
import * as pipelinesMod from "./sources/pipelines.js";
import * as instancesMod from "./sources/instances.js";
import * as runsMod from "./sources/runs.js";
import * as journalMod from "./sources/journal.js";

async function load() {
  // Loosely typed, as the dynamic imports these replaced were: the tests read
  // the modules' shapes at runtime and assert on persisted records.
  return {
    engine: engineMod as any,
    pipelines: pipelinesMod as any,
    instances: instancesMod as any,
    runsSrc: runsMod as any,
    journalSrc: journalMod as any,
  };
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

let counter = 0;
function deferred() {
  let resolve!: (v: { code: number | null }) => void;
  const promise = new Promise<{ code: number | null }>((r) => (resolve = r));
  return { promise, resolve };
}

const baseDeps = (over: Record<string, unknown> = {}) => ({
  now: () => new Date(2026, 5, 30, 12, 0),
  newId: () => `id-${++counter}`,
  signalUrlBase: "http://localhost:7777",
  maxConcurrent: 4,
  tickMs: 30000,
  // A controlled parent environment: an ordinary var, a home var, an Argus
  // secret, and a var no baseline/allowlist recognizes.
  parentEnv: { PATH: "/bin", HOME: "/h", ARGUS_TOKEN: "secret", MY_SECRET: "x" },
  ...over,
});

// Records every spawn call in full — the run, the raw env, and the prepared
// invocation the harness built — so tests can assert on any of them.
function recordingSpawn() {
  const calls: { run: any; env: Record<string, string>; prepared: any }[] = [];
  const dones: ReturnType<typeof deferred>[] = [];
  const spawn = (run: any, _log: string, env: Record<string, string>, prepared: any) => {
    calls.push({ run, env, prepared });
    const d = deferred();
    dones.push(d);
    return { pid: 1000 + calls.length, done: d.promise };
  };
  return { spawn, calls, dones };
}

async function seed(pipelines: any, phases: unknown[], over: Record<string, unknown> = {}) {
  return pipelines.createPipeline(
    pipelines.validatePipelineInput({ name: "feature", phases, ...over }),
    new Date(2026, 5, 30, 9, 0),
    "p1",
  );
}

// ── 1. start() prepares and records the invocation ──────────────────────────

test("start passes a prepared invocation to spawn, and it is readable back off disk", async () => {
  const { engine, pipelines, runsSrc } = await load();
  await seed(pipelines, [
    { id: "only", name: "Only", cwd: home, gated: false, steps: [{ name: "s", prompt: "p" }] },
  ]);
  const rec = recordingSpawn();
  const e = engine.createEngine(baseDeps({ spawn: rec.spawn }));
  const inst = await e.start("p1", "manual");
  assert.ok(inst);
  assert.equal(rec.calls.length, 1);

  const { env: rawEnv, prepared } = rec.calls[0];
  assert.equal(rawEnv.ARGUS_TOKEN, undefined);
  assert.equal(prepared.env.ARGUS_TOKEN, undefined);
  assert.equal(prepared.env.PATH, "/bin");
  assert.equal(prepared.env.ARGUS_SIGNAL_TOKEN, inst!.signalToken);
  assert.ok(prepared.env.ARGUS_ARTIFACT_DIR);
  assert.ok(prepared.record.envStripped.includes("ARGUS_TOKEN"));

  const runId = inst!.phases[0].steps[0].runId;
  const record = await runsSrc.readInvocation(runId);
  assert.ok(record);
  assert.ok(record.bin);
  assert.ok(Array.isArray(record.args) && record.args.length > 0);
  assert.equal(record.cwd, home);
  assert.equal(record.runtime, "claude");
  assert.equal(record.capabilities, null);
  assert.equal(record.deadlineAt, null);
});

// ── 2. env inherit: minimal ──────────────────────────────────────────────────

test("phase capabilities env inherit minimal denies a non-baseline variable", async () => {
  const { engine, pipelines } = await load();
  await seed(pipelines, [
    {
      id: "only",
      name: "Only",
      cwd: home,
      gated: false,
      capabilities: { env: { inherit: "minimal" } },
      steps: [{ name: "s", prompt: "p" }],
    },
  ]);
  const rec = recordingSpawn();
  const e = engine.createEngine(baseDeps({ spawn: rec.spawn }));
  await e.start("p1", "manual");
  assert.equal(rec.calls[0].prepared.env.PATH, "/bin");
  assert.equal(rec.calls[0].prepared.env.MY_SECRET, undefined);
});

test("phase capabilities env inherit minimal + allow lets the named variable through", async () => {
  const { engine, pipelines } = await load();
  await seed(pipelines, [
    {
      id: "only",
      name: "Only",
      cwd: home,
      gated: false,
      capabilities: { env: { inherit: "minimal", allow: ["MY_*"] } },
      steps: [{ name: "s", prompt: "p" }],
    },
  ]);
  const rec = recordingSpawn();
  const e = engine.createEngine(baseDeps({ spawn: rec.spawn }));
  await e.start("p1", "manual");
  assert.equal(rec.calls[0].prepared.env.PATH, "/bin");
  assert.equal(rec.calls[0].prepared.env.MY_SECRET, "x");
});

// ── 3. capability files are materialized ────────────────────────────────────

test("an mcpServers profile materializes mcp.json and a Stop-hook settings.json", async () => {
  const { engine, pipelines, runsSrc } = await load();
  await seed(pipelines, [
    {
      id: "only",
      name: "Only",
      cwd: home,
      gated: false,
      capabilities: { mcpServers: {} },
      steps: [{ name: "s", prompt: "p" }],
    },
  ]);
  const rec = recordingSpawn();
  const e = engine.createEngine(baseDeps({ spawn: rec.spawn }));
  const inst = await e.start("p1", "manual");

  const { prepared } = rec.calls[0];
  assert.ok(prepared.plan.args.includes("--strict-mcp-config"));
  const mcpFile = prepared.files.find((f: { path: string }) => f.path.endsWith("mcp.json"));
  const settingsFile = prepared.files.find((f: { path: string }) =>
    f.path.endsWith("settings.json"),
  );
  assert.ok(mcpFile, "expected an mcp.json in prepared.files");
  assert.ok(settingsFile, "expected a settings.json in prepared.files");
  assert.ok(existsSync(mcpFile.path));
  assert.ok(existsSync(settingsFile.path));

  const settingsJson = JSON.parse(readFileSync(settingsFile.path, "utf8"));
  assert.ok(settingsJson.hooks.Stop[0].hooks[0].command);

  const runId = inst!.phases[0].steps[0].runId;
  const record = await runsSrc.readInvocation(runId);
  assert.ok(record.materializedFiles.some((p: string) => p.endsWith("mcp.json")));
  assert.ok(record.materializedFiles.some((p: string) => p.endsWith("settings.json")));
});

// ── 4. pipeline + phase capability merge ────────────────────────────────────

test("pipeline-level and phase-level capabilities merge by key", async () => {
  const { engine, pipelines, runsSrc } = await load();
  await seed(
    pipelines,
    [
      {
        id: "only",
        name: "Only",
        cwd: home,
        gated: false,
        capabilities: { filesystem: "read-only" },
        steps: [{ name: "s", prompt: "p" }],
      },
    ],
    { capabilities: { env: { inherit: "minimal" } } },
  );
  const rec = recordingSpawn();
  const e = engine.createEngine(baseDeps({ spawn: rec.spawn }));
  const inst = await e.start("p1", "manual");
  const runId = inst!.phases[0].steps[0].runId;
  const record = await runsSrc.readInvocation(runId);
  assert.deepEqual(record.capabilities, {
    env: { inherit: "minimal" },
    filesystem: "read-only",
  });
});

// ── 5. strict enforcement refuses to launch; best-effort launches anyway ────

test("strict enforcement fails the phase as configuration and never spawns", async () => {
  const { engine, pipelines, instances, runsSrc } = await load();
  await seed(pipelines, [
    {
      id: "only",
      name: "Only",
      cwd: home,
      gated: false,
      runtime: "opencode",
      capabilities: { tools: { allow: ["Read"] } },
      retry: { attempts: 3, backoffSeconds: 0 },
      steps: [{ name: "s", prompt: "p" }],
    },
  ]);
  const rec = recordingSpawn();
  const e = engine.createEngine(baseDeps({ spawn: rec.spawn }));
  const inst = await e.start("p1", "manual");
  assert.equal(rec.calls.length, 0);

  const after = await instances.readInstance(inst!.id);
  assert.equal(after.status, "failed");
  assert.equal(after.phases[0].status, "failed");
  assert.equal((after.phases[0].payload as any).failureClass, "configuration");
  assert.equal(after.phases[0].retryAt, undefined);

  const runId = after.phases[0].steps[0].runId;
  const run = await runsSrc.readRun(runId);
  assert.equal(run!.run.termination, "spawn-failed");

  await e.reconcile();
  assert.equal(rec.calls.length, 0);
});

test("best-effort enforcement launches anyway and records the limitation", async () => {
  const { engine, pipelines, instances, runsSrc } = await load();
  await seed(pipelines, [
    {
      id: "only",
      name: "Only",
      cwd: home,
      gated: false,
      runtime: "opencode",
      capabilities: { tools: { allow: ["Read"] }, enforcement: "best-effort" },
      steps: [{ name: "s", prompt: "p" }],
    },
  ]);
  const rec = recordingSpawn();
  const e = engine.createEngine(baseDeps({ spawn: rec.spawn }));
  const inst = await e.start("p1", "manual");
  assert.equal(rec.calls.length, 1);
  const after = await instances.readInstance(inst!.id);
  const runId = after.phases[0].steps[0].runId;
  const record = await runsSrc.readInvocation(runId);
  assert.ok(record.limitations.length > 0);
});

// ── 6. deadline enforcement ──────────────────────────────────────────────────

test("a step past its deadline is killed, timed out, and failed", async () => {
  const { engine, pipelines, instances, runsSrc, journalSrc } = await load();
  await seed(pipelines, [
    {
      id: "only",
      name: "Only",
      cwd: home,
      gated: false,
      timeoutSeconds: 1,
      steps: [{ name: "s", prompt: "p" }],
    },
  ]);
  const killed: number[] = [];
  let resolveDone!: (v: { code: number | null }) => void;
  const donePromise = new Promise<{ code: number | null }>((r) => (resolveDone = r));
  const spawn = () => ({ pid: 777, done: donePromise });
  // Only records the kill; the process's own exit (the `done` resolution) is
  // simulated separately, below, once the deadline handler has certainly
  // finished — see the note there for why the two must not be simultaneous.
  const kill = (pid: number) => {
    killed.push(pid);
    return true;
  };
  const e = engine.createEngine(baseDeps({ spawn, kill, killGraceMs: 50, now: () => new Date() }));
  const inst = await e.start("p1", "manual");
  const runId = inst!.phases[0].steps[0].runId;

  // The deadline handler (expireStep -> failStep) fails the phase from the
  // *run record*, independent of the spawned process actually exiting.
  await waitFor(async () => (await instances.readInstance(inst!.id)).phases[0].status === "failed");
  assert.deepEqual(killed, [777]);

  const timedOut = await runsSrc.readRun(runId);
  assert.equal(timedOut!.run.termination, "timed-out");
  assert.match(timedOut!.run.error, /timed out after 1s/);

  const after = await instances.readInstance(inst!.id);
  assert.equal(after.status, "failed");
  assert.equal((after.phases[0].payload as any).failureClass, "timeout");
  assert.equal((after.phases[0].payload as any).kind, "timed-out");

  const j = await journalSrc.readJournal(inst!.id);
  assert.ok(j.some((entry: any) => entry.kind === "step.timed-out"));

  // Only *now* does the process actually die (its exit reaching Argus well
  // after the deadline handler's own bookkeeping — the realistic order, since
  // a signal is not instant teardown): the run's own status catches up.
  resolveDone({ code: null });
  await waitFor(async () => (await runsSrc.readRun(runId))?.run.status === "failed");
});

test("a completion signal that beats the deadline wins, permanently", async () => {
  const { engine, pipelines, instances, runsSrc } = await load();
  await seed(pipelines, [
    {
      id: "only",
      name: "Only",
      cwd: home,
      gated: false,
      timeoutSeconds: 1,
      steps: [{ name: "s", prompt: "p" }],
    },
  ]);
  const killed: number[] = [];
  const d = deferred();
  const spawn = () => ({ pid: 778, done: d.promise });
  const kill = (pid: number) => {
    killed.push(pid);
    return true;
  };
  const e = engine.createEngine(baseDeps({ spawn, kill, killGraceMs: 50, now: () => new Date() }));
  const inst = await e.start("p1", "manual");
  const runId = inst!.phases[0].steps[0].runId;

  await e.onSignal(inst!.id, {
    instanceId: inst!.id,
    phaseId: "only",
    runId,
    type: "completed",
    token: inst!.signalToken,
  });
  d.resolve({ code: 0 });

  await waitFor(async () => (await runsSrc.readRun(runId))?.run.status === "succeeded");
  // Give the deadline timer (due at ~1s) every chance to fire and prove it is a no-op.
  await new Promise((r) => setTimeout(r, 1500));

  const after = await instances.readInstance(inst!.id);
  assert.equal(after.status, "succeeded");
  assert.equal(after.phases[0].status, "succeeded");
  assert.equal(killed.length, 0);
});

// ── 7-8. verification ────────────────────────────────────────────────────────

test("a passing verification concludes the phase and starts the next one", async () => {
  const { engine, pipelines, instances, journalSrc } = await load();
  await seed(pipelines, [
    {
      id: "checked",
      name: "Checked",
      cwd: home,
      gated: false,
      checks: [{ kind: "command", run: "exit 0", label: "ok" }],
      steps: [{ name: "s", prompt: "p" }],
    },
    {
      id: "next",
      name: "Next",
      cwd: home,
      gated: false,
      needs: ["checked"],
      steps: [{ name: "n", prompt: "n" }],
    },
  ]);
  const rec = recordingSpawn();
  const e = engine.createEngine(baseDeps({ spawn: rec.spawn }));
  const inst = await e.start("p1", "manual");
  const runId = inst!.phases[0].steps[0].runId;

  await e.onSignal(inst!.id, {
    instanceId: inst!.id,
    phaseId: "checked",
    runId,
    type: "completed",
    token: inst!.signalToken,
  });
  await e.drain();

  const after = await instances.readInstance(inst!.id);
  assert.equal(after.phases[0].status, "succeeded");
  assert.equal(after.phases[0].verification.status, "passed");
  assert.equal(after.phases[0].verification.checks[0].label, "ok");
  assert.equal(rec.calls.length, 2);

  const j = await journalSrc.readJournal(inst!.id);
  assert.ok(j.some((entry: any) => entry.kind === "phase.verifying"));
  assert.ok(j.some((entry: any) => entry.kind === "phase.verified"));
});

test("a failing verification fails the phase and never starts the next one", async () => {
  const { engine, pipelines, instances } = await load();
  let failures = 0;
  await seed(pipelines, [
    {
      id: "checked",
      name: "Checked",
      cwd: home,
      gated: false,
      checks: [{ kind: "command", run: "exit 1", label: "bad" }],
      steps: [{ name: "s", prompt: "p" }],
    },
    {
      id: "next",
      name: "Next",
      cwd: home,
      gated: false,
      needs: ["checked"],
      steps: [{ name: "n", prompt: "n" }],
    },
  ]);
  const rec = recordingSpawn();
  const e = engine.createEngine(baseDeps({ spawn: rec.spawn, onFailure: () => failures++ }));
  const inst = await e.start("p1", "manual");
  const runId = inst!.phases[0].steps[0].runId;

  await e.onSignal(inst!.id, {
    instanceId: inst!.id,
    phaseId: "checked",
    runId,
    type: "completed",
    token: inst!.signalToken,
  });
  await e.drain();

  const after = await instances.readInstance(inst!.id);
  assert.equal(after.phases[0].status, "failed");
  assert.equal((after.phases[0].payload as any).failureClass, "verification");
  assert.match((after.phases[0].payload as any).reason, /bad/);
  assert.equal(rec.calls.length, 1);
  assert.equal(after.status, "failed");
  assert.equal(failures, 1);
});

// ── 9. verification + gate ordering ─────────────────────────────────────────

test("a failing check never lets a gated phase reach awaiting-approval", async () => {
  const { engine, pipelines, instances } = await load();
  await seed(pipelines, [
    {
      id: "gated",
      name: "Gated",
      cwd: home,
      gated: true,
      checks: [{ kind: "command", run: "exit 1" }],
      steps: [{ name: "s", prompt: "p" }],
    },
  ]);
  const rec = recordingSpawn();
  const e = engine.createEngine(baseDeps({ spawn: rec.spawn }));
  const inst = await e.start("p1", "manual");
  const runId = inst!.phases[0].steps[0].runId;

  await e.onSignal(inst!.id, {
    instanceId: inst!.id,
    phaseId: "gated",
    runId,
    type: "completed",
    token: inst!.signalToken,
  });
  await e.drain();

  const after = await instances.readInstance(inst!.id);
  assert.equal(after.phases[0].status, "failed");
});

test("a passing check still waits at the gate, and approve advances past it", async () => {
  const { engine, pipelines, instances } = await load();
  await seed(pipelines, [
    {
      id: "gated",
      name: "Gated",
      cwd: home,
      gated: true,
      checks: [{ kind: "command", run: "exit 0" }],
      steps: [{ name: "s", prompt: "p" }],
    },
    {
      id: "after",
      name: "After",
      cwd: home,
      gated: false,
      needs: ["gated"],
      steps: [{ name: "n", prompt: "n" }],
    },
  ]);
  const rec = recordingSpawn();
  const e = engine.createEngine(baseDeps({ spawn: rec.spawn }));
  const inst = await e.start("p1", "manual");
  const runId = inst!.phases[0].steps[0].runId;

  await e.onSignal(inst!.id, {
    instanceId: inst!.id,
    phaseId: "gated",
    runId,
    type: "completed",
    token: inst!.signalToken,
  });
  await e.drain();

  const paused = await instances.readInstance(inst!.id);
  assert.equal(paused.phases[0].status, "awaiting-approval");
  assert.equal(rec.calls.length, 1);

  await e.approve(inst!.id);
  const after = await instances.readInstance(inst!.id);
  assert.equal(after.phases[0].status, "succeeded");
  assert.equal(rec.calls.length, 2);
});

// ── 10. verification retry note ─────────────────────────────────────────────

test("a verification-triggered retry carries a repair note naming the failed check", async () => {
  const { engine, pipelines, instances } = await load();
  await seed(pipelines, [
    {
      id: "checked",
      name: "Checked",
      cwd: home,
      gated: false,
      retry: { attempts: 2, backoffSeconds: 0, retryOn: ["verification"] },
      checks: [{ kind: "file", path: "missing.txt" }],
      steps: [{ name: "s", prompt: "p" }],
    },
  ]);
  const rec = recordingSpawn();
  const e = engine.createEngine(baseDeps({ spawn: rec.spawn }));
  const inst = await e.start("p1", "manual");
  const runId = inst!.phases[0].steps[0].runId;

  await e.onSignal(inst!.id, {
    instanceId: inst!.id,
    phaseId: "checked",
    runId,
    type: "completed",
    token: inst!.signalToken,
  });
  await e.drain();

  await e.reconcile();
  await waitFor(() => rec.calls.length === 2);

  const retryRun = rec.calls[1].run;
  assert.match(retryRun.prompt, /Previous attempt \(1 of 2\) failed — verification:/);
  assert.match(retryRun.prompt, /missing\.txt/);

  const after = await instances.readInstance(inst!.id);
  assert.equal(after.phases[0].attempt, 1);
  assert.equal(after.phases[0].retries, 1);
  assert.equal(after.phases[0].verification, undefined);
});

// ── 11. artifact directory ───────────────────────────────────────────────────

test("artifact directories are per-phase, reset on revise, and interpolate across phases", async () => {
  const { engine, pipelines, instances } = await load();
  await seed(pipelines, [
    { id: "one", name: "One", cwd: home, gated: false, steps: [{ name: "a", prompt: "p" }] },
    {
      id: "two",
      name: "Two",
      cwd: home,
      gated: false,
      needs: ["one"],
      steps: [{ name: "b", prompt: "prev={{artifactDir.one}} own={{artifactDir}}" }],
    },
  ]);
  const rec = recordingSpawn();
  const e = engine.createEngine(baseDeps({ spawn: rec.spawn }));
  const inst = await e.start("p1", "manual");

  const firstArtifactDir = inst!.phases[0].artifactDir;
  assert.ok(firstArtifactDir);
  assert.equal(rec.calls[0].prepared.env.ARGUS_ARTIFACT_DIR, firstArtifactDir);
  assert.equal(firstArtifactDir, phaseArtifactDir(paths.artifactsDir(), inst!.id, "one"));
  assert.ok(existsSync(firstArtifactDir));

  writeFileSync(path.join(firstArtifactDir, "stale.txt"), "leftover", "utf8");

  const runId1 = inst!.phases[0].steps[0].runId;
  await e.onSignal(inst!.id, {
    instanceId: inst!.id,
    phaseId: "one",
    runId: runId1,
    type: "failed",
    token: inst!.signalToken,
  });
  await e.revise(inst!.id);

  assert.deepEqual(readdirSync(firstArtifactDir), []);

  const afterRevise = await instances.readInstance(inst!.id);
  const runId2 = afterRevise.phases[0].steps[0].runId;
  assert.notEqual(runId2, runId1);

  await e.onSignal(inst!.id, {
    instanceId: inst!.id,
    phaseId: "one",
    runId: runId2,
    type: "completed",
    token: inst!.signalToken,
  });
  await e.drain(); // phase "two" is launched off a detached continuation

  const finalInst = await instances.readInstance(inst!.id);
  const secondArtifactDir = finalInst.phases[1].artifactDir;
  const phaseTwoCall = rec.calls.find((c) => c.run.phaseId === "two");
  assert.ok(phaseTwoCall);
  assert.equal(phaseTwoCall.run.prompt, `prev=${firstArtifactDir} own=${secondArtifactDir}`);
});

// ── 12. abort marks termination ──────────────────────────────────────────────

test("abort marks the run killed, and a later exit cannot overturn it", async () => {
  const { engine, pipelines, runsSrc } = await load();
  await seed(pipelines, [
    { id: "only", name: "Only", cwd: home, gated: false, steps: [{ name: "s", prompt: "p" }] },
  ]);
  const killed: number[] = [];
  const d = deferred();
  const spawn = () => ({ pid: process.pid, done: d.promise });
  const kill = (pid: number) => {
    killed.push(pid);
    return true;
  };
  const e = engine.createEngine(baseDeps({ spawn, kill }));
  const inst = await e.start("p1", "manual");
  const runId = inst!.phases[0].steps[0].runId;

  const res = await e.abort(inst!.id);
  assert.equal(res.ok, true);
  assert.deepEqual(killed, [process.pid]);

  const midway = await runsSrc.readRun(runId);
  assert.equal(midway!.run.termination, "killed");
  assert.equal(midway!.run.error, "aborted");

  d.resolve({ code: 0 }); // the process exits normally, after Argus already decided
  await waitFor(async () => (await runsSrc.readRun(runId))?.run.status === "failed");
  const finalRun = await runsSrc.readRun(runId);
  assert.equal(finalRun!.run.error, "aborted");
});

// ── 13. reconcile enforces the deadline on an adopted run ───────────────────

test("reconcile kills and finalizes an adopted run past its deadline, healing the phase", async () => {
  const { engine, pipelines, instances, runsSrc } = await load();
  const def = await seed(pipelines, [
    { id: "only", name: "Only", cwd: home, gated: false, steps: [{ name: "s", prompt: "p" }] },
  ]);

  const child = nodeSpawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const now = new Date();
  const past = new Date(now.getTime() - 5000).toISOString();
  const runId = "orphan-run";
  await runsSrc.writeRun({
    id: runId,
    scheduleId: `pipeline:${def.id}`,
    scheduleName: "feature · Only",
    prompt: "p",
    cwd: home,
    status: "running",
    trigger: "scheduled",
    queuedAt: past,
    startedAt: past,
    endedAt: null,
    durationMs: null,
    pid: child.pid,
    exitCode: null,
    sessionId: null,
    runtime: "claude",
    project: null,
    resultSummary: null,
    error: null,
    instanceId: "inst-x",
    phaseId: "only",
    deadlineAt: past,
  });
  await instances.writeInstance({
    id: "inst-x",
    pipelineId: def.id,
    pipelineName: def.name,
    status: "running",
    currentPhaseIndex: 0,
    phases: [
      {
        id: "only",
        name: "Only",
        gated: false,
        status: "running",
        steps: [{ name: "s", runId, status: "running" }],
        attempt: 0,
        needs: [],
        retries: 0,
        payload: null,
      },
    ],
    trigger: "manual",
    signalToken: "tok",
    createdAt: past,
    updatedAt: past,
    endedAt: null,
    artifacts: {},
  });

  const e = engine.createEngine(baseDeps({ spawn: recordingSpawn().spawn, now: () => new Date() }));
  await e.adopt();
  await e.reconcile();

  const afterFirst = await runsSrc.readRun(runId);
  assert.equal(afterFirst!.run.termination, "timed-out");

  await waitFor(() => !isAlive(child.pid ?? null));

  await e.reconcile();

  const afterSecond = await runsSrc.readRun(runId);
  assert.equal(afterSecond!.run.status, "failed");

  const inst = await instances.readInstance("inst-x");
  assert.equal(inst.phases[0].status, "failed");
  assert.equal((inst.phases[0].payload as any).failureClass, "timeout");
});

// ── 14. reconcile resumes an interrupted verification ───────────────────────

test("reconcile resumes a verification that was running when Argus stopped", async () => {
  const { engine, pipelines, instances } = await load();
  const def = await seed(pipelines, [
    {
      id: "checked",
      name: "Checked",
      cwd: home,
      gated: false,
      checks: [{ kind: "command", run: "exit 0" }],
      steps: [{ name: "s", prompt: "p" }],
    },
  ]);
  const now = new Date().toISOString();
  await instances.writeInstance({
    id: "inst-y",
    pipelineId: def.id,
    pipelineName: def.name,
    status: "running",
    currentPhaseIndex: 0,
    phases: [
      {
        id: "checked",
        name: "Checked",
        gated: false,
        status: "running",
        steps: [{ name: "s", runId: "run-y", status: "succeeded" }],
        attempt: 0,
        needs: [],
        retries: 0,
        payload: null,
        verification: { status: "running", startedAt: now, checks: [] },
      },
    ],
    trigger: "manual",
    signalToken: "tok",
    createdAt: now,
    updatedAt: now,
    endedAt: null,
    artifacts: {},
  });

  const e = engine.createEngine(baseDeps({ spawn: recordingSpawn().spawn }));
  await e.reconcile();
  await e.drain();

  const inst = await instances.readInstance("inst-y");
  assert.equal(inst.phases[0].status, "succeeded");
  assert.equal(inst.phases[0].verification.status, "passed");
});

// ── 15. retryNote / failureClassOfRecord (pure) ──────────────────────────────

test("retryNote is empty with no class, or configuration (never retried)", () => {
  assert.equal(retryNote({ attempt: 1, maxAttempts: 2 }), "");
  assert.equal(retryNote({ failureClass: "configuration", attempt: 1, maxAttempts: 2 }), "");
});

test("retryNote: signal, timeout and spawn carry the one-line reason as-is", () => {
  assert.equal(
    retryNote({ failureClass: "signal", reason: "  trimmed  ", attempt: 1, maxAttempts: 3 }),
    "\n\nPrevious attempt (1 of 3) failed — signal:\ntrimmed",
  );
  assert.equal(
    retryNote({
      failureClass: "timeout",
      reason: "timed out after 900s",
      attempt: 2,
      maxAttempts: 3,
    }),
    "\n\nPrevious attempt (2 of 3) failed — timeout:\ntimed out after 900s",
  );
  assert.equal(
    retryNote({
      failureClass: "timeout",
      reason: "stalled: no output for 120s",
      attempt: 1,
      maxAttempts: 2,
    }),
    "\n\nPrevious attempt (1 of 2) failed — timeout:\nstalled: no output for 120s",
  );
  assert.equal(
    retryNote({
      failureClass: "spawn",
      reason: "ENOENT: no such binary",
      attempt: 1,
      maxAttempts: 2,
    }),
    "\n\nPrevious attempt (1 of 2) failed — spawn:\nENOENT: no such binary",
  );
  // No reason at all: nothing worth restating.
  assert.equal(retryNote({ failureClass: "spawn", attempt: 1, maxAttempts: 2 }), "");
});

test("retryNote: verification lists each failed check with its output tail", () => {
  const note = retryNote({
    failureClass: "verification",
    attempt: 1,
    maxAttempts: 2,
    verification: {
      status: "failed",
      startedAt: "2026-01-01T00:00:00.000Z",
      checks: [
        {
          kind: "command",
          label: "unit tests",
          status: "failed",
          detail: "exit 1",
          durationMs: 1,
          output: "FAIL src/x.test.ts\nAssertionError",
        },
        { kind: "command", label: "lint", status: "passed", detail: "exit 0", durationMs: 1 },
        { kind: "artifact", label: "report", status: "failed", detail: "missing", durationMs: 1 },
      ],
    },
  });
  assert.equal(
    note,
    "\n\nPrevious attempt (1 of 2) failed — verification:\n" +
      "unit tests: FAIL src/x.test.ts\nAssertionError\n" +
      "report:",
  );
  // Passing checks never appear, and a check with no output tail is blank, not "undefined".
  assert.ok(!note.includes("lint"));
});

test("retryNote: verification caps a long output tail at ~600 chars per check", () => {
  const long = "x".repeat(1000);
  const note = retryNote({
    failureClass: "verification",
    attempt: 1,
    maxAttempts: 1,
    verification: {
      status: "failed",
      startedAt: "2026-01-01T00:00:00.000Z",
      checks: [
        {
          kind: "command",
          label: "t",
          status: "failed",
          detail: "exit 1",
          durationMs: 1,
          output: long,
        },
      ],
    },
  });
  assert.equal(note, `\n\nPrevious attempt (1 of 1) failed — verification:\nt: ${"x".repeat(600)}`);
});

test("retryNote: exit-code carries the code plus a tail of the run's own text", () => {
  assert.equal(
    retryNote({
      failureClass: "exit-code",
      exitCode: 1,
      runText: "  npm ERR! Test failed  ",
      attempt: 1,
      maxAttempts: 2,
    }),
    "\n\nPrevious attempt (1 of 2) failed — exit-code:\nexit code 1: npm ERR! Test failed",
  );
  // No text at all: still names the exit code.
  assert.equal(
    retryNote({ failureClass: "exit-code", exitCode: 137, attempt: 1, maxAttempts: 2 }),
    "\n\nPrevious attempt (1 of 2) failed — exit-code:\nexit code 137",
  );
});

test("retryNote: exit-code caps its own text tail at ~800 chars", () => {
  const long = "e".repeat(1200);
  const note = retryNote({
    failureClass: "exit-code",
    exitCode: 1,
    runText: long,
    attempt: 1,
    maxAttempts: 1,
  });
  assert.equal(
    note,
    `\n\nPrevious attempt (1 of 1) failed — exit-code:\nexit code 1: ${"e".repeat(800)}`,
  );
});

test("retryNote caps the whole note at ~2KiB even with several large failed checks", () => {
  const checks = Array.from({ length: 6 }, (_, i) => ({
    kind: "command" as const,
    label: `check-${i}`,
    status: "failed" as const,
    detail: "exit 1",
    durationMs: 1,
    output: "y".repeat(600),
  }));
  const note = retryNote({
    failureClass: "verification",
    attempt: 1,
    maxAttempts: 1,
    verification: { status: "failed", startedAt: "2026-01-01T00:00:00.000Z", checks },
  });
  const header = "\n\nPrevious attempt (1 of 1) failed — verification:\n";
  assert.ok(note.length <= header.length + 2000);
  assert.ok(note.startsWith(header.slice(0, 10)));
});

test("failureClassOfRecord classes a run from its termination and pid, stall counted as timeout", () => {
  assert.equal(failureClassOfRecord({ termination: "timed-out", pid: 123 } as any), "timeout");
  assert.equal(failureClassOfRecord({ termination: "stalled", pid: 123 } as any), "timeout");
  assert.equal(failureClassOfRecord({ pid: null } as any), "spawn");
  assert.equal(failureClassOfRecord({ pid: 123 } as any), "exit-code");
});

// ── 16. workspace isolation ─────────────────────────────────────────────────

function gitAvailable(): boolean {
  try {
    return spawnSync("git", ["--version"]).status === 0;
  } catch {
    return false;
  }
}

const gitIn = (dir: string, args: string[]) =>
  spawnSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=T", ...args], {
    cwd: dir,
    encoding: "utf8",
  });

/** A real repository with one commit, as a phase's `cwd`. */
function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "argus-engine-repo-"));
  gitIn(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(dir, "README.md"), "base\n", "utf8");
  gitIn(dir, ["add", "."]);
  gitIn(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

test("an instance-scoped workspace is shared by every phase and removed when the instance ends", async (t) => {
  if (!gitAvailable()) return t.skip("git not available");
  const { engine, pipelines, instances, runsSrc, journalSrc } = await load();
  const repo = makeRepo();
  await seed(
    pipelines,
    [
      { id: "one", name: "One", cwd: repo, gated: false, steps: [{ name: "s", prompt: "p" }] },
      {
        id: "two",
        name: "Two",
        cwd: repo,
        gated: false,
        needs: ["one"],
        steps: [{ name: "s", prompt: "p" }],
      },
    ],
    { workspace: { scope: "instance" } },
  );
  const rec = recordingSpawn();
  const e = engine.createEngine(baseDeps({ spawn: rec.spawn }));
  const inst = await e.start("p1", "manual");

  const shared = path.join(paths.worktreesDir(), inst!.id, "shared");
  assert.equal(rec.calls[0].run.cwd, shared);
  // The transcript lands under the directory the agent actually ran in.
  assert.equal(rec.calls[0].run.project, runsSrc.encodeProject(shared));
  assert.equal(rec.calls[0].env.ARGUS_WORKSPACE, shared);
  assert.equal(rec.calls[0].prepared.env.ARGUS_WORKSPACE, shared);
  assert.equal(rec.calls[0].prepared.record.workspace.branch, `argus/${inst!.id}/shared`);
  assert.equal(existsSync(path.join(shared, "README.md")), true);

  const started = await instances.readInstance(inst!.id);
  assert.equal(started.workspace.path, shared);
  assert.equal(started.phases[0].workspace.path, shared);

  await e.onSignal(inst!.id, {
    instanceId: inst!.id,
    phaseId: "one",
    runId: inst!.phases[0].steps[0].runId,
    type: "completed",
    token: inst!.signalToken,
  });
  await e.drain();
  // The second phase reuses the same tree rather than cutting its own.
  assert.equal(rec.calls.length, 2);
  assert.equal(rec.calls[1].run.cwd, shared);
  const mid = await instances.readInstance(inst!.id);
  assert.equal(mid.phases[1].workspace.path, shared);
  assert.equal(existsSync(shared), true);

  await e.onSignal(inst!.id, {
    instanceId: inst!.id,
    phaseId: "two",
    runId: mid.phases[1].steps[0].runId,
    type: "completed",
    token: inst!.signalToken,
  });
  await e.drain();

  const done = await instances.readInstance(inst!.id);
  assert.equal(done.status, "succeeded");
  // The directory is disposable; the branch is the deliverable.
  assert.equal(existsSync(shared), false);
  assert.equal(gitIn(repo, ["rev-parse", "--verify", `argus/${inst!.id}/shared`]).status, 0);
  const j = await journalSrc.readJournal(inst!.id);
  assert.ok(j.some((entry: any) => entry.kind === "workspace.created"));
  assert.ok(j.some((entry: any) => entry.kind === "workspace.removed"));
});

test("an attempt-scoped workspace is fresh per attempt, and the superseded one is removed", async (t) => {
  if (!gitAvailable()) return t.skip("git not available");
  const { engine, pipelines, instances } = await load();
  const repo = makeRepo();
  await seed(pipelines, [
    {
      id: "gate",
      name: "Gate",
      cwd: repo,
      gated: true,
      workspace: { scope: "attempt" },
      steps: [{ name: "s", prompt: "p" }],
    },
  ]);
  const rec = recordingSpawn();
  const e = engine.createEngine(baseDeps({ spawn: rec.spawn }));
  const inst = await e.start("p1", "manual");
  const first = path.join(paths.worktreesDir(), inst!.id, "gate-attempt0");
  assert.equal(rec.calls[0].run.cwd, first);
  assert.equal(existsSync(first), true);

  await e.onSignal(inst!.id, {
    instanceId: inst!.id,
    phaseId: "gate",
    runId: inst!.phases[0].steps[0].runId,
    type: "needs-input",
    token: inst!.signalToken,
  });
  await e.revise(inst!.id, "try again");
  await e.drain();

  const second = path.join(paths.worktreesDir(), inst!.id, "gate-attempt1");
  assert.equal(rec.calls.length, 2);
  assert.equal(rec.calls[1].run.cwd, second);
  assert.equal(existsSync(second), true);
  // The superseded attempt's tree goes as the new one starts; its branch stays.
  assert.equal(existsSync(first), false);
  assert.equal(gitIn(repo, ["rev-parse", "--verify", `argus/${inst!.id}/gate/0`]).status, 0);
  const after = await instances.readInstance(inst!.id);
  assert.equal(after.phases[0].workspace.path, second);
  assert.equal(after.workspace, undefined);
});

test("a workspace Argus cannot create fails the phase as configuration, without a retry", async (t) => {
  if (!gitAvailable()) return t.skip("git not available");
  const { engine, pipelines, instances, journalSrc } = await load();
  // `home` is a plain temp directory: not a git work tree.
  await seed(pipelines, [
    {
      id: "only",
      name: "Only",
      cwd: home,
      gated: false,
      workspace: { scope: "instance" },
      retry: { attempts: 3, backoffSeconds: 1, retryOn: ["spawn", "exit-code", "verification"] },
      steps: [{ name: "s", prompt: "p" }],
    },
  ]);
  const rec = recordingSpawn();
  let failures = 0;
  const e = engine.createEngine(baseDeps({ spawn: rec.spawn, onFailure: () => failures++ }));
  const inst = await e.start("p1", "manual");
  await e.drain();

  assert.equal(rec.calls.length, 0);
  const after = await instances.readInstance(inst!.id);
  assert.equal(after.status, "failed");
  assert.equal(after.phases[0].status, "failed");
  assert.equal(after.phases[0].payload.failureClass, "configuration");
  assert.match(after.phases[0].payload.reason, /not inside a git work tree/);
  // `configuration` is never retried: nothing is scheduled.
  assert.equal(after.phases[0].retryAt ?? null, null);
  assert.equal(failures, 1);
  const j = await journalSrc.readJournal(inst!.id);
  assert.ok(
    j.some((entry: any) => entry.kind === "phase.failed" && /configuration/.test(entry.detail)),
  );
});

test("keep leaves the worktree directory behind, and the phase's checks run inside it", async (t) => {
  if (!gitAvailable()) return t.skip("git not available");
  const { engine, pipelines, instances } = await load();
  const repo = makeRepo();
  await seed(pipelines, [
    {
      id: "build",
      name: "Build",
      cwd: repo,
      gated: false,
      workspace: { scope: "instance", keep: true },
      checks: [{ kind: "file", path: "built.txt", label: "built" }],
      steps: [{ name: "s", prompt: "p" }],
    },
  ]);
  // The "agent" leaves its file in the directory it was given.
  const rec = recordingSpawn();
  const spawn = (run: any, log: string, env: Record<string, string>, prepared: any) => {
    writeFileSync(path.join(run.cwd, "built.txt"), "done\n", "utf8");
    return rec.spawn(run, log, env, prepared);
  };
  const e = engine.createEngine(baseDeps({ spawn }));
  const inst = await e.start("p1", "manual");
  const tree = path.join(paths.worktreesDir(), inst!.id, "shared");

  await e.onSignal(inst!.id, {
    instanceId: inst!.id,
    phaseId: "build",
    runId: inst!.phases[0].steps[0].runId,
    type: "completed",
    token: inst!.signalToken,
  });
  await e.drain();

  const after = await instances.readInstance(inst!.id);
  // The check passed, which it only can if it looked in the worktree.
  assert.equal(after.phases[0].verification.status, "passed");
  assert.equal(after.status, "succeeded");
  assert.equal(existsSync(path.join(tree, "built.txt")), true);
  assert.equal(existsSync(path.join(repo, "built.txt")), false);
  // keep: the directory outlives the instance.
  assert.equal(existsSync(tree), true);
});

// ── 17. candidates: best-of-N with verifier-gated selection ─────────────────

/** A candidates phase over a real repository: `count` drafts, one `file` check. */
function candidateSeed(
  pipelines: any,
  repo: string,
  over: Record<string, unknown> = {},
  phaseOver: Record<string, unknown> = {},
) {
  return seed(pipelines, [
    {
      id: "impl",
      name: "Implement",
      cwd: repo,
      gated: false,
      workspace: { scope: "attempt" },
      checks: [{ kind: "file", path: "done.txt", label: "wrote it" }],
      candidates: { count: 3, select: "first-verified", ...over },
      steps: [{ name: "code", prompt: "implement it" }],
      ...phaseOver,
    },
  ]);
}

const signalOf = (e: any, inst: any, runId: string, type = "completed") =>
  e.onSignal(inst.id, {
    instanceId: inst.id,
    phaseId: "impl",
    runId,
    type,
    token: inst.signalToken,
  });

test("candidates launch N isolated drafts of one step, each with its own tree and artifacts", async (t) => {
  if (!gitAvailable()) return t.skip("git not available");
  const { engine, pipelines, instances, journalSrc } = await load();
  const repo = makeRepo();
  await candidateSeed(pipelines, repo);
  const rec = recordingSpawn();
  const e = engine.createEngine(baseDeps({ spawn: rec.spawn }));
  const inst = await e.start("p1", "manual");

  assert.equal(rec.calls.length, 3);
  const started = await instances.readInstance(inst!.id);
  const steps = started.phases[0].steps;
  assert.deepEqual(
    steps.map((s: any) => s.candidate),
    [0, 1, 2],
  );
  // One worktree each, named for the candidate, and all three really exist.
  for (let i = 0; i < 3; i++) {
    const tree = path.join(paths.worktreesDir(), inst!.id, `impl-attempt0-c${i}`);
    assert.equal(rec.calls[i].run.cwd, tree);
    assert.equal(steps[i].workspace.path, tree);
    assert.equal(steps[i].workspace.branch, `argus/${inst!.id}/impl/0-c${i}`);
    assert.equal(existsSync(path.join(tree, "README.md")), true);
    // One artifact directory each: c1 must not satisfy c0's `artifact` checks.
    const art = path.join(phaseArtifactDir(paths.artifactsDir(), inst!.id, "impl"), `c${i}`);
    assert.equal(rec.calls[i].env.ARGUS_ARTIFACT_DIR, art);
    assert.equal(existsSync(art), true);
  }
  // The phase itself has no tree until one is selected.
  assert.equal(started.phases[0].workspace ?? null, null);
  const j = await journalSrc.readJournal(inst!.id);
  assert.ok(j.some((x: any) => x.kind === "phase.started" && x.detail === "3 candidates"));
});

test("first-verified: the first passing draft wins and its siblings are killed as superseded", async (t) => {
  if (!gitAvailable()) return t.skip("git not available");
  const { engine, pipelines, instances, runsSrc, journalSrc } = await load();
  const repo = makeRepo();
  await candidateSeed(pipelines, repo);
  const rec = recordingSpawn();
  // Only candidate 1 does the work the check looks for. The handles carry this
  // process's own pid so `isAlive` is true for the siblings — the kill itself is
  // the injected stub, so nothing is ever actually signalled.
  const spawn = (run: any, log: string, env: Record<string, string>, prepared: any) => {
    if (run.cwd.endsWith("-c1")) writeFileSync(path.join(run.cwd, "done.txt"), "ok\n", "utf8");
    return { ...rec.spawn(run, log, env, prepared), pid: process.pid };
  };
  const killed: { pid: number; signal?: string }[] = [];
  const e = engine.createEngine(
    baseDeps({
      spawn,
      killGraceMs: 60_000,
      kill: (pid: number, signal?: string) => (killed.push({ pid, signal }), true),
    }),
  );
  const inst = await e.start("p1", "manual");
  const steps = (await instances.readInstance(inst!.id)).phases[0].steps;

  // c0 reports first and fails its checks; c1 reports next and passes.
  await signalOf(e, inst, steps[0].runId);
  await e.drain();
  const mid = await instances.readInstance(inst!.id);
  assert.equal(mid.phases[0].status, "running");
  assert.equal(mid.phases[0].steps[0].verification.status, "failed");

  await signalOf(e, inst, steps[1].runId);
  await e.drain();

  const after = await instances.readInstance(inst!.id);
  assert.equal(after.status, "succeeded");
  assert.equal(after.phases[0].status, "succeeded");
  assert.equal(after.phases[0].selectedCandidate, 1);
  assert.equal(after.phases[0].verification.status, "passed");
  assert.equal(after.phases[0].workspace.branch, `argus/${inst!.id}/impl/0-c1`);
  // c2 never reported: superseded, not failed.
  assert.equal(after.phases[0].steps[2].status, "aborted");
  assert.match(after.phases[0].steps[2].failure.reason, /superseded by candidate 1/);
  const c2 = await runsSrc.readRun(steps[2].runId);
  assert.equal(c2.run.termination, "killed");
  assert.match(c2.run.error, /superseded by candidate 1/);
  assert.ok(killed.some((k) => k.pid === process.pid));
  // The losers' directories go; their branches stay as evidence.
  assert.equal(existsSync(path.join(paths.worktreesDir(), inst!.id, "impl-attempt0-c0")), false);
  assert.equal(existsSync(path.join(paths.worktreesDir(), inst!.id, "impl-attempt0-c2")), false);
  assert.equal(gitIn(repo, ["rev-parse", "--verify", `argus/${inst!.id}/impl/0-c0`]).status, 0);
  const j = await journalSrc.readJournal(inst!.id);
  assert.ok(j.some((x: any) => x.kind === "phase.candidate-selected" && /c1 of 3/.test(x.detail)));
});

test("cheapest-verified waits for every draft, then takes the cheapest that passed", async (t) => {
  if (!gitAvailable()) return t.skip("git not available");
  const { engine, pipelines, instances, runsSrc } = await load();
  const repo = makeRepo();
  await candidateSeed(pipelines, repo, { count: 3, select: "cheapest-verified" });
  const rec = recordingSpawn();
  // All three do the work; only their prices differ.
  const spawn = (run: any, log: string, env: Record<string, string>, prepared: any) => {
    writeFileSync(path.join(run.cwd, "done.txt"), "ok\n", "utf8");
    return rec.spawn(run, log, env, prepared);
  };
  const e = engine.createEngine(baseDeps({ spawn }));
  const inst = await e.start("p1", "manual");
  const steps = (await instances.readInstance(inst!.id)).phases[0].steps;
  const costs = [3.5, 0.75, 1.25];
  for (let i = 0; i < 3; i++) await runsSrc.patchRun(steps[i].runId, { costUsd: costs[i] });

  await signalOf(e, inst, steps[0].runId);
  await e.drain();
  // A verified candidate does not end it: the cheap one may still be running.
  assert.equal((await instances.readInstance(inst!.id)).phases[0].status, "running");
  await signalOf(e, inst, steps[1].runId);
  await e.drain();
  assert.equal((await instances.readInstance(inst!.id)).phases[0].status, "running");
  await signalOf(e, inst, steps[2].runId);
  await e.drain();

  const after = await instances.readInstance(inst!.id);
  assert.equal(after.phases[0].status, "succeeded");
  assert.equal(after.phases[0].selectedCandidate, 1);
  assert.deepEqual(
    after.phases[0].candidateOutcomes.map((o: any) => [o.candidate, o.verified, o.costUsd]),
    [
      [0, true, 3.5],
      [1, true, 0.75],
      [2, true, 1.25],
    ],
  );
});

test("every candidate failing its checks fails the phase once, under the verification class", async (t) => {
  if (!gitAvailable()) return t.skip("git not available");
  const { engine, pipelines, instances } = await load();
  const repo = makeRepo();
  await candidateSeed(pipelines, repo, { count: 2, select: "first-verified" });
  const rec = recordingSpawn();
  let failures = 0;
  const e = engine.createEngine(baseDeps({ spawn: rec.spawn, onFailure: () => failures++ }));
  const inst = await e.start("p1", "manual");
  const steps = (await instances.readInstance(inst!.id)).phases[0].steps;
  // Nobody wrote done.txt.
  await signalOf(e, inst, steps[0].runId);
  await e.drain();
  assert.equal((await instances.readInstance(inst!.id)).status, "running");
  await signalOf(e, inst, steps[1].runId);
  await e.drain();

  const after = await instances.readInstance(inst!.id);
  assert.equal(after.status, "failed");
  assert.equal(after.phases[0].status, "failed");
  assert.equal(after.phases[0].selectedCandidate, null);
  assert.equal(after.phases[0].payload.failureClass, "verification");
  assert.match(after.phases[0].payload.reason, /no candidate passed its checks/);
  assert.match(after.phases[0].payload.reason, /c0 \(claude\): [^;]*wrote it/);
  assert.match(after.phases[0].payload.reason, /c1 \(claude\): [^;]*wrote it/);
  assert.equal(after.phases[0].candidateOutcomes.length, 2);
  assert.equal(failures, 1);
});

test("a candidate that dies before its checks simply loses; a surviving one still wins", async (t) => {
  if (!gitAvailable()) return t.skip("git not available");
  const { engine, pipelines, instances } = await load();
  const repo = makeRepo();
  await candidateSeed(pipelines, repo, { count: 2, select: "first-verified" });
  const rec = recordingSpawn();
  const spawn = (run: any, log: string, env: Record<string, string>, prepared: any) => {
    if (run.cwd.endsWith("-c1")) writeFileSync(path.join(run.cwd, "done.txt"), "ok\n", "utf8");
    return rec.spawn(run, log, env, prepared);
  };
  const e = engine.createEngine(baseDeps({ spawn }));
  const inst = await e.start("p1", "manual");
  const steps = (await instances.readInstance(inst!.id)).phases[0].steps;

  await signalOf(e, inst, steps[0].runId, "failed");
  await e.drain();
  const mid = await instances.readInstance(inst!.id);
  // One dead draft is not a dead phase.
  assert.equal(mid.status, "running");
  assert.equal(mid.phases[0].status, "running");
  assert.equal(mid.phases[0].steps[0].failure.class, "signal");

  await signalOf(e, inst, steps[1].runId);
  await e.drain();
  const after = await instances.readInstance(inst!.id);
  assert.equal(after.status, "succeeded");
  assert.equal(after.phases[0].selectedCandidate, 1);
});

test("variants apply runtime, model and effort per candidate, cycled to fill the count", async (t) => {
  if (!gitAvailable()) return t.skip("git not available");
  const { engine, pipelines } = await load();
  const repo = makeRepo();
  await candidateSeed(pipelines, repo, {
    count: 4,
    select: "first-verified",
    variants: [
      { runtime: "claude", model: "opus" },
      { runtime: "codex", reasoningEffort: "high" },
    ],
  });
  const rec = recordingSpawn();
  const e = engine.createEngine(baseDeps({ spawn: rec.spawn }));
  await e.start("p1", "manual");

  assert.equal(rec.calls.length, 4);
  assert.deepEqual(
    rec.calls.map((c: any) => [c.run.runtime, c.run.model ?? null, c.run.reasoningEffort ?? null]),
    [
      ["claude", "opus", null],
      ["codex", null, "high"],
      ["claude", "opus", null],
      ["codex", null, "high"],
    ],
  );
  // Same prompt either side of the variant: the only thing being sampled is the
  // model's answer (the artifact directory apart, which is per candidate).
  const stripped = rec.calls.map((c: any) => c.run.prompt.replace(/\/c\d+/g, "/cN"));
  assert.equal(new Set(stripped).size, 1);
});

test("a restart between a candidate's checks and the selection re-decides from disk", async (t) => {
  if (!gitAvailable()) return t.skip("git not available");
  const { engine, pipelines, instances } = await load();
  const repo = makeRepo();
  await candidateSeed(pipelines, repo, { count: 2, select: "cheapest-verified" });
  const rec = recordingSpawn();
  const spawn = (run: any, log: string, env: Record<string, string>, prepared: any) => {
    writeFileSync(path.join(run.cwd, "done.txt"), "ok\n", "utf8");
    return rec.spawn(run, log, env, prepared);
  };
  const e = engine.createEngine(baseDeps({ spawn }));
  const inst = await e.start("p1", "manual");
  const steps = (await instances.readInstance(inst!.id)).phases[0].steps;
  await signalOf(e, inst, steps[0].runId);
  await signalOf(e, inst, steps[1].runId);
  await e.drain();
  // Rewind the record to the instant before selection: both verified, nothing
  // selected — exactly what a crash in that window leaves on disk.
  const stalled = await instances.readInstance(inst!.id);
  stalled.status = "running";
  stalled.endedAt = null;
  stalled.phases[0].status = "running";
  delete stalled.phases[0].selectedCandidate;
  delete stalled.phases[0].candidateOutcomes;
  delete stalled.phases[0].verification;
  for (const s of stalled.phases[0].steps) s.status = "succeeded";
  await instances.writeInstance(stalled);

  // A fresh engine, as after a restart.
  const e2 = engine.createEngine(baseDeps({ spawn: rec.spawn }));
  await e2.reconcile();
  await e2.drain();

  const healed = await instances.readInstance(inst!.id);
  assert.equal(healed.phases[0].status, "succeeded");
  assert.equal(healed.phases[0].selectedCandidate, 0);
  assert.equal(healed.status, "succeeded");
});

test("an aborted candidates phase leaves no worktree behind", async (t) => {
  if (!gitAvailable()) return t.skip("git not available");
  const { engine, pipelines } = await load();
  const repo = makeRepo();
  await candidateSeed(pipelines, repo, { count: 3, select: "first-verified" });
  const rec = recordingSpawn();
  const e = engine.createEngine(baseDeps({ spawn: rec.spawn }));
  const inst = await e.start("p1", "manual");
  for (let i = 0; i < 3; i++) {
    assert.equal(
      existsSync(path.join(paths.worktreesDir(), inst!.id, `impl-attempt0-c${i}`)),
      true,
    );
  }
  await e.abort(inst!.id);
  await e.drain();
  for (let i = 0; i < 3; i++) {
    assert.equal(
      existsSync(path.join(paths.worktreesDir(), inst!.id, `impl-attempt0-c${i}`)),
      false,
    );
  }
});

test("only the winner's payload and result reach the next phase", async (t) => {
  if (!gitAvailable()) return t.skip("git not available");
  const { engine, pipelines, instances } = await load();
  const repo = makeRepo();
  await seed(pipelines, [
    {
      id: "impl",
      name: "Implement",
      cwd: repo,
      gated: false,
      workspace: { scope: "attempt" },
      checks: [{ kind: "file", path: "done.txt", label: "wrote it" }],
      candidates: { count: 2, select: "first-verified" },
      steps: [{ name: "code", prompt: "implement it" }],
    },
    {
      id: "ship",
      name: "Ship",
      cwd: repo,
      gated: false,
      needs: ["impl"],
      steps: [{ name: "go", prompt: "ship this: {{previous.payload}}" }],
    },
  ]);
  const rec = recordingSpawn();
  const spawn = (run: any, log: string, env: Record<string, string>, prepared: any) => {
    if (run.cwd.endsWith("-c1")) writeFileSync(path.join(run.cwd, "done.txt"), "ok\n", "utf8");
    return rec.spawn(run, log, env, prepared);
  };
  const e = engine.createEngine(baseDeps({ spawn }));
  const inst = await e.start("p1", "manual");
  const steps = (await instances.readInstance(inst!.id)).phases[0].steps;

  await e.onSignal(inst!.id, {
    instanceId: inst!.id,
    phaseId: "impl",
    runId: steps[0].runId,
    type: "completed",
    token: inst!.signalToken,
    payload: { from: "the losing draft" },
  });
  await e.drain();
  await e.onSignal(inst!.id, {
    instanceId: inst!.id,
    phaseId: "impl",
    runId: steps[1].runId,
    type: "completed",
    token: inst!.signalToken,
    payload: { from: "the winning draft" },
  });
  await e.drain();

  const after = await instances.readInstance(inst!.id);
  assert.deepEqual(after.phases[0].payload, { from: "the winning draft" });
  const shipPrompt = rec.calls[rec.calls.length - 1].run.prompt;
  assert.match(shipPrompt, /the winning draft/);
  assert.doesNotMatch(shipPrompt, /the losing draft/);
});

// ── 17. workspace scope "none" ───────────────────────────────────────────────

test('workspace scope "none" opts a phase out of a pipeline-wide policy: no worktree, runs in cwd', async () => {
  const { engine, pipelines, instances } = await load();
  await seed(
    pipelines,
    [
      {
        id: "readonly",
        name: "Readonly",
        cwd: home,
        gated: false,
        workspace: { scope: "none" },
        steps: [{ name: "s", prompt: "p" }],
      },
    ],
    // Pipeline-wide isolation every other phase would inherit — but a git
    // repo is never required here, because "none" never asks git for anything.
    { workspace: { scope: "instance" } },
  );
  const rec = recordingSpawn();
  const e = engine.createEngine(baseDeps({ spawn: rec.spawn }));
  const inst = await e.start("p1", "manual");
  assert.equal(rec.calls.length, 1);
  assert.equal(rec.calls[0].run.cwd, home, "ran in the phase's own cwd, not a worktree");

  const after = await instances.readInstance(inst!.id);
  assert.equal(after.phases[0].workspace ?? null, null);
  assert.equal(after.workspace ?? null, null, "the shared instance worktree was never created");
});

// ── 18. pipeline memory ──────────────────────────────────────────────────────

test("memory disabled: {{memory}} is empty and ARGUS_MEMORY_DIR is never set", async () => {
  const { engine, pipelines } = await load();
  await seed(pipelines, [
    {
      id: "only",
      name: "Only",
      cwd: home,
      gated: false,
      steps: [{ name: "s", prompt: "notes: {{memory}}" }],
    },
  ]);
  const rec = recordingSpawn();
  const e = engine.createEngine(baseDeps({ spawn: rec.spawn }));
  await e.start("p1", "manual");
  assert.equal(rec.calls[0].run.prompt, "notes: ");
  assert.ok(!("ARGUS_MEMORY_DIR" in rec.calls[0].env));
});

test("memory enabled: ARGUS_MEMORY_DIR is set, {{memory}} reads NOTES.md, and the instruction is appended", async () => {
  const { engine, pipelines } = await load();
  const { memoryNotesPath, ensureMemoryDir } = await import("./harness/memory.js");
  await seed(
    pipelines,
    [
      {
        id: "only",
        name: "Only",
        cwd: home,
        gated: false,
        steps: [{ name: "s", prompt: "notes: {{memory}}" }],
      },
    ],
    { memory: { enabled: true, maxBytes: 4096 } },
  );
  const dir = await ensureMemoryDir("p1");
  writeFileSync(memoryNotesPath("p1"), "remember the deploy gotcha", "utf8");

  const rec = recordingSpawn();
  const e = engine.createEngine(baseDeps({ spawn: rec.spawn }));
  await e.start("p1", "manual");

  assert.equal(rec.calls[0].env.ARGUS_MEMORY_DIR, dir);
  assert.match(rec.calls[0].run.prompt, /notes: remember the deploy gotcha/);
  assert.match(
    rec.calls[0].run.prompt,
    /Durable notes for this pipeline live at \$ARGUS_MEMORY_DIR\/NOTES\.md/,
  );
  assert.match(rec.calls[0].run.prompt, /keep it under 4096 bytes/);
});

test("a settled instance trims NOTES.md back to its cap, and journals memory.trimmed", async () => {
  const { engine, pipelines, instances, journalSrc } = await load();
  const { memoryNotesPath, ensureMemoryDir } = await import("./harness/memory.js");
  await seed(
    pipelines,
    [{ id: "only", name: "Only", cwd: home, gated: false, steps: [{ name: "s", prompt: "p" }] }],
    { memory: { enabled: true, maxBytes: 1024 } },
  );
  await ensureMemoryDir("p1");
  const long = Array.from({ length: 200 }, (_, i) => `note ${i}: ${"x".repeat(20)}`).join("\n");
  writeFileSync(memoryNotesPath("p1"), long, "utf8");

  const rec = recordingSpawn();
  const e = engine.createEngine(baseDeps({ spawn: rec.spawn }));
  const inst = await e.start("p1", "manual");
  const runId = inst!.phases[0].steps[0].runId;
  await e.onSignal(inst!.id, {
    instanceId: inst!.id,
    phaseId: "only",
    runId,
    type: "completed",
    token: inst!.signalToken,
  });
  await e.drain();
  await waitFor(async () => (await instances.readInstance(inst!.id)).status === "succeeded");
  // The trim is detached off the settlement; give it a tick to land.
  await waitFor(
    () => Buffer.byteLength(readFileSync(memoryNotesPath("p1"), "utf8"), "utf8") <= 1024,
  );

  const j = await journalSrc.readJournal(inst!.id);
  assert.ok(j.some((entry: any) => entry.kind === "memory.trimmed"));
});

test("never created until enabled: no pipeline ever writes a memory directory it didn't opt into", async () => {
  const { engine, pipelines } = await load();
  await seed(pipelines, [
    { id: "only", name: "Only", cwd: home, gated: false, steps: [{ name: "s", prompt: "p" }] },
  ]);
  const rec = recordingSpawn();
  const e = engine.createEngine(baseDeps({ spawn: rec.spawn }));
  await e.start("p1", "manual");
  assert.equal(existsSync(path.join(home, "argus", "memory")), false);
});

// ── 19. {{previous.instance}} ────────────────────────────────────────────────

test("{{previous.instance}} summarizes the last settled instance of the same pipeline", async () => {
  const { engine, pipelines, instances } = await load();
  await seed(pipelines, [
    {
      id: "only",
      name: "Only",
      cwd: home,
      gated: false,
      steps: [{ name: "s", prompt: "last time: {{previous.instance}}" }],
    },
  ]);
  const rec = recordingSpawn();
  const e = engine.createEngine(
    baseDeps({ spawn: rec.spawn, now: () => new Date(2026, 5, 30, 12, 0) }),
  );

  // First instance: no history yet.
  const first = await e.start("p1", "manual");
  assert.match(rec.calls[0].run.prompt, /^last time: $/);
  await e.onSignal(first!.id, {
    instanceId: first!.id,
    phaseId: "only",
    runId: first!.phases[0].steps[0].runId,
    type: "failed",
    token: first!.signalToken,
    payload: { reason: "the build broke" },
  });
  await e.drain();
  await waitFor(async () => (await instances.readInstance(first!.id)).status === "failed");

  // Second instance, started later: sees the first's outcome.
  const e2 = engine.createEngine(
    baseDeps({ spawn: rec.spawn, now: () => new Date(2026, 5, 30, 13, 0) }),
  );
  await e2.start("p1", "manual");
  const secondPrompt = rec.calls[1].run.prompt;
  assert.match(secondPrompt, /last time: Previous run failed/);
  assert.match(secondPrompt, /the build broke/);
});

// ── 20. stall detection ──────────────────────────────────────────────────────

test("a step stalled past stallSeconds is killed, classed as timeout, and journaled distinctly from a hard timeout", async () => {
  const { engine, pipelines, instances, runsSrc, journalSrc } = await load();
  await seed(pipelines, [
    {
      id: "only",
      name: "Only",
      cwd: home,
      gated: false,
      stallSeconds: 30,
      steps: [{ name: "s", prompt: "p" }],
    },
  ]);
  const killed: number[] = [];
  const kill = (pid: number) => {
    killed.push(pid);
    return true;
  };
  let clock = new Date(2026, 5, 30, 12, 0, 0);
  const e = engine.createEngine(
    baseDeps({ spawn: () => ({ pid: 999, done: new Promise(() => {}) }), kill, now: () => clock }),
  );
  const inst = await e.start("p1", "manual");
  const runId = inst!.phases[0].steps[0].runId;

  // Well within the stall window: nothing happens.
  await e.reconcile();
  assert.equal((await instances.readInstance(inst!.id)).phases[0].status, "running");
  assert.deepEqual(killed, []);

  // Past it: killed and failed, distinctly from a hard timeout.
  clock = new Date(clock.getTime() + 31_000);
  await e.reconcile();
  await waitFor(async () => (await instances.readInstance(inst!.id)).phases[0].status === "failed");
  assert.deepEqual(killed, [999]);

  const got = await runsSrc.readRun(runId);
  assert.equal(got!.run.termination, "stalled");
  assert.match(got!.run.error, /stalled: no output for 30s/);

  const after = await instances.readInstance(inst!.id);
  assert.equal((after.phases[0].payload as any).failureClass, "timeout");
  assert.equal((after.phases[0].payload as any).kind, "stalled");

  const j = await journalSrc.readJournal(inst!.id);
  assert.ok(j.some((entry: any) => entry.kind === "step.stalled"));
  assert.ok(!j.some((entry: any) => entry.kind === "step.timed-out"));
});

test("stall detection: the retry policy treats a stall as a timeout, and retries it", async () => {
  const { engine, pipelines, instances } = await load();
  await seed(pipelines, [
    {
      id: "only",
      name: "Only",
      cwd: home,
      gated: false,
      stallSeconds: 30,
      retry: { attempts: 2, backoffSeconds: 0, retryOn: ["timeout"] },
      steps: [{ name: "s", prompt: "p" }],
    },
  ]);
  let clock = new Date(2026, 5, 30, 12, 0, 0);
  const rec = recordingSpawn();
  const e = engine.createEngine(baseDeps({ spawn: rec.spawn, kill: () => true, now: () => clock }));
  await e.start("p1", "manual");
  clock = new Date(clock.getTime() + 31_000);
  await e.reconcile(); // detects and kills the stall
  await e.reconcile(); // runs the now-due retry
  await waitFor(() => rec.calls.length === 2);
  const inst2 = (await instances.readInstance((await instances.readInstances())[0].id))!;
  assert.equal(inst2.phases[0].attempt, 1);
});

test("stallSeconds absent: no stall check ever runs, however long a step is quiet", async () => {
  const { engine, pipelines, instances } = await load();
  await seed(pipelines, [
    { id: "only", name: "Only", cwd: home, gated: false, steps: [{ name: "s", prompt: "p" }] },
  ]);
  let clock = new Date(2026, 5, 30, 12, 0, 0);
  const e = engine.createEngine(
    baseDeps({
      spawn: () => ({ pid: 1, done: new Promise(() => {}) }),
      kill: () => true,
      now: () => clock,
    }),
  );
  const inst = await e.start("p1", "manual");
  clock = new Date(clock.getTime() + 3600_000);
  await e.reconcile();
  assert.equal((await instances.readInstance(inst!.id)).phases[0].status, "running");
});
