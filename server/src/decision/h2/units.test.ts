import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createAnalysisRunner, type AnalysisSpawn } from "../../sources/analysis.js";
import { tempRoot } from "../testSupport.js";
import { countAnalysisPasses } from "./activity.js";
import { H2_DEFAULTS, h2Enablement, readH2Settings } from "./config.js";
import { CollectionLedger, LedgerError, parseLedger, type NewRecord } from "./ledger.js";
import { isSelected, sampleUnit } from "./sampling.js";

// ── Settings ────────────────────────────────────────────────────────────────

test("collection needs both switches, and ARGUS_ANALYSIS=off wins", () => {
  assert.equal(h2Enablement({}).enabled, false);
  assert.deepEqual((h2Enablement({}) as { reasons: string[] }).reasons, [
    "ARGUS_DECISIONS is not on",
    "ARGUS_DECISIONS_H2_COLLECT is not on",
  ]);
  assert.equal(h2Enablement({ ARGUS_DECISIONS: "on" }).enabled, false);
  assert.equal(
    h2Enablement({ ARGUS_DECISIONS: "true", ARGUS_DECISIONS_H2_COLLECT: "on" }).enabled,
    false,
  );
  assert.equal(
    h2Enablement({ ARGUS_DECISIONS: " ON ", ARGUS_DECISIONS_H2_COLLECT: "on" }).enabled,
    true,
  );
  const off = h2Enablement({
    ARGUS_DECISIONS: "on",
    ARGUS_DECISIONS_H2_COLLECT: "on",
    ARGUS_ANALYSIS: "off",
  });
  assert.equal(off.enabled, false);
});

test("defaults are the conservative ones the design note names", () => {
  const en = h2Enablement({ ARGUS_DECISIONS: "on", ARGUS_DECISIONS_H2_COLLECT: "on" });
  assert.ok(en.enabled);
  assert.deepEqual(en.settings, H2_DEFAULTS);
  assert.deepEqual(
    [
      H2_DEFAULTS.residualRate,
      H2_DEFAULTS.probeRate,
      H2_DEFAULTS.model,
      H2_DEFAULTS.window.minAgeMs,
      H2_DEFAULTS.window.maxAgeMs,
      H2_DEFAULTS.limits.maxCallsPer24h,
      H2_DEFAULTS.limits.minCallIntervalMs,
      H2_DEFAULTS.limits.maxUsdPer24h,
      H2_DEFAULTS.limits.maxTriesPerItem,
      H2_DEFAULTS.limits.retryAfterMs,
    ],
    [0.5, 0.1, null, 600_000, 86_400_000, 20, 900_000, 1, 3, 1_800_000],
  );
});

test("an invalid setting disables collection and names itself; it never falls back to a guess", () => {
  const bad = {
    ARGUS_DECISIONS_H2_PROBE_RATE: "5",
    ARGUS_DECISIONS_H2_RESIDUAL_RATE: "-0.1",
    ARGUS_DECISIONS_H2_MAX_CALLS_PER_DAY: "2.5",
    ARGUS_DECISIONS_H2_MIN_INTERVAL_MINUTES: "0",
    ARGUS_DECISIONS_H2_MAX_USD_PER_DAY: "lots",
    ARGUS_DECISIONS_H2_SEED: "has space",
    ARGUS_DECISIONS_H2_MODEL: "x; rm -rf /",
  };
  const { errors } = readH2Settings(bad);
  assert.equal(errors.length, 7);
  const en = h2Enablement({ ARGUS_DECISIONS: "on", ARGUS_DECISIONS_H2_COLLECT: "on", ...bad });
  assert.equal(en.enabled, false);
  assert.equal(en.settings, null);
  const ok = readH2Settings({
    ARGUS_DECISIONS_H2_PROBE_RATE: "0.25",
    ARGUS_DECISIONS_H2_MAX_CALLS_PER_DAY: "5",
    ARGUS_DECISIONS_H2_MIN_INTERVAL_MINUTES: "60",
    ARGUS_DECISIONS_H2_MAX_USD_PER_DAY: "0.5",
    ARGUS_DECISIONS_H2_MODEL: "claude-haiku-4-5-20251001",
  });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.settings.probeRate, 0.25);
  assert.equal(ok.settings.limits.maxCallsPer24h, 5);
  assert.equal(ok.settings.limits.minCallIntervalMs, 3_600_000);
  assert.equal(ok.settings.limits.maxUsdPer24h, 0.5);
  assert.equal(ok.settings.model, "claude-haiku-4-5-20251001");
});

// ── Sampling ────────────────────────────────────────────────────────────────

test("the sampling draw is a fixed function of seed, question and run id", () => {
  const q = { id: "run.termination-probe", version: 1 };
  const u = sampleUnit("argus-h2", q, "run-1");
  assert.equal(u, sampleUnit("argus-h2", q, "run-1"));
  assert.ok(u >= 0 && u < 1);
  assert.notEqual(u, sampleUnit("other-seed", q, "run-1"));
  assert.notEqual(u, sampleUnit("argus-h2", { ...q, version: 2 }, "run-1"));
  assert.equal(isSelected("argus-h2", q, "run-1", 0), false, "rate 0 selects nothing");
  assert.equal(isSelected("argus-h2", q, "run-1", 1), true, "rate 1 selects everything");
});

// ── Ledger ──────────────────────────────────────────────────────────────────

const start: NewRecord = {
  kind: "start",
  at: "2026-09-01T00:00:00.000Z",
  format: "argus.h2-collection-ledger",
  version: 1,
};
const expired = (runId: string): NewRecord => ({
  kind: "expired",
  at: "2026-09-01T00:00:00.000Z",
  runId,
  question: { id: "q", version: 1 },
  reason: "window-closed",
});

test("the ledger round-trips with consecutive seqs, and reading never creates anything", async () => {
  const root = path.join(tempRoot(), "h2");
  const reader = new CollectionLedger({ root });
  assert.deepEqual(await reader.read(), { records: [], notices: [], bytes: 0, lastSeq: 0 });
  assert.equal(existsSync(root), false, "a read made no directory");
  const l = new CollectionLedger({ root });
  await l.append([start, expired("a")]);
  await l.append([expired("b")]);
  const view = await new CollectionLedger({ root }).read();
  assert.deepEqual(
    view.records.map((r) => [r.record.seq, r.record.kind]),
    [
      [1, "start"],
      [2, "expired"],
      [3, "expired"],
    ],
  );
  assert.deepEqual(view.notices, []);
});

test("the ledger reports corrupt lines, lost lines and malformed records by line", () => {
  const root = path.join(tempRoot(), "h2");
  return (async () => {
    const l = new CollectionLedger({ root });
    await l.append([start, expired("a"), expired("b"), expired("c")]);
    const lines = readFileSync(l.file, "utf8").split("\n");
    lines[1] = lines[1].replace('"a"', '"z"'); // digest no longer matches
    lines.splice(2, 1); // a whole line lost
    writeFileSync(l.file, lines.join("\n"));
    const view = parseLedger(readFileSync(l.file, "utf8"));
    assert.deepEqual(
      view.notices.map((n) => [n.kind, n.line]),
      [
        ["corrupt-line", 2],
        ["seq-gap", 3],
      ],
    );
    assert.deepEqual(
      parseLedger('{"body":{"seq":1},"kind":"nonsense","sha256":"x"}\n').notices.map((n) => n.kind),
      ["corrupt-line"],
    );
  })();
});

test("the ledger refuses an append past its cap and writes nothing", async () => {
  const root = path.join(tempRoot(), "h2");
  const l = new CollectionLedger({ root, maxBytes: 400 });
  await l.append([start]);
  const size = readFileSync(l.file).length;
  await assert.rejects(
    l.append([expired("a"), expired("b"), expired("c")]),
    (e) => e instanceof LedgerError && e.code === "ledger-full",
  );
  assert.equal(readFileSync(l.file).length, size);
});

test("a duplicate attempt or a result without an attempt is damage", () => {
  const attempt = (id: string) => ({
    attemptId: id,
    assessmentId: "DA-x00000",
    config: "c",
    runId: "r",
    runEndedAt: "2026-09-01T00:00:00.000Z",
    question: { id: "q", version: 1, digest: "d" },
    projection: { id: "p", version: 1, digest: "d" },
    provider: {
      provider: "claude-cli",
      requestedModel: null,
      adapterVersion: 1,
      elicitation: "verbalized",
    },
    sample: 0,
    try: 1,
    stratum: { class: "deadline", observation: null },
    reference: null,
  });
  return (async () => {
    const l = new CollectionLedger({ root: path.join(tempRoot(), "h2") });
    await l.append([
      start,
      { kind: "attempt", at: start.at, ...attempt("A") } as NewRecord,
      { kind: "attempt", at: start.at, ...attempt("A") } as NewRecord,
      {
        kind: "result",
        at: start.at,
        attemptId: "B",
        class: "answered",
        providerCalled: "yes",
        assessmentId: null,
        outcome: null,
        code: null,
        detail: "",
        costUsd: null,
        latencyMs: null,
        reconciled: false,
      },
    ]);
    const view = await l.read();
    assert.deepEqual(
      view.notices.map((n) => n.kind),
      ["duplicate-attempt", "orphan-result"],
    );
  })();
});

// ── The pass counter ────────────────────────────────────────────────────────

test("the pass counter only delegates: same results, same gate, decide passes uncounted", async () => {
  let release!: () => void;
  const spawn: AnalysisSpawn = () => ({
    kill() {},
    done: new Promise((resolve) => {
      release = () =>
        resolve({
          code: 0,
          stdout: JSON.stringify({ result: '{"ok":true}', total_cost_usd: 0.001 }),
          error: null,
        });
    }),
  });
  const inner = createAnalysisRunner({
    spawn,
    enabled: () => true,
    blocked: async () => false,
    meter: async () => {},
  });
  const runner = countAnalysisPasses(inner);
  const first = runner.run({ kind: "autopsy", prompt: "p", cwd: "/tmp" }, (v) => v);
  assert.equal(runner.passesStarted(), 1);
  // The wrapped runner's own concurrency gate refuses the second pass.
  const busy = await runner.run({ kind: "decide", prompt: "p", cwd: "/tmp" }, (v) => v);
  assert.equal(busy.failure, "busy");
  assert.equal(runner.passesStarted(), 1, "a decide pass is not counted");
  assert.equal(runner.inFlight(), inner.inFlight());
  await new Promise((resolve) => setTimeout(resolve, 5));
  release();
  const done = await first;
  assert.equal(done.ok, true);
  assert.deepEqual(done.value, { ok: true });
  assert.equal(runner.inFlight(), 0);
});

// ── The service's pre-assigned id ───────────────────────────────────────────

test("the service accepts a pre-assigned assessment id, and refuses a malformed one before any call", async () => {
  const { createMockProvider } = await import("../providers/mock.js");
  const { harness, RESIDUAL_P } = await import("../testSupport.js");
  const mock = createMockProvider({ script: () => ({ distribution: RESIDUAL_P }) });
  const h = harness({ providers: { mock } });
  const req = {
    question: "run.failure-cause.residual",
    subject: { kind: "run" as const, runId: "run-1" },
    provider: "mock",
  };
  const bad = await h.service.assess({ ...req, id: "../escape" });
  assert.deepEqual(
    [bad.ok, !bad.ok && bad.reason, bad.providerCalled],
    [false, "invalid-id", false],
  );
  assert.equal(mock.calls.length, 0);
  const good = await h.service.assess({ ...req, id: "DA-preassigned01" });
  assert.ok(good.ok);
  assert.equal(good.ok && good.assessment.id, "DA-preassigned01");
  assert.deepEqual(
    (await h.journal.read()).entries.map((e) => e.assessment.id),
    ["DA-preassigned01"],
  );
});

test("H2 runtime is explicit, independent and fails closed for incompatible model or effort", () => {
  assert.equal(readH2Settings({ ARGUS_ANALYSIS_RUNTIME: "codex" }).settings.runtime, "claude");
  const configured = readH2Settings({
    ARGUS_DECISIONS_H2_RUNTIME: "codex",
    ARGUS_DECISIONS_H2_MODEL: "gpt-5.6-luna",
    ARGUS_DECISIONS_H2_REASONING_EFFORT: "low",
  });
  assert.deepEqual(configured.errors, []);
  assert.equal(configured.settings.runtime, "codex");
  for (const env of [
    { ARGUS_DECISIONS_H2_RUNTIME: "typo" },
    { ARGUS_DECISIONS_H2_RUNTIME: "codex" },
    { ARGUS_DECISIONS_H2_RUNTIME: "codex", ARGUS_DECISIONS_H2_MODEL: "haiku" },
    { ARGUS_DECISIONS_H2_MODEL: "gpt-5.6-luna" },
    { ARGUS_DECISIONS_H2_REASONING_EFFORT: "low" },
  ])
    assert.ok(readH2Settings(env).errors.length);
});
