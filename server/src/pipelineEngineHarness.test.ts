import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";
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
  assert.match(retryRun.prompt, /Previous attempt failed/);
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

// ── 15. retryNote / failureClassOfRecord (pure) ─────────────────────────────

test("retryNote is empty for infrastructure failures and carries the reason for verification/signal", () => {
  assert.equal(retryNote(null), "");
  assert.equal(retryNote(undefined), "");
  assert.equal(retryNote({ failureClass: "spawn", reason: "no bin" }), "");
  assert.equal(retryNote({ failureClass: "exit-code", reason: "exit 1" }), "");
  assert.equal(
    retryNote({ failureClass: "verification", reason: "checks failed" }),
    "\n\nPrevious attempt failed: checks failed",
  );
  assert.equal(
    retryNote({ failureClass: "signal", reason: "  trimmed  " }),
    "\n\nPrevious attempt failed: trimmed",
  );
  assert.equal(retryNote({ failureClass: "verification" }), "");
});

test("failureClassOfRecord classes a run from its termination and pid", () => {
  assert.equal(failureClassOfRecord({ termination: "timed-out", pid: 123 } as any), "timeout");
  assert.equal(failureClassOfRecord({ pid: null } as any), "spawn");
  assert.equal(failureClassOfRecord({ pid: 123 } as any), "exit-code");
});
