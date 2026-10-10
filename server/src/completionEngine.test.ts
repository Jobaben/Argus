/**
 * Strict completion (Hardening Item 3, checkpoint A), through the real engine.
 *
 * The pure decision is covered in harness/completion.test.ts; this file is
 * about where the engine applies it: before any staging, per run, on the
 * signal path and on the run-record path, under the phase's own policy read
 * from the instance's definition snapshot, and with the retry policy that the
 * new `unverified` class gets by default.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fakeKill } from "./testPlatform.js";
import { createEngine } from "./pipelineEngine.js";
import { createPipeline, validatePipelineInput, updatePipeline } from "./sources/pipelines.js";
import { readInstance } from "./sources/instances.js";
import { readRun, writeRun } from "./sources/runs.js";
import { readJournal } from "./sources/journal.js";
import { knowledgeDeltaFile, readDeltaRecord } from "./knowledge/staging.js";
import { readLedger } from "./knowledge/store.js";
import { summarizePhaseCompletion } from "./harness/completion.js";
import { createApp } from "./app.js";
import { testRunToken } from "./testSignalToken.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-completion-"));
  process.env.ARGUS_CLAUDE_HOME = home;
});

const MARKED = { last_assistant_message: "All done.\nARGUS_OUTCOME: succeeded" };
const UNMARKED = { last_assistant_message: "All done." };

let counter = 0;
function deferred() {
  let resolve!: (v: { code: number | null }) => void;
  const promise = new Promise<{ code: number | null }>((r) => (resolve = r));
  return { promise, resolve };
}
function recordingSpawn() {
  const calls: { run: any; env: Record<string, string> }[] = [];
  const spawn = (run: any, _log: string, env: Record<string, string>) => {
    calls.push({ run, env });
    return { pid: 1000 + calls.length, done: deferred().promise };
  };
  return { spawn, calls };
}
const deps = (over: Record<string, unknown> = {}): any => ({
  now: () => new Date(2026, 9, 4, 12, 0),
  newId: () => `c-${++counter}`,
  signalUrlBase: "http://localhost:7777",
  newSignalToken: testRunToken,
  maxConcurrent: 8,
  tickMs: 30000,
  kill: fakeKill().kill,
  parentEnv: { PATH: process.env.PATH ?? "/bin", HOME: home },
  ...over,
});
async function seed(phases: unknown[], over: Record<string, unknown> = {}) {
  return createPipeline(
    validatePipelineInput({ name: "strict", trigger: null, phases, ...over }),
    new Date(2026, 9, 4, 9, 0),
    "p1",
  );
}
const one = (over: Record<string, unknown> = {}) => ({
  id: "only",
  name: "Only",
  cwd: home,
  gated: false,
  steps: [{ name: "s", prompt: "p" }],
  ...over,
});
async function waitFor(cond: () => boolean | Promise<boolean>, ms = 3000) {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
const signal = (
  inst: any,
  phaseId: string,
  runId: string,
  extra: Record<string, unknown> = {},
) => ({
  instanceId: inst.id,
  phaseId,
  runId,
  type: "completed" as const,
  token: testRunToken(runId),
  ...extra,
});

// ── strict by default, lenient on request ───────────────────────────────────

test("by default a completion with no marker is refused as unverified, recorded per step", async () => {
  await seed([one()]);
  const rec = recordingSpawn();
  const e = createEngine(deps({ spawn: rec.spawn }));
  const inst = (await e.start("p1", "manual"))!;
  const runId = rec.calls[0].run.id;

  const res = await e.onSignal(inst.id, signal(inst, "only", runId, { payload: UNMARKED }));
  assert.equal(res.code, 202);

  const after = (await readInstance(inst.id))!;
  const phase = after.phases[0];
  assert.equal(phase.status, "failed");
  assert.equal((phase.payload as { failureClass: string }).failureClass, "unverified");
  assert.match((phase.payload as { reason: string }).reason, /no ARGUS_OUTCOME marker/);
  const step = phase.steps[0];
  assert.equal(step.status, "failed");
  assert.equal(step.completion?.verdict, "refused");
  assert.equal(step.completion?.marker, "missing");
  assert.equal(step.completion?.policy, "required");
  assert.equal(step.completion?.source, "signal");
  assert.equal((await readRun(runId))?.run.outcome, "failed");
  await waitFor(async () =>
    (await readJournal(inst.id)).some(
      (j: any) =>
        j.kind === "phase.signalled" && /refused: unverified, marker missing/.test(j.detail),
    ),
  );
});

test("a marked completion is accepted under the default, and says what it saw", async () => {
  await seed([one()]);
  const rec = recordingSpawn();
  const e = createEngine(deps({ spawn: rec.spawn }));
  const inst = (await e.start("p1", "manual"))!;
  const runId = rec.calls[0].run.id;
  await e.onSignal(inst.id, signal(inst, "only", runId, { payload: MARKED }));
  const after = (await readInstance(inst.id))!;
  assert.equal(after.status, "succeeded");
  const completion = after.phases[0].steps[0].completion!;
  assert.equal(completion.verdict, "accepted");
  assert.equal(completion.marker, "succeeded");
  // An old hook sends no metadata, and the record says so by its absence.
  assert.equal(completion.hook, undefined);
  assert.equal((await readRun(runId))?.run.outcome, "succeeded");
});

test("lenient accepts a markerless completion and records it truthfully as markerless", async () => {
  await seed([one()], { completion: { marker: "lenient" } });
  const rec = recordingSpawn();
  const e = createEngine(deps({ spawn: rec.spawn }));
  const inst = (await e.start("p1", "manual"))!;
  await e.onSignal(inst.id, signal(inst, "only", rec.calls[0].run.id, { payload: UNMARKED }));
  const after = (await readInstance(inst.id))!;
  assert.equal(after.status, "succeeded");
  const completion = after.phases[0].steps[0].completion!;
  assert.equal(completion.verdict, "accepted");
  assert.equal(completion.marker, "missing");
  assert.equal(completion.policy, "lenient");
});

test("a phase's own policy overrides its pipeline's, in both directions", async () => {
  await seed(
    [
      one({ id: "strict", name: "Strict", completion: { marker: "required" } }),
      one({ id: "loose", name: "Loose", needs: [] }),
    ],
    { completion: { marker: "lenient" } },
  );
  const rec = recordingSpawn();
  const e = createEngine(deps({ spawn: rec.spawn }));
  const inst = (await e.start("p1", "manual"))!;
  const byPhase = (id: string) => rec.calls.find((c) => c.run.phaseId === id)!.run.id;
  await e.onSignal(inst.id, signal(inst, "loose", byPhase("loose"), { payload: UNMARKED }));
  await e.onSignal(inst.id, signal(inst, "strict", byPhase("strict"), { payload: UNMARKED }));
  const after = (await readInstance(inst.id))!;
  assert.equal(after.phases.find((p) => p.id === "loose")?.status, "succeeded");
  assert.equal(after.phases.find((p) => p.id === "strict")?.status, "failed");
});

test("a failed or blocked marker inside a completed signal is refused under either policy, as signal", async () => {
  for (const policy of ["required", "lenient"] as const) {
    for (const kind of ["failed", "blocked"]) {
      home = mkdtempSync(path.join(tmpdir(), "argus-completion-"));
      process.env.ARGUS_CLAUDE_HOME = home;
      await seed([one()], { completion: { marker: policy } });
      const rec = recordingSpawn();
      const e = createEngine(deps({ spawn: rec.spawn }));
      const inst = (await e.start("p1", "manual"))!;
      await e.onSignal(
        inst.id,
        signal(inst, "only", rec.calls[0].run.id, {
          payload: { last_assistant_message: `ARGUS_OUTCOME: ${kind} — no credentials` },
        }),
      );
      const phase = (await readInstance(inst.id))!.phases[0];
      assert.equal(phase.status, "failed", `${policy}/${kind}`);
      assert.equal((phase.payload as { failureClass: string }).failureClass, "signal");
      assert.match(
        (phase.payload as { reason: string }).reason,
        new RegExp(`${kind}: no credentials`),
      );
    }
  }
});

test("the policy is the instance's snapshot's: editing the pipeline mid-flight changes nothing", async () => {
  await seed([one()], { completion: { marker: "lenient" } });
  const rec = recordingSpawn();
  const e = createEngine(deps({ spawn: rec.spawn }));
  const inst = (await e.start("p1", "manual"))!;
  // The live definition becomes strict after the instance started.
  await updatePipeline("p1", { completion: { marker: "required" } }, new Date());
  await e.onSignal(inst.id, signal(inst, "only", rec.calls[0].run.id, { payload: UNMARKED }));
  assert.equal((await readInstance(inst.id))!.status, "succeeded");
});

// ── the hook's metadata ──────────────────────────────────────────────────────

test("hook metadata that disagrees with the message refuses a strict completion", async () => {
  await seed([one()]);
  const rec = recordingSpawn();
  const e = createEngine(deps({ spawn: rec.spawn }));
  const inst = (await e.start("p1", "manual"))!;
  await e.onSignal(
    inst.id,
    signal(inst, "only", rec.calls[0].run.id, {
      payload: MARKED,
      // The caller claims it read nothing; the message says otherwise. The
      // two readings of one message differ — that is the ambiguity refused.
      completion: { hookVersion: 2, marker: "missing" },
    }),
  );
  const phase = (await readInstance(inst.id))!.phases[0];
  assert.equal(phase.status, "failed");
  assert.equal((phase.payload as { failureClass: string }).failureClass, "unverified");
  assert.deepEqual(phase.steps[0].completion?.hook, {
    version: 2,
    marker: "missing",
    agrees: false,
  });
});

test("caller metadata claiming success never stands in for the message", async () => {
  await seed([one()]);
  const rec = recordingSpawn();
  const e = createEngine(deps({ spawn: rec.spawn }));
  const inst = (await e.start("p1", "manual"))!;
  await e.onSignal(
    inst.id,
    signal(inst, "only", rec.calls[0].run.id, {
      payload: UNMARKED,
      completion: { hookVersion: 2, marker: "succeeded" },
    }),
  );
  const phase = (await readInstance(inst.id))!.phases[0];
  assert.equal(phase.status, "failed");
  assert.equal(phase.steps[0].completion?.marker, "missing");
});

test("an agreeing v2 hook is recorded with its version, through the HTTP route", async () => {
  await seed([one()]);
  const rec = recordingSpawn();
  const e = createEngine(deps({ spawn: rec.spawn }));
  const app = createApp({
    config: {
      port: 7777,
      host: "127.0.0.1",
      token: null,
      allowedHosts: [],
      allowedOrigins: [],
      maxConcurrentRuns: 4,
      schedulerTickMs: 30000,
      webhookUrl: null,
    },
    engine: e,
    broadcast: () => {},
    serveWeb: false,
  } as any);
  const inst = (await e.start("p1", "manual"))!;
  const res = await app.request(`/api/instances/${inst.id}/signal`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "localhost:7777",
      origin: "http://localhost:7777",
    },
    body: JSON.stringify({
      phaseId: "only",
      runId: rec.calls[0].run.id,
      type: "completed",
      token: testRunToken(rec.calls[0].run.id),
      payload: MARKED,
      completion: { hookVersion: 2, marker: "succeeded" },
    }),
  });
  assert.equal(res.status, 202);
  const after = (await readInstance(inst.id))!;
  assert.equal(after.status, "succeeded");
  assert.deepEqual(after.phases[0].steps[0].completion?.hook, {
    version: 2,
    marker: "succeeded",
    agrees: true,
  });
});

// ── before staging, before checks ────────────────────────────────────────────

test("a refused completion stages nothing the run proposed", async () => {
  await seed([one()]);
  const rec = recordingSpawn();
  const e = createEngine(deps({ spawn: rec.spawn }));
  const inst = (await e.start("p1", "manual"))!;
  const runId = rec.calls[0].run.id;
  const file = knowledgeDeltaFile(runId);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 1,
      claims: [{ localId: "c", kind: "fact", statement: "never staged" }],
    }),
  );
  await e.onSignal(inst.id, signal(inst, "only", runId, { payload: UNMARKED }));
  const after = (await readInstance(inst.id))!;
  assert.equal(after.phases[0].status, "failed");
  assert.equal(after.phases[0].steps[0].knowledgeDelta, undefined);
  assert.equal(await readDeltaRecord(runId), null);
  assert.equal((await readLedger()).claims.length, 0);
});

test("the same delta is staged when the completion carries its marker (control)", async () => {
  await seed([one({ gated: true })]);
  const rec = recordingSpawn();
  const e = createEngine(deps({ spawn: rec.spawn }));
  const inst = (await e.start("p1", "manual"))!;
  const runId = rec.calls[0].run.id;
  const file = knowledgeDeltaFile(runId);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 1,
      claims: [{ localId: "c", kind: "fact", statement: "staged" }],
    }),
  );
  await e.onSignal(inst.id, signal(inst, "only", runId, { payload: MARKED }));
  assert.equal((await readDeltaRecord(runId))?.status, "staged");
});

test("a missing marker on a phase with checks is refused before any check runs", async () => {
  await seed([one({ checks: [{ kind: "command", run: "exit 0", label: "ok" }] })]);
  const rec = recordingSpawn();
  const e = createEngine(deps({ spawn: rec.spawn }));
  const inst = (await e.start("p1", "manual"))!;
  await e.onSignal(inst.id, signal(inst, "only", rec.calls[0].run.id, { payload: UNMARKED }));
  await e.drain();
  const phase = (await readInstance(inst.id))!.phases[0];
  assert.equal(phase.status, "failed");
  // Checks are a separate authority: they did not run, and nothing claims
  // they verified anything.
  assert.equal(phase.verification, undefined);
  const journal = await readJournal(inst.id);
  assert.equal(
    journal.some((j: any) => j.kind === "phase.verifying"),
    false,
  );
});

test("under lenient, the same markerless completion still has to pass the checks", async () => {
  await seed([one({ checks: [{ kind: "command", run: "exit 3", label: "red" }] })], {
    completion: { marker: "lenient" },
  });
  const rec = recordingSpawn();
  const e = createEngine(deps({ spawn: rec.spawn }));
  const inst = (await e.start("p1", "manual"))!;
  await e.onSignal(inst.id, signal(inst, "only", rec.calls[0].run.id, { payload: UNMARKED }));
  await e.drain();
  const phase = (await readInstance(inst.id))!.phases[0];
  assert.equal(phase.status, "failed");
  assert.equal((phase.payload as { failureClass: string }).failureClass, "verification");
  assert.equal(phase.steps[0].completion?.marker, "missing");
  assert.equal(phase.steps[0].completion?.verdict, "accepted");
});

// ── multi-step and candidates ────────────────────────────────────────────────

test("a multi-step phase keeps each run's own completion; one unmarked run fails it", async () => {
  await seed([
    one({
      steps: [
        { name: "a", prompt: "a" },
        { name: "b", prompt: "b" },
      ],
    }),
  ]);
  const rec = recordingSpawn();
  const e = createEngine(deps({ spawn: rec.spawn }));
  const inst = (await e.start("p1", "manual"))!;
  const [a, b] = rec.calls.map((c) => c.run.id);
  await e.onSignal(inst.id, signal(inst, "only", a, { payload: MARKED }));
  let phase = (await readInstance(inst.id))!.phases[0];
  assert.equal(phase.status, "running");
  assert.equal(phase.steps[0].completion?.verdict, "accepted");
  // The last signal does not speak for the phase.
  assert.equal(summarizePhaseCompletion(phase.steps).allSucceededMarkers, false);
  await e.onSignal(inst.id, signal(inst, "only", b, { payload: UNMARKED }));
  phase = (await readInstance(inst.id))!.phases[0];
  assert.equal(phase.status, "failed");
  assert.equal(phase.steps[0].completion?.marker, "succeeded");
  assert.equal(phase.steps[1].completion?.marker, "missing");
  assert.equal(phase.steps[1].completion?.verdict, "refused");
});

test("under lenient, a mixed multi-step phase succeeds and its summary says it was mixed", async () => {
  await seed(
    [
      one({
        steps: [
          { name: "a", prompt: "a" },
          { name: "b", prompt: "b" },
        ],
      }),
    ],
    { completion: { marker: "lenient" } },
  );
  const rec = recordingSpawn();
  const e = createEngine(deps({ spawn: rec.spawn }));
  const inst = (await e.start("p1", "manual"))!;
  const [a, b] = rec.calls.map((c) => c.run.id);
  await e.onSignal(inst.id, signal(inst, "only", a, { payload: UNMARKED }));
  await e.onSignal(inst.id, signal(inst, "only", b, { payload: MARKED }));
  const after = (await readInstance(inst.id))!;
  assert.equal(after.status, "succeeded");
  const summary = summarizePhaseCompletion(after.phases[0].steps);
  assert.equal(summary.allSucceededMarkers, false);
  assert.deepEqual(summary.markers, { missing: 1, succeeded: 1 });
});

function gitAvailable(): boolean {
  try {
    return spawnSync("git", ["--version"]).status === 0;
  } catch {
    return false;
  }
}
function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "argus-completion-repo-"));
  const git = (args: string[]) =>
    spawnSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=T", ...args], { cwd: dir });
  git(["init", "-q", "-b", "main"]);
  writeFileSync(path.join(dir, "README.md"), "base\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);
  return dir;
}

test("an unmarked candidate loses as unverified and can never be selected", async (t) => {
  if (!gitAvailable()) return t.skip("git not available");
  const repo = makeRepo();
  await seed([
    {
      id: "impl",
      name: "Implement",
      cwd: repo,
      gated: false,
      workspace: { scope: "attempt" },
      candidates: { count: 2, select: "first-verified" },
      steps: [{ name: "code", prompt: "implement it" }],
    },
  ]);
  const rec = recordingSpawn();
  const e = createEngine(deps({ spawn: rec.spawn }));
  const inst = (await e.start("p1", "manual"))!;
  const steps = (await readInstance(inst.id))!.phases[0].steps;
  await e.onSignal(inst.id, signal(inst, "impl", steps[0].runId!, { payload: UNMARKED }));
  await e.drain();
  let phase = (await readInstance(inst.id))!.phases[0];
  assert.equal(phase.status, "running");
  assert.equal(phase.steps[0].status, "failed");
  assert.equal(phase.steps[0].failure?.class, "unverified");
  assert.equal(
    phase.steps[0].verification,
    undefined,
    "a refused candidate never reaches its checks",
  );
  await e.onSignal(inst.id, signal(inst, "impl", steps[1].runId!, { payload: MARKED }));
  await e.drain();
  await waitFor(async () => (await readInstance(inst.id))!.phases[0].status === "succeeded");
  phase = (await readInstance(inst.id))!.phases[0];
  assert.equal(phase.selectedCandidate, 1);
  assert.match(phase.candidateOutcomes?.[0].reason ?? "", /unverified/);
});

test("every candidate refused fails the phase under unverified", async (t) => {
  if (!gitAvailable()) return t.skip("git not available");
  const repo = makeRepo();
  await seed([
    {
      id: "impl",
      name: "Implement",
      cwd: repo,
      gated: false,
      workspace: { scope: "attempt" },
      candidates: { count: 2, select: "first-verified" },
      steps: [{ name: "code", prompt: "implement it" }],
    },
  ]);
  const rec = recordingSpawn();
  const e = createEngine(deps({ spawn: rec.spawn }));
  const inst = (await e.start("p1", "manual"))!;
  const steps = (await readInstance(inst.id))!.phases[0].steps;
  for (const s of steps) {
    await e.onSignal(inst.id, signal(inst, "impl", s.runId!, { payload: UNMARKED }));
  }
  await e.drain();
  const phase = (await readInstance(inst.id))!.phases[0];
  assert.equal(phase.status, "failed");
  assert.equal((phase.payload as { failureClass: string }).failureClass, "unverified");
  assert.equal(phase.selectedCandidate, null);
});

// ── the run-record path ──────────────────────────────────────────────────────

async function endRun(runId: string, resultSummary: string) {
  const got = await readRun(runId);
  await writeRun({
    ...got!.run,
    status: "succeeded",
    exitCode: 0,
    endedAt: new Date().toISOString(),
    resultSummary,
  });
}

test("run-record recovery uses the same classifier: missing → unverified, with its provenance", async () => {
  await seed([one()], { runtime: "codex" });
  const rec = recordingSpawn();
  const e = createEngine(deps({ spawn: rec.spawn }));
  const inst = (await e.start("p1", "manual"))!;
  const runId = rec.calls[0].run.id;
  await endRun(runId, "Done, no marker.");
  await e.reconcile();
  const phase = (await readInstance(inst.id))!.phases[0];
  assert.equal(phase.status, "failed");
  assert.equal((phase.payload as { failureClass: string }).failureClass, "unverified");
  assert.equal(phase.steps[0].completion?.source, "run-record");
  assert.equal(phase.steps[0].completion?.marker, "missing");
  assert.equal(phase.steps[0].completion?.verdict, "refused");
});

test("run-record recovery never infers success from an exit code, even under lenient", async () => {
  await seed([one()], { runtime: "opencode", completion: { marker: "lenient" } });
  const rec = recordingSpawn();
  const e = createEngine(deps({ spawn: rec.spawn }));
  const inst = (await e.start("p1", "manual"))!;
  await endRun(rec.calls[0].run.id, "Done, no marker.");
  await e.reconcile();
  const phase = (await readInstance(inst.id))!.phases[0];
  assert.equal(phase.status, "failed");
  assert.equal((phase.payload as { failureClass: string }).failureClass, "unverified");
  assert.equal(phase.steps[0].completion?.policy, "lenient");
});

test("a marked run record completes, and records where the completion came from", async () => {
  await seed([one()], { runtime: "codex" });
  const rec = recordingSpawn();
  const e = createEngine(deps({ spawn: rec.spawn }));
  const inst = (await e.start("p1", "manual"))!;
  await endRun(rec.calls[0].run.id, "Done.\nARGUS_OUTCOME: succeeded");
  await e.reconcile();
  const after = (await readInstance(inst.id))!;
  assert.equal(after.status, "succeeded");
  assert.equal(after.phases[0].steps[0].completion?.source, "run-record");
  assert.equal(after.phases[0].steps[0].completion?.verdict, "accepted");
});

test("a run-record failure marker is the agent's verdict: class signal, reported-failure", async () => {
  await seed([one()], { runtime: "codex" });
  const rec = recordingSpawn();
  const e = createEngine(deps({ spawn: rec.spawn }));
  const inst = (await e.start("p1", "manual"))!;
  await endRun(rec.calls[0].run.id, "ARGUS_OUTCOME: blocked — no network");
  await e.reconcile();
  const phase = (await readInstance(inst.id))!.phases[0];
  assert.equal((phase.payload as { failureClass: string }).failureClass, "signal");
  assert.equal(phase.steps[0].completion?.verdict, "reported-failure");
});

// ── retry ────────────────────────────────────────────────────────────────────

test("unverified is retried by default, and the retry is told which marker is required", async () => {
  let now = new Date(2026, 9, 4, 12, 0);
  await seed([one({ retry: { attempts: 2, backoffSeconds: 0 } })]);
  const rec = recordingSpawn();
  const e = createEngine(deps({ spawn: rec.spawn, now: () => now }));
  const inst = (await e.start("p1", "manual"))!;
  await e.onSignal(inst.id, signal(inst, "only", rec.calls[0].run.id, { payload: UNMARKED }));
  const failed = (await readInstance(inst.id))!;
  assert.equal(failed.status, "running", "a retry is scheduled, so the instance is not terminal");
  assert.ok(failed.phases[0].retryAt);
  now = new Date(now.getTime() + 1000);
  await e.reconcile();
  await waitFor(() => rec.calls.length === 2);
  const prompt: string = rec.calls[1].run.prompt;
  assert.match(prompt, /failed — unverified/);
  assert.match(prompt, /ARGUS_OUTCOME: succeeded/);
});

test("a policy that lists classes explicitly must name unverified to retry it", async () => {
  await seed([one({ retry: { attempts: 2, backoffSeconds: 0, retryOn: ["exit-code"] } })]);
  const rec = recordingSpawn();
  const e = createEngine(deps({ spawn: rec.spawn }));
  const inst = (await e.start("p1", "manual"))!;
  await e.onSignal(inst.id, signal(inst, "only", rec.calls[0].run.id, { payload: UNMARKED }));
  const after = (await readInstance(inst.id))!;
  assert.equal(after.status, "failed");
  assert.equal(after.phases[0].retryAt ?? null, null);
});

// ── authoring ────────────────────────────────────────────────────────────────

test("completion is validated where it is authored", () => {
  const base = { name: "x", trigger: null, phases: [one()] };
  assert.deepEqual(
    validatePipelineInput({ ...base, completion: { marker: "lenient" } }).completion,
    {
      marker: "lenient",
    },
  );
  assert.equal(validatePipelineInput(base).completion, undefined);
  assert.equal(validatePipelineInput({ ...base, completion: null }).completion, undefined);
  for (const bad of [{ marker: "off" }, { marker: "lenient", extra: 1 }, "lenient", [], {}]) {
    assert.throws(() => validatePipelineInput({ ...base, completion: bad }), /completion/);
    assert.throws(
      () => validatePipelineInput({ ...base, phases: [one({ completion: bad })] }),
      /completion/,
    );
  }
  assert.deepEqual(
    validatePipelineInput({ ...base, phases: [one({ completion: { marker: "required" } })] })
      .phases[0].completion,
    { marker: "required" },
  );
});

test("retryOn accepts every retryable class, including unverified", () => {
  const all = [
    "spawn",
    "exit-code",
    "signal",
    "timeout",
    "verification",
    "knowledge-delta",
    "knowledge-context-integrity",
    "rule-verification",
    "change-proposal",
    "change-context-integrity",
    "acceptance-verification",
    "unverified",
  ];
  const input = validatePipelineInput({
    name: "x",
    trigger: null,
    phases: [one({ retry: { attempts: 3, retryOn: all } })],
  });
  assert.deepEqual(input.phases[0].retry?.retryOn, all);
  assert.throws(
    () =>
      validatePipelineInput({
        name: "x",
        trigger: null,
        phases: [one({ retry: { attempts: 3, retryOn: ["configuration"] } })],
      }),
    /retryOn/,
  );
});
