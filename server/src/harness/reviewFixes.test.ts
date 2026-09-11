/**
 * Regression tests pinning the review fixes landed alongside the fake-agent
 * e2e suite (see the commit "Add the fake-agent end-to-end suite and fix the
 * review findings"). Each test here is written to FAIL against the behavior
 * that shipped just before that commit — see the comment on each test for
 * what the previous, buggy behavior was.
 *
 * Style mirrors `../pipelineEngineHarness.test.ts` (recordingSpawn/baseDeps/
 * waitFor/seed/deferred) and `./verification.test.ts` (gitAvailable/makeRepo).
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile, rm, symlink, truncate } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { redactProfile, safeSegment, phaseArtifactDir, phaseBaselinePath } from "./invocation.js";
import {
  runCheck,
  snapshotWorkingTree,
  committedSince,
  MAX_SNAPSHOT_ENTRIES,
  MAX_HASH_BYTES,
  type CheckContext,
} from "./verification.js";
import type { CapabilityProfile } from "../sources/pipelineTypes.js";

// ── Shared engine-test helpers (mirrors ../pipelineEngineHarness.test.ts) ────

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-review-fixes-"));
  process.env.ARGUS_CLAUDE_HOME = home;
});

async function load() {
  const engine = await import(`../pipelineEngine.js?${Math.random()}`);
  const pipelines = await import(`../sources/pipelines.js?${Math.random()}`);
  const instances = await import(`../sources/instances.js?${Math.random()}`);
  const runsSrc = await import(`../sources/runs.js?${Math.random()}`);
  const journalSrc = await import(`../sources/journal.js?${Math.random()}`);
  return { engine, pipelines, instances, runsSrc, journalSrc };
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
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
  parentEnv: { PATH: "/bin", HOME: "/h", ARGUS_TOKEN: "secret", MY_SECRET: "x" },
  ...over,
});

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

// ── Shared verification-test helpers (mirrors ./verification.test.ts) ───────

function gitAvailable(): boolean {
  try {
    const res = spawnSync("git", ["--version"]);
    return res.status === 0;
  } catch {
    return false;
  }
}

function gitRun(args: string[], cwd: string) {
  return spawnSync("git", args, { cwd });
}

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "argus-review-verify-"));
  gitRun(["init", "-q"], dir);
  gitRun(
    [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test",
      "commit",
      "--allow-empty",
      "-q",
      "-m",
      "init",
    ],
    dir,
  );
  return dir;
}

async function makeUncommittedRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "argus-review-verify-nc-"));
  gitRun(["init", "-q"], dir);
  return dir;
}

function commit(dir: string, message: string): void {
  gitRun(
    ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "-m", message],
    dir,
  );
}

function baseCtx(overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    cwd: overrides.cwd ?? process.cwd(),
    artifactDir: overrides.artifactDir ?? null,
    baseline: overrides.baseline ?? null,
    ...overrides,
  };
}

// ── 1. Deadline starts at spawn, not at planning ─────────────────────────────
// Previously `deadlineAt` was computed when the wave was *planned* (before a
// step even had a concurrency slot), so a step that had to wait behind a
// sibling could be handed an already-expired deadline the moment it finally
// spawned.

test("the step deadline starts at spawn time, not when the wave was planned", async () => {
  const { engine, pipelines, instances, runsSrc } = await load();
  await seed(pipelines, [
    {
      id: "only",
      name: "Only",
      cwd: home,
      gated: false,
      // Only step "b" carries a deadline: step "a" is held open past 2s on
      // purpose (to prove "b"'s deadline is *not* stamped at planning time,
      // ~when "a" started), and must not time out itself while we do that.
      steps: [
        { name: "a", prompt: "p" },
        { name: "b", prompt: "p", timeoutSeconds: 2 },
      ],
    },
  ]);
  const rec = recordingSpawn();
  const e = engine.createEngine(
    baseDeps({ spawn: rec.spawn, maxConcurrent: 1, now: () => new Date(), killGraceMs: 50 }),
  );

  // maxConcurrent: 1 means step "b" must wait behind "a" for a slot.
  const startP = e.start("p1", "manual");

  let inst: any = null;
  await waitFor(async () => {
    const list = await instances.readInstances();
    if (list.length !== 1) return false;
    inst = await instances.readInstance(list[0].id);
    // `initInstance` pre-populates each phase's steps (name + null runId,
    // status "pending") before `startPhase` ever runs — wait for the actual
    // launch to assign real runIds, not just for the array to be the right
    // length.
    return (
      !!inst &&
      inst.phases[0].steps.length === 2 &&
      inst.phases[0].steps.every((s: any) => s.runId != null)
    );
  });
  const runIdB = inst.phases[0].steps[1].runId;

  // Queued: step "b" has no run record yet, and certainly no deadline.
  assert.equal(await runsSrc.readRun(runIdB), null);

  // Hold step "a" running well past its own 2s timeout before freeing the
  // slot. Under the OLD behavior (deadline fixed at planning time, ~now),
  // step "b" would be handed an already-expired deadline the instant it
  // finally spawned.
  await new Promise((r) => setTimeout(r, 2500));
  rec.dones[0].resolve({ code: 0 });

  // `rec.calls.length` grows the instant `deps.spawn` is *called*, before the
  // run record is written — wait for the record itself so the read below
  // isn't racing that write.
  await waitFor(async () => (await runsSrc.readRun(runIdB)) !== null);
  assert.equal(rec.calls.length, 2);
  const runB = await runsSrc.readRun(runIdB);
  assert.ok(runB);
  assert.ok(runB!.run.deadlineAt);
  assert.ok(runB!.run.startedAt);
  const delta = Date.parse(runB!.run.deadlineAt!) - Date.parse(runB!.run.startedAt!);
  assert.ok(Math.abs(delta - 2000) < 500, `expected deadline ~2000ms after spawn, got ${delta}ms`);

  // And it must not already be expired: give the deadline timer every chance
  // to fire wrongly, then confirm the phase is still running.
  await new Promise((r) => setTimeout(r, 500));
  const mid = await instances.readInstance(inst.id);
  assert.equal(mid!.phases[0].status, "running");

  rec.dones[1].resolve({ code: 0 });
  await startP;
  await e.drain();
});

// ── 2. Invocation record redacts secrets ─────────────────────────────────────
// Previously the invocation record stored the capability profile verbatim,
// so env.set values and MCP server env/header secrets were readable by
// anyone who could read a run's invocation record.

test("the invocation record redacts env.set and MCP env/header secrets, while the child and materialized config still get them", async () => {
  const { engine, pipelines, runsSrc } = await load();
  await seed(pipelines, [
    {
      id: "only",
      name: "Only",
      cwd: home,
      gated: false,
      capabilities: {
        env: { set: { MY_TOOL_TOKEN: "sk-secret" } },
        mcpServers: {
          docs: { command: "x", env: { API_KEY: "k1" }, headers: { Authorization: "Bearer zzz" } },
        },
      },
      steps: [{ name: "s", prompt: "p" }],
    },
  ]);
  const rec = recordingSpawn();
  const e = engine.createEngine(baseDeps({ spawn: rec.spawn }));
  const inst = await e.start("p1", "manual");
  const runId = inst!.phases[0].steps[0].runId;

  const record = await runsSrc.readInvocation(runId);
  assert.equal(record.capabilities.env.set.MY_TOOL_TOKEN, "<redacted>");
  assert.equal(record.capabilities.mcpServers.docs.env.API_KEY, "<redacted>");
  assert.equal(record.capabilities.mcpServers.docs.headers.Authorization, "<redacted>");

  // The materialized mcp.json on disk still carries the real values — the
  // record redacts what it *shows*, not what the process actually gets.
  const mcpFile = rec.calls[0].prepared.files.find((f: { path: string }) =>
    f.path.endsWith("mcp.json"),
  );
  assert.ok(mcpFile);
  assert.ok(existsSync(mcpFile.path));
  const contents = readFileSync(mcpFile.path, "utf8");
  assert.ok(contents.includes("k1"));
  assert.ok(contents.includes("Bearer zzz"));

  // And the actual child environment still gets the secret too.
  assert.equal(rec.calls[0].prepared.env.MY_TOOL_TOKEN, "sk-secret");
});

test("redactProfile: keeps keys, redacts only env.set/MCP env/header values, and never mutates its input", () => {
  const profile: CapabilityProfile = {
    filesystem: "workspace-write",
    env: { inherit: "minimal", set: { A: "secret-a", B: "secret-b" } },
    mcpServers: {
      docs: { command: "x", env: { K: "v1" }, headers: { Authorization: "Bearer z" } },
      bare: { command: "y" },
    },
  };
  const snapshot = JSON.parse(JSON.stringify(profile));

  const out = redactProfile(profile);

  assert.equal(out.filesystem, "workspace-write");
  assert.equal(out.env!.inherit, "minimal");
  assert.deepEqual(Object.keys(out.env!.set!).sort(), ["A", "B"]);
  assert.equal(out.env!.set!.A, "<redacted>");
  assert.equal(out.env!.set!.B, "<redacted>");

  assert.equal(out.mcpServers!.docs.command, "x");
  assert.equal(out.mcpServers!.docs.env!.K, "<redacted>");
  assert.equal(out.mcpServers!.docs.headers!.Authorization, "<redacted>");
  // A server with no env/headers is left as-is (nothing to redact).
  assert.deepEqual(out.mcpServers!.bare, { command: "y" });

  // The input object itself is untouched.
  assert.deepEqual(profile, snapshot);
});

// ── 3. Verification commands run under the phase env policy ─────────────────
// Previously Argus's own checks ran under `buildChildEnv(parentEnv(), undefined)`
// — i.e. Argus's own (unrestricted) environment — regardless of what the
// phase's own capability profile said the agent could see.

test("a command check runs under the phase's own env policy: a denied variable is unset", async () => {
  const { engine, pipelines, instances } = await load();
  await seed(pipelines, [
    {
      id: "checked",
      name: "Checked",
      cwd: home,
      gated: false,
      capabilities: { env: { inherit: "minimal", deny: ["LEAKY_*"] } },
      checks: [{ kind: "command", run: 'test -z "$LEAKY_SECRET"' }],
      steps: [{ name: "s", prompt: "p" }],
    },
  ]);
  const rec = recordingSpawn();
  const e = engine.createEngine(
    baseDeps({ spawn: rec.spawn, parentEnv: { ...process.env, LEAKY_SECRET: "1" } }),
  );
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
  assert.equal(after.phases[0].verification.status, "passed");
});

test("control: with no capabilities declared, the same check fails because the variable is inherited", async () => {
  const { engine, pipelines, instances } = await load();
  await seed(pipelines, [
    {
      id: "checked",
      name: "Checked",
      cwd: home,
      gated: false,
      checks: [{ kind: "command", run: 'test -z "$LEAKY_SECRET"' }],
      steps: [{ name: "s", prompt: "p" }],
    },
  ]);
  const rec = recordingSpawn();
  const e = engine.createEngine(
    baseDeps({ spawn: rec.spawn, parentEnv: { ...process.env, LEAKY_SECRET: "1" } }),
  );
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
  assert.equal(after.phases[0].verification.status, "failed");
});

// ── 4. Timeout is not recorded for a step that already completed ────────────
// Previously `expireStep` wrote `termination: "timed-out"` and the
// `step.timed-out` journal entry unconditionally, even when the completion
// signal had already landed and `failStep`'s own guard was about to no-op the
// transition — leaving a stray "timed-out" stamp on an otherwise-succeeded run.

test("a completion signal that beats the deadline leaves no timeout stamp on the run or journal", async () => {
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
  const d = deferred();
  const spawn = () => ({ pid: 9001, done: d.promise });
  const e = engine.createEngine(baseDeps({ spawn, now: () => new Date() }));
  const inst = await e.start("p1", "manual");
  const runId = inst!.phases[0].steps[0].runId;

  // Signal completed well before the 1s deadline.
  await e.onSignal(inst!.id, {
    instanceId: inst!.id,
    phaseId: "only",
    runId,
    type: "completed",
    token: inst!.signalToken,
  });
  await e.drain();

  // The process itself doesn't actually exit until after the deadline fires.
  await new Promise((r) => setTimeout(r, 1500));
  d.resolve({ code: 0 });
  await new Promise((r) => setTimeout(r, 500));

  const after = await instances.readInstance(inst!.id);
  assert.equal(after.status, "succeeded");
  assert.equal(after.phases[0].status, "succeeded");

  const run = await runsSrc.readRun(runId);
  assert.equal(run!.run.termination, undefined);

  const j = await journalSrc.readJournal(inst!.id);
  assert.ok(!j.some((entry: any) => entry.kind === "step.timed-out"));
});

// ── 5. Reconcile fails a step whose process never started ──────────────────
// A phase can be persisted with a step recorded as "running" whose process
// was never actually launched (Argus stopped between recording the step and
// spawning it). Reconcile must heal it as a spawn failure, not leave it
// running forever.

test("reconcile fails a step whose process never started (no run record at all)", async () => {
  const { engine, pipelines, instances, runsSrc } = await load();
  const def = await seed(pipelines, [
    { id: "only", name: "Only", cwd: home, gated: false, steps: [{ name: "s", prompt: "p" }] },
  ]);
  const now = new Date().toISOString();
  await instances.writeInstance({
    id: "inst-ghost-1",
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
        steps: [{ name: "s", runId: "ghost-1", status: "running" }],
        attempt: 0,
        needs: [],
        retries: 0,
        payload: null,
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

  const inst = await instances.readInstance("inst-ghost-1");
  assert.equal(inst!.phases[0].status, "failed");
  assert.equal((inst!.phases[0].payload as any).failureClass, "spawn");
  assert.match((inst!.phases[0].payload as any).reason, /before the step's process was started/);

  const run = await runsSrc.readRun("ghost-1");
  assert.ok(run);
  assert.equal(run!.run.termination, "spawn-failed");
});

test("reconcile fails a step whose process never started (a run record exists but never got a pid)", async () => {
  const { engine, pipelines, instances, runsSrc } = await load();
  const def = await seed(pipelines, [
    { id: "only", name: "Only", cwd: home, gated: false, steps: [{ name: "s", prompt: "p" }] },
  ]);
  const now = new Date().toISOString();
  await runsSrc.writeRun({
    id: "ghost-2",
    scheduleId: `pipeline:${def.id}`,
    scheduleName: "feature · Only",
    prompt: "p",
    cwd: home,
    status: "running",
    trigger: "scheduled",
    queuedAt: now,
    startedAt: now,
    endedAt: null,
    durationMs: null,
    pid: null,
    exitCode: null,
    sessionId: null,
    runtime: "claude",
    project: null,
    resultSummary: null,
    error: null,
    instanceId: "inst-ghost-2",
    phaseId: "only",
    deadlineAt: null,
  });
  await instances.writeInstance({
    id: "inst-ghost-2",
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
        steps: [{ name: "s", runId: "ghost-2", status: "running" }],
        attempt: 0,
        needs: [],
        retries: 0,
        payload: null,
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

  const inst = await instances.readInstance("inst-ghost-2");
  assert.equal(inst!.phases[0].status, "failed");
  assert.equal((inst!.phases[0].payload as any).failureClass, "spawn");

  const run = await runsSrc.readRun("ghost-2");
  assert.equal(run!.run.termination, "spawn-failed");
});

test("reconcile schedules a retry for a never-started step when the phase's retry policy allows it", async () => {
  const { engine, pipelines, instances } = await load();
  const def = await seed(pipelines, [
    {
      id: "only",
      name: "Only",
      cwd: home,
      gated: false,
      retry: { attempts: 2, backoffSeconds: 0 },
      steps: [{ name: "s", prompt: "p" }],
    },
  ]);
  const now = new Date().toISOString();
  await instances.writeInstance({
    id: "inst-ghost-3",
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
        steps: [{ name: "s", runId: "ghost-3", status: "running" }],
        attempt: 0,
        needs: [],
        retries: 0,
        payload: null,
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

  const inst = await instances.readInstance("inst-ghost-3");
  assert.equal(inst!.phases[0].status, "failed");
  assert.ok(inst!.phases[0].retryAt, "expected a retry to be scheduled");
});

// ── 6. A step being launched in this process is not mistaken for a never-started one ──
// Previously `start()` launched phases *outside* the instance lock, so a
// concurrent `reconcile()` healing pass could observe a step recorded as
// "running" with no run record yet (the run record is only written once the
// spawn call resolves) and wrongly fail it as a spawn failure.

test("reconcile never mistakes a step still being spawned in this process for one that never started", async () => {
  const { engine, pipelines, instances, runsSrc } = await load();
  await seed(pipelines, [
    { id: "only", name: "Only", cwd: home, gated: false, steps: [{ name: "s", prompt: "p" }] },
  ]);
  let resolveHandle!: (h: { pid: number; done: Promise<{ code: number | null }> }) => void;
  const handleP = new Promise<{ pid: number; done: Promise<{ code: number | null }> }>(
    (r) => (resolveHandle = r),
  );
  const spawn = () => handleP; // the spawn call itself resolves only after a delay
  const e = engine.createEngine(baseDeps({ spawn }));

  const startP = e.start("p1", "manual");

  await waitFor(async () => (await instances.readInstances()).length === 1);
  const instId = (await instances.readInstances())[0].id;

  // reconcile() runs concurrently with the still-pending spawn.
  const reconcileP = e.reconcile();
  setTimeout(() => resolveHandle({ pid: 4242, done: new Promise(() => {}) }), 300);

  await Promise.all([startP, reconcileP]);

  const inst = await instances.readInstance(instId);
  assert.equal(inst!.phases[0].status, "running");
  assert.equal(inst!.phases[0].steps[0].status, "running");
  const runId = inst!.phases[0].steps[0].runId;
  const run = await runsSrc.readRun(runId);
  assert.equal(run!.run.pid, 4242);
});

// ── 7. changed-files sees committed changes ─────────────────────────────────
// Previously `changed-files` only diffed the working tree, so an agent that
// committed its work left a clean tree and nothing was ever reported.

test("changed-files sees changes the agent committed, not only working-tree edits", async (t) => {
  if (!gitAvailable()) return t.skip("git not available");
  const dir = await makeRepo();
  const baseline = await snapshotWorkingTree(dir);
  assert.ok(baseline);

  await writeFile(path.join(dir, "a.txt"), "hi");
  gitRun(["add", "a.txt"], dir);
  commit(dir, "add a");

  const ctx = baseCtx({ cwd: dir, baseline });
  const denied = await runCheck({ kind: "changed-files", deny: ["a.txt"] }, ctx);
  assert.equal(denied.status, "failed");
  assert.match(denied.detail, /a\.txt/);

  const passing = await runCheck({ kind: "changed-files" }, ctx);
  assert.equal(passing.status, "passed");
  assert.ok(passing.output?.includes("a.txt"));

  await rm(dir, { recursive: true, force: true });
});

test("committedSince: an unchanged HEAD reports no committed changes", async (t) => {
  if (!gitAvailable()) return t.skip("git not available");
  const dir = await makeRepo();
  const snap = await snapshotWorkingTree(dir);
  assert.ok(snap);
  const result = await committedSince(snap!, snap!, dir);
  assert.deepEqual(result, []);
  await rm(dir, { recursive: true, force: true });
});

test("committedSince: a null baseline head lists every tracked file at the current head", async (t) => {
  if (!gitAvailable()) return t.skip("git not available");
  const dir = await makeUncommittedRepo();
  const baseline = await snapshotWorkingTree(dir);
  assert.ok(baseline);
  assert.equal(baseline!.head, null);

  await writeFile(path.join(dir, "a.txt"), "hi");
  await writeFile(path.join(dir, "b.txt"), "there");
  gitRun(["add", "a.txt", "b.txt"], dir);
  commit(dir, "first commit");

  const current = await snapshotWorkingTree(dir);
  assert.ok(current);
  assert.ok(current!.head);

  const result = await committedSince(baseline!, current!, dir);
  assert.ok(result);
  assert.deepEqual([...result!].sort(), ["a.txt", "b.txt"]);
  await rm(dir, { recursive: true, force: true });
});

// ── 8. Staging is not a content change ──────────────────────────────────────
// Previously a dirty path's identity included git's status code
// (`${statusCode}:${hash}`), so `git add`-ing an already-dirty file changed
// its identity (the status code flips) even though its bytes did not,
// producing a false positive.

test("staging an already-dirty file is not itself reported as a content change", async (t) => {
  if (!gitAvailable()) return t.skip("git not available");
  const dir = await makeRepo();
  await writeFile(path.join(dir, "note.txt"), "hello");
  gitRun(["add", "note.txt"], dir);
  commit(dir, "add note");

  await writeFile(path.join(dir, "note.txt"), "hello, modified");
  const baseline = await snapshotWorkingTree(dir);
  assert.ok(baseline);
  assert.ok("note.txt" in baseline!.dirty);

  gitRun(["add", "note.txt"], dir); // stage it; content is unchanged

  const ctx = baseCtx({ cwd: dir, baseline });
  const passing = await runCheck({ kind: "changed-files", deny: ["*.txt"] }, ctx);
  assert.equal(passing.status, "passed");

  // Modifying its content after staging is still detected.
  await writeFile(path.join(dir, "note.txt"), "hello, modified again");
  const failing = await runCheck({ kind: "changed-files", deny: ["*.txt"] }, ctx);
  assert.equal(failing.status, "failed");
  assert.match(failing.detail, /note\.txt/);

  await rm(dir, { recursive: true, force: true });
});

// ── 9. Symlinked artifact/file rejected ─────────────────────────────────────
// Previously `stat` (which follows symlinks) was used, so a symlink to some
// file elsewhere on disk could satisfy an artifact/file check.

test("artifact check rejects a symlink even when it resolves to a real file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "argus-review-symlink-"));
  await symlink("/etc/hostname", path.join(dir, "report.md"));
  const ctx = baseCtx({ artifactDir: dir });

  const res = await runCheck({ kind: "artifact", path: "report.md" }, ctx);
  assert.equal(res.status, "failed");
  assert.match(res.detail, /symbolic link/);

  await writeFile(path.join(dir, "ok.md"), "a real file");
  const control = await runCheck({ kind: "artifact", path: "ok.md" }, ctx);
  assert.equal(control.status, "passed");

  await rm(dir, { recursive: true, force: true });
});

test("file check also rejects a symlink even when it resolves to a real file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "argus-review-symlink-file-"));
  await symlink("/etc/hostname", path.join(dir, "linked.txt"));
  const ctx = baseCtx({ cwd: dir });

  const res = await runCheck({ kind: "file", path: "linked.txt" }, ctx);
  assert.equal(res.status, "failed");
  assert.match(res.detail, /symbolic link/);

  await rm(dir, { recursive: true, force: true });
});

// ── 10. A command check that ignores SIGTERM still settles ──────────────────
// Previously the timeout sent a single SIGTERM and never escalated, so a
// command trapping/ignoring it could hang verification (and with it the
// phase, the instance, and drain()) forever.

test("a command that ignores SIGTERM is escalated to SIGKILL and settles", async () => {
  const ctx = baseCtx({ killGraceMs: 200 });
  const start = Date.now();
  const res = await runCheck(
    {
      kind: "command",
      run: `node -e "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"`,
      timeoutSeconds: 1,
    },
    ctx,
  );
  const elapsed = Date.now() - start;
  assert.equal(res.status, "failed");
  assert.match(res.detail, /timed out/);
  assert.ok(elapsed < 3000, `expected the check to settle well under 3s, took ${elapsed}ms`);
});

// ── 11. Snapshot caps ────────────────────────────────────────────────────────
// Previously an unbounded dirty set could be hashed file-by-file with no
// upper bound, and a `changed-files` verdict was rendered over it regardless
// of how large or unreliable that snapshot was.

test("a working tree with more dirty paths than MAX_SNAPSHOT_ENTRIES is truncated, and changed-files refuses to judge it", async (t) => {
  if (!gitAvailable()) return t.skip("git not available");
  const dir = await makeRepo();
  const baseline = await snapshotWorkingTree(dir);
  assert.ok(baseline);

  for (let i = 0; i < MAX_SNAPSHOT_ENTRIES + 5; i++) {
    writeFileSync(path.join(dir, `f${i}.txt`), "x");
  }

  const snap = await snapshotWorkingTree(dir);
  assert.ok(snap);
  assert.equal(snap!.truncated, true);

  const ctx = baseCtx({ cwd: dir, baseline: snap });
  const res = await runCheck({ kind: "changed-files" }, ctx);
  assert.equal(res.status, "failed");
  assert.match(res.detail, /cannot be evaluated/);

  await rm(dir, { recursive: true, force: true });
});

test("a dirty file above MAX_HASH_BYTES is identified by size, not by hashing its bytes", async (t) => {
  if (!gitAvailable()) return t.skip("git not available");
  const dir = await makeRepo();
  const file = path.join(dir, "big.bin");
  await writeFile(file, "seed");
  gitRun(["add", "big.bin"], dir);
  commit(dir, "add big");

  await truncate(file, MAX_HASH_BYTES + 1);
  const snap = await snapshotWorkingTree(dir);
  assert.ok(snap);
  assert.ok(snap!.dirty["big.bin"]?.startsWith("size:"), `got ${snap!.dirty["big.bin"]}`);

  await rm(dir, { recursive: true, force: true });
});

// ── 15. Failure class persisted on the signal path without a retry policy ──
// Previously `noteFailure`'s return value (whether a retry was scheduled)
// gated the write of the failure class onto the phase, so a phase with no
// retry policy (where `noteFailure` returns false) never got its
// `payload.failureClass` persisted at all.

test("an agent-signalled failure with no retry policy still persists failureClass: signal", async () => {
  const { engine, pipelines, instances } = await load();
  await seed(pipelines, [
    { id: "only", name: "Only", cwd: home, gated: false, steps: [{ name: "s", prompt: "p" }] },
  ]);
  const rec = recordingSpawn();
  const e = engine.createEngine(baseDeps({ spawn: rec.spawn }));
  const inst = await e.start("p1", "manual");
  const runId = inst!.phases[0].steps[0].runId;

  await e.onSignal(inst!.id, {
    instanceId: inst!.id,
    phaseId: "only",
    runId,
    type: "failed",
    token: inst!.signalToken,
  });
  await e.drain();

  const after = await instances.readInstance(inst!.id);
  assert.equal(after.phases[0].status, "failed");
  assert.equal((after.phases[0].payload as any).failureClass, "signal");
});

test("a phase declaring a result whose completion carries none is also classed as a signal failure", async () => {
  const { engine, pipelines, instances } = await load();
  await seed(pipelines, [
    {
      id: "checked",
      name: "Checked",
      cwd: home,
      gated: false,
      result: { artifact: "verdict", schema: { type: "string" } },
      steps: [{ name: "s", prompt: "p" }],
    },
  ]);
  const rec = recordingSpawn();
  const e = engine.createEngine(baseDeps({ spawn: rec.spawn }));
  const inst = await e.start("p1", "manual");
  const runId = inst!.phases[0].steps[0].runId;

  // Signal completed without ever submitting the declared result.
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
  assert.equal((after.phases[0].payload as any).failureClass, "signal");
});

// ── 16. Exit after completion is journalled ─────────────────────────────────
// A step's completion signal is authoritative, but if the underlying process
// then exits non-zero it must not be silently swallowed: the mismatch is
// journalled and the run record keeps both facts.

test("a process that exits non-zero after its own completion signal is journalled, not silently dropped", async () => {
  const { engine, pipelines, instances, runsSrc, journalSrc } = await load();
  await seed(pipelines, [
    { id: "only", name: "Only", cwd: home, gated: false, steps: [{ name: "s", prompt: "p" }] },
  ]);
  const d = deferred();
  const spawn = () => ({ pid: 5551, done: d.promise });
  const e = engine.createEngine(baseDeps({ spawn }));
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

  d.resolve({ code: 3 });
  await waitFor(async () => (await runsSrc.readRun(runId))?.run.status === "failed");

  const after = await instances.readInstance(inst!.id);
  assert.equal(after.phases[0].status, "succeeded");

  const run = await runsSrc.readRun(runId);
  assert.equal(run!.run.status, "failed");
  assert.equal(run!.run.outcome, "succeeded");

  const j = await journalSrc.readJournal(inst!.id);
  const entry = j.find((e2: any) => e2.kind === "step.exit-mismatch");
  assert.ok(entry, "expected a step.exit-mismatch journal entry");
  assert.match(entry.detail, /exited 3/);
});

// ── 17. safeSegment / phaseArtifactDir keep directory joins inside their root ──
// Previously phase/instance ids were joined into a path with no sanitization,
// so an id containing "." / ".." segments or separators could steer the
// per-attempt artifact wipe outside its own directory.

test("safeSegment neutralizes path-hostile segments and leaves normal ids alone", () => {
  assert.equal(safeSegment("../x"), ".._x");
  assert.equal(safeSegment(".."), "_.._");
  assert.equal(safeSegment("a/b"), "a_b");
  assert.equal(safeSegment("feature-1.a_b"), "feature-1.a_b");
});

/** A path escapes `root` only if some segment of the relative path is
 *  literally `".."` (or the relative path is itself absolute) — a segment
 *  that merely *starts with* two dots, like the sanitized `"..evil"`, is a
 *  perfectly ordinary (safe) directory name, not a parent-directory escape. */
function escapesRoot(root: string, absolutePath: string): boolean {
  const rel = path.relative(root, absolutePath);
  return path.isAbsolute(rel) || rel.split(path.sep).some((seg) => seg === "..");
}

test("phaseArtifactDir stays under its root even for a path-hostile phase id", () => {
  const root = "/argus/artifacts";
  const dir = phaseArtifactDir(root, "i", "../../x");
  assert.ok(!escapesRoot(root, dir), `escaped root: ${dir}`);
});

test("phaseBaselinePath stays under its root for a path-hostile instance id", () => {
  const root = "/argus/invocations";
  const file = phaseBaselinePath(root, "../evil", "only", 0);
  assert.ok(!escapesRoot(root, file), `escaped root: ${file}`);
});
