/**
 * Approval conditions (DL-A3), through the real engine: a gated phase whose
 * `approveWhen` command Argus polls while the gate waits. Exit 0 opens the
 * gate as a person's approval would, recorded as the rule that did it; the
 * `failOnExit` code fails the phase, never retried; anything else waits. Every
 * assertion is on disk — the instance, the decision log, the journal — or on
 * the files the polled commands themselves wrote.
 *
 * The commands are real (`node -e`, through the platform shell) and written
 * to run under `cmd.exe` too: JavaScript in double quotes with only single
 * quotes inside, no arrow functions, paths as separate quoted arguments read
 * from `process.argv`. The engines get no `parentEnv`, so `node` is on the
 * poll's `PATH` (HARNESS.md §17).
 */
import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PipelineInstance } from "@argus/contracts";
import {
  createEngine,
  type Engine,
  type EngineDeps,
  type GateEffectPoint,
} from "../pipelineEngine.js";
import { fakeKill } from "../testPlatform.js";
import { createPipeline, validatePipelineInput } from "../sources/pipelines.js";
import { readInstance, writeInstance } from "../sources/instances.js";
import { buildGateDecisionsResponse, readGateDecisions } from "../sources/gateDecisions.js";
import { readJournal } from "../sources/journal.js";
import { rubricDigest, writeVerdict } from "../sources/verdict.js";
import { paths } from "../claudeHome.js";
import { testRunToken } from "../testSignalToken.js";

let home: string;
let clock: number;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-gate-polls-"));
  process.env.ARGUS_CLAUDE_HOME = home;
  mkdirSync(path.join(home, "argus", "runs"), { recursive: true });
  mkdirSync(path.join(home, "argus", "instances"), { recursive: true });
  clock = Date.parse("2026-10-21T12:00:00.000Z");
});

// Every engine a test builds stops polling and is drained before the next
// test repoints the home: a poll still in flight would otherwise land there.
const engines: Engine[] = [];
afterEach(async () => {
  for (const e of engines) e.stopPolls();
  await Promise.all(engines.splice(0).map((e) => e.drain()));
});

const MARKED = { last_assistant_message: "done\nARGUS_OUTCOME: succeeded" };
const RUBRIC = { goal: "Be good.", criteria: [{ id: "quality", label: "Quality" }] };

let counter = 0;
interface Spawned {
  runId: string;
  env: Record<string, string>;
}

function harness() {
  const calls: Spawned[] = [];
  let failures = 0;
  const spawn = (run: { id: string }, _log: string, env: Record<string, string>) => {
    calls.push({ runId: run.id, env });
    // Alive, so a reconcile pass never takes the step for a lost process.
    return { pid: process.pid, done: new Promise<{ code: number | null }>(() => {}) };
  };
  const make = (extra: Partial<EngineDeps> = {}) => {
    const e = createEngine({
      now: () => new Date(clock),
      newId: () => `gp-${++counter}`,
      spawn,
      kill: fakeKill().kill,
      killGraceMs: 60_000,
      signalUrlBase: "http://localhost:7777",
      newSignalToken: testRunToken,
      maxConcurrent: 8,
      tickMs: 30000,
      onFailure: () => {
        failures++;
      },
      ...extra,
    });
    engines.push(e);
    return e;
  };
  const launches = (phaseId: string) => calls.filter((c) => c.env.ARGUS_PHASE_ID === phaseId);
  return { calls, make, launches, failures: () => failures };
}
type Harness = ReturnType<typeof harness>;

/** A probe that fails exactly once, at `at`: the process dying there. */
function failAt(at: GateEffectPoint): Partial<EngineDeps> {
  let fired = false;
  return {
    gateEffectProbe: (point: GateEffectPoint) => {
      if (point === at && !fired) {
        fired = true;
        throw new Error(`injected failure at ${point}`);
      }
    },
  };
}

/** A gated `pr` phase that declares `approveWhen`, then an ungated `next`. */
async function seed(approveWhen: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return createPipeline(
    validatePipelineInput({
      name: "polls",
      trigger: null,
      phases: [
        {
          id: "pr",
          name: "PR",
          cwd: home,
          gated: true,
          needs: [],
          steps: [{ name: "s", prompt: "open the pull request" }],
          approveWhen: { kind: "command", label: "pr merged", ...approveWhen },
          ...extra,
        },
        {
          id: "next",
          name: "Next",
          cwd: home,
          gated: false,
          needs: ["pr"],
          steps: [{ name: "s", prompt: "carry on" }],
        },
      ],
    }),
    new Date(clock),
    "p1",
  );
}

/** `node -e "<js>" "<arg>"…`, portable to `cmd.exe`. */
const node = (js: string, ...args: string[]) =>
  [`node -e "${js}"`, ...args.map((a) => `"${a}"`)].join(" ");
/** Appends one "x" per poll to `file`, then exits with `code`. */
const counting = (file: string, code: number) =>
  node(
    "require('fs').appendFileSync(process.argv[1], 'x'); process.exit(Number(process.argv[2]))",
    file,
    String(code),
  );
/** Appends one "x" per poll to `started`, then exits 0 once `go` exists. */
const blocking = (started: string, go: string) =>
  node(
    "var fs=require('fs'); fs.appendFileSync(process.argv[1], 'x'); " +
      "setInterval(function(){ if (fs.existsSync(process.argv[2])) process.exit(0) }, 20)",
    started,
    go,
  );
/** How many polls a `counting` or `blocking` command has started. */
const polls = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").length : 0);

function stageDelta(call: Spawned) {
  const file = call.env.ARGUS_KNOWLEDGE_DELTA_FILE;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 1,
      claims: [{ localId: "f", kind: "fact", statement: "x" }],
      evidence: [{ claim: { local: "f" }, source: { type: "document", uri: "spec://x" } }],
    }),
  );
}

async function load(id: string): Promise<PipelineInstance> {
  const inst = await readInstance(id);
  assert.ok(inst, `instance ${id} is on disk`);
  return inst;
}
const phaseOf = (inst: PipelineInstance, id: string) => inst.phases.find((p) => p.id === id)!;

/** Started, its `pr` step reported, and waiting at the gate (or, with `ask`,
 *  at an agent's question). `stage` stages a knowledge delta first. */
async function atGate(
  h: Harness,
  e: Engine,
  opts: { stage?: boolean; ask?: boolean; payload?: unknown } = {},
): Promise<PipelineInstance> {
  const inst =
    opts.payload === undefined
      ? await e.start("p1", "manual")
      : await e.start("p1", "webhook", { triggerPayload: opts.payload });
  assert.ok(inst, "the instance started");
  const pr = h.launches("pr")[h.launches("pr").length - 1];
  if (opts.stage) stageDelta(pr);
  const res = await e.onSignal(inst.id, {
    instanceId: inst.id,
    phaseId: "pr",
    runId: pr.runId,
    type: opts.ask ? "needs-input" : "completed",
    token: testRunToken(pr.runId),
    payload: MARKED,
  });
  assert.equal(res.ok, true, "the signal was accepted");
  await e.drain();
  const waiting = await load(inst.id);
  assert.equal(phaseOf(waiting, "pr").status, "awaiting-approval", "pr waits");
  assert.equal(phaseOf(waiting, "pr").pause, opts.ask ? "needs-input" : "gate", "pause cause");
  return waiting;
}

/** One scheduler tick, as far as approval polls go: queue, then let them land. */
async function tick(e: Engine) {
  await e.pollGates();
  await e.drain();
}

async function conditionEntries(instanceId: string) {
  return (await readJournal(instanceId)).filter((j) => j.kind === "phase.approval-condition");
}

async function effects(instanceId: string) {
  const inst = await readInstance(instanceId);
  return buildGateDecisionsResponse(instanceId, inst, await readGateDecisions(instanceId))
    .decisions;
}

async function waitFor(cond: () => boolean | Promise<boolean>, label: string, ms = 10_000) {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ── The three outcomes ──────────────────────────────────────────────────────

test("exit 0 approves the gate once, recorded as the rule that did it, and starts the next phase", async () => {
  await seed({ run: node("process.stdout.write('x'.repeat(2000) + 'END')"), everySeconds: 30 });
  const h = harness();
  const e = h.make();
  const inst = await atGate(h, e);
  const runId = h.launches("pr")[0].runId;

  await tick(e);
  const after = await load(inst.id);
  assert.equal(phaseOf(after, "pr").status, "succeeded", "the gate opened");
  assert.equal(h.launches("next").length, 1, "next started");
  const decisions = await readGateDecisions(inst.id);
  assert.equal(decisions.length, 1, "one decision");
  const [d] = decisions;
  assert.equal(d.decision, "approve");
  assert.equal(d.mechanism, "approval-condition");
  assert.equal(d.channel, "approval-poll");
  assert.deepEqual(d.principal, { kind: "system", component: "approval-poll" });
  assert.deepEqual(d.phases, [
    { phaseId: "pr", attempt: 0, status: "awaiting-approval", runIds: [runId] },
  ]);
  assert.equal(d.condition?.kind, "command");
  assert.equal(d.condition?.label, "pr merged");
  assert.equal(d.condition?.exitCode, 0);
  assert.equal(d.condition?.output.length, 500, "only the tail is kept");
  assert.ok(d.condition?.output.endsWith("END"), "the end of the output");
  assert.equal(d.condition?.startedAt, new Date(clock).toISOString());
  assert.equal(typeof d.condition?.durationMs, "number");
  assert.equal(d.verdicts, undefined, "no Verdict basis");
  assert.deepEqual(after.gateDecisionIds, [d.id], "linked to the instance");
  assert.equal(buildGateDecisionsResponse(inst.id, after, [d]).decisions[0].effect, "applied");
  const entries = await conditionEntries(inst.id);
  assert.equal(entries.length, 1, "one journal entry");
  assert.match(entries[0].detail ?? "", /^pr merged: exit 0 in \d+ms: approved the gate$/);

  clock += 60_000;
  await tick(e);
  assert.equal((await readGateDecisions(inst.id)).length, 1, "never approved twice");
  assert.equal(h.launches("next").length, 1, "next started once");
  assert.equal((await conditionEntries(inst.id)).length, 1, "nothing more to journal");
});

test("a poll runs where the work is, told the attempt's inputs and the trigger payload", async () => {
  const seen = path.join(home, "seen.json");
  await seed({
    run: node(
      "var fs=require('fs'), env=process.env; fs.writeFileSync(process.argv[1], JSON.stringify({" +
        " id: env.ARGUS_INSTANCE_ID, phase: env.ARGUS_PHASE_ID, attempt: env.ARGUS_PHASE_ATTEMPT," +
        " artifacts: env.ARGUS_ARTIFACT_DIR ? env.ARGUS_ARTIFACT_DIR : null," +
        " workspace: env.ARGUS_WORKSPACE ? env.ARGUS_WORKSPACE : null," +
        " payload: env.ARGUS_TRIGGER_PAYLOAD_FILE ? fs.readFileSync(env.ARGUS_TRIGGER_PAYLOAD_FILE, 'utf8') : null," +
        " cwd: process.cwd() })); process.exit(1)",
      seen,
    ),
    everySeconds: 30,
  });
  const h = harness();
  const e = h.make();
  const inst = await atGate(h, e, { payload: { pr: { id: 12, branch: "feature/x" } } });

  await tick(e);
  const got = JSON.parse(readFileSync(seen, "utf8")) as Record<string, string | null>;
  assert.equal(got.id, inst.id);
  assert.equal(got.phase, "pr");
  assert.equal(got.attempt, "0");
  assert.equal(got.artifacts, phaseOf(inst, "pr").artifactDir ?? null, "the phase's folder");
  assert.equal(got.workspace, null, "no worktree, so no ARGUS_WORKSPACE");
  // The phase has no checks: the poll alone is what writes the payload file.
  assert.deepEqual(JSON.parse(got.payload ?? "null"), { pr: { id: 12, branch: "feature/x" } });
  assert.equal(realpathSync(got.cwd ?? ""), realpathSync(home), "the phase's cwd");
  assert.equal(phaseOf(await load(inst.id), "pr").status, "awaiting-approval", "exit 1 waits");
});

test("failOnExit fails the phase without a retry, and a person can still revise it", async () => {
  const f = path.join(home, "polls.txt");
  await seed(
    { run: counting(f, 3), everySeconds: 30, failOnExit: 3 },
    {
      retry: {
        attempts: 3,
        backoffSeconds: 0,
        retryOn: ["spawn", "exit-code", "signal", "timeout", "verification", "unverified"],
      },
    },
  );
  const h = harness();
  const e = h.make();
  const inst = await atGate(h, e);

  await tick(e);
  assert.equal(polls(f), 1);
  const after = await load(inst.id);
  const pr = phaseOf(after, "pr");
  assert.equal(pr.status, "failed");
  const payload = pr.payload as { failureClass?: string; reason?: string };
  assert.equal(payload.failureClass, "approval-condition");
  assert.match(payload.reason ?? "", /^approval condition "pr merged" exited 3$/);
  assert.equal(pr.retryAt, undefined, "no retry is scheduled, whatever retryOn says");
  assert.equal(after.status, "failed");
  assert.equal(h.failures(), 1, "the failure is notified once");
  assert.deepEqual(await readGateDecisions(inst.id), [], "not a gate decision");
  await waitFor(
    async () =>
      (await readJournal(inst.id)).some(
        (j) => j.kind === "phase.failed" && /^approval-condition:/.test(j.detail ?? ""),
      ),
    "the phase.failed entry",
  );
  const entries = await conditionEntries(inst.id);
  assert.equal(entries.length, 1);
  assert.match(entries[0].detail ?? "", /exit 3: failed the phase/);

  await e.reconcile();
  await e.drain();
  assert.equal(h.launches("pr").length, 1, "reconcile does not retry it");

  const res = await e.revise(inst.id, "try again");
  assert.equal(res.ok, true, "a person can still revise a condition failure");
  await e.drain();
  const revised = await load(inst.id);
  assert.equal(phaseOf(revised, "pr").attempt, 1);
  assert.equal(phaseOf(revised, "pr").status, "running");
  assert.equal(h.launches("pr").length, 2, "attempt 1 launched");
});

test("other exit codes keep the gate waiting, journalled only when the result changes", async () => {
  const f = path.join(home, "polls.txt");
  await seed({ run: counting(f, 1), everySeconds: 30, failOnExit: 3 });
  const h = harness();
  const e = h.make();
  const inst = await atGate(h, e);

  await tick(e);
  assert.equal(polls(f), 1);
  assert.equal(phaseOf(await load(inst.id), "pr").status, "awaiting-approval");
  assert.deepEqual(await readGateDecisions(inst.id), []);
  let entries = await conditionEntries(inst.id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].detail, "pr merged: waiting: exit 1");

  clock += 30_000;
  await tick(e);
  assert.equal(polls(f), 2, "polled again");
  entries = await conditionEntries(inst.id);
  assert.equal(entries.length, 1, "an unchanged result is not journalled again");
});

test("without a label, a condition takes a command check's default label", async () => {
  const f = path.join(home, "polls.txt");
  const run = counting(f, 3);
  assert.ok(run.length > 71, "long enough to be clipped");
  await seed({ run, label: null, everySeconds: 30, failOnExit: 3 });
  const h = harness();
  const e = h.make();
  const inst = await atGate(h, e);

  await tick(e);
  const label = `command: ${run.slice(0, 71)}`;
  const pr = phaseOf(await load(inst.id), "pr");
  assert.equal(pr.status, "failed");
  assert.equal(
    (pr.payload as { reason?: string }).reason,
    `approval condition "${label}" exited 3`,
  );
  const entries = await conditionEntries(inst.id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].detail, `${label}: exit 3: failed the phase`);
});

test("a timeout keeps the gate waiting, whatever the process left behind", async () => {
  await seed({
    run: node("setTimeout(function(){}, 10000)"),
    everySeconds: 30,
    timeoutSeconds: 1,
    failOnExit: 3,
  });
  const h = harness();
  const e = h.make();
  const inst = await atGate(h, e);

  const start = Date.now();
  await tick(e);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 8000, `the poll was cut at its timeout, took ${elapsed}ms`);
  assert.equal(phaseOf(await load(inst.id), "pr").status, "awaiting-approval");
  assert.deepEqual(await readGateDecisions(inst.id), []);
  const entries = await conditionEntries(inst.id);
  assert.equal(entries.length, 1);
  assert.match(entries[0].detail ?? "", /waiting: timed out after 1s/);
});

// ── A person, and the rule beside it ────────────────────────────────────────

test("a person's revise beats a poll that is in flight", async () => {
  const started = path.join(home, "started.txt");
  const go = path.join(home, "go");
  await seed({ run: blocking(started, go), everySeconds: 30 });
  const h = harness();
  const e = h.make();
  const inst = await atGate(h, e);

  await e.pollGates();
  await waitFor(() => existsSync(started), "the poll to start");
  const res = await e.revise(inst.id, "not this one");
  assert.equal(res.ok, true, "the person's revise applies");
  writeFileSync(go, "");
  await e.drain();

  const decisions = await readGateDecisions(inst.id);
  assert.deepEqual(
    decisions.map((d) => d.decision),
    ["revise"],
    "the poll's exit 0 recorded nothing",
  );
  const after = await load(inst.id);
  assert.equal(phaseOf(after, "pr").attempt, 1);
  assert.equal(phaseOf(after, "pr").status, "running");
  assert.equal(h.launches("next").length, 0, "next never started");
  const entries = await conditionEntries(inst.id);
  assert.equal(entries.length, 1);
  assert.match(entries[0].detail ?? "", /exit 0, not applied: phase pr is not awaiting approval/);
});

test("approveWhen beside autoApprove: whichever qualifies first opens the gate", async () => {
  await seed(
    { run: node("process.exit(0)"), everySeconds: 30 },
    { rubric: RUBRIC, autoApprove: { verdict: 7 } },
  );
  const h = harness();
  const e = h.make();
  const inst = await atGate(h, e);
  const runId = h.launches("pr")[0].runId;
  await writeVerdict({
    id: "V-1",
    runId,
    scheduleId: "pipeline:p1",
    scheduleName: "polls",
    phaseId: "pr",
    status: "ready",
    at: new Date(clock).toISOString(),
    score: 9,
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
  });

  await tick(e);
  const res = await e.approveAutomatically({
    instanceId: inst.id,
    phaseId: "pr",
    attempt: 0,
    runIds: [runId],
    verdicts: [{ runId, verdictId: "V-1" }],
  });
  assert.equal(res.code, 409, "the gate is already open");
  const decisions = await readGateDecisions(inst.id);
  assert.equal(decisions.length, 1, "one decision");
  assert.equal(decisions[0].mechanism, "approval-condition", "the condition was first");
  // Only a Verdict auto-approval carries a Verdict basis, even with one on disk.
  assert.equal(decisions[0].verdicts, undefined);
  assert.equal(decisions[0].trajectoryVerdicts, undefined);
});

// ── What is never polled ────────────────────────────────────────────────────

test("no poll at a question an agent asked (needs-input)", async () => {
  const f = path.join(home, "polls.txt");
  await seed({ run: counting(f, 0), everySeconds: 30 });
  const h = harness();
  const e = h.make();
  const inst = await atGate(h, e, { ask: true });

  await tick(e);
  assert.equal(polls(f), 0);
  assert.deepEqual(await conditionEntries(inst.id), []);
  assert.deepEqual(await readGateDecisions(inst.id), []);
});

test("no poll for an attempt that staged knowledge: journalled once, and a person still approves", async () => {
  const f = path.join(home, "polls.txt");
  await seed({ run: counting(f, 0), everySeconds: 30 });
  const h = harness();
  const e = h.make();
  const inst = await atGate(h, e, { stage: true });

  await tick(e);
  clock += 60_000;
  await tick(e);
  assert.equal(polls(f), 0, "never polled");
  const entries = await conditionEntries(inst.id);
  assert.equal(entries.length, 1, "journalled once");
  assert.match(
    entries[0].detail ?? "",
    /^not polled: this gate commits knowledge \(staged-knowledge-delta\) and needs a person$/,
  );
  const res = await e.approve(inst.id, undefined, { phaseId: "pr", attempt: 0 });
  assert.equal(res.ok, true, "a person approves it");
  await e.drain();
  assert.equal(phaseOf(await load(inst.id), "pr").status, "succeeded");
});

test("no poll for an instance whose pipeline was deleted", async () => {
  const f = path.join(home, "polls.txt");
  await seed({ run: counting(f, 0), everySeconds: 30 });
  const h = harness();
  const e = h.make();
  const inst = await atGate(h, e);
  writeFileSync(path.join(paths.argus(), "pipelines.json"), "[]");

  await tick(e);
  assert.equal(polls(f), 0);
  assert.deepEqual(await conditionEntries(inst.id), []);
});

test("no poll for a pause of unknown cause", async () => {
  const f = path.join(home, "polls.txt");
  await seed({ run: counting(f, 0), everySeconds: 30 });
  const h = harness();
  const e = h.make();
  const inst = await atGate(h, e);
  const legacy = await load(inst.id);
  delete phaseOf(legacy, "pr").pause;
  await writeInstance(legacy);

  await tick(e);
  assert.equal(polls(f), 0);
  assert.deepEqual(await conditionEntries(inst.id), []);
});

// ── Cadence ─────────────────────────────────────────────────────────────────

test("cadence: everySeconds from one poll's start to the next, to within a second", async () => {
  const f = path.join(home, "polls.txt");
  await seed({ run: counting(f, 1), everySeconds: 60 });
  const h = harness();
  const e = h.make();
  await atGate(h, e);

  await tick(e);
  assert.equal(polls(f), 1, "t0");
  clock += 30_000;
  await tick(e);
  assert.equal(polls(f), 1, "30 s: not due");
  clock += 29_500;
  await tick(e);
  assert.equal(polls(f), 2, "59.5 s: due, within the slack");
  clock += 30_000;
  await tick(e);
  assert.equal(polls(f), 2, "30 s after the second: not due");
  clock += 30_000;
  await tick(e);
  assert.equal(polls(f), 3, "60 s after the second: due");
});

test("at most one poll in flight per attempt", async () => {
  const started = path.join(home, "started.txt");
  const go = path.join(home, "go");
  await seed({ run: blocking(started, go), everySeconds: 30 });
  const h = harness();
  const e = h.make();
  await atGate(h, e);

  await e.pollGates();
  await waitFor(() => existsSync(started), "the poll to start");
  clock += 120_000;
  await e.pollGates();
  await e.pollGates();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(polls(started), 1, "long overdue, but one is still running");
  writeFileSync(go, "");
  await e.drain();
});

// ── Shutdown and restarts ───────────────────────────────────────────────────

test("shutdown cuts a poll in flight and discards it; no more are queued", async () => {
  const started = path.join(home, "started.txt");
  const go = path.join(home, "go");
  await seed({ run: blocking(started, go), everySeconds: 30 });
  const h = harness();
  const e = h.make();
  const inst = await atGate(h, e);

  await e.pollGates();
  await waitFor(() => existsSync(started), "the poll to start");
  const start = Date.now();
  e.stopPolls();
  await e.drain();
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 15_000, `drain waited for the cut poll only, took ${elapsed}ms`);
  assert.deepEqual(await readGateDecisions(inst.id), []);
  assert.equal(phaseOf(await load(inst.id), "pr").status, "awaiting-approval");
  assert.deepEqual(await conditionEntries(inst.id), [], "a cut poll observed nothing");

  rmSync(started);
  clock += 60_000;
  await tick(e);
  assert.equal(existsSync(started), false, "a stopped engine polls no more");
});

test("FAULT SEAM: a condition approval interrupted after its link completes once on restart", async () => {
  await seed({ run: node("process.exit(0)"), everySeconds: 30 });
  const h = harness();
  const crashing = h.make(failAt("approve:linked"));
  const inst = await atGate(h, crashing);

  await tick(crashing);
  assert.deepEqual(
    (await effects(inst.id)).map((d) => d.effect),
    ["incomplete"],
  );
  const entries = await conditionEntries(inst.id);
  assert.equal(entries.length, 1);
  assert.match(
    entries[0].detail ?? "",
    /exit 0, not applied: the gate decision was linked but not completed/,
  );

  const restarted = h.make();
  await restarted.reconcile();
  await restarted.drain();
  const after = await load(inst.id);
  assert.equal(phaseOf(after, "pr").status, "succeeded");
  assert.equal(after.pendingGateOperation, undefined);
  assert.equal(h.launches("next").length, 1, "next started once");
  assert.deepEqual(
    (await effects(inst.id)).map((d) => d.effect),
    ["applied"],
  );

  await tick(restarted);
  assert.equal((await readGateDecisions(inst.id)).length, 1, "no second approval");
  assert.equal(h.launches("next").length, 1);
});

test("FAULT SEAM: a condition approval recorded but never linked reads not applied, and the next poll applies one", async () => {
  await seed({ run: node("process.exit(0)"), everySeconds: 30 });
  const h = harness();
  const crashing = h.make(failAt("approve:recorded"));
  const inst = await atGate(h, crashing);

  await tick(crashing);
  assert.deepEqual(
    (await effects(inst.id)).map((d) => d.effect),
    ["not-applied"],
  );
  assert.equal(phaseOf(await load(inst.id), "pr").status, "awaiting-approval");

  const restarted = h.make();
  await tick(restarted);
  assert.deepEqual(
    (await effects(inst.id)).map((d) => d.effect),
    ["not-applied", "applied"],
  );
  assert.equal(phaseOf(await load(inst.id), "pr").status, "succeeded");
  assert.equal(h.launches("next").length, 1);
});

test("a fresh engine polls on its first tick, and journals its first result again", async () => {
  const f = path.join(home, "polls.txt");
  await seed({ run: counting(f, 1), everySeconds: 3600 });
  const h = harness();
  const first = h.make();
  const inst = await atGate(h, first);

  await tick(first);
  assert.equal(polls(f), 1);
  clock += 1000;
  await tick(first);
  assert.equal(polls(f), 1, "the same process waits out its cadence");

  const second = h.make();
  await tick(second);
  assert.equal(polls(f), 2, "a new process has no cadence to wait out");
  const entries = await conditionEntries(inst.id);
  assert.equal(entries.length, 2, "and journals what it saw once more");
});
