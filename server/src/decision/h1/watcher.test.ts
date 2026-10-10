import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { H1ModelPopulation, H1Report } from "@argus/contracts";
import { h1Registry } from "./definitions.js";
import type { H1Record } from "./ledger.js";
import { replayH1 } from "./report.js";
import { gateInstance, gateWorld, h1Harness, H1_ON, MIN, reviewOf } from "./testSupport.js";

/**
 * The H1 watcher over real stores and a real runner, with the gate world held
 * in memory so the operator can act at exact points (RFC §Q.3, §Q.5).
 */

const kinds = (rs: H1Record[]) => rs.map((r) => r.kind);
const of = <K extends H1Record["kind"]>(rs: H1Record[], k: K) =>
  rs.filter((r): r is Extract<H1Record, { kind: K }> => r.kind === k);

async function report(h: ReturnType<typeof h1Harness>): Promise<H1Report> {
  return replayH1(h.boot().ledger, h.boot().snapshots, h.boot().journal, h1Registry());
}

const model = (r: H1Report, population = "manual"): H1ModelPopulation | undefined =>
  r.models.find((m) => m.population === population);

test("off by default and with either switch off: nothing is read, written or spawned", async () => {
  for (const env of [
    {},
    { ARGUS_DECISIONS: "on" },
    { ARGUS_DECISIONS_H1_COLLECT: "on" },
    { ...H1_ON, ARGUS_ANALYSIS: "off" },
    { ...H1_ON, ARGUS_DECISIONS_H1_RATE: "5" },
    { ...H1_ON, ARGUS_DECISIONS_H1_MODELS: "gpt-4" },
  ]) {
    const h = h1Harness({ env });
    h.world.put(gateInstance());
    for (let i = 0; i < 3; i++) assert.equal((await h.tick()).action, "inactive");
    assert.equal(h.spawns.length, 0);
    assert.equal(h.world.reads.instances + h.world.reads.decisions, 0);
    assert.ok(!existsSync(path.join(h.root, "h1")), "no H1 directory");
    assert.ok(!existsSync(path.join(h.root, "decisions")), "no journal directory");
  }
});

test("capture, then a call on the captured snapshot, a post-check, and settlement after the operator approves", async () => {
  const h = h1Harness();
  h.world.put(gateInstance());
  const first = await h.tick();
  assert.equal(first.action, "done");
  assert.equal(first.action === "done" && first.captured, 1);
  assert.equal(first.action === "done" && first.call.kind, "deferred"); // first check since start
  assert.equal(h.spawns.length, 0);
  let recs = await h.records();
  const capture = of(recs, "capture")[0];
  assert.equal(capture.itemKey, "inst-1|publish#0|gate.operator-action@1");
  assert.equal(capture.population, "manual");
  assert.deepEqual(capture.relevantRuns, ["run-a"]);
  assert.equal(capture.sample.selected, true);

  const second = await h.tick();
  assert.equal(second.action === "done" && second.call.kind, "attempted");
  assert.equal(h.spawns.length, 1);
  recs = await h.records();
  assert.deepEqual(kinds(recs).slice(-3), ["attempt", "result", "post-check"]);
  const post = of(recs, "post-check")[0];
  assert.equal(post.eligible, true);
  assert.equal(post.sameState, true);
  const attempt = of(recs, "attempt")[0];
  assert.equal(attempt.snapshot, capture.snapshot.sha256, "the captured snapshot is what is sent");
  // The prompt is the captured body; no decision record exists to leak.
  assert.ok(h.spawns[0].prompt.includes("Will the operator send this phase attempt back"));
  assert.ok(!h.spawns[0].prompt.includes("GD-"));

  // Pending: the report shows a count, and nothing about the prediction.
  let r = await report(h);
  assert.equal(r.pending.total, 1);
  assert.equal(r.models.length, 0);
  assert.equal(r.deterministic[0].scored, 0);
  assert.ok(!JSON.stringify(r).includes(attempt.assessmentId));
  assert.ok(!JSON.stringify(r).includes('"p":0.8'));
  assert.ok(!JSON.stringify(h.watcher.status()).includes("answered"));

  h.world.act("inst-1", "approve");
  await h.tick();
  recs = await h.records();
  const settle = of(recs, "settle")[0];
  assert.equal(settle.outcome, "labeled");
  assert.equal(settle.reference!.label, "not-sent-back");
  assert.equal(settle.reference!.value, "approve");
  assert.deepEqual(settle.reference!.principal, { kind: "session", username: "ops", role: "root" });

  r = await report(h);
  assert.equal(r.pending.total, 0);
  const m = model(r)!;
  assert.equal(m.agreement.scored, 1);
  // p = 0.8 predicts sent back; the operator approved: a false escalation.
  assert.deepEqual(m.agreement.falseEscalation.k, 1);
  assert.deepEqual(m.agreement.falseEscalation.n, 1);
  assert.equal(m.agreement.agreementAnswered.k, 0);
  assert.equal(m.provider.reportedModel, null);
  assert.equal(r.census[0].labeled.notSentBack, 1);
  assert.equal(r.census[0].principals.session, 1);
  assert.equal(r.deterministic[0].scored, 1);
});

test("a gate whose attempt already has a decision record is never captured", async () => {
  const h = h1Harness();
  h.world.put(gateInstance());
  h.world.record("inst-1", "approve"); // written, not yet linked
  await h.tick();
  const recs = await h.records();
  assert.equal(of(recs, "capture").length, 0);
  assert.deepEqual(
    of(recs, "gate").map((g) => g.reason),
    ["prior-decision-record"],
  );
});

test("needs-input and pauses of unknown cause are excluded, and recorded as such", async () => {
  const h = h1Harness();
  h.world.put(gateInstance({ id: "inst-q", phase: { pause: "needs-input" } }));
  h.world.put(gateInstance({ id: "inst-u", phase: { pause: undefined } }));
  await h.tick();
  const recs = await h.records();
  assert.equal(of(recs, "capture").length, 0);
  assert.deepEqual(
    of(recs, "gate")
      .map((g) => `${g.instanceId}:${g.reason}`)
      .sort(),
    ["inst-q:needs-input", "inst-u:unknown-pause"],
  );
  const r = await report(h);
  assert.deepEqual(r.gates.excluded, { "needs-input": 1, "unknown-pause": 1 });
});

test("a decision recorded while the capture is being built makes it capture-raced", async () => {
  const world = gateWorld();
  const h = h1Harness({ world });
  world.put(gateInstance());
  let once = true;
  world.hooks.afterProject = () => {
    if (once) world.record("inst-1", "revise");
    once = false;
  };
  await h.tick();
  const recs = await h.records();
  assert.equal(of(recs, "capture").length, 0);
  assert.deepEqual(
    of(recs, "gate").map((g) => g.reason),
    ["capture-raced"],
  );
});

test("an action before any call slot: nothing is spent, the baselines are still scored", async () => {
  const h = h1Harness();
  h.world.put(gateInstance());
  await h.tick(); // capture; the call is deferred
  h.world.act("inst-1", "revise");
  await h.tick();
  assert.equal(h.spawns.length, 0);
  const r = await report(h);
  assert.equal(r.models.length, 0);
  assert.equal(r.census[0].labeled.sentBack, 1);
  assert.deepEqual(r.census[0].notCalled, { "no-call-before-action": 1 });
  assert.equal(r.deterministic[0].scored, 1);
  assert.equal(r.verdict[0].scored, 1);
  assert.deepEqual(r.verdict[0].agreement.confusion.counts[0], [0, 0, 1, 0, 0]); // not-configured
});

test("an action during the call excludes the prediction from prospective scoring, and keeps it counted", async () => {
  const world = gateWorld();
  const h = h1Harness({ world, duringCall: () => world.act("inst-1", "abort") });
  world.put(gateInstance());
  await h.tick();
  await h.tick(); // the call; the operator aborts inside it
  let recs = await h.records();
  const post = of(recs, "post-check")[0];
  assert.equal(post.eligible, false);
  await h.tick();
  recs = await h.records();
  assert.equal(of(recs, "settle")[0].reference!.label, "sent-back");
  const r = await report(h);
  const m = model(r)!;
  assert.equal(m.assessed, 1);
  assert.equal(m.agreement.scored, 0);
  assert.deepEqual(m.excluded, { "action-during-call": 1 });
  assert.equal(r.deterministic[0].scored, 1, "the capture preceded the action, so baselines stand");
});

test("a prediction that precedes the action is scored; a later revision is a new item", async () => {
  const h = h1Harness({ answer: () => JSON.stringify({ p: 0.9 }) });
  h.world.put(gateInstance());
  await h.tick();
  await h.tick(); // call, post-check eligible
  h.world.act("inst-1", "revise");
  await h.tick(); // settle
  const r = await report(h);
  const m = model(r)!;
  assert.equal(m.agreement.scored, 1);
  assert.equal(m.agreement.agreementAnswered.k, 1);
  assert.equal(m.agreement.falseClose.n, 1);
  assert.equal(m.agreement.falseClose.k, 0);
  // The revised attempt pauses again: attempt 1 is its own item.
  const inst = h.world.instances.get("inst-1")!;
  inst.phases[0].status = "awaiting-approval";
  inst.phases[0].pause = "gate";
  inst.phases[0].steps = inst.phases[0].steps.map((s) => ({ ...s, status: "succeeded" }));
  inst.status = "awaiting-approval";
  h.world.put({ ...inst });
  await h.tick();
  const captures = of(await h.records(), "capture");
  assert.deepEqual(
    captures.map((c) => c.itemKey),
    ["inst-1|publish#0|gate.operator-action@1", "inst-1|publish#1|gate.operator-action@1"],
  );
  assert.deepEqual(captures[1].deterministic.fired, ["later-attempt"]);
});

test("a review state that changes during the pause is never compared with the action", async () => {
  const h = h1Harness();
  h.world.put(gateInstance());
  await h.tick(); // capture
  h.world.runs.get("run-a")!.resultSummary = "Rewrote NOTES.md after all.";
  await h.tick(); // the observation sees the change first: the item is never called
  assert.equal(h.spawns.length, 0);
  const recs = await h.records();
  assert.equal(of(recs, "drift").length, 1);
  h.world.act("inst-1", "approve");
  await h.tick();
  const r = await report(h);
  assert.deepEqual(r.census[0].state, { held: 0, changed: 1, unobserved: 0 });
  assert.deepEqual(r.census[0].notCalled, { "state-changed-before-call": 1 });
  assert.equal(r.deterministic[0].scored, 0);
  assert.equal(r.verdict[0].scored, 0);
});

test("cost backfill and Watchtower movement are context, not a change of review state", async () => {
  const h = h1Harness();
  h.world.put(gateInstance());
  await h.tick();
  h.world.runs.get("run-a")!.costUsd = 0.5;
  h.world.runs.get("run-a")!.tokens = 90_000;
  await h.tick();
  assert.equal(h.spawns.length, 1);
  assert.equal(of(await h.records(), "drift").length, 0);
});

test("uncertain effects: an incomplete decision is waited for; an orphaned record beside an applied one does not block the label", async () => {
  const h = h1Harness();
  h.world.put(gateInstance());
  await h.tick();
  const orphan = h.world.record("inst-1", "approve"); // crashed before its link
  const d = h.world.record("inst-1", "revise");
  h.world.link(d, true); // linked, effects under way
  h.world.instances.get("inst-1")!.phases[0].status = "running"; // the gate has moved
  await h.tick();
  assert.equal(of(await h.records(), "settle").length, 0, "incomplete is waited for");
  h.world.complete(d);
  await h.tick();
  const s = of(await h.records(), "settle")[0];
  assert.equal(s.outcome, "labeled");
  assert.equal(s.reference!.value, "revise");
  assert.deepEqual(s.reference!.others, [
    { id: orphan.id, decision: "approve", mechanism: "operator", effect: "not-applied" },
  ]);
});

test("an incomplete decision that never completes settles unlabeled, never as a negative", async () => {
  const h = h1Harness();
  h.world.put(gateInstance());
  await h.tick();
  const d = h.world.record("inst-1", "approve");
  h.world.link(d, true);
  h.world.instances.get("inst-1")!.phases[0].status = "succeeded";
  await h.tick();
  await h.tick(61 * MIN);
  const s = of(await h.records(), "settle")[0];
  assert.equal(s.outcome, "unlabeled");
  assert.equal(s.reason, "effect-incomplete");
  const r = await report(h);
  assert.deepEqual(r.census[0].unlabeled, { "effect-incomplete": 1 });
  assert.equal(r.census[0].labeled.notSentBack + r.census[0].labeled.sentBack, 0);
});

test("automated and unattributed decisions are never operator-action references", async () => {
  const h = h1Harness();
  h.world.put(gateInstance({ id: "inst-a", phaseDef: { autoApprove: { verdict: 7 } } as never }));
  h.world.put(gateInstance({ id: "inst-b" }));
  await h.tick();
  h.world.act("inst-a", "approve", {
    mechanism: "verdict-auto-approve",
    channel: "verdict-watcher",
    principal: { kind: "system", component: "verdict-watcher" },
  });
  h.world.act("inst-b", "approve", {
    mechanism: "unspecified",
    channel: "in-process",
    principal: { kind: "unknown" },
  });
  await h.tick();
  const r = await report(h);
  const auto = r.census.find((c) => c.population === "auto-approve-declared")!;
  const manual = r.census.find((c) => c.population === "manual")!;
  assert.deepEqual(auto.unlabeled, { "automated-approval": 1 });
  assert.deepEqual(manual.unlabeled, { unattributed: 1 });
  assert.equal(
    r.deterministic.every((d) => d.scored === 0),
    true,
  );
});

test("a best-of-N gate is judged on the selected candidate's run only", async () => {
  const h = h1Harness();
  h.world.put(
    gateInstance({
      runIds: [],
      phase: {
        selectedCandidate: 1,
        steps: [
          { name: "ship", runId: "run-c0", status: "aborted", candidate: 0 },
          { name: "ship", runId: "run-c1", status: "succeeded", candidate: 1 },
        ],
      },
    }),
  );
  h.world.runs.set("run-c1", { ...h.world.runs.get("run-c1")!, resultSummary: "winner" });
  await h.tick();
  const c = of(await h.records(), "capture")[0];
  assert.deepEqual(c.relevantRuns, ["run-c1"]);
  const snap = await h.snapshots.load(c.snapshot.sha256);
  assert.equal(snap.status, "retained");
  const body = (snap as { snapshot: { content: { body: { steps: Array<{ runId: string }> } } } })
    .snapshot.content.body;
  assert.deepEqual(
    body.steps.map((s) => s.runId),
    ["run-c1"],
  );
});

test("the report reads no live record: pruning the instance, runs and gate log changes nothing", async () => {
  const h = h1Harness();
  h.world.put(gateInstance());
  await h.tick();
  await h.tick();
  h.world.act("inst-1", "approve");
  await h.tick();
  const before = JSON.stringify(await report(h));
  h.world.instances.clear();
  h.world.runs.clear();
  h.world.decisions.length = 0;
  await h.boot().journal.archive();
  const after = JSON.stringify(await report(h));
  assert.equal(after, before);
  assert.ok(readdirSync(path.join(h.root, "h1", "snapshots")).length > 0);
});

test("a change between the observation and the call is caught by the pre-call re-check", async () => {
  const world = gateWorld();
  const h = h1Harness({ world });
  world.put(gateInstance());
  await h.tick(); // capture
  // The observation in the next check sees the captured state; the change
  // lands after it and before the call's re-check.
  let reviews = 0;
  world.hooks.review = (inst, phaseId) => {
    reviews++;
    if (reviews === 2) world.runs.get("run-a")!.resultSummary = "changed mid-check";
    return reviewOf(inst, phaseId);
  };
  await h.tick();
  assert.equal(h.spawns.length, 0);
  const recs = await h.records();
  assert.deepEqual(
    of(recs, "precheck").map((p) => p.reason),
    ["state-changed"],
  );
  assert.equal(of(recs, "drift").length, 1);
});

test("unknown shared cost contains later calls only within the rolling window", async () => {
  const unknownAt = Date.parse("2026-09-01T12:00:00.000Z");
  const h = h1Harness({ otherSpend: async () => [{ atMs: unknownAt, costUsd: null }] });
  h.world.put(gateInstance());
  await h.tick();
  const blocked = await h.tick(31 * MIN);
  assert.equal(blocked.action === "done" && blocked.call.kind, "limited");
  assert.match(
    blocked.action === "done" && blocked.call.kind === "limited" ? blocked.call.detail : "",
    /unknown cost/,
  );
  assert.equal(h.spawns.length, 0);
  await h.tick(24 * 60 * MIN);
  h.world.put(gateInstance({ id: "fresh" }));
  await h.tick();
  assert.equal(h.spawns.length, 1);
});

test("unknown own cost stops another pending item while pre-call refusal does not", async () => {
  for (const preCall of [false, true]) {
    const h = h1Harness({ costUsd: null });
    h.world.put(gateInstance());
    await h.tick();
    h.state.blocked = preCall;
    await h.tick();
    h.state.blocked = false;
    h.world.put(gateInstance({ id: "next" }));
    for (let i = 0; i < 4; i++) await h.tick(31 * MIN);
    assert.equal(h.spawns.length, 1);
    if (!preCall) {
      const result = await h.tick(31 * MIN);
      assert.equal(result.action === "done" && result.call.kind, "limited");
    }
  }
});

test("invalid historical shared costs cannot reduce the rolling spend bound", async () => {
  for (const costUsd of [-1, NaN, Infinity, -Infinity]) {
    const h = h1Harness({
      otherSpend: async () => [{ atMs: Date.parse("2026-09-01T12:00:00.000Z"), costUsd }],
    });
    h.world.put(gateInstance());
    await h.tick();
    const result = await h.tick(31 * MIN);
    assert.equal(result.action === "done" && result.call.kind, "limited");
    assert.match(
      result.action === "done" && result.call.kind === "limited" ? result.call.detail : "",
      /unknown cost/,
    );
    assert.equal(h.spawns.length, 0);
  }
});
