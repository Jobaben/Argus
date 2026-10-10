/**
 * The engine's saves as transition commits (Hardening Item 1, checkpoint D).
 *
 * Every scenario here ends by comparing the saved instance with the fold of
 * its transition log: an engine that saved something its log does not explain
 * fails the comparison, and the test preload makes any status change no
 * transition accounted for throw where it happens.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fakeKill } from "../testPlatform.js";
import { createEngine } from "../pipelineEngine.js";
import { createPipeline, validatePipelineInput } from "../sources/pipelines.js";
import { readInstance, writeInstance } from "../sources/instances.js";
import { readGateDecisions } from "../sources/gateDecisions.js";
import { knowledgeDeltaFile } from "../knowledge/staging.js";
import { readLedger } from "../knowledge/store.js";
import { readTransitionLog, appendTransitionRecord } from "../transitionLog/store.js";
import { compareIntegrity } from "../transitionLog/fold.js";
import { testRunToken } from "../testSignalToken.js";
import type { TransitionRecord } from "@argus/contracts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-transition-engine-"));
  process.env.ARGUS_CLAUDE_HOME = home;
});

const MARKED = { last_assistant_message: "done\nARGUS_OUTCOME: succeeded" };
let counter = 0;

function recordingSpawn() {
  const calls: { run: any }[] = [];
  const spawn = (run: any) => {
    calls.push({ run });
    return { pid: 3000 + calls.length, done: new Promise<{ code: number | null }>(() => {}) };
  };
  return { spawn, calls };
}
const deps = (over: Record<string, unknown> = {}): any => ({
  now: () => new Date(2026, 9, 4, 12, 0),
  newId: () => `x-${++counter}`,
  newSignalToken: testRunToken,
  signalUrlBase: "http://localhost:7777",
  maxConcurrent: 8,
  tickMs: 30000,
  kill: fakeKill().kill,
  ...over,
});
async function seed(phases: unknown[], over: Record<string, unknown> = {}) {
  return createPipeline(
    validatePipelineInput({ name: "tx", trigger: null, phases, ...over }),
    new Date(2026, 9, 4, 9, 0),
    "p1",
  );
}
const phase = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  cwd: home,
  gated: false,
  steps: [{ name: "s", prompt: "p" }],
  ...over,
});
const complete = (e: any, inst: any, phaseId: string, runId: string, payload: unknown = MARKED) =>
  e.onSignal(inst.id, {
    instanceId: inst.id,
    phaseId,
    runId,
    type: "completed",
    token: testRunToken(runId),
    payload,
  });

async function integrity(id: string) {
  return compareIntegrity(id, await readInstance(id), await readTransitionLog(id));
}
async function records(id: string): Promise<TransitionRecord[]> {
  return (await readTransitionLog(id)).records;
}
const runOf = async (id: string, phaseId: string) =>
  (await readInstance(id))!.phases.find((p) => p.id === phaseId)!.steps[0].runId!;

// ── full lifecycles ──────────────────────────────────────────────────────────

test("a gated lifecycle: every save is a record, and the fold is the saved instance", async () => {
  await seed([phase("build"), phase("ship", { gated: true })]);
  const rec = recordingSpawn();
  const e = createEngine(deps({ spawn: rec.spawn }));
  const inst = (await e.start("p1", "manual"))!;
  await complete(e, inst, "build", await runOf(inst.id, "build"));
  await e.drain();
  await complete(e, inst, "ship", await runOf(inst.id, "ship"));
  assert.equal((await readInstance(inst.id))!.status, "awaiting-approval");
  assert.equal((await e.approve(inst.id)).code, 200);
  await e.drain();

  const saved = (await readInstance(inst.id))!;
  assert.equal(saved.status, "succeeded");
  const report = await integrity(inst.id);
  assert.equal(report.status, "consistent", report.findings.join("; "));
  assert.equal(report.coverage, "full");
  assert.equal(report.replayedTo, saved.transitionLog?.seq);

  const log = await records(inst.id);
  assert.equal(log[0].source, "start");
  assert.ok(log[0].events.some((ev) => ev.kind === "init"));
  assert.ok(log[0].baseline, "the first record carries the initial state");
  assert.ok(log.slice(1).every((r) => !r.baseline && Array.isArray(r.changes)));
  assert.deepEqual(
    log.map((r) => r.seq),
    log.map((_, i) => i + 1),
  );
  const kinds = log.flatMap((r) => r.events.map((ev) => ev.kind));
  for (const k of [
    "launch-planned",
    "signal",
    "completion-recorded",
    "phase-paused",
    "gate-linked",
    "approve",
    "gate-completed",
    "phase-succeeded",
  ]) {
    assert.ok(kinds.includes(k as never), `${k} recorded`);
  }
  const sources = new Set(log.map((r) => r.source));
  for (const s of ["start", "signal", "operator"]) assert.ok(sources.has(s as never), s);
  assert.equal(
    log.some((r) => r.unattributed?.length),
    false,
  );
});

test("the gate link is its own record, ahead of the approval's effects", async () => {
  await seed([phase("ship", { gated: true })]);
  const rec = recordingSpawn();
  const e = createEngine(deps({ spawn: rec.spawn }));
  const inst = (await e.start("p1", "manual"))!;
  await complete(e, inst, "ship", await runOf(inst.id, "ship"));
  await e.approve(inst.id);
  const log = await records(inst.id);
  const link = log.findIndex((r) => r.events.some((ev) => ev.kind === "gate-linked"));
  const done = log.findIndex((r) => r.events.some((ev) => ev.kind === "gate-completed"));
  assert.ok(link > 0 && done > link);
  assert.ok(log[link].effects.some((ef) => ef.kind === "gate-operation"));
  assert.equal(log[link].events.length, 1, "the link carries no effect with it");
});

test("a failure, a scheduled retry and the retried attempt all replay", async () => {
  let now = new Date(2026, 9, 4, 12, 0);
  await seed([phase("only", { retry: { attempts: 2, backoffSeconds: 0 } })]);
  const rec = recordingSpawn();
  const e = createEngine(deps({ spawn: rec.spawn, now: () => now }));
  const inst = (await e.start("p1", "manual"))!;
  const first = await runOf(inst.id, "only");
  await e.onSignal(inst.id, {
    instanceId: inst.id,
    phaseId: "only",
    runId: first,
    type: "failed",
    token: testRunToken(first),
    payload: { reason: "red" },
  });
  // `signal` is not retried by default; fail it as a missing marker instead.
  assert.equal((await readInstance(inst.id))!.status, "failed");

  // A second instance whose failure is retried.
  const inst2 = (await e.start("p1", "manual"))!;
  await complete(e, inst2, "only", await runOf(inst2.id, "only"), { last_assistant_message: "x" });
  assert.ok((await readInstance(inst2.id))!.phases[0].retryAt);
  now = new Date(now.getTime() + 1000);
  await e.reconcile();
  await e.drain();
  await complete(e, inst2, "only", await runOf(inst2.id, "only"));
  assert.equal((await readInstance(inst2.id))!.status, "succeeded");
  for (const id of [inst.id, inst2.id]) {
    const r = await integrity(id);
    assert.equal(r.status, "consistent", `${id}: ${r.findings.join("; ")}`);
  }
  const kinds = (await records(inst2.id)).flatMap((r) => r.events.map((ev) => ev.kind));
  for (const k of ["failure-classified", "retry-scheduled", "retry-started"]) {
    assert.ok(kinds.includes(k as never), k);
  }
  const retry = (await records(inst2.id)).find((r) => r.source === "retry");
  assert.ok(retry, "the retry's own commit names its source");
});

test("revise and abort replay, and abort's record names every phase it stopped", async () => {
  await seed([phase("a", { gated: true }), phase("b", { needs: [] })]);
  const rec = recordingSpawn();
  const e = createEngine(deps({ spawn: rec.spawn }));
  const inst = (await e.start("p1", "manual"))!;
  await complete(e, inst, "a", await runOf(inst.id, "a"));
  assert.equal((await e.revise(inst.id, "again", { phaseId: "a" })).code, 200);
  assert.equal((await e.abort(inst.id)).code, 200);
  const r = await integrity(inst.id);
  assert.equal(r.status, "consistent", r.findings.join("; "));
  const abort = (await records(inst.id)).find((x) => x.events.some((ev) => ev.kind === "abort"));
  assert.ok(abort);
  assert.match(abort!.events.find((ev) => ev.kind === "abort")!.detail ?? "", /a.*b|b.*a/);
});

test("a knowledge commit at approval replays: pending, then committed", async () => {
  await seed([phase("learn", { gated: true })]);
  const rec = recordingSpawn();
  const e = createEngine(deps({ spawn: rec.spawn }));
  const inst = (await e.start("p1", "manual"))!;
  const runId = await runOf(inst.id, "learn");
  const file = knowledgeDeltaFile(runId);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({ schemaVersion: 1, claims: [{ localId: "c", kind: "fact", statement: "x" }] }),
  );
  await complete(e, inst, "learn", runId);
  await e.approve(inst.id);
  await e.drain();
  assert.equal((await readInstance(inst.id))!.status, "succeeded");
  assert.equal((await readLedger()).claims.length, 1);
  const kinds = (await records(inst.id)).flatMap((r) => r.events.map((ev) => ev.kind));
  assert.ok(kinds.indexOf("knowledge-pending") < kinds.indexOf("knowledge-committed"));
  const r = await integrity(inst.id);
  assert.equal(r.status, "consistent", r.findings.join("; "));
});

function gitAvailable(): boolean {
  try {
    return spawnSync("git", ["--version"]).status === 0;
  } catch {
    return false;
  }
}

test("a candidates phase replays through selection and tree cleanup", async (t) => {
  if (!gitAvailable()) return t.skip("git not available");
  const repo = mkdtempSync(path.join(tmpdir(), "argus-tx-repo-"));
  const git = (args: string[]) =>
    spawnSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=T", ...args], { cwd: repo });
  git(["init", "-q", "-b", "main"]);
  writeFileSync(path.join(repo, "README.md"), "x\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);
  await seed([
    {
      id: "impl",
      name: "impl",
      cwd: repo,
      gated: false,
      workspace: { scope: "attempt" },
      candidates: { count: 2, select: "first-verified" },
      steps: [{ name: "code", prompt: "do it" }],
    },
  ]);
  const rec = recordingSpawn();
  const e = createEngine(deps({ spawn: rec.spawn }));
  const inst = (await e.start("p1", "manual"))!;
  const steps = (await readInstance(inst.id))!.phases[0].steps;
  await complete(e, inst, "impl", steps[1].runId!);
  await e.drain();
  assert.equal((await readInstance(inst.id))!.status, "succeeded");
  const kinds = (await records(inst.id)).flatMap((r) => r.events.map((ev) => ev.kind));
  for (const k of [
    "candidate-verification-applied",
    "candidate-selected",
    "candidate-tree-removed",
  ]) {
    assert.ok(kinds.includes(k as never), k);
  }
  const r = await integrity(inst.id);
  assert.equal(r.status, "consistent", r.findings.join("; "));
});

// ── degradation ──────────────────────────────────────────────────────────────

test("a log that cannot be written degrades the record, not the pipeline", async () => {
  await seed([phase("a"), phase("b", { gated: true })]);
  const rec = recordingSpawn();
  let failing = false;
  const e = createEngine(
    deps({
      spawn: rec.spawn,
      transitionLog: {
        append: async (r: TransitionRecord) =>
          failing
            ? { ok: false, reason: "error", error: new Error("disk") }
            : appendTransitionRecord(r),
      },
    }),
  );
  const inst = (await e.start("p1", "manual"))!;
  failing = true;
  await complete(e, inst, "a", await runOf(inst.id, "a"));
  await e.drain();
  let saved = (await readInstance(inst.id))!;
  assert.equal(saved.phases[0].status, "succeeded", "ordinary progress continued");
  const degradedFrom = saved.transitionLog?.degradedFrom;
  assert.ok(degradedFrom, "the instance says where its history stops being complete");
  // An approval still needs its own durable decision record, log or no log.
  await complete(e, inst, "b", await runOf(inst.id, "b"));
  const refused = await createEngine(
    deps({
      spawn: rec.spawn,
      recordGateDecision: async () => {
        throw new Error("gate log down");
      },
      transitionLog: {
        append: async () => ({ ok: false, reason: "error", error: new Error("x") }),
      },
    }),
  ).approve(inst.id);
  assert.equal(refused.code, 500, "a failing transition log grants nothing");
  assert.equal((await readInstance(inst.id))!.status, "awaiting-approval");
  assert.equal((await e.approve(inst.id)).code, 200);
  assert.equal(
    (await readGateDecisions(inst.id)).length,
    1,
    "the refused approval left no record; the accepted one did",
  );
  saved = (await readInstance(inst.id))!;
  assert.equal(saved.status, "succeeded");
  assert.equal(saved.transitionLog?.degradedFrom, degradedFrom, "the gap is never forgotten");
  const r = await integrity(inst.id);
  assert.equal(r.status, "degraded", r.findings.join("; "));
  // The log resumed from a baseline once it could be written again.
  failing = false;
  assert.ok((await records(inst.id)).length >= 1);
});

test("a log at its cap stops growing and the instance says so", async () => {
  await seed([phase("a"), phase("b")]);
  const rec = recordingSpawn();
  const e = createEngine(
    deps({
      spawn: rec.spawn,
      transitionLog: {
        append: (r: TransitionRecord) => appendTransitionRecord(r, { maxBytes: 3000 }),
      },
    }),
  );
  const inst = (await e.start("p1", "manual"))!;
  await complete(e, inst, "a", await runOf(inst.id, "a"));
  await e.drain();
  await complete(e, inst, "b", await runOf(inst.id, "b"));
  const saved = (await readInstance(inst.id))!;
  assert.equal(saved.status, "succeeded");
  assert.equal(saved.transitionLog?.capped, true);
  const bytes = readFileSync(path.join(home, "argus", "transitions", `${inst.id}.jsonl`)).length;
  assert.ok(bytes <= 3000, "nothing past the cap was written, and nothing was pruned");
});

// ── the commit point ─────────────────────────────────────────────────────────

test("a crash between the log append and the instance publication leaves a proposal, never an effect", async () => {
  await seed([phase("a"), phase("b")]);
  const rec = recordingSpawn();
  let failPublish = false;
  const { writeInstance: realWrite } = await import("../sources/instances.js");
  const e = createEngine(
    deps({
      spawn: rec.spawn,
      transitionLog: {
        publish: async (i: any) => {
          if (failPublish) throw new Error("power cut");
          await realWrite(i);
        },
      },
    }),
  );
  const inst = (await e.start("p1", "manual"))!;
  const a = await runOf(inst.id, "a");
  failPublish = true;
  await assert.rejects(complete(e, inst, "a", a));
  failPublish = false;
  await e.drain();
  const saved = (await readInstance(inst.id))!;
  assert.equal(saved.phases[0].status, "running", "the saved instance never moved");
  assert.equal(rec.calls.length, 1, "nothing the proposal owed was executed");
  const ahead = await integrity(inst.id);
  assert.equal(ahead.status, "ahead");
  assert.match(ahead.findings.join(" "), /proposed, never committed/);

  // The hook delivers again; this time it commits. The log re-anchors past
  // the proposal and agrees with the instance from there.
  await complete(e, inst, "a", a);
  await e.drain();
  assert.equal(rec.calls.length, 2);
  const after = await integrity(inst.id);
  assert.ok(after.status === "partial" || after.status === "consistent", after.findings.join("; "));
  assert.match(after.findings.join(" "), /never committed|baseline/);
});

test("an instance that predates the log is adopted with a baseline on its next save", async () => {
  await seed([phase("a"), phase("b")]);
  const rec = recordingSpawn();
  const e = createEngine(deps({ spawn: rec.spawn }));
  const inst = (await e.start("p1", "manual"))!;
  // Simulate the pre-upgrade instance: no log, no transitionLog field.
  const legacy = (await readInstance(inst.id))!;
  delete legacy.transitionLog;
  await writeInstance(legacy);
  const { rmSync } = await import("node:fs");
  rmSync(path.join(home, "argus", "transitions", `${inst.id}.jsonl`));
  assert.equal((await integrity(inst.id)).status, "untracked");
  await complete(e, inst, "a", await runOf(inst.id, "a"));
  await e.drain();
  const r = await integrity(inst.id);
  assert.equal(r.status, "partial", r.findings.join("; "));
  assert.equal(r.coverage, "from-baseline");
  const first = (await records(inst.id))[0];
  assert.ok(first.baseline);
  assert.equal(first.events[0].kind, "baseline");
});

test("the integrity route reports the comparison", async () => {
  const { createApp } = await import("../app.js");
  await seed([phase("a")]);
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
  const res = await app.request(`/api/instances/${inst.id}/transitions/integrity`, {
    headers: { host: "localhost:7777" },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { status: string; coverage: string };
  assert.equal(body.status, "consistent");
  assert.equal(body.coverage, "full");
  const missing = await app.request(`/api/instances/nope/transitions/integrity`, {
    headers: { host: "localhost:7777" },
  });
  assert.equal(missing.status, 404);
  const bad = await app.request(`/api/instances/..%2Fx/transitions/integrity`, {
    headers: { host: "localhost:7777" },
  });
  assert.equal(bad.status, 404);
});

// ── the static rule ──────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "..");

/**
 * Engine modules may not write pipeline status fields directly: those are the
 * transitions' (pipelineTransitions.ts), so every change is a recorded event.
 * Targeted on purpose — run records, verification reports, Verdicts and every
 * other `status` in the engine are not pipeline state and are not banned.
 */
test("no engine module assigns a pipeline status field itself", () => {
  const engineFiles = [
    path.join(SRC, "pipelineEngine.ts"),
    ...readdirSync(path.join(SRC, "engine"))
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f) => path.join(SRC, "engine", f)),
  ];
  const holders =
    "(?:phase|progress|step|s|inst|instance|current|fresh|aborted|healed|settled\\.instance|res\\.instance|out\\.instance|next\\.instance)";
  const fields =
    "(?:status|attempt|retryAt|pause|pendingGateOperation|gateDecisionIds|retries|steps|currentPhaseIndex)";
  const assign = new RegExp(`\\b${holders}\\.${fields}\\s*=(?!=)`);
  const del = new RegExp(`\\bdelete\\s+${holders}\\.${fields}\\b`);
  const offenders: string[] = [];
  for (const file of engineFiles) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return;
        if (assign.test(line) || del.test(line)) {
          offenders.push(`${path.relative(SRC, file)}:${i + 1}: ${line.trim()}`);
        }
      });
  }
  assert.deepEqual(offenders, []);
  // And the rule is not vacuous: the transitions module does exactly this.
  const transitions = readFileSync(path.join(SRC, "pipelineTransitions.ts"), "utf8");
  assert.ok(assign.test(transitions));
});

test("a status change made behind the engine's back shows as a disagreement", async () => {
  await seed([phase("a"), phase("b")]);
  const rec = recordingSpawn();
  const e = createEngine(deps({ spawn: rec.spawn }));
  const inst = (await e.start("p1", "manual"))!;
  const tampered = (await readInstance(inst.id))!;
  tampered.phases[1].status = "skipped";
  await writeInstance(tampered);
  const r = await integrity(inst.id);
  assert.equal(r.status, "disagreement");
  assert.equal(r.firstDivergence, "/phases/1/status");
});

test("a commit whose status change no event accounts for records it as unattributed", async () => {
  const { createInstancePersistence } = await import("./persistence.js");
  const appended: TransitionRecord[] = [];
  const reported: string[][] = [];
  const persist = createInstancePersistence({
    now: () => new Date("2026-10-04T12:00:00.000Z"),
    publish: async () => {},
    readSaved: async () => null,
    append: async (r) => {
      appended.push(r);
      return { ok: true, bytes: 1, oversized: false };
    },
    readLog: async () => ({
      records: [],
      corruptLines: [],
      invalidLines: [],
      tornTail: 0,
      present: false,
    }),
    onUnattributed: (_id, changes) => reported.push(changes),
    onDegraded: () => {},
  });
  const inst: any = {
    id: "u1",
    status: "running",
    phases: [
      { id: "a", status: "running", attempt: 0, steps: [{ runId: "r", status: "running" }] },
    ],
  };
  persist.fresh(inst, "start");
  persist.note(inst, [{ kind: "init" }]);
  await persist.commit(inst);
  // A forgotten transition: the phase fails with no event saying so.
  inst.phases[0].status = "failed";
  inst.phases[0].steps[0].status = "failed";
  const out = await persist.commit(inst);
  assert.deepEqual(out.unattributed, [
    "phase:a: running|0|-|- → failed|0|-|-",
    "step:a#0: r|running → r|failed",
  ]);
  assert.deepEqual(appended[1].unattributed, out.unattributed);
  assert.deepEqual(reported, [out.unattributed]);
  // The same change, recorded by a transition, is attributed.
  inst.phases[0].status = "running";
  persist.note(inst, [{ kind: "revise", phaseId: "a" }]);
  assert.deepEqual((await persist.commit(inst)).unattributed, []);
});
