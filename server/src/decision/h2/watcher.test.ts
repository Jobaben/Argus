import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DecisionQuestion } from "@argus/contracts";
import { DEFAULT_ANALYSIS_MODEL } from "../../sources/analysis.js";
import { builtinRegistry, TERMINATION_PROBE_V1 } from "../definitions.js";
import type { AttemptRecord, CensusRecord, LedgerRecord, ResultRecord } from "./ledger.js";
import { endedRun, h2Harness, MIN, ON, START } from "./testSupport.js";
import { classifyServiceResult, fromAssessment } from "./watcher.js";

/**
 * The H2 collection watcher (RFC §P.1–§P.5), exercised over real stores with
 * only the process spawn injected. `spawns` counts what would have reached a
 * model: every assertion about "no call" is an assertion on it.
 */

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ["ARGUS_ANALYSIS_MODEL", "ARGUS_ANALYSIS_RUNTIME", "ARGUS_ANALYSIS"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Both switches on, one question at full rate and the other off, unless overridden. */
const env = (over: Record<string, string> = {}) => ({
  ...ON,
  ARGUS_DECISIONS_H2_RESIDUAL_RATE: "1",
  ARGUS_DECISIONS_H2_PROBE_RATE: "0",
  ...over,
});

const of = <K extends LedgerRecord["kind"]>(rs: LedgerRecord[], kind: K) =>
  rs.filter((r) => r.kind === kind) as Extract<LedgerRecord, { kind: K }>[];

/** First check (records the start, defers), then step past the settle time. */
async function warm(h: ReturnType<typeof h2Harness>) {
  const first = await h.watcher.check();
  assert.equal(first.action, "deferred");
  h.clock.advance(11 * MIN);
}

test("collection is off by default: no read, no write, no provider call", async () => {
  for (const e of [
    {},
    { ARGUS_DECISIONS: "on" },
    { ARGUS_DECISIONS_H2_COLLECT: "on" },
    { ARGUS_DECISIONS: "off", ARGUS_DECISIONS_H2_COLLECT: "on" },
    { ...ON, ARGUS_ANALYSIS: "off" },
    { ...ON, ARGUS_DECISIONS_H2_PROBE_RATE: "5" },
  ]) {
    const h = h2Harness({ env: e });
    for (let i = 0; i < 6; i++) {
      assert.equal((await h.watcher.check()).action, "inactive", JSON.stringify(e));
      h.clock.advance(20 * MIN);
    }
    assert.equal(h.spawns.length, 0);
    assert.equal(h.state.runReads, 0, "not even the runs are read");
    assert.equal(existsSync(path.join(h.root, "h2")), false, "no ledger directory");
    assert.equal(existsSync(path.join(h.root, "decisions")), false, "no journal directory");
    assert.equal(h.watcher.status().state, "inactive");
  }
});

test("the first enabled check records the start and defers; runs that ended before it are never considered", async () => {
  const h = h2Harness({
    env: env({ ARGUS_DECISIONS_H2_PROBE_RATE: "1" }),
    runs: [endedRun("old", -30 * MIN), endedRun("new", MIN)],
  });
  await warm(h);
  for (let i = 0; i < 8; i++) {
    await h.watcher.check();
    h.clock.advance(16 * MIN);
  }
  const rs = await h.records();
  assert.equal(rs[0].kind, "start");
  assert.equal(rs[0].at, new Date(START).toISOString());
  const census = of(rs, "census");
  assert.deepEqual([...new Set(census.map((c) => c.runId))], ["new"], "history is not drained");
  assert.ok(h.spawns.length > 0);
  for (const a of of(rs, "attempt")) assert.equal(a.runId, "new");
});

test("at most one provider invocation per check, oldest first, spaced by the minimum interval", async () => {
  const h = h2Harness({
    env: env({ ARGUS_DECISIONS_H2_PROBE_RATE: "1" }),
    runs: [endedRun("b", 2 * MIN), endedRun("a", MIN)],
  });
  await warm(h);
  const r1 = await h.watcher.check();
  assert.equal(r1.action, "attempted");
  assert.equal(h.spawns.length, 1, "both questions were eligible; one call");
  assert.equal((await h.watcher.check()).action, "limited", "the interval has not passed");
  h.clock.advance(14 * MIN);
  assert.equal((await h.watcher.check()).action, "limited");
  h.clock.advance(MIN);
  assert.equal((await h.watcher.check()).action, "attempted");
  assert.equal(h.spawns.length, 2);
  const attempts = of(await h.records(), "attempt");
  // Oldest run first; within a run, question id order (residual before probe).
  assert.deepEqual(
    attempts.map((a) => `${a.runId}:${a.question.id}`),
    ["a:run.failure-cause.residual", "a:run.termination-probe"],
  );
});

test("another analysis pass since the last check, or one in flight, defers the shadow call", async () => {
  const h = h2Harness({ env: env(), hold: true });
  await warm(h);
  // Autopsy (or anything else) starts a pass through the same runner.
  const autopsy = h.runner.run({ kind: "autopsy", prompt: "x", cwd: h.root }, (v) => v);
  await h.spawned(1);
  let r = await h.watcher.check();
  assert.deepEqual(r, {
    action: "deferred",
    detail: "another analysis pass ran since the last check",
  });
  r = await h.watcher.check();
  assert.deepEqual(r, { action: "deferred", detail: "an analysis pass is in flight" });
  h.release();
  await autopsy;
  assert.equal(h.spawns.length, 1, "only the autopsy pass spawned");
  const p = h.watcher.check();
  await h.spawned(2);
  h.release();
  assert.equal((await p).action, "attempted");
  assert.equal(h.spawns.length, 2);
  assert.equal(h.spawns[1].prompt.includes("QUESTION"), true);
});

test("the spend hard stop pauses collection without a call", async () => {
  const h = h2Harness({ env: env() });
  await warm(h);
  h.state.blocked = true;
  const r = await h.watcher.check();
  assert.equal(r.action, "paused");
  h.clock.advance(5 * MIN);
  assert.equal((await h.watcher.check()).action, "paused");
  h.clock.advance(11 * MIN);
  assert.equal((await h.watcher.check()).action, "paused", "still blocked: paused again");
  assert.equal(h.spawns.length, 0);
  assert.equal(of(await h.records(), "attempt").length, 0, "a pre-check refusal writes no attempt");
  h.state.blocked = false;
  h.clock.advance(16 * MIN);
  assert.equal((await h.watcher.check()).action, "attempted");
  assert.equal(h.spawns.length, 1);
});

test("a refusal inside the runner is not a call: retried at most three times, 30 minutes apart, then abandoned", async () => {
  const h = h2Harness({ env: env() });
  await warm(h);
  h.state.enabled = false; // the runner's own switch refuses before any spawn
  const seen: string[] = [];
  for (let i = 0; i < 20; i++) {
    const r = await h.watcher.check();
    seen.push(r.action === "attempted" ? `attempted:${r.class}` : r.action);
    h.clock.advance(10 * MIN);
  }
  assert.equal(h.spawns.length, 0);
  const rs = await h.records();
  const results = of(rs, "result");
  assert.equal(results.length, 3);
  assert.equal((await h.journal.read()).entries.length, 0, "proven refusals append no assessment");
  for (const res of results) {
    assert.equal(res.class, "refused");
    assert.equal(res.providerCalled, "no");
    assert.equal(res.code, "disabled");
  }
  const tries = of(rs, "attempt").map((a) => Date.parse(a.at));
  assert.deepEqual(
    of(rs, "attempt").map((a) => a.try),
    [1, 2, 3],
  );
  for (let i = 1; i < tries.length; i++) assert.ok(tries[i] - tries[i - 1] >= 30 * MIN);
  assert.equal(seen.filter((s) => s.startsWith("attempted")).length, 3);
});

test("a started call's guard failure name cannot release spend, while typed service refusal can", async () => {
  const h = h2Harness();
  const result = await h.service.assess({
    question: "run.failure-cause.residual",
    subject: { kind: "run", runId: "run-1" },
    provider: "claude-cli",
  });
  assert.ok(result.ok);
  assert.equal(h.spawns.length, 1);
  for (const failure of ["disabled", "busy", "budget-blocked", "aborted", "unsafe-cwd"]) {
    const assessment = {
      ...result.assessment,
      costUsd: null,
      outcome: { status: "failed" as const, failure, detail: "started call" },
    };
    const classified = fromAssessment(assessment);
    assert.equal(classified.class, "provider-failed", failure);
    assert.equal(classified.providerCalled, "yes", failure);
    assert.equal(classified.costUsd, null);
    const refusal = classifyServiceResult({
      ok: false,
      reason: failure as "disabled",
      detail: "guard",
      providerCalled: false,
    });
    assert.equal(refusal.class, "refused", failure);
    assert.equal(refusal.providerCalled, "no", failure);
  }
});

test("missing input is not a call, and is retried within the same bound", async () => {
  const h = h2Harness({ env: env(), transcripts: { "run-1": null } });
  await warm(h);
  for (let i = 0; i < 12; i++) {
    await h.watcher.check();
    h.clock.advance(31 * MIN);
  }
  assert.equal(h.spawns.length, 0);
  const results = of(await h.records(), "result");
  assert.deepEqual(
    results.map((r) => [r.class, r.providerCalled]),
    [
      ["missing-input", "no"],
      ["missing-input", "no"],
      ["missing-input", "no"],
    ],
  );
});

test("the daily call limit bounds invocations, and a backlog expires rather than drains", async () => {
  const runs = Array.from({ length: 30 }, (_, i) =>
    endedRun(`r${String(i).padStart(2, "0")}`, MIN),
  );
  const h = h2Harness({ env: env(), runs });
  await warm(h);
  for (let i = 0; i < 4 * 30; i++) {
    await h.watcher.check();
    h.clock.advance(15 * MIN);
  }
  assert.equal(h.spawns.length, 20, "twenty in the first 24 hours, then the window closed");
  const rs = await h.records();
  assert.equal(of(rs, "expired").length, 10);
  for (const e of of(rs, "expired")) assert.equal(e.reason, "window-closed");
});

test("the dollar cap stops invocations once recorded cost reaches it", async () => {
  const runs = Array.from({ length: 6 }, (_, i) => endedRun(`r${i}`, MIN));
  const h = h2Harness({ env: env(), runs, costUsd: 0.4 });
  await warm(h);
  for (let i = 0; i < 20; i++) {
    await h.watcher.check();
    h.clock.advance(16 * MIN);
  }
  assert.equal(
    h.spawns.length,
    3,
    "0.4 + 0.4 + 0.4 ≥ 1.00: the third call passes the cap by one call",
  );
});

test("a crash after the intent line is an unknown outcome on restart, never a silent repeat", async () => {
  let crash = true;
  const h = h2Harness({
    env: env(),
    fault: (point) => {
      if (crash && point === "attempt-written") throw new Error("power cut");
    },
  });
  await warm(h);
  assert.equal((await h.watcher.check()).action, "error");
  assert.equal(h.spawns.length, 0);
  crash = false;
  const restarted = h.boot();
  for (let i = 0; i < 10; i++) {
    await restarted.watcher.check();
    h.clock.advance(31 * MIN);
  }
  assert.equal(h.spawns.length, 0, "the item is never re-sent");
  const rs = await h.records();
  const [res] = of(rs, "result");
  assert.equal(res.class, "unknown-outcome");
  assert.equal(res.providerCalled, "unknown");
  assert.equal(res.reconciled, true);
  assert.equal(of(rs, "attempt").length, 1);
});

test("a crash after the call and before the result is reconciled from the journal", async () => {
  let crash = true;
  const h = h2Harness({
    env: env(),
    fault: (point) => {
      if (crash && point === "assessed") throw new Error("killed");
    },
  });
  await warm(h);
  await h.watcher.check();
  assert.equal(h.spawns.length, 1);
  crash = false;
  const restarted = h.boot();
  for (let i = 0; i < 6; i++) {
    await restarted.watcher.check();
    h.clock.advance(31 * MIN);
  }
  assert.equal(h.spawns.length, 1);
  const rs = await h.records();
  const [attempt] = of(rs, "attempt");
  const [res] = of(rs, "result");
  assert.equal(res.class, "answered");
  assert.equal(res.reconciled, true);
  assert.equal(res.assessmentId, attempt.assessmentId);
  const journal = await restarted.journal.read();
  assert.deepEqual(
    journal.entries.map((e) => e.assessment.id),
    [attempt.assessmentId],
  );
});

test("restarts and journal archival never reopen an assessed item", async () => {
  const h = h2Harness({ env: env({ ARGUS_DECISIONS_H2_PROBE_RATE: "1" }) });
  await warm(h);
  for (let i = 0; i < 3; i++) {
    await h.watcher.check();
    h.clock.advance(16 * MIN);
  }
  assert.equal(h.spawns.length, 2);
  const before = (await h.journal.read()).entries.length;
  const archived = await h.journal.archive();
  assert.ok(archived.segments.length > 0, "the segment holding both assessments was archived");
  for (let n = 0; n < 3; n++) {
    const b = h.boot();
    for (let i = 0; i < 4; i++) {
      await b.watcher.check();
      h.clock.advance(16 * MIN);
    }
  }
  assert.equal(h.spawns.length, 2);
  assert.equal((await h.journal.read()).entries.length, before);
});

test("changing the requested model does not re-assess another identity's items", async () => {
  const h = h2Harness({ env: env(), runs: [endedRun("run-1", MIN)] });
  await warm(h);
  await h.watcher.check();
  assert.equal(h.spawns.length, 1);
  assert.equal(h.spawns[0].model, DEFAULT_ANALYSIS_MODEL, "the runner's default: haiku");
  // The operator sets an explicit model and restarts; a new run arrives.
  const h2 = h2Harness({
    env: env(),
    root: h.root,
    model: "sonnet",
    runs: [endedRun("run-1", MIN), endedRun("run-2", 40 * MIN)],
  });
  h2.clock.set(h.clock.now().getTime() + 30 * MIN);
  for (let i = 0; i < 6; i++) {
    await h2.watcher.check();
    h2.clock.advance(16 * MIN);
  }
  assert.equal(h2.spawns.length, 1);
  assert.equal(h2.spawns[0].model, "sonnet");
  const rs = await h2.records();
  const attempts = of(rs, "attempt");
  assert.deepEqual(
    attempts.map((a) => [a.runId, a.provider.requestedModel]),
    [
      ["run-1", "haiku"],
      ["run-2", "sonnet"],
    ],
  );
  assert.equal(of(rs, "config").length, 2, "the new identity is a new config");
  const assessments = (await h2.journal.read()).entries.map((e) => e.assessment.provider);
  assert.deepEqual(
    assessments.map((p) => [p.provider, p.requestedModel, p.reportedModel, p.elicitation]),
    [
      ["claude-cli", "haiku", null, "verbalized"],
      ["claude-cli", "sonnet", null, "verbalized"],
    ],
  );
});

test("overlapping checks: the second returns at once and makes no call", async () => {
  const h = h2Harness({ env: env(), hold: true });
  await warm(h);
  const first = h.watcher.check();
  await h.spawned(1);
  const second = await h.watcher.check();
  assert.deepEqual(second, { action: "overlap" });
  h.release();
  assert.equal((await first).action, "attempted");
  assert.equal(h.spawns.length, 1);
});

test("a damaged ledger halts collection: deduplication can no longer be trusted", async () => {
  for (const damage of ["corrupt", "lost-line"] as const) {
    const h = h2Harness({ env: env({ ARGUS_DECISIONS_H2_PROBE_RATE: "1" }) });
    await warm(h);
    await h.watcher.check();
    assert.equal(h.spawns.length, 1);
    const lines = readFileSync(h.ledgerFile, "utf8").split("\n");
    if (damage === "corrupt") lines[2] = lines[2].replace(/"at":"/, '"at":"X');
    else lines.splice(2, 1);
    writeFileSync(h.ledgerFile, lines.join("\n"));
    const b = h.boot();
    h.clock.advance(16 * MIN);
    const r = await b.watcher.check();
    assert.equal(r.action, "halted", damage);
    assert.match((r as { detail: string }).detail, /damaged/);
    assert.equal(h.spawns.length, 1);
  }
});

test("a torn final line is fenced and collection continues", async () => {
  const h = h2Harness({ env: env({ ARGUS_DECISIONS_H2_PROBE_RATE: "1" }) });
  await warm(h);
  await h.watcher.check();
  appendFileSync(h.ledgerFile, '{"body":{"seq":');
  const b = h.boot();
  h.clock.advance(16 * MIN);
  assert.equal((await b.watcher.check()).action, "deferred", "a restarted process defers once");
  assert.equal((await b.watcher.check()).action, "attempted");
  const view = await b.ledger.read();
  assert.deepEqual(
    view.notices.map((n) => n.kind),
    ["recovered-torn-write"],
  );
});

test("journal storage refused before the call is a refusal, and pauses an hour", async () => {
  const h = h2Harness({
    env: env(),
    journalLimits: { activeMaxBytes: 2000, snapshotMaxBytes: 1000 },
  });
  await warm(h);
  const r = await h.watcher.check();
  assert.equal(r.action, "attempted");
  const [res] = of(await h.records(), "result");
  assert.equal(res.class, "refused");
  assert.equal(res.code, "storage-refused");
  assert.equal(h.spawns.length, 0);
  h.clock.advance(59 * MIN);
  assert.equal((await h.watcher.check()).action, "paused");
});

test("a full collection ledger stops collection and writes nothing more", async () => {
  const h = h2Harness({ env: env(), maxLedgerBytes: 3000 });
  await warm(h);
  // The census fits; the intent line would not, so it is refused whole.
  const r = await h.watcher.check();
  assert.equal(r.action, "error");
  assert.match((r as { detail: string }).detail, /ledger-full/);
  assert.equal(h.watcher.status().state, "halted");
  const size = readFileSync(h.ledgerFile).length;
  assert.ok(size <= 3000);
  for (let i = 0; i < 5; i++) {
    h.clock.advance(31 * MIN);
    assert.equal((await h.watcher.check()).action, "error");
  }
  assert.equal(readFileSync(h.ledgerFile).length, size, "nothing more was written");
  assert.equal(of(await h.records(), "attempt").length, 0, "no intent line, so no call");
  assert.equal(h.spawns.length, 0);
});

test("with no invocations allowed, selected items expire at 24 hours and nothing is called", async () => {
  const h = h2Harness({ env: env({ ARGUS_DECISIONS_H2_MAX_CALLS_PER_DAY: "0" }) });
  await warm(h);
  for (let i = 0; i < 30; i++) {
    await h.watcher.check();
    h.clock.advance(60 * MIN);
  }
  assert.equal(h.spawns.length, 0);
  const [e] = of(await h.records(), "expired");
  assert.equal(e.runId, "run-1");
});

test("eligibility and exclusions are recorded in the census, with the observed stratum", async () => {
  const runs = [
    endedRun("failed-exit", MIN),
    endedRun("timed-out", MIN, { termination: "timed-out", exitCode: null }),
    endedRun("stalled", MIN, { termination: "stalled", exitCode: null }),
    endedRun("succeeded", MIN, { status: "succeeded", exitCode: 0, error: null }),
    endedRun("signal-failed", MIN, {
      status: "succeeded",
      exitCode: 0,
      error: null,
      outcome: "failed",
    }),
    endedRun("spawn-failed", MIN, {
      termination: "spawn-failed",
      startedAt: null,
      sessionId: null,
    }),
    endedRun("interrupted", MIN, { status: "interrupted" }),
    endedRun("killed", MIN, { termination: "killed", status: "cancelled" }),
    endedRun("skipped", MIN, { status: "skipped", startedAt: null }),
    endedRun("codex", MIN, { runtime: "codex" }),
  ];
  const h = h2Harness({ env: env({ ARGUS_DECISIONS_H2_PROBE_RATE: "1" }), runs });
  await warm(h);
  await h.watcher.check();
  const census = of(await h.records(), "census");
  const row = (run: string, q: string) =>
    census.find((c) => c.runId === run && c.question.id === q)!;
  const R = "run.failure-cause.residual";
  const P = "run.termination-probe";
  const got = (run: string) => ({
    residual: [row(run, R).verdict, row(run, R).reason],
    probe: [row(run, P).verdict, row(run, P).reason],
    stratum: row(run, R).stratum,
  });
  assert.deepEqual(got("failed-exit"), {
    residual: ["selected", null],
    probe: ["selected", null],
    stratum: "ended-normally",
  });
  assert.deepEqual(got("timed-out"), {
    residual: ["selected", null],
    probe: ["selected", null],
    stratum: "deadline",
  });
  assert.deepEqual(got("stalled").stratum, "deadline");
  assert.deepEqual(
    got("succeeded").residual,
    ["excluded", "successful"],
    "never ask why a success failed",
  );
  assert.deepEqual(got("succeeded").probe, ["selected", null]);
  assert.deepEqual(
    got("signal-failed").residual,
    ["selected", null],
    "outcome failed is unsuccessful",
  );
  assert.deepEqual(
    got("spawn-failed").residual,
    ["excluded", "never-ran"],
    "nothing ran to explain",
  );
  assert.deepEqual(got("spawn-failed").probe, ["selected", null]);
  assert.deepEqual(got("interrupted"), {
    residual: ["excluded", "termination-not-derivable:interrupted"],
    probe: ["excluded", "termination-not-derivable:interrupted"],
    stratum: "not-derivable",
  });
  assert.deepEqual(got("killed").probe, ["excluded", "termination-not-derivable:killed"]);
  assert.deepEqual(got("skipped").probe, ["excluded", "termination-not-derivable:skipped"]);
  assert.deepEqual(got("codex").residual, ["excluded", "runtime-not-claude"]);
  assert.deepEqual(got("codex").probe, ["excluded", "runtime-not-claude"]);
});

test("a run first seen after its window closed is censused as missed, not assessed", async () => {
  const h = h2Harness({ env: env({ ARGUS_DECISIONS_H2_PROBE_RATE: "1" }), runs: [] });
  await h.watcher.check();
  h.mem.runs.set("late", endedRun("late", MIN));
  h.clock.advance(25 * 60 * MIN);
  await h.watcher.check();
  await h.watcher.check();
  const census = of(await h.records(), "census");
  assert.deepEqual(
    census.map((c) => [c.verdict, c.reason]),
    [
      ["excluded", "missed-window"],
      ["excluded", "missed-window"],
    ],
  );
  assert.equal(h.spawns.length, 0);
});

test("sampling is deterministic and label-blind: the same runs give the same census under a fresh ledger", async () => {
  const runs = Array.from({ length: 200 }, (_, i) =>
    endedRun(`run-${i}`, MIN, i % 2 ? { termination: "timed-out" } : {}),
  );
  const censusOf = async () => {
    const h = h2Harness({ env: { ...ON }, runs });
    await warm(h);
    await h.watcher.check();
    return of(await h.records(), "census");
  };
  const a = await censusOf();
  const b = await censusOf();
  const key = (c: CensusRecord) => `${c.runId}|${c.question.id}|${c.verdict}`;
  assert.deepEqual(a.map(key), b.map(key));
  const rate = (q: string) =>
    a.filter((c) => c.question.id === q && c.verdict === "selected").length / 200;
  const residual = rate("run.failure-cause.residual");
  const probe = rate("run.termination-probe");
  assert.ok(residual > 0.35 && residual < 0.65, `residual ${residual}`);
  assert.ok(probe > 0.03 && probe < 0.2, `probe ${probe}`);
  // Label-blind: the draw depends on the id only, so the two strata are sampled alike.
  const sel = (stratum: string) =>
    a.filter(
      (c) =>
        c.question.id === "run.termination-probe" &&
        c.stratum === stratum &&
        c.verdict === "selected",
    ).length;
  assert.ok(Math.abs(sel("deadline") - sel("ended-normally")) <= 10);
});

test("the probe's input is blind: termination fields are withheld, and the reference lives only in the ledger", async () => {
  const run = endedRun("run-1", MIN, {
    termination: "timed-out",
    exitCode: null,
    error: "timed out after 600s",
    resultSummary: null,
  });
  const h = h2Harness({
    env: env({ ARGUS_DECISIONS_H2_RESIDUAL_RATE: "0", ARGUS_DECISIONS_H2_PROBE_RATE: "1" }),
    runs: [run],
  });
  await warm(h);
  await h.watcher.check();
  assert.equal(h.spawns.length, 1);
  const prompt = h.spawns[0].prompt;
  assert.ok(prompt.includes("From this trace alone, how did this run end?"));
  const input = prompt.slice(
    prompt.indexOf("INPUT"),
    prompt.indexOf("Answer with a single JSON object"),
  );
  const body = JSON.parse(input.split("\n").find((l) => l.startsWith("{"))!);
  assert.deepEqual(Object.keys(body.run).sort(), [
    "durationMs",
    "model",
    "runtime",
    "scheduleName",
    "trigger",
  ]);
  for (const leak of [
    "timed out",
    "timed-out",
    "termination",
    "observedTermination",
    "exitCode",
    "deadline",
  ]) {
    assert.ok(!input.includes(leak), `the provider input carries "${leak}"`);
  }
  // Nothing but the prompt and the runner's own fields reaches the spawn.
  assert.deepEqual(Object.keys(h.spawns[0]).sort(), [
    "cwd",
    "maxOutputBytes",
    "model",
    "prompt",
    "runtime",
  ]);

  const [attempt] = of(await h.records(), "attempt") as AttemptRecord[];
  assert.equal(attempt.reference?.label, "deadline");
  assert.equal(attempt.reference?.stream, "observed-termination");
  assert.equal(attempt.reference?.observation.source.store, "runs");
  assert.match(attempt.reference!.observation.source.recordDigest, /^[0-9a-f]{64}$/);
  const [entry] = (await h.journal.read()).entries;
  const snap = await h.journal.loadSnapshot(entry.assessment.snapshot.sha256);
  assert.equal(snap.status, "retained");
  const bytes = JSON.stringify(snap.status === "retained" ? snap.snapshot.content : null);
  assert.equal(entry.assessment.snapshot.projection.id, "run-failure.blind");
  assert.ok(
    !bytes.includes('"deadline"') && !bytes.includes("timed"),
    "no reference label in the snapshot",
  );
  assert.equal(entry.assessment.mode, "shadow");
});

test("a label outside the probe's answer space is a construction error: excluded, counted, never asked", async () => {
  const registry = builtinRegistry();
  const narrow: DecisionQuestion = {
    ...TERMINATION_PROBE_V1,
    version: 99,
    answers: {
      shape: "choice",
      options:
        TERMINATION_PROBE_V1.answers.shape === "choice"
          ? TERMINATION_PROBE_V1.answers.options.filter((o) => o.id !== "deadline")
          : [],
      sumTolerance: 0.02,
    },
  };
  registry.registerQuestion(narrow);
  const h = h2Harness({
    env: env({ ARGUS_DECISIONS_H2_RESIDUAL_RATE: "0", ARGUS_DECISIONS_H2_PROBE_RATE: "1" }),
    runs: [endedRun("dl", MIN, { termination: "timed-out" }), endedRun("en", MIN)],
    registry,
    questions: {
      residual: { id: "run.failure-cause.residual", version: 1 },
      probe: { id: narrow.id, version: 99 },
    },
    answer: () =>
      JSON.stringify({
        p: {
          "never-ran": 0,
          "output-refused": 0,
          "rate-limited": 0,
          "permission-denied": 0,
          "ended-normally": 1,
        },
      }),
  });
  await warm(h);
  for (let i = 0; i < 4; i++) {
    await h.watcher.check();
    h.clock.advance(16 * MIN);
  }
  const rs = await h.records();
  const census = of(rs, "census").filter((c) => c.question.version === 99);
  assert.deepEqual(
    census.find((c) => c.runId === "dl")!.reason,
    "construction-error:label-outside-answer-space",
  );
  assert.equal(h.spawns.length, 1, "only the in-space item was asked");
  assert.deepEqual(
    of(rs, "attempt").map((a) => a.runId),
    ["en"],
  );
});

test("a reference that changed after the census is a construction error at attempt time, with no call", async () => {
  const h = h2Harness({
    env: env({ ARGUS_DECISIONS_H2_RESIDUAL_RATE: "0", ARGUS_DECISIONS_H2_PROBE_RATE: "1" }),
  });
  await warm(h);
  h.state.blocked = true;
  await h.watcher.check(); // census written, call paused
  const run = h.mem.runs.get("run-1")!;
  h.mem.runs.set("run-1", { ...run, status: "interrupted" });
  h.state.blocked = false;
  h.clock.advance(16 * MIN);
  const r = await h.watcher.check();
  assert.deepEqual(r.action === "attempted" && r.class, "construction-error");
  const [res] = of(await h.records(), "result") as ResultRecord[];
  assert.equal(res.providerCalled, "no");
  assert.equal(res.code, "reference-not-derivable");
  assert.equal(h.spawns.length, 0);
});

test("unknown shared cost contains later calls only within the rolling window", async () => {
  const h = h2Harness({ env: env(), otherSpend: async () => [{ atMs: START, costUsd: null }] });
  await warm(h);
  h.clock.advance(31 * MIN);
  const blocked = await h.watcher.check();
  assert.equal(blocked.action, "limited");
  assert.match(blocked.action === "limited" ? blocked.detail : "", /unknown cost/);
  assert.equal(h.spawns.length, 0);
  h.clock.advance(24 * 60 * MIN);
  h.mem.runs.set("fresh", endedRun("fresh", 24 * 60 * MIN));
  h.mem.transcripts.set("fresh", h.mem.transcripts.get("run-1")!);
  await h.watcher.check();
  assert.equal(h.spawns.length, 1);
});

test("unknown own cost stops another pending item while pre-call refusal does not", async () => {
  for (const preCall of [false, true]) {
    const h = h2Harness({
      env: env(),
      runs: [endedRun("a", MIN), endedRun("b", MIN)],
      costUsd: null,
    });
    await warm(h);
    h.state.enabled = !preCall;
    await h.watcher.check();
    h.state.enabled = true;
    for (let i = 0; i < 4; i++) {
      h.clock.advance(31 * MIN);
      await h.watcher.check();
    }
    assert.equal(h.spawns.length, 1);
    if (!preCall) {
      h.clock.advance(31 * MIN);
      const result = await h.watcher.check();
      assert.equal(result.action, "limited");
    }
  }
});

test("invalid historical shared costs cannot reduce the rolling spend bound", async () => {
  for (const costUsd of [-1, NaN, Infinity, -Infinity]) {
    const h = h2Harness({ env: env(), otherSpend: async () => [{ atMs: START, costUsd }] });
    await warm(h);
    h.clock.advance(31 * MIN);
    const result = await h.watcher.check();
    assert.equal(result.action, "limited");
    assert.match(result.action === "limited" ? result.detail : "", /unknown cost/);
    assert.equal(h.spawns.length, 0);
  }
});
