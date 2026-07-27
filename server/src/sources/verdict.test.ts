import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MAX_CRITERIA,
  PROMPT_MAX_CHARS,
  RubricValidationError,
  VERDICT_KEEP,
  buildVerdictPrompt,
  buildVerdictTrends,
  failingVerdicts,
  parseVerdictResponse,
  performVerdict,
  readVerdicts,
  validateAutoApprove,
  validateRubric,
  weightedScore,
  writeVerdict,
  type Rubric,
  type Verdict,
} from "./verdict.js";
import { createAnalysisRunner, type AnalysisSpawn } from "./analysis.js";
import type { Run } from "./scheduleTypes.js";

beforeEach(() => {
  const home = mkdtempSync(path.join(tmpdir(), "argus-verdict-"));
  mkdirSync(path.join(home, "argus"), { recursive: true });
  process.env.ARGUS_CLAUDE_HOME = home;
  delete process.env.ARGUS_ANALYSIS;
});

const NOW = new Date("2026-07-20T12:00:00.000Z");

const RUBRIC: Rubric = {
  goal: "A triage summary that names every new failure and proposes one next step each.",
  criteria: [
    { id: "coverage", label: "Names every new failure", weight: 2 },
    { id: "actionable", label: "Proposes a concrete next step" },
  ],
  minScore: 6,
};

function run(over: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    scheduleId: "s1",
    scheduleName: "Nightly triage",
    prompt: "Triage the overnight failures.",
    cwd: "/tmp",
    status: "succeeded",
    trigger: "scheduled",
    queuedAt: NOW.toISOString(),
    startedAt: NOW.toISOString(),
    endedAt: NOW.toISOString(),
    durationMs: 1000,
    pid: 1,
    exitCode: 0,
    sessionId: null,
    project: null,
    resultSummary: "Two failures found; both are lockfile drift.",
    error: null,
    ...over,
  };
}

const GOOD = JSON.stringify({
  criteria: [
    { id: "coverage", score: 8, note: "Both failures are named." },
    { id: "actionable", score: 6, note: "One step given, one missing." },
  ],
  summary: "Solid but incomplete.",
});

const envelope = (result: string) =>
  JSON.stringify({
    result,
    total_cost_usd: 0.001,
    usage: { input_tokens: 800, output_tokens: 100 },
  });

const respond =
  (stdout: string): AnalysisSpawn =>
  () => ({ kill: () => {}, done: Promise.resolve({ code: 0, stdout, error: null }) });

const deps = (spawn: AnalysisSpawn) => ({
  runner: createAnalysisRunner({ spawn, now: () => NOW, meter: async () => {} }),
  now: () => NOW,
});

// ── Rubric validation ───────────────────────────────────────────────────────

test("a rubric round-trips, and absent means no rubric", () => {
  assert.equal(validateRubric(undefined), undefined);
  assert.equal(validateRubric(null), undefined);
  const r = validateRubric(RUBRIC);
  assert.equal(r?.criteria.length, 2);
  assert.equal(r?.minScore, 6);
});

test("a rubric with no goal or no criteria is rejected with a usable message", () => {
  assert.throws(() => validateRubric({ criteria: RUBRIC.criteria }), RubricValidationError);
  assert.throws(() => validateRubric({ goal: "g", criteria: [] }), RubricValidationError);
  assert.throws(
    () => validateRubric({ goal: "g", criteria: [{ id: "a", label: "" }] }),
    /needs a label/,
  );
});

test("criterion ids must be slugs, unique, and bounded in number", () => {
  assert.throws(
    () => validateRubric({ goal: "g", criteria: [{ id: "Has Space", label: "x" }] }),
    /slug/,
  );
  assert.throws(
    () =>
      validateRubric({
        goal: "g",
        criteria: [
          { id: "a", label: "x" },
          { id: "a", label: "y" },
        ],
      }),
    /duplicate/,
  );
  assert.throws(
    () =>
      validateRubric({
        goal: "g",
        criteria: Array.from({ length: MAX_CRITERIA + 1 }, (_, i) => ({ id: `c${i}`, label: "x" })),
      }),
    /capped/,
  );
});

test("minScore must be a real 0–10 threshold", () => {
  assert.throws(() => validateRubric({ ...RUBRIC, minScore: 11 }), RubricValidationError);
  assert.throws(() => validateRubric({ ...RUBRIC, minScore: "high" }), RubricValidationError);
  assert.equal(validateRubric({ ...RUBRIC, minScore: null })?.minScore, undefined);
});

test("regression: autoApprove without a rubric is refused — there is nothing to clear", () => {
  assert.throws(() => validateAutoApprove({ verdict: 8 }, false), /needs a rubric/);
  assert.deepEqual(validateAutoApprove({ verdict: 8 }, true), { verdict: 8 });
  assert.throws(() => validateAutoApprove({ verdict: 20 }, true), /between 0 and 10/);
});

// ── Scoring ─────────────────────────────────────────────────────────────────

test("regression: the overall score is computed from the weights, not taken from the model", () => {
  // A judge that scores everything 3/10 will still hand back an 8 if asked for
  // an overall. Weighted here: (8*2 + 6*1) / 3 = 7.3.
  const parsed = parseVerdictResponse(JSON.parse(GOOD), RUBRIC);
  assert.ok(parsed);
  assert.equal(weightedScore(RUBRIC, parsed.criteria), 7.3);
});

test("a score for a criterion the rubric never mentioned is dropped", () => {
  const parsed = parseVerdictResponse(
    {
      criteria: [
        { id: "coverage", score: 9, note: "" },
        { id: "invented", score: 10, note: "" },
      ],
    },
    RUBRIC,
  );
  assert.equal(parsed?.criteria.length, 1);
  assert.equal(parsed?.criteria[0].id, "coverage");
});

test("a response that scores none of the real criteria is a failure, not a zero", () => {
  assert.equal(parseVerdictResponse({ criteria: [{ id: "nope", score: 5 }] }, RUBRIC), null);
  assert.equal(parseVerdictResponse({ criteria: [] }, RUBRIC), null);
  assert.equal(parseVerdictResponse({}, RUBRIC), null);
  assert.equal(parseVerdictResponse(null, RUBRIC), null);
});

test("scores are clamped to 0–10 and labels come from the rubric, not the model", () => {
  const parsed = parseVerdictResponse(
    {
      criteria: [
        { id: "coverage", score: 42, note: "n" },
        { id: "actionable", score: -3, note: "n" },
      ],
    },
    RUBRIC,
  );
  assert.equal(parsed?.criteria[0].score, 10);
  assert.equal(parsed?.criteria[1].score, 0);
  // Renaming the label in the rubric keeps history joined by id.
  assert.equal(parsed?.criteria[0].label, "Names every new failure");
});

test("a partially-answered rubric still scores, over the criteria that were judged", () => {
  const parsed = parseVerdictResponse({ criteria: [{ id: "actionable", score: 4 }] }, RUBRIC);
  assert.equal(weightedScore(RUBRIC, parsed!.criteria), 4);
});

test("weightedScore returns null rather than 0 when nothing matched", () => {
  assert.equal(weightedScore(RUBRIC, []), null);
});

// ── The prompt ──────────────────────────────────────────────────────────────

test("the prompt names every criterion id verbatim and forbids an overall score", () => {
  const prompt = buildVerdictPrompt(run(), RUBRIC);
  assert.match(prompt, /id "coverage"/);
  assert.match(prompt, /id "actionable"/);
  assert.match(prompt, /weight 2/);
  assert.match(prompt, /Do not return an\noverall score/);
  assert.match(prompt, /Two failures found/);
});

test("regression: a huge result summary cannot write a huge prompt", () => {
  const prompt = buildVerdictPrompt(run({ resultSummary: "x".repeat(200_000) }), RUBRIC);
  assert.ok(prompt.length <= PROMPT_MAX_CHARS);
});

// ── The pass ────────────────────────────────────────────────────────────────

test("a good pass stores a ready verdict with its computed score", async () => {
  const v = await performVerdict(run(), RUBRIC, deps(respond(envelope(GOOD))));
  assert.equal(v.status, "ready");
  assert.equal(v.score, 7.3);
  assert.equal(v.regression, false);
  assert.equal(v.minScore, 6);
  assert.equal(v.costUsd, 0.001);
});

test("a score under the author's bar is a regression", async () => {
  const low = JSON.stringify({
    criteria: [
      { id: "coverage", score: 2, note: "misses most" },
      { id: "actionable", score: 3, note: "vague" },
    ],
  });
  const v = await performVerdict(run(), RUBRIC, deps(respond(envelope(low))));
  assert.equal(v.regression, true);
  assert.ok((v.score ?? 10) < 6);
});

test("with no minScore, Verdict measures and never fails anything", async () => {
  const { minScore: _drop, ...noBar } = RUBRIC;
  const low = JSON.stringify({ criteria: [{ id: "coverage", score: 1, note: "bad" }] });
  const v = await performVerdict(run(), noBar as Rubric, deps(respond(envelope(low))));
  assert.equal(v.regression, false);
  assert.equal(v.minScore, null);
});

test("regression: a failed pass is stored, so the run is not re-judged every tick", async () => {
  const v = await performVerdict(run(), RUBRIC, deps(respond(envelope("not json"))));
  assert.equal(v.status, "failed");
  assert.equal((await readVerdicts()).length, 1);
});

test("the verdict store is capped", async () => {
  const record = (i: number): Verdict => ({
    runId: `r${i}`,
    scheduleId: "s1",
    scheduleName: "n",
    phaseId: null,
    status: "ready",
    at: new Date(NOW.getTime() + i * 1000).toISOString(),
    score: 7,
    criteria: [],
    summary: null,
    regression: false,
    minScore: null,
    costUsd: null,
    tokens: null,
    durationMs: null,
    error: null,
  });
  for (let i = 0; i < VERDICT_KEEP + 3; i++) await writeVerdict(record(i));
  assert.equal((await readVerdicts()).length, VERDICT_KEEP);
});

// ── Trends ──────────────────────────────────────────────────────────────────

function scored(runId: string, score: number, over: Partial<Verdict> = {}): Verdict {
  return {
    runId,
    scheduleId: "s1",
    scheduleName: "Nightly triage",
    phaseId: null,
    status: "ready",
    at: new Date(NOW.getTime() + Number(runId.slice(1)) * 60_000).toISOString(),
    score,
    criteria: [],
    summary: null,
    regression: false,
    minScore: 6,
    costUsd: null,
    tokens: null,
    durationMs: null,
    error: null,
    ...over,
  };
}

test("a trend orders oldest to newest and reports the latest, median and delta", () => {
  const report = buildVerdictTrends(
    [scored("r1", 8), scored("r2", 8), scored("r3", 8), scored("r4", 5)],
    new Map([["schedule:s1", 6]]),
    NOW,
  );
  const t = report.trends[0];
  assert.equal(t.points.length, 4);
  assert.equal(t.points[0].runId, "r1");
  assert.equal(t.latest, 5);
  // Delta compares against the median of everything *before* the latest, so a
  // single noisy judgement doesn't read as a collapse of the whole line.
  assert.equal(t.delta, -3);
  assert.equal(t.minScore, 6);
});

test("thresholds come from the live definition, not the stored verdict", () => {
  // An author who tightens the bar should see the new line against old history.
  const report = buildVerdictTrends([scored("r1", 8)], new Map([["schedule:s1", 9]]), NOW);
  assert.equal(report.trends[0].minScore, 9);
});

test("failed and unscored verdicts are excluded from the trend", () => {
  const report = buildVerdictTrends(
    [scored("r1", 8), scored("r2", 0, { status: "failed", score: null })],
    new Map(),
    NOW,
  );
  assert.equal(report.trends[0].points.length, 1);
  assert.equal(report.summary.scored, 1);
});

test("phase verdicts trend separately from their pipeline's schedule", () => {
  const report = buildVerdictTrends(
    [
      scored("r1", 8, { scheduleId: "pipeline:p1", phaseId: "build" }),
      scored("r2", 4, { scheduleId: "pipeline:p1", phaseId: "test" }),
    ],
    new Map(),
    NOW,
  );
  assert.equal(report.trends.length, 2);
  assert.ok(report.trends.every((t) => t.scope === "phase"));
});

test("an empty history is an empty report", () => {
  const report = buildVerdictTrends([], new Map(), NOW);
  assert.deepEqual(report.trends, []);
  assert.equal(report.summary.average, null);
});

// ── Regressions as issues ───────────────────────────────────────────────────

test("failingVerdicts describes the miss in a way repeated misses group under", () => {
  const map = failingVerdicts([
    scored("r1", 3.2, { regression: true }),
    scored("r2", 4.8, { regression: true }),
    scored("r3", 9, { regression: false }),
  ]);
  assert.equal(map.size, 2);
  assert.match(map.get("r1") ?? "", /quality below the bar for Nightly triage/);
  // The digits differ but Issues normalizes them away, so both land in one group.
  assert.notEqual(map.get("r1"), map.get("r2"));
  assert.equal(map.has("r3"), false);
});
