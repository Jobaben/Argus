import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GateDecision, PipelineInstance } from "@argus/contracts";
import {
  createEngine,
  type AutomatedApproval,
  type Engine,
  type GateEffectPoint,
} from "./pipelineEngine.js";
import { createPipeline, validatePipelineInput } from "./sources/pipelines.js";
import { readInstance, writeInstance } from "./sources/instances.js";
import { paths } from "./claudeHome.js";
import {
  buildGateDecisionsResponse,
  gateDecisionFile,
  readGateDecisions,
} from "./sources/gateDecisions.js";
import { rubricDigest, writeVerdict } from "./sources/verdict.js";
import { readLedger } from "./knowledge/store.js";

/**
 * Phase 0 of the Decision Plane RFC, through the real engine: who may open a
 * gate, what is recorded when anyone does, and what survives a failure. Every
 * assertion is on disk — the instance file, the ledger, the decision log —
 * because those are what a later reader has to go on.
 */

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-gates-"));
  process.env.ARGUS_CLAUDE_HOME = home;
  mkdirSync(path.join(home, "argus", "runs"), { recursive: true });
  mkdirSync(path.join(home, "argus", "instances"), { recursive: true });
});

const NOW = new Date("2026-09-29T10:00:00.000Z");
const RUBRIC = { goal: "Be good.", criteria: [{ id: "quality", label: "Quality" }] };

let counter = 0;
interface Spawned {
  runId: string;
  env: Record<string, string>;
}
function recordingSpawn() {
  const calls: Spawned[] = [];
  const spawn = (run: { id: string }, _log: string, env: Record<string, string>) => {
    calls.push({ runId: run.id, env });
    return { pid: 2000 + calls.length, done: new Promise<{ code: number | null }>(() => {}) };
  };
  return { spawn, calls };
}

function engine(spawn: ReturnType<typeof recordingSpawn>["spawn"], over = {}): Engine {
  return createEngine({
    now: () => new Date(),
    newId: () => `id-${++counter}`,
    spawn,
    signalUrlBase: "http://localhost:7777",
    maxConcurrent: 4,
    tickMs: 30000,
    parentEnv: { PATH: process.env.PATH ?? "/bin", HOME: home },
    ...over,
  });
}

const gatedPhase = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  cwd: home,
  gated: true,
  steps: [{ name: "s", prompt: "p" }],
  ...extra,
});

async function seed(phases: Record<string, unknown>[]) {
  return createPipeline(validatePipelineInput({ name: "gates", trigger: null, phases }), NOW, "p1");
}

/** Simulate a definition saved before Phase 0: patch pipelines.json on disk. */
function injectLegacy(phaseId: string, patch: Record<string, unknown>) {
  const file = path.join(paths.argus(), "pipelines.json");
  const list = JSON.parse(readFileSync(file, "utf8"));
  const phase = list[0].phases.find((p: { id: string }) => p.id === phaseId);
  Object.assign(phase, patch);
  writeFileSync(file, JSON.stringify(list, null, 2));
}

async function complete(e: Engine, inst: PipelineInstance, phaseId: string, runId: string) {
  const res = await e.onSignal(inst.id, {
    instanceId: inst.id,
    phaseId,
    runId,
    type: "completed",
    token: inst.signalToken,
    payload: { last_assistant_message: "done\nARGUS_OUTCOME: succeeded" },
  });
  await e.drain();
  return res;
}

async function load(id: string): Promise<PipelineInstance> {
  const inst = await readInstance(id);
  assert.ok(inst);
  return inst;
}

const phaseOf = (inst: PipelineInstance, id: string) => inst.phases.find((p) => p.id === id)!;

/** The request's basis entry: identity only (the engine reads the rest). */
function basis(runId: string, verdictId: string | null = "V-1") {
  return { runId, verdictId };
}

/** Store the verdict {@link basis} describes: the engine re-reads it. */
async function storeVerdict(runId: string, score = 9, over: Record<string, unknown> = {}) {
  await writeVerdict({
    id: "V-1",
    runId,
    scheduleId: "pipeline:p1",
    scheduleName: "gates",
    phaseId: "build",
    status: "ready",
    at: NOW.toISOString(),
    score,
    criteria: [],
    summary: null,
    regression: false,
    minScore: null,
    costUsd: null,
    tokens: null,
    durationMs: null,
    error: null,
    provenance: {
      runtime: "claude",
      requestedModel: "haiku",
      reportedModel: null,
      promptVersion: 1,
    },
    rubricDigest: rubricDigest(RUBRIC),
    ...over,
  });
}

/** A pipeline with one auto-approvable gate, started and waiting at it. */
async function waitingAtAutoGate(extra: Record<string, unknown> = {}) {
  await seed([gatedPhase("build", { rubric: RUBRIC, autoApprove: { verdict: 7 }, ...extra })]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  await complete(e, inst, "build", rec.calls[0].runId);
  const waiting = await load(inst.id);
  assert.equal(phaseOf(waiting, "build").status, "awaiting-approval");
  assert.equal(phaseOf(waiting, "build").pause, "gate");
  await storeVerdict(rec.calls[0].runId);
  return { e, rec, inst: waiting, runId: rec.calls[0].runId };
}

const request = (inst: PipelineInstance, runId: string, over: Partial<AutomatedApproval> = {}) => ({
  instanceId: inst.id,
  phaseId: "build",
  attempt: 0,
  runIds: [runId],
  verdicts: [basis(runId)],
  ...over,
});

// ── The authority boundary ──────────────────────────────────────────────────

test("an automated approval of an ordinary gate is recorded as the rule that made it, with its basis", async () => {
  const { e, inst, runId } = await waitingAtAutoGate();
  const res = await e.approveAutomatically(request(inst, runId));
  assert.equal(res.ok, true);

  const after = await load(inst.id);
  assert.equal(phaseOf(after, "build").status, "succeeded");
  const [d] = await readGateDecisions(inst.id);
  assert.equal(d.decision, "approve");
  assert.equal(d.mechanism, "verdict-auto-approve");
  assert.equal(d.channel, "verdict-watcher");
  assert.deepEqual(d.principal, { kind: "system", component: "verdict-watcher" });
  assert.deepEqual(d.phases, [
    { phaseId: "build", attempt: 0, status: "awaiting-approval", runIds: [runId] },
  ]);
  assert.equal(d.verdicts?.[0].verdictId, "V-1");
  assert.equal(d.verdicts?.[0].score, 9);
  assert.deepEqual(after.gateDecisionIds, [d.id]);
  assert.equal(buildGateDecisionsResponse(inst.id, after, [d]).decisions[0].effect, "applied");
});

test("MANDATORY REGRESSION: a legacy knowledge gate with autoApprove refuses automated approval at the engine", async () => {
  // Saved before validation refused it, and snapshotted onto the instance: a
  // phase whose definition requires a KnowledgeDelta, declaring autoApprove.
  await seed([gatedPhase("build", { rubric: RUBRIC, knowledgeDelta: "required" })]);
  injectLegacy("build", { autoApprove: { verdict: 7 } });
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  assert.deepEqual(
    inst.definition?.phases[0].autoApprove,
    { verdict: 7 },
    "the unsafe field survives on the snapshot",
  );
  const call = rec.calls[0];
  const file = call.env.ARGUS_KNOWLEDGE_DELTA_FILE;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 1,
      claims: [{ localId: "f", kind: "fact", statement: "The sky is green" }],
      evidence: [{ claim: { local: "f" }, source: { type: "human", who: "an agent said so" } }],
    }),
  );
  await complete(e, inst, "build", call.runId);
  const waiting = await load(inst.id);
  assert.equal(phaseOf(waiting, "build").status, "awaiting-approval");
  const ledgerBefore = JSON.stringify(await readLedger());

  const res = await e.approveAutomatically(
    request(waiting, call.runId, { verdicts: [basis(call.runId)] }),
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, 409);
  assert.match(res.error ?? "", /knowledge-delta-required/);
  assert.match(res.error ?? "", /staged-knowledge-delta/);
  assert.equal(
    phaseOf(await load(inst.id), "build").status,
    "awaiting-approval",
    "the gate still waits",
  );
  assert.equal(JSON.stringify(await readLedger()), ledgerBefore, "nothing reached the ledger");
  assert.deepEqual(await readGateDecisions(inst.id), [], "a refused request records no decision");

  // A person can still approve it, and that is what the record says.
  const ok = await e.approve(inst.id, undefined, {
    source: { channel: "http", principal: { kind: "session", username: "ana", role: "admin" } },
  });
  assert.equal(ok.ok, true);
  const ledgerAfter = await readLedger();
  assert.equal(ledgerAfter.claims.length, 1, "the person's approval committed the delta");
  const [d] = await readGateDecisions(inst.id);
  assert.equal(d.mechanism, "operator");
  assert.deepEqual(d.principal, { kind: "session", username: "ana", role: "admin" });
  assert.ok(d.phases[0].runIds.includes(call.runId), "the decision names the run the ledger names");
  assert.deepEqual((await load(inst.id)).gateDecisionIds, [d.id]);
});

test("MANDATORY REGRESSION: an ordinary gate that staged an optional delta refuses automated approval", async () => {
  // Nothing in the configuration says knowledge. The step staged a delta
  // anyway; Argus's own staging record is what the refusal reads.
  const { e, rec, inst, runId } = await (async () => {
    await seed([gatedPhase("build", { rubric: RUBRIC, autoApprove: { verdict: 7 } })]);
    const rec = recordingSpawn();
    const e = engine(rec.spawn);
    const inst = (await e.start("p1", "manual"))!;
    const file = rec.calls[0].env.ARGUS_KNOWLEDGE_DELTA_FILE;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        claims: [{ localId: "f", kind: "fact", statement: "x" }],
        evidence: [{ claim: { local: "f" }, source: { type: "document", uri: "spec://x" } }],
      }),
    );
    await complete(e, inst, "build", rec.calls[0].runId);
    return { e, rec, inst, runId: rec.calls[0].runId };
  })();
  void rec;
  const res = await e.approveAutomatically(request(inst, runId));
  assert.equal(res.code, 409);
  assert.match(res.error ?? "", /staged-knowledge-delta/);
  assert.equal((await readLedger()).claims.length, 0);
});

test("the engine re-checks the request's shape under the lock: attempt, runs and basis entries", async () => {
  const { e, inst, runId } = await waitingAtAutoGate();
  const refusals: Array<[string, Partial<AutomatedApproval>, RegExp]> = [
    ["wrong attempt", { attempt: 1 }, /attempt 0, not attempt 1/],
    [
      "a run of another attempt",
      { runIds: ["run-elsewhere"], verdicts: [basis("run-elsewhere")] },
      /not exactly/,
    ],
    [
      "an extra run",
      { runIds: [runId, "run-x"], verdicts: [basis(runId), basis("run-x")] },
      /not exactly/,
    ],
    ["no verdict for the run", { verdicts: [] }, /no verdict/],
    ["a duplicate basis entry", { verdicts: [basis(runId), basis(runId)] }, /more than once/],
    ["an extraneous basis entry", { verdicts: [basis(runId), basis("run-x")] }, /not about/],
    [
      "a verdict id that is not current",
      { verdicts: [basis(runId, "V-9")] },
      /not that run's current verdict/,
    ],
    ["no verdict id", { verdicts: [basis(runId, null)] }, /not that run's current verdict/],
    ["another phase", { phaseId: "nope" }, /not awaiting approval/],
  ];
  for (const [label, over, message] of refusals) {
    const res = await e.approveAutomatically(request(inst, runId, over));
    assert.equal(res.ok, false, label);
    assert.match(res.error ?? "", message, label);
  }
  assert.deepEqual(await readGateDecisions(inst.id), [], "no refused request left a record");
  assert.equal(phaseOf(await load(inst.id), "build").status, "awaiting-approval");
});

test("the stored verdict decides, not the request: score, status and rubric are read from the store", async () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["below the bar", { score: 6 }, /below the bar/],
    ["another rubric", { rubricDigest: "0".repeat(64) }, /rubric/],
    ["a legacy verdict with no digest", { rubricDigest: undefined }, /rubric/],
    ["a failed judgment", { status: "failed", score: null }, /failed, not a score/],
  ];
  for (const [label, over, message] of cases) {
    // A fresh home per case: each seeds its own pipeline.
    home = mkdtempSync(path.join(tmpdir(), "argus-gates-"));
    process.env.ARGUS_CLAUDE_HOME = home;
    mkdirSync(path.join(home, "argus", "runs"), { recursive: true });
    mkdirSync(path.join(home, "argus", "instances"), { recursive: true });
    const { e, inst, runId } = await waitingAtAutoGate();
    await storeVerdict(runId, 9, {
      id: "V-2",
      at: new Date(NOW.getTime() + 1000).toISOString(),
      ...over,
    });
    const res = await e.approveAutomatically(
      request(inst, runId, { verdicts: [basis(runId, "V-2")] }),
    );
    assert.equal(res.ok, false, label);
    assert.match(res.error ?? "", message, label);
  }
});

test("MANDATORY: persisted provenance comes from the stored verdict and the snapshot, never the request", async () => {
  const { e, inst, runId } = await waitingAtAutoGate();
  // A caller that sends the right identity with invented metadata — a model,
  // a runtime, a prompt version, a score and a bar the store never said.
  const forged = {
    ...basis(runId),
    score: 10,
    bar: 1,
    at: "1999-01-01T00:00:00.000Z",
    runtime: "codex",
    requestedModel: "gpt-9",
    reportedModel: "gpt-9-final",
    promptVersion: 42,
    rubricDigest: "f".repeat(64),
    stepName: "not-a-step",
  } as unknown as AutomatedApproval["verdicts"][0];
  const res = await e.approveAutomatically(request(inst, runId, { verdicts: [forged] }));
  assert.equal(res.ok, true);
  const [d] = await readGateDecisions(inst.id);
  assert.deepEqual(d.verdicts, [
    {
      runId,
      stepName: "s",
      verdictId: "V-1",
      at: NOW.toISOString(),
      score: 9,
      bar: 7,
      runtime: "claude",
      requestedModel: "haiku",
      reportedModel: null,
      promptVersion: 1,
      rubricDigest: rubricDigest(RUBRIC),
    },
  ]);
});

test("a stored verdict with no provenance records it as unknown, never filled in", async () => {
  const { e, inst, runId } = await waitingAtAutoGate();
  await storeVerdict(runId, 9, {
    id: "V-3",
    at: new Date(NOW.getTime() + 1000).toISOString(),
    provenance: undefined,
  });
  const res = await e.approveAutomatically(
    request(inst, runId, {
      verdicts: [{ ...basis(runId, "V-3"), runtime: "claude", promptVersion: 1 } as never],
    }),
  );
  assert.equal(res.ok, true);
  const [d] = await readGateDecisions(inst.id);
  assert.equal(d.verdicts?.[0].runtime, null);
  assert.equal(d.verdicts?.[0].requestedModel, null);
  assert.equal(d.verdicts?.[0].reportedModel, null);
  assert.equal(d.verdicts?.[0].promptVersion, null);
});

test("a gate without autoApprove cannot be opened automatically, however it scored", async () => {
  await seed([gatedPhase("build", { rubric: RUBRIC })]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  await complete(e, inst, "build", rec.calls[0].runId);
  const res = await e.approveAutomatically(request(inst, rec.calls[0].runId));
  assert.equal(res.code, 409);
  assert.match(res.error ?? "", /does not declare autoApprove/);
});

test("regression: a revised attempt cannot be opened by an approval computed for the previous one", async () => {
  const { e, rec, inst, runId } = await waitingAtAutoGate();
  const revised = await e.revise(inst.id, "try again");
  assert.equal(revised.ok, true);
  const second = rec.calls[1].runId;
  await complete(e, await load(inst.id), "build", second);
  // The watcher's stale view: attempt 1, the first run.
  const stale = await e.approveAutomatically(request(inst, runId));
  assert.equal(stale.ok, false);
  assert.equal(phaseOf(await load(inst.id), "build").status, "awaiting-approval");
  // The current attempt, fully judged, opens it.
  await storeVerdict(second);
  const fresh = await e.approveAutomatically(
    request(inst, second, { attempt: 1, verdicts: [basis(second)] }),
  );
  assert.equal(fresh.ok, true);
});

test("regression: an automated approval opens the named sibling, never another paused phase", async () => {
  await seed([
    gatedPhase("review", { needs: [] }),
    gatedPhase("build", { needs: [], rubric: RUBRIC, autoApprove: { verdict: 7 } }),
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  const runOf = (phase: string) => rec.calls.find((c) => c.env.ARGUS_PHASE_ID === phase)!.runId;
  await complete(e, inst, "build", runOf("build"));
  // The engine drops a completion signal while any sibling is paused (it
  // only accepts signals on a `running` instance — tracked separately), so the
  // second waiting gate is set up on disk: both phases paused, `review` first.
  const both = await load(inst.id);
  phaseOf(both, "review").status = "awaiting-approval";
  phaseOf(both, "review").steps[0].status = "succeeded";
  await writeInstance(both);
  assert.equal(phaseOf(both, "build").status, "awaiting-approval");

  await storeVerdict(runOf("build"));
  const res = await e.approveAutomatically(request(both, runOf("build")));
  assert.equal(res.ok, true);
  const after = await load(inst.id);
  assert.equal(phaseOf(after, "build").status, "succeeded");
  assert.equal(
    phaseOf(after, "review").status,
    "awaiting-approval",
    "the human's gate is untouched",
  );
});

test("regression: a needs-input pause is a question for a person; no score answers it", async () => {
  await seed([gatedPhase("build", { rubric: RUBRIC, autoApprove: { verdict: 7 } })]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  await e.onSignal(inst.id, {
    instanceId: inst.id,
    phaseId: "build",
    runId: rec.calls[0].runId,
    type: "needs-input",
    token: inst.signalToken,
    payload: "Which database?",
  });
  const asked = await load(inst.id);
  assert.equal(phaseOf(asked, "build").pause, "needs-input");
  await storeVerdict(rec.calls[0].runId, 10);
  const res = await e.approveAutomatically(
    request(asked, rec.calls[0].runId, { verdicts: [basis(rec.calls[0].runId)] }),
  );
  assert.equal(res.code, 409);
  assert.match(res.error ?? "", /agent's question/);
  assert.deepEqual(await readGateDecisions(inst.id), []);
});

test("a pause written before causes were recorded is not a rule's to open", async () => {
  const { e, inst, runId } = await waitingAtAutoGate();
  const legacy = await load(inst.id);
  delete phaseOf(legacy, "build").pause;
  await writeInstance(legacy);
  const res = await e.approveAutomatically(request(legacy, runId));
  assert.equal(res.code, 409);
  assert.match(res.error ?? "", /before pause causes were recorded/);
});

test("regression: a re-judgment that lands after the watcher looked wins over the basis it sent", async () => {
  const { e, inst, runId } = await waitingAtAutoGate();
  // The watcher built its request from V-1 (9/10). Before the engine got it,
  // the run was judged again and the new pass failed.
  await storeVerdict(runId, 0, {
    id: "V-2",
    status: "failed",
    score: null,
    at: new Date(NOW.getTime() + 60_000).toISOString(),
  });
  const res = await e.approveAutomatically(request(inst, runId));
  assert.equal(res.code, 409);
  assert.match(res.error ?? "", /not that run's current verdict/);
  assert.equal(phaseOf(await load(inst.id), "build").status, "awaiting-approval");
});

// ── The approval decision point (verdict writes racing an approval) ──────────

/**
 * Starts a verdict write from inside the approval's critical window (after
 * validation, before the instance link) without awaiting it, and records
 * whether it had landed by the time the approval was linked.
 */
function racingWrite(runId: string, over: Record<string, unknown>) {
  let landed = false;
  let pending: Promise<unknown> | null = null;
  let landedAtLink: boolean | null = null;
  return {
    deps: {
      gateEffectProbe: (point: GateEffectPoint) => {
        if (point === "approve:validated" && !pending) {
          pending = storeVerdict(runId, 9, over).then(() => {
            landed = true;
          });
        }
        if (point === "approve:linked") landedAtLink = landed;
      },
    },
    done: () => pending,
    landedAtLink: () => landedAtLink,
  };
}

test("MANDATORY: a newer low-scoring verdict written during the approval lands after its commit point", async () => {
  const { inst, runId } = await waitingAtAutoGate();
  const race = racingWrite(runId, {
    id: "V-2",
    score: 2,
    at: new Date(NOW.getTime() + 1000).toISOString(),
  });
  const e = engine(recordingSpawn().spawn, race.deps);
  const res = await e.approveAutomatically(request(inst, runId));
  await race.done();
  assert.equal(res.ok, true, "the approval was valid at its commit point");
  assert.equal(
    race.landedAtLink(),
    false,
    "the write could not land before the approval was linked",
  );
  const [d] = await readGateDecisions(inst.id);
  assert.equal(
    d.verdicts?.[0].verdictId,
    "V-1",
    "the basis is the verdict current at the commit point",
  );
  assert.equal(phaseOf(await load(inst.id), "build").status, "succeeded");
});

test("MANDATORY: a newer failed judgment written during the approval is ordered after it, never silently before", async () => {
  const { inst, runId } = await waitingAtAutoGate();
  const race = racingWrite(runId, {
    id: "V-2",
    status: "failed",
    score: null,
    at: new Date(NOW.getTime() + 1000).toISOString(),
  });
  const e = engine(recordingSpawn().spawn, race.deps);
  const res = await e.approveAutomatically(request(inst, runId));
  await race.done();
  assert.equal(res.ok, true);
  assert.equal(race.landedAtLink(), false);
});

test("a verdict that lands before the commit point refuses the approval", async () => {
  // The same newer judgment, written before the engine takes the verdict
  // lock: it is what validation sees.
  const { e, inst, runId } = await waitingAtAutoGate();
  await storeVerdict(runId, 2, { id: "V-2", at: new Date(NOW.getTime() + 1000).toISOString() });
  const res = await e.approveAutomatically(request(inst, runId));
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /not that run's current verdict/);
});

test("a judgment after the approval is committed does not revoke it", async () => {
  const { e, inst, runId } = await waitingAtAutoGate();
  assert.equal((await e.approveAutomatically(request(inst, runId))).ok, true);
  await storeVerdict(runId, 0, {
    id: "V-2",
    status: "failed",
    score: null,
    at: new Date(NOW.getTime() + 1000).toISOString(),
  });
  const after = await load(inst.id);
  assert.equal(phaseOf(after, "build").status, "succeeded");
  const [d] = await readGateDecisions(inst.id);
  assert.equal(d.verdicts?.[0].verdictId, "V-1", "the record keeps the basis it was decided on");
  assert.equal(buildGateDecisionsResponse(inst.id, after, [d]).decisions[0].effect, "applied");
});

// ── Provenance ──────────────────────────────────────────────────────────────

test("an in-process approval that names no source is recorded as unspecified and unknown, not as a person", async () => {
  const { e, inst } = await waitingAtAutoGate();
  assert.equal((await e.approve(inst.id)).ok, true);
  const [d] = await readGateDecisions(inst.id);
  assert.equal(d.mechanism, "unspecified");
  assert.equal(d.channel, "in-process");
  assert.deepEqual(d.principal, { kind: "unknown" });
});

test("revise and abort are recorded with the attempt and phases they acted on", async () => {
  const { e, inst, runId } = await waitingAtAutoGate();
  const who = {
    channel: "http" as const,
    principal: { kind: "session" as const, username: "ana", role: "admin" },
  };
  assert.equal((await e.revise(inst.id, "tighten it", { source: who })).ok, true);
  assert.equal((await e.abort(inst.id, { source: who })).ok, true);
  const [revise, abort] = await readGateDecisions(inst.id);
  assert.equal(revise.decision, "revise");
  assert.deepEqual(revise.phases[0], {
    phaseId: "build",
    attempt: 0,
    status: "awaiting-approval",
    runIds: [runId],
  });
  assert.equal(revise.note, "tighten it");
  assert.equal(abort.decision, "abort");
  assert.equal(abort.phases[0].attempt, 1, "the abort stopped the revised attempt");
  assert.deepEqual((await load(inst.id)).gateDecisionIds, [revise.id, abort.id]);

  // An abort of an ended instance is refused before anything is recorded.
  assert.equal((await e.abort(inst.id, { source: who })).code, 409);
  assert.equal((await readGateDecisions(inst.id)).length, 2);
});

test("an operator approval bound to an attempt is refused once the phase has moved on", async () => {
  const { e, rec, inst } = await waitingAtAutoGate();
  await e.revise(inst.id);
  await complete(e, await load(inst.id), "build", rec.calls[1].runId);
  const res = await e.approve(inst.id, undefined, { attempt: 0 });
  assert.equal(res.code, 409);
  assert.match(res.error ?? "", /attempt 1, not attempt 0/);
  assert.equal((await e.approve(inst.id, undefined, { attempt: 1 })).ok, true);
});

test("historical gates with no decision on record are reported as undocumented, never attributed", async () => {
  const { e, inst } = await waitingAtAutoGate();
  await e.approve(inst.id);
  // Simulate an instance decided before decisions were recorded.
  rmSync(gateDecisionFile());
  const legacy = await load(inst.id);
  delete legacy.gateDecisionIds;
  const view = buildGateDecisionsResponse(inst.id, legacy, []);
  assert.deepEqual(view.decisions, []);
  assert.deepEqual(view.undocumented, [{ phaseId: "build", attempt: 0, status: "succeeded" }]);
});

// ── Persistence failure, duplicates, restart ────────────────────────────────

test("a decision that cannot be recorded is not applied, and nothing changes", async () => {
  const { inst, runId } = await waitingAtAutoGate();
  const failing = engine(recordingSpawn().spawn, {
    recordGateDecision: async () => {
      throw new Error("disk full");
    },
  });
  const before = readFileSync(path.join(paths.argus(), "instances", `${inst.id}.json`), "utf8");
  for (const res of [
    await failing.approve(inst.id),
    await failing.approveAutomatically(request(inst, runId)),
    await failing.revise(inst.id),
    await failing.abort(inst.id),
  ]) {
    assert.equal(res.ok, false);
    assert.equal(res.code, 500);
    assert.match(res.error ?? "", /could not be recorded/);
  }
  const after = readFileSync(path.join(paths.argus(), "instances", `${inst.id}.json`), "utf8");
  assert.equal(after, before, "the instance file is byte-identical");
});

test("the decision is durable before the transition: at record time the instance still shows the gate waiting", async () => {
  const { inst } = await waitingAtAutoGate();
  const seen: string[] = [];
  const e = engine(recordingSpawn().spawn, {
    recordGateDecision: async (d: GateDecision) => {
      const onDisk = await load(d.instanceId);
      seen.push(phaseOf(onDisk, "build").status);
      assert.equal(onDisk.gateDecisionIds, undefined);
      appendFileSync(gateDecisionFile(), `${JSON.stringify(d)}\n`);
    },
  });
  assert.equal((await e.approve(inst.id)).ok, true);
  assert.deepEqual(seen, ["awaiting-approval"]);
});

test("duplicate approvals: one takes effect, the other is refused and records nothing", async () => {
  const { e, inst } = await waitingAtAutoGate();
  const [a, b] = await Promise.all([e.approve(inst.id), e.approve(inst.id)]);
  assert.deepEqual([a.code, b.code].sort(), [200, 409]);
  const records = await readGateDecisions(inst.id);
  assert.equal(records.length, 1);
  assert.deepEqual((await load(inst.id)).gateDecisionIds, [records[0].id]);
});

test("restart between recording and saving: the orphan reads not-applied, and the retried decision applies", async () => {
  const { inst } = await waitingAtAutoGate();
  // The process wrote the decision and died before saving the transition.
  const crashing = engine(recordingSpawn().spawn, {
    recordGateDecision: async (d: GateDecision) => {
      appendFileSync(gateDecisionFile(), `${JSON.stringify(d)}\n`);
      throw new Error("process killed");
    },
  });
  await crashing.approve(inst.id, undefined, {
    source: { channel: "http", principal: { kind: "session", username: "ana", role: "admin" } },
  });
  // And a torn half-line from a second, interrupted append.
  appendFileSync(gateDecisionFile(), '{"id":"GD-torn","instanceId');
  assert.equal(phaseOf(await load(inst.id), "build").status, "awaiting-approval");

  // A fresh engine (the restart) and a person approving again.
  const restarted = engine(recordingSpawn().spawn);
  await restarted.reconcile();
  assert.equal(
    phaseOf(await load(inst.id), "build").status,
    "awaiting-approval",
    "nothing replays it",
  );
  const ok = await restarted.approve(inst.id, undefined, {
    source: { channel: "http", principal: { kind: "session", username: "bo", role: "admin" } },
  });
  assert.equal(ok.ok, true);

  const view = buildGateDecisionsResponse(
    inst.id,
    await load(inst.id),
    await readGateDecisions(inst.id),
  );
  assert.equal(view.decisions.length, 2, "the torn line is skipped, never parsed as a record");
  assert.deepEqual(
    view.decisions.map((d) => [
      d.principal.kind === "session" ? d.principal.username : null,
      d.effect,
    ]),
    [
      ["ana", "not-applied"],
      ["bo", "applied"],
    ],
  );
  // Once the instance is gone, nothing can say which took effect.
  assert.ok(
    view.decisions.every(
      (d) => buildGateDecisionsResponse(inst.id, null, [d]).decisions[0].effect === "unknown",
    ),
  );
});

// ── Unaffected pipelines ────────────────────────────────────────────────────

test("an ungated pipeline records no gate decisions and behaves as before", async () => {
  await seed([{ ...gatedPhase("build"), gated: false }]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  await complete(e, inst, "build", rec.calls[0].runId);
  const after = await load(inst.id);
  assert.equal(after.status, "succeeded");
  assert.equal(after.gateDecisionIds, undefined);
  assert.deepEqual(await readGateDecisions(), []);
});
