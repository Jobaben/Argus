import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { createAnalysisRunner } from "../sources/analysis.js";
import { builtinRegistry } from "./definitions.js";
import { DecisionJournal } from "./journal.js";
import { createClaudeCliProvider } from "./providers/claudeCli.js";
import { createMockProvider } from "./providers/mock.js";
import { createRegistry } from "./registry.js";
import { JOURNAL_REPORT_V1, replay } from "./replay.js";
import { layout } from "./storage.js";
import { harness, RESIDUAL_P, tempRoot } from "./testSupport.js";

/**
 * Replay is a reader: the same retained records and the same named
 * definitions give the same canonical report bytes, and no provider is
 * consulted. These tests arm a trap on every call path — the mock records
 * calls, and a Claude CLI provider sits on a runner whose spawn throws — and
 * assert both stay untouched.
 */

async function populated() {
  const mock = createMockProvider({
    script: (_q, _s, n) =>
      n % 3 === 2
        ? { abstain: "cannot tell" }
        : { distribution: { ...RESIDUAL_P, other: n % 2 ? 0.04 : 0.05 } },
  });
  let spawned = 0;
  const runner = createAnalysisRunner({
    spawn: () => {
      spawned++;
      throw new Error("replay must not spawn");
    },
    meter: async () => {},
    blocked: async () => false,
  });
  const claude = createClaudeCliProvider({ runner, cwd: tempRoot() });
  const h = harness({ providers: { mock, claude }, limits: { segmentMaxBytes: 5000 } });
  for (let i = 0; i < 6; i++) {
    const r = await h.service.assess({
      question: i % 2 ? "run.termination-probe" : "run.failure-cause.residual",
      subject: { kind: "run", runId: "run-1" },
      provider: "mock",
      sample: i,
    });
    assert.ok(r.ok);
    // A probe distribution is invalid for the residual keys and vice versa:
    // odd samples go to the probe, whose mock answer fails validation.
  }
  const first = (await h.journal.read()).entries[0].assessment;
  const re = await h.service.reEvaluate({ assessmentId: first.id, provider: "mock", sample: 1 });
  assert.ok(re.ok);
  return { h, mock, spawned: () => spawned };
}

test("replay emits identical canonical bytes across calls, fresh readers and clocks, and calls no provider", async () => {
  const { h, mock, spawned } = await populated();
  const calls = mock.calls.length;
  const a = await replay(h.journal, h.registry);
  const b = await replay(
    new DecisionJournal({ root: h.root, now: () => new Date(0) }),
    builtinRegistry(),
  );
  const c = await replay(
    new DecisionJournal({ root: h.root, now: () => new Date(8.64e15) }),
    builtinRegistry(),
    JOURNAL_REPORT_V1,
  );
  assert.equal(a, b);
  assert.equal(a, c);
  assert.ok(a.endsWith("\n"));
  assert.equal(mock.calls.length, calls, "no provider call");
  assert.equal(spawned(), 0, "no spawn");

  const report = JSON.parse(a);
  assert.equal(report.totals.assessments, 7);
  assert.equal(report.assessments[6].reEvaluates, report.assessments[0].id);
  assert.equal(report.assessments[6].reEvaluatesFound, true);
  assert.ok(report.assessments.every((x: { mode: string }) => x.mode === "shadow"));
  // Probe and residual rows are separate questions and are never pooled.
  const qs = report.questions.map((q: { question: { id: string } }) => q.question.id);
  assert.deepEqual([...new Set(qs)].sort(), [
    "run.failure-cause.residual",
    "run.termination-probe",
  ]);
  const residual = report.questions.find(
    (q: { question: { id: string } }) => q.question.id === "run.failure-cause.residual",
  );
  assert.deepEqual([residual.answered, residual.abstained, residual.failed], [3, 1, 0]);
  assert.deepEqual(residual.top, { "missing-context": 3 });
  const probe = report.questions.find(
    (q: { question: { id: string } }) => q.question.id === "run.termination-probe",
  );
  assert.equal(probe.failed + probe.abstained + probe.answered, 3);
});

test("replay does not change when segments and snapshots are archived", async () => {
  const { h } = await populated();
  const before = await replay(h.journal, h.registry);
  await h.journal.archive();
  assert.equal(await replay(h.journal, h.registry), before);
});

test("replay reports unavailable and damaged snapshots, missing definitions and gaps explicitly", async () => {
  const { h } = await populated();
  const view = await h.journal.read();
  const sha = view.entries[0].assessment.snapshot.sha256;
  rmSync(layout(h.root).snapshotPath("active", sha));
  const gone = JSON.parse(await replay(h.journal, h.registry));
  assert.ok(gone.totals.unavailableSnapshots > 0);
  const row = gone.assessments.find(
    (a: { snapshot: { sha256: string } }) => a.snapshot.sha256 === sha,
  );
  assert.deepEqual([row.snapshot.availability, row.snapshot.reEvaluable], ["unavailable", false]);

  const other = view.entries.find((e) => e.assessment.snapshot.sha256 !== sha)!.assessment.snapshot
    .sha256;
  writeFileSync(layout(h.root).snapshotPath("active", other), "{}");
  const damaged = JSON.parse(await replay(h.journal, h.registry));
  assert.ok(
    damaged.assessments.some(
      (a: { snapshot: { availability: string } }) => a.snapshot.availability === "corrupt",
    ),
  );

  const empty = JSON.parse(await replay(h.journal, createRegistry()));
  assert.ok(
    empty.assessments.every(
      (a: { question: { definition: string } }) => a.question.definition === "missing",
    ),
  );

  // A segment that vanished without a tombstone is a "missing" gap.
  await h.journal.archive();
  const archived = (await h.journal.read()).segments[0].segment;
  rmSync(layout(h.root).segmentPath("archive", archived));
  const gap = JSON.parse(await replay(h.journal, h.registry));
  assert.deepEqual(gap.gaps[0], {
    segment: archived,
    reason: "missing",
    records: null,
    firstAt: null,
    lastAt: null,
  });
});

test("replay refuses an unknown report definition rather than guessing", async () => {
  const { h } = await populated();
  await assert.rejects(
    replay(h.journal, h.registry, { id: "decision-journal-report", version: 2 }),
    /unknown report/,
  );
});
