/**
 * Per-run signal tokens (Hardening Item 3, checkpoint B), through the engine.
 *
 * What is being proved: a run's token authenticates signals for that run and
 * nothing else; a run that is no longer the step's current run cannot move
 * anything; a step that already reported is not re-decided; runs launched
 * before the upgrade keep working; and no token value reaches a record.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fakeKill } from "./testPlatform.js";
import { createEngine } from "./pipelineEngine.js";
import { createPipeline, validatePipelineInput } from "./sources/pipelines.js";
import { readInstance, writeInstance } from "./sources/instances.js";
import { readRun, writeRun } from "./sources/runs.js";
import { readJournal } from "./sources/journal.js";
import { testRunToken } from "./testSignalToken.js";
import {
  signalAuthFor,
  signalTokenDigest,
  verifySignalToken,
  safeEqual,
} from "./harness/signalToken.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-signal-tokens-"));
  process.env.ARGUS_CLAUDE_HOME = home;
});

const MARKED = { last_assistant_message: "done\nARGUS_OUTCOME: succeeded" };

let counter = 0;
function recordingSpawn() {
  const calls: { run: any; env: Record<string, string> }[] = [];
  const spawn = (run: any, _log: string, env: Record<string, string>) => {
    calls.push({ run, env });
    return { pid: 2000 + calls.length, done: new Promise<{ code: number | null }>(() => {}) };
  };
  return { spawn, calls };
}
const deps = (over: Record<string, unknown> = {}): any => ({
  now: () => new Date(2026, 9, 4, 12, 0),
  newId: () => `t-${++counter}`,
  signalUrlBase: "http://localhost:7777",
  newSignalToken: testRunToken,
  maxConcurrent: 8,
  tickMs: 30000,
  kill: fakeKill().kill,
  ...over,
});
async function seed(phases: unknown[], over: Record<string, unknown> = {}, id = "p1") {
  return createPipeline(
    validatePipelineInput({ name: "tokens", trigger: null, phases, ...over }),
    new Date(2026, 9, 4, 9, 0),
    id,
  );
}
const phase = (over: Record<string, unknown> = {}) => ({
  id: "only",
  name: "Only",
  cwd: home,
  gated: false,
  steps: [{ name: "s", prompt: "p" }],
  ...over,
});
const twoSteps = () =>
  phase({
    steps: [
      { name: "a", prompt: "a" },
      { name: "b", prompt: "b" },
    ],
  });
const sig = (
  inst: { id: string },
  phaseId: string,
  runId: string,
  token: string,
  type: "completed" | "failed" | "needs-input" = "completed",
  payload: unknown = MARKED,
) => ({ instanceId: inst.id, phaseId, runId, type, token, payload });

// ── the pure binding ─────────────────────────────────────────────────────────

test("a digest binds the token to one instance, phase, attempt and run", () => {
  const b = { instanceId: "i", phaseId: "p", attempt: 1, runId: "r" };
  const auth = signalAuthFor(b, "secret");
  assert.equal(auth.scheme, "run-token-v1");
  assert.equal(verifySignalToken(auth, "i", "r", "secret"), true);
  assert.equal(verifySignalToken(auth, "i", "r", "other"), false);
  assert.equal(verifySignalToken(auth, "i", "r2", "secret"), false, "another run");
  assert.equal(verifySignalToken(auth, "i2", "r", "secret"), false, "another instance");
  const digest = signalTokenDigest(b, "secret");
  assert.equal(auth.scheme === "run-token-v1" ? auth.sha256 : null, digest);
  assert.notEqual(signalTokenDigest({ ...b, attempt: 2 }, "secret"), digest, "another attempt");
  assert.notEqual(signalTokenDigest({ ...b, phaseId: "q" }, "secret"), digest, "another phase");
  assert.equal(verifySignalToken(auth, "i", "r", undefined), false);
  assert.equal(verifySignalToken(auth, "i", "r", ""), false);
  assert.equal(verifySignalToken({ scheme: "none" }, "i", "r", "secret"), false);
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abcd"), false);
});

// ── siblings, stale runs, other instances ────────────────────────────────────

test("one run's token cannot complete, fail or pause its sibling", async () => {
  await seed([twoSteps()]);
  const rec = recordingSpawn();
  const e = createEngine(deps({ spawn: rec.spawn }));
  const inst = (await e.start("p1", "manual"))!;
  const [a, b] = rec.calls.map((c) => c.run.id);
  for (const type of ["completed", "failed", "needs-input"] as const) {
    const res = await e.onSignal(inst.id, sig(inst, "only", b, testRunToken(a), type));
    assert.equal(res.code, 403, type);
  }
  // The legacy instance-wide token is no credential at all for a new instance.
  assert.equal((await e.onSignal(inst.id, sig(inst, "only", b, inst.signalToken))).code, 403);
  let p = (await readInstance(inst.id))!.phases[0];
  assert.deepEqual(
    p.steps.map((s) => s.status),
    ["running", "running"],
  );
  // Each run's own token is accepted for that run.
  assert.equal((await e.onSignal(inst.id, sig(inst, "only", b, testRunToken(b)))).code, 202);
  assert.equal((await e.onSignal(inst.id, sig(inst, "only", a, testRunToken(a)))).code, 202);
  p = (await readInstance(inst.id))!.phases[0];
  assert.equal(p.status, "succeeded");
});

test("a token for a run of another instance is refused", async () => {
  await seed([phase()]);
  await seed([phase()], {}, "p2");
  const rec = recordingSpawn();
  const e = createEngine(deps({ spawn: rec.spawn }));
  const one = (await e.start("p1", "manual"))!;
  const two = (await e.start("p2", "manual"))!;
  const runOne = rec.calls[0].run.id;
  const runTwo = rec.calls[1].run.id;
  // Instance two, naming its own run, with instance one's run token.
  assert.equal(
    (await e.onSignal(two.id, sig(two, "only", runTwo, testRunToken(runOne)))).code,
    403,
  );
  // Instance two, naming instance one's run, with that run's genuine token.
  assert.equal(
    (await e.onSignal(two.id, sig(two, "only", runOne, testRunToken(runOne)))).code,
    403,
  );
  assert.equal((await readInstance(one.id))!.phases[0].status, "running");
  assert.equal((await readInstance(two.id))!.phases[0].status, "running");
});

test("a superseded attempt's run is heard but never acted on; a forger for it is refused", async () => {
  await seed([phase({ gated: true })]);
  const rec = recordingSpawn();
  const e = createEngine(deps({ spawn: rec.spawn }));
  const inst = (await e.start("p1", "manual"))!;
  const first = rec.calls[0].run.id;
  await e.onSignal(inst.id, sig(inst, "only", first, testRunToken(first)));
  assert.equal((await readInstance(inst.id))!.phases[0].status, "awaiting-approval");
  assert.equal((await e.revise(inst.id, "again")).code, 200);
  const second = rec.calls[1].run.id;
  const outcomeBefore = (await readRun(first))?.run.outcome;

  // The first run, late, with its own genuine token: heard, journalled, inert.
  const late = await e.onSignal(inst.id, sig(inst, "only", first, testRunToken(first), "failed"));
  assert.equal(late.code, 202);
  const after = (await readInstance(inst.id))!;
  assert.equal(after.phases[0].status, "running");
  assert.equal(after.phases[0].attempt, 1);
  assert.equal(after.phases[0].steps[0].runId, second);
  assert.equal(after.phases[0].steps[0].status, "running");
  assert.equal(
    (await readRun(first))?.run.outcome,
    outcomeBefore,
    "its run record is not rewritten",
  );
  await e.drain();
  assert.ok(
    (await readJournal(inst.id)).some(
      (j: any) => j.kind === "phase.signalled" && j.runId === first && /ignored/.test(j.detail),
    ),
  );

  // The same stale run named with the *current* run's token: refused.
  assert.equal(
    (await e.onSignal(inst.id, sig(inst, "only", first, testRunToken(second)))).code,
    403,
  );
  // And the stale run's token cannot reach the current run.
  assert.equal(
    (await e.onSignal(inst.id, sig(inst, "only", second, testRunToken(first)))).code,
    403,
  );
  assert.equal((await readInstance(inst.id))!.phases[0].steps[0].status, "running");
});

// ── duplicates, and steps already decided ────────────────────────────────────

test("a duplicate signal for a step that already reported does not re-decide it", async () => {
  await seed([twoSteps()]);
  const rec = recordingSpawn();
  const e = createEngine(deps({ spawn: rec.spawn }));
  const inst = (await e.start("p1", "manual"))!;
  const [a, b] = rec.calls.map((c) => c.run.id);
  await e.onSignal(
    inst.id,
    sig(inst, "only", a, testRunToken(a), "completed", { ...MARKED, n: 1 }),
  );
  // The same run again, saying something else entirely.
  const dup = await e.onSignal(
    inst.id,
    sig(inst, "only", a, testRunToken(a), "completed", { ...MARKED, n: 2 }),
  );
  assert.equal(dup.code, 202);
  const lateFail = await e.onSignal(inst.id, sig(inst, "only", a, testRunToken(a), "failed"));
  assert.equal(lateFail.code, 202);
  let p = (await readInstance(inst.id))!.phases[0];
  assert.equal(p.status, "running", "a late failure from a step that succeeded fails nothing");
  assert.deepEqual(p.payload, { ...MARKED, n: 1 }, "the first report stands");
  assert.equal((await readRun(a))?.run.outcome, "succeeded");
  await e.onSignal(inst.id, sig(inst, "only", b, testRunToken(b)));
  p = (await readInstance(inst.id))!.phases[0];
  assert.equal(p.status, "succeeded");
  await e.drain();
  assert.ok(
    (await readJournal(inst.id)).some((j: any) =>
      /already ended as succeeded/.test(j.detail ?? ""),
    ),
  );
});

test("a refused completion stays refused when the hook repeats it", async () => {
  await seed([phase()]);
  const rec = recordingSpawn();
  const e = createEngine(deps({ spawn: rec.spawn }));
  const inst = (await e.start("p1", "manual"))!;
  const r = rec.calls[0].run.id;
  await e.onSignal(
    inst.id,
    sig(inst, "only", r, testRunToken(r), "completed", { last_assistant_message: "x" }),
  );
  assert.equal((await readRun(r))?.run.outcome, "failed");
  // Delivered again — this time with a marker. The decision was made.
  await e.onSignal(inst.id, sig(inst, "only", r, testRunToken(r)));
  assert.equal((await readRun(r))?.run.outcome, "failed");
  assert.equal((await readInstance(inst.id))!.phases[0].status, "failed");
});

test("needs-input pauses the phase; the same run's later Stop is ignored; approval resumes", async () => {
  await seed([phase(), phase({ id: "next", name: "Next" })]);
  const rec = recordingSpawn();
  const e = createEngine(deps({ spawn: rec.spawn }));
  const inst = (await e.start("p1", "manual"))!;
  const r = rec.calls[0].run.id;
  const asked = await e.onSignal(
    inst.id,
    sig(inst, "only", r, testRunToken(r), "needs-input", { question: "which db?" }),
  );
  assert.equal(asked.code, 202);
  let after = (await readInstance(inst.id))!;
  assert.equal(after.phases[0].status, "awaiting-approval");
  assert.equal(after.phases[0].pause, "needs-input");
  // The agent's process stops, and its Stop hook reports completion.
  const stop = await e.onSignal(inst.id, sig(inst, "only", r, testRunToken(r)));
  assert.equal(stop.code, 200, "the instance is paused, so the signal is a no-op");
  after = (await readInstance(inst.id))!;
  assert.equal(after.phases[0].status, "awaiting-approval");
  assert.equal(rec.calls.length, 1, "nothing downstream started");
  // A person answers; that, not the late Stop, is what moves the phase on.
  assert.equal((await e.approve(inst.id, { db: "postgres" })).code, 200);
  await e.drain();
  after = (await readInstance(inst.id))!;
  assert.equal(after.phases[0].status, "succeeded");
  assert.deepEqual(after.phases[0].payload, { db: "postgres" });
  assert.equal(rec.calls.length, 2);
});

// ── pre-upgrade instances ────────────────────────────────────────────────────

/** Rewrite an instance as one written before per-run tokens existed. */
async function asPreUpgrade(id: string) {
  const inst = (await readInstance(id))!;
  delete inst.signalScheme;
  for (const p of inst.phases) for (const s of p.steps) delete s.signalAuth;
  await writeInstance(inst);
  for (const p of inst.phases) {
    for (const s of p.steps) {
      if (!s.runId) continue;
      const got = await readRun(s.runId);
      if (got) {
        const { signalAuth: _drop, ...run } = got.run;
        await writeRun(run);
      }
    }
  }
  return inst;
}

test("a run launched before the upgrade still completes with its instance's token", async () => {
  await seed([phase(), phase({ id: "next", name: "Next" })]);
  const rec = recordingSpawn();
  const e = createEngine(deps({ spawn: rec.spawn }));
  const started = (await e.start("p1", "manual"))!;
  const legacy = await asPreUpgrade(started.id);
  const r = rec.calls[0].run.id;
  // Its per-run token never existed; the run holds the instance's.
  assert.equal(
    (await e.onSignal(legacy.id, sig(legacy, "only", r, "a guess"))).code,
    403,
    "a legacy step still needs the legacy token",
  );
  assert.equal((await e.onSignal(legacy.id, sig(legacy, "only", r, legacy.signalToken))).code, 202);
  await e.drain();
  const after = (await readInstance(legacy.id))!;
  assert.equal(after.phases[0].status, "succeeded");
  // The next phase was launched after the upgrade: it has its own token, and
  // the instance's legacy token is no credential for it.
  const next = after.phases[1].steps[0];
  assert.equal(next.signalAuth?.scheme, "run-token-v1");
  assert.equal(
    (await e.onSignal(legacy.id, sig(legacy, "next", next.runId!, legacy.signalToken))).code,
    403,
  );
  assert.equal(
    (await e.onSignal(legacy.id, sig(legacy, "next", next.runId!, testRunToken(next.runId!)))).code,
    202,
  );
  assert.equal((await readInstance(legacy.id))!.status, "succeeded");
});

// ── runtimes without a hook ──────────────────────────────────────────────────

test("a runtime without a signal hook is handed no credential, and no signal is accepted for it", async () => {
  await seed([phase()], { runtime: "opencode" });
  const rec = recordingSpawn();
  const e = createEngine(deps({ spawn: rec.spawn }));
  const inst = (await e.start("p1", "manual"))!;
  const r = rec.calls[0].run.id;
  assert.equal(rec.calls[0].env.ARGUS_SIGNAL_TOKEN, undefined);
  assert.deepEqual((await readInstance(inst.id))!.phases[0].steps[0].signalAuth, {
    scheme: "none",
  });
  for (const token of [testRunToken(r), inst.signalToken, ""]) {
    assert.equal((await e.onSignal(inst.id, sig(inst, "only", r, token))).code, 403);
  }
  // The engine's own completion path — the run record — is untouched by that.
  const got = await readRun(r);
  await writeRun({
    ...got!.run,
    status: "succeeded",
    exitCode: 0,
    endedAt: new Date().toISOString(),
    resultSummary: "ARGUS_OUTCOME: succeeded",
  });
  await e.reconcile();
  assert.equal((await readInstance(inst.id))!.status, "succeeded");
});

// ── no token on disk ─────────────────────────────────────────────────────────

function everyFile(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...everyFile(full));
    else out.push(full);
  }
  return out;
}

test("no persisted record — invocation, run, instance, materialized config — holds a token", async () => {
  const issued: string[] = [];
  await seed([twoSteps()]);
  const rec = recordingSpawn();
  // The production token source (real random bits); the values are read back
  // out of the spawn environment, the one place they are supposed to be.
  const e = createEngine(deps({ spawn: rec.spawn, newSignalToken: undefined }));
  const inst = (await e.start("p1", "manual"))!;
  for (const call of rec.calls) issued.push(call.env.ARGUS_SIGNAL_TOKEN);
  assert.equal(issued.length, 2);
  assert.ok(issued.every((t) => typeof t === "string" && t.length >= 40));
  assert.notEqual(issued[0], issued[1]);
  await e.onSignal(inst.id, sig(inst, "only", rec.calls[0].run.id, issued[0]));
  await e.drain();
  const files = everyFile(home);
  assert.ok(files.some((f) => f.endsWith("invocation.json")));
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const token of issued) {
      assert.equal(text.includes(token), false, `${path.relative(home, file)} holds a token`);
    }
  }
});
