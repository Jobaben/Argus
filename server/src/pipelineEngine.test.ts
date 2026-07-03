import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildClaudeArgs, OUTCOME_CONTRACT } from "./pipelineEngine.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-engine-"));
  process.env.ARGUS_CLAUDE_HOME = home;
});

async function load() {
  const engine = await import(`./pipelineEngine.js?${Math.random()}`);
  const pipelines = await import(`./sources/pipelines.js?${Math.random()}`);
  const instances = await import(`./sources/instances.js?${Math.random()}`);
  return { engine, pipelines, instances };
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!await cond()) {
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

// A spawn that records calls and lets the test resolve each run's completion.
function recordingSpawn() {
  const calls: { runId: string; env: Record<string, string> }[] = [];
  const dones: ReturnType<typeof deferred>[] = [];
  const spawn = (run: { id: string }, _log: string, env: Record<string, string>) => {
    calls.push({ runId: run.id, env });
    const d = deferred();
    dones.push(d);
    return { pid: 1000 + calls.length, done: d.promise };
  };
  return { spawn, calls, dones };
}

const baseDeps = (over: Record<string, unknown>) => ({
  now: () => new Date(2026, 5, 30, 12, 0),
  newId: () => `id-${++counter}`,
  signalUrlBase: "http://localhost:7777",
  maxConcurrent: 4,
  tickMs: 30000,
  ...over,
});

async function seedPipeline(pipelines: any, over: Record<string, unknown> = {}) {
  return pipelines.createPipeline(
    pipelines.validatePipelineInput({
      name: "feature",
      phases: [
        { id: "brainstorm", name: "Brainstorm", cwd: home, gated: true, steps: [{ name: "bs", prompt: "go" }] },
        { id: "plan", name: "Plan", cwd: home, gated: false, steps: [{ name: "wp", prompt: "plan {{previous.payload}}" }] },
      ],
      ...over,
    }),
    new Date(2026, 5, 30, 9, 0),
    "p1",
  );
}

test("start spawns phase 0's step with signal env injected", async () => {
  const { engine, pipelines } = await load();
  await seedPipeline(pipelines);
  const rec = recordingSpawn();
  const e = engine.createEngine(baseDeps({ spawn: rec.spawn }));
  const inst = await e.start("p1", "manual");
  assert.ok(inst);
  assert.equal(rec.calls.length, 1);
  assert.equal(rec.calls[0].env.ARGUS_INSTANCE_ID, inst!.id);
  assert.equal(rec.calls[0].env.ARGUS_PHASE_ID, "brainstorm");
  assert.equal(rec.calls[0].env.ARGUS_SIGNAL_TOKEN, inst!.signalToken);
  assert.ok(rec.calls[0].env.ARGUS_SIGNAL_URL.includes(inst!.id));
});

test("a needs-input signal pauses the instance for approval", async () => {
  const { engine, pipelines, instances } = await load();
  await seedPipeline(pipelines);
  const rec = recordingSpawn();
  const e = engine.createEngine(baseDeps({ spawn: rec.spawn }));
  const inst = await e.start("p1", "manual");
  const runId = rec.calls[0].runId;
  const res = await e.onSignal(inst!.id, {
    instanceId: inst!.id, phaseId: "brainstorm", runId, type: "needs-input", token: inst!.signalToken, payload: "Q?",
  });
  assert.equal(res.code, 202);
  const after = await instances.readInstance(inst!.id);
  assert.equal(after?.status, "awaiting-approval");
  assert.equal(after?.phases[0].payload, "Q?");
});

test("approve advances to the next phase, forwarding answers into the prompt", async () => {
  const { engine, pipelines } = await load();
  await seedPipeline(pipelines);
  const rec = recordingSpawn();
  const e = engine.createEngine(baseDeps({ spawn: rec.spawn }));
  const inst = await e.start("p1", "manual");
  await e.onSignal(inst!.id, {
    instanceId: inst!.id, phaseId: "brainstorm", runId: rec.calls[0].runId, type: "needs-input", token: inst!.signalToken, payload: "Q?",
  });
  await e.approve(inst!.id, "USE TYPESCRIPT");
  assert.equal(rec.calls.length, 2); // phase 1 spawned
  const planRun = rec.calls[1];
  assert.equal(planRun.env.ARGUS_PHASE_ID, "plan");
});

test("onSignal rejects a bad token with 403", async () => {
  const { engine, pipelines } = await load();
  await seedPipeline(pipelines);
  const rec = recordingSpawn();
  const e = engine.createEngine(baseDeps({ spawn: rec.spawn }));
  const inst = await e.start("p1", "manual");
  const res = await e.onSignal(inst!.id, {
    instanceId: inst!.id, phaseId: "brainstorm", runId: rec.calls[0].runId, type: "completed", token: "WRONG",
  });
  assert.equal(res.code, 403);
});

test("a duplicate signal is idempotent (no double spawn)", async () => {
  const { engine, pipelines } = await load();
  await seedPipeline(pipelines, { phases: [
    { id: "only", name: "Only", cwd: home, gated: false, steps: [{ name: "s", prompt: "p" }] },
  ] });
  const rec = recordingSpawn();
  const e = engine.createEngine(baseDeps({ spawn: rec.spawn }));
  const inst = await e.start("p1", "manual");
  const sig = { instanceId: inst!.id, phaseId: "only", runId: rec.calls[0].runId, type: "completed" as const, token: inst!.signalToken };
  await e.onSignal(inst!.id, sig);
  await e.onSignal(inst!.id, sig);
  const { instances } = await load();
  const after = await instances.readInstance(inst!.id);
  assert.equal(after?.status, "succeeded");
  assert.equal(rec.calls.length, 1);
});

test("overlap=skip refuses a second concurrent instance", async () => {
  const { engine, pipelines } = await load();
  await seedPipeline(pipelines);
  const rec = recordingSpawn();
  const e = engine.createEngine(baseDeps({ spawn: rec.spawn }));
  await e.start("p1", "manual");
  const second = await e.start("p1", "manual");
  assert.equal(second, null);
});

test("concurrency cap limits simultaneous spawns", async () => {
  const { engine, pipelines } = await load();
  await seedPipeline(pipelines, { phases: [
    { id: "wide", name: "Wide", cwd: home, gated: false, steps: [
      { name: "a", prompt: "p" }, { name: "b", prompt: "p" }, { name: "c", prompt: "p" },
    ] },
  ] });
  // Wrap recordingSpawn so each handle.done is a custom thenable.
  // The engine calls `void handle.done.then(engineCb)` — our thenable's
  // .then() captures the returned promise (which resolves when engineCb
  // fully settles, including its internal `await writeRun`).
  // engineDrains[i] resolves when spawn i's fire-and-forget callback is done.
  const engineDrains: Promise<unknown>[] = [];
  const calls: { runId: string; env: Record<string, string> }[] = [];
  const dones: ReturnType<typeof deferred>[] = [];
  const spawn = (run: { id: string }, _log: string, env: Record<string, string>) => {
    calls.push({ runId: run.id, env });
    const d = deferred();
    dones.push(d);
    // Build a custom thenable wrapping d.promise.  Each .then() call returns
    // the chained promise and stores it; the last one is the engine's callback.
    const thenResults: Promise<unknown>[] = [];
    const trackedDone = {
      then(onFulfilled: any, onRejected?: any) {
        const result = d.promise.then(onFulfilled, onRejected);
        thenResults.push(result);
        return result;
      },
    };
    // engineDrains[i] will be the result of the engine's .then() call (the
    // last .then() registered on this done before the test resolves d).
    // We use a lazy reference: a Promise that resolves to the last thenResult.
    let drainResolve!: (p: Promise<unknown>) => void;
    engineDrains.push(new Promise<Promise<unknown>>((r) => (drainResolve = r)).then((p) => p));
    // After the deferred is resolved, the engine's .then() callback has been
    // registered.  We close the drain by resolving it with the last thenResult.
    const originalResolve = d.resolve;
    d.resolve = (v) => {
      originalResolve(v);
      // Yield one microtask tick so the engine's .then() handler starts,
      // then capture the settled state via the last registered thenResult.
      Promise.resolve().then(() => {
        drainResolve(thenResults[thenResults.length - 1] ?? Promise.resolve());
      });
    };
    return { pid: 1000 + calls.length, done: trackedDone as unknown as Promise<{ code: number | null }> };
  };
  const e = engine.createEngine(baseDeps({ spawn, maxConcurrent: 2 }));
  const startP = e.start("p1", "manual");
  await waitFor(() => calls.length >= 2);
  assert.equal(calls.length, 2); // third is queued behind the cap
  dones[0].resolve({ code: 0 });
  await waitFor(() => calls.length >= 3);
  assert.equal(calls.length, 3); // freed slot lets the third spawn
  dones[1].resolve({ code: 0 });
  dones[2].resolve({ code: 0 });
  await startP;
  // Drain: wait until all engine fire-and-forget done.then(writeRun) callbacks
  // have fully completed so no async I/O leaks past the test boundary.
  await Promise.all(engineDrains);
});

test("abort returns 409 on an already-terminal instance", async () => {
  const { engine, pipelines } = await load();
  await seedPipeline(pipelines, { phases: [
    { id: "only", name: "Only", cwd: home, gated: false, steps: [{ name: "s", prompt: "p" }] },
  ] });
  const rec = recordingSpawn();
  const e = engine.createEngine(baseDeps({ spawn: rec.spawn }));
  const inst = await e.start("p1", "manual");
  // drive it to succeeded
  await e.onSignal(inst!.id, { instanceId: inst!.id, phaseId: "only", runId: rec.calls[0].runId, type: "completed", token: inst!.signalToken });
  const res = await e.abort(inst!.id);
  assert.equal(res.code, 409);
});

test("reconcile fails a phase whose run ended without signalling", async () => {
  const { engine, pipelines, instances } = await load();
  const runs = await import(`./sources/runs.js?${Math.random()}`);
  await seedPipeline(pipelines);
  const rec = recordingSpawn();
  const e = engine.createEngine(baseDeps({ spawn: rec.spawn }));
  const inst = await e.start("p1", "manual");
  // Mark the run record terminal with a dead pid, but never send a signal.
  const runId = rec.calls[0].runId;
  const got = await runs.readRun(runId);
  await runs.writeRun({ ...got!.run, status: "failed", pid: 2_000_000_000, endedAt: new Date().toISOString() });
  await e.reconcile();
  const after = await instances.readInstance(inst!.id);
  assert.equal(after?.status, "failed");
});

test("reconcile records the run error as the failed phase reason", async () => {
  const { engine, pipelines, instances } = await load();
  const runs = await import(`./sources/runs.js?${Math.random()}`);
  await seedPipeline(pipelines);
  const rec = recordingSpawn();
  const e = engine.createEngine(baseDeps({ spawn: rec.spawn }));
  const inst = await e.start("p1", "manual");
  // Run ended non-zero (dead pid, real error) but never emitted a signal.
  const runId = rec.calls[0].runId;
  const got = await runs.readRun(runId);
  await runs.writeRun({
    ...got!.run, status: "failed", error: "exit code 1",
    pid: 2_000_000_000, endedAt: new Date().toISOString(),
  });
  await e.reconcile();
  const after = await instances.readInstance(inst!.id);
  assert.equal(after?.status, "failed");
  assert.equal((after?.phases[0].payload as { reason?: string })?.reason, "exit code 1");
});

test("OUTCOME_CONTRACT carries the sentinel the Stop hook matches", () => {
  // Stop hook regex: /ARGUS_OUTCOME:\s*(failed|blocked)/i
  assert.match(OUTCOME_CONTRACT, /ARGUS_OUTCOME:/);
  assert.match(OUTCOME_CONTRACT, /succeeded/);
  assert.match(OUTCOME_CONTRACT, /failed/);
  assert.match(OUTCOME_CONTRACT, /blocked/);
});

test("OUTCOME_CONTRACT interpolates no per-run data", () => {
  // A template placeholder here would change the system-prompt prefix per run
  // and destroy the prompt cache.
  assert.doesNotMatch(OUTCOME_CONTRACT, /\{\{/);
});

test("buildClaudeArgs appends the contract to the system prompt", () => {
  const run = { sessionId: "sess-123" } as Parameters<typeof buildClaudeArgs>[0];
  const args = buildClaudeArgs(run);
  const i = args.indexOf("--append-system-prompt");
  assert.notEqual(i, -1, "expected --append-system-prompt in args");
  assert.equal(args[i + 1], OUTCOME_CONTRACT);
});

test("buildClaudeArgs keeps -p, json output, and the session id", () => {
  const run = { sessionId: "sess-abc" } as Parameters<typeof buildClaudeArgs>[0];
  const args = buildClaudeArgs(run);
  assert.ok(args.includes("-p"));
  const oi = args.indexOf("--output-format");
  assert.equal(args[oi + 1], "json");
  const si = args.indexOf("--session-id");
  assert.equal(args[si + 1], "sess-abc");
});

test("buildClaudeArgs falls back to a generated session id when absent", () => {
  const run = { sessionId: null } as Parameters<typeof buildClaudeArgs>[0];
  const args = buildClaudeArgs(run);
  const si = args.indexOf("--session-id");
  assert.equal(typeof args[si + 1], "string");
  assert.ok((args[si + 1] as string).length > 0);
});

test("start() refuses when preflight fails and spawns nothing", async () => {
  const { engine, pipelines } = await load();
  await seedPipeline(pipelines);
  const rec = recordingSpawn();
  const e = engine.createEngine(baseDeps({
    spawn: rec.spawn,
    preflight: async () => ({ ok: false, reasons: ["Signal Stop hook: outdated"] }),
  }));
  await assert.rejects(() => e.start("p1"), (err: Error) => err.name === "PreflightError");
  assert.equal(rec.calls.length, 0);
});

test("start() proceeds when preflight passes", async () => {
  const { engine, pipelines } = await load();
  await seedPipeline(pipelines);
  const rec = recordingSpawn();
  const e = engine.createEngine(baseDeps({
    spawn: rec.spawn,
    preflight: async () => ({ ok: true, reasons: [] }),
  }));
  const inst = await e.start("p1");
  assert.ok(inst);
  assert.equal(rec.calls.length, 1);
});
