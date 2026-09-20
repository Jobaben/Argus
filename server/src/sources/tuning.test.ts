import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MAX_PROPOSALS_PER_PHASE,
  PROMPT_MAX_CHARS,
  TUNING_KEEP,
  buildTuningPrompt,
  isTuningInFlight,
  parseTuningResponse,
  performPipelineTuning,
  readTuningReport,
  readTuningReports,
  resolveStepSettings,
  seedTuningReport,
  writeTuningReport,
  type RuntimeCatalogue,
  type TuningReport,
} from "./tuning.js";
import type { AnalysisResult, AnalysisRunner, AnalysisRequest } from "./analysis.js";
import type { PhaseDef, PipelineDefinition } from "@argus/contracts";

beforeEach(() => {
  const home = mkdtempSync(path.join(tmpdir(), "argus-tuning-"));
  mkdirSync(path.join(home, "argus"), { recursive: true });
  process.env.ARGUS_CLAUDE_HOME = home;
  delete process.env.ARGUS_AGENT;
});

const NOW = new Date("2026-09-17T10:00:00.000Z");

const catalogue: RuntimeCatalogue = {
  claude: { models: ["opus", "sonnet", "haiku"], efforts: [] },
  codex: { models: ["gpt-5-codex", "o4-mini"], efforts: ["low", "medium", "high"] },
  opencode: { models: [], efforts: [] },
  qwen: { models: [], efforts: [] },
};

function phase(over: Partial<PhaseDef> = {}): PhaseDef {
  return {
    id: "build",
    name: "Build",
    cwd: "/repo",
    gated: false,
    steps: [
      { name: "plan", prompt: "Read the ticket and write a short plan.", model: "opus" },
      { name: "implement", prompt: "Refactor the payment module across every call site." },
    ],
    ...over,
  };
}

function def(over: Partial<PipelineDefinition> = {}): PipelineDefinition {
  return {
    id: "p1",
    name: "Nightly",
    phases: [phase()],
    trigger: null,
    enabled: true,
    overlapPolicy: "skip",
    model: "sonnet",
    lastStartedAt: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...over,
  };
}

const ctx = (d: PipelineDefinition = def(), p: PhaseDef = d.phases[0]) => ({
  def: d,
  phase: p,
  catalogue,
});

// ── Resolution ──────────────────────────────────────────────────────────────

test("resolveStepSettings walks step → phase → pipeline → cli", () => {
  const d = def({ capabilities: { maxTurns: 40 } });
  const p = phase({ timeoutSeconds: 600 });
  const [plan, implement] = p.steps;
  assert.deepEqual(resolveStepSettings(d, p, plan).model, { value: "opus", inheritedFrom: "step" });
  assert.deepEqual(resolveStepSettings(d, p, implement).model, {
    value: "sonnet",
    inheritedFrom: "pipeline",
  });
  assert.deepEqual(resolveStepSettings(d, p, implement).timeoutSeconds, {
    value: 600,
    inheritedFrom: "phase",
  });
  assert.deepEqual(resolveStepSettings(d, p, implement).maxTurns, {
    value: 40,
    inheritedFrom: "pipeline",
  });
  assert.deepEqual(resolveStepSettings(d, p, implement).reasoningEffort, {
    value: null,
    inheritedFrom: "cli",
  });
});

// ── Prompt ──────────────────────────────────────────────────────────────────

test("the prompt quotes every step prompt as read-only with the runtime roster", () => {
  const text = buildTuningPrompt(def(), phase(), catalogue);
  assert.match(text, /READ-ONLY/);
  assert.match(text, /Read the ticket and write a short plan\./);
  assert.match(text, /Refactor the payment module/);
  assert.match(text, /allowed models: opus, sonnet, haiku/);
  assert.match(text, /allowed reasoning efforts: none/);
  assert.match(text, /"proposals": \[\] is a correct and expected answer/);
  assert.match(text, /You cannot change any prompt/);
});

test("the prompt lists efforts for a runtime that has them", () => {
  const text = buildTuningPrompt(def({ runtime: "codex" }), phase(), catalogue);
  assert.match(text, /allowed reasoning efforts: low, medium, high/);
});

test("the prompt never exceeds its cap", () => {
  const steps = Array.from({ length: 200 }, (_, i) => ({
    name: `step-${i}`,
    prompt: "x".repeat(5000),
  }));
  const text = buildTuningPrompt(def(), phase({ steps }), catalogue);
  assert.ok(text.length <= PROMPT_MAX_CHARS);
});

// ── Validation ──────────────────────────────────────────────────────────────

const proposal = (over: Record<string, unknown>) => ({
  scope: "step",
  step: "implement",
  field: "model",
  value: "opus",
  reason: "a cross-module refactor wants the strongest model",
  ...over,
});

test("a well-formed empty answer is ready with no proposals, not a parse failure", () => {
  const parsed = parseTuningResponse({ summary: "Fits.", proposals: [] }, ctx());
  assert.ok(parsed);
  assert.equal(parsed.summary, "Fits.");
  assert.deepEqual(parsed.proposals, []);
  assert.deepEqual(parsed.unchanged, ["plan", "implement"]);
  assert.deepEqual(parsed.warnings, []);
});

test("the wrong shape is null", () => {
  assert.equal(parseTuningResponse("nope", ctx()), null);
  assert.equal(parseTuningResponse({ summary: "x" }, ctx()), null);
});

test("a valid model proposal is re-derived from the definition, not the payload", () => {
  const parsed = parseTuningResponse(
    {
      proposals: [
        proposal({ phaseName: "LIES", before: "LIES", after: "LIES", inheritedFrom: "step" }),
      ],
    },
    ctx(),
  )!;
  assert.equal(parsed.proposals.length, 1);
  const p = parsed.proposals[0];
  assert.equal(p.phaseName, "Build");
  assert.equal(p.stepIndex, 1);
  assert.equal(p.current, "sonnet");
  assert.equal(p.inheritedFrom, "pipeline");
  assert.equal(p.before, "sonnet");
  assert.equal(p.after, "opus");
  assert.deepEqual(parsed.unchanged, ["plan"]);
});

test("a proposal for a field outside the closed set is dropped — including prompt", () => {
  const parsed = parseTuningResponse(
    {
      proposals: [
        proposal({ field: "prompt", value: "Do something else entirely." }),
        proposal({ field: "runtime", value: "codex" }),
        proposal({ field: "tools", value: ["Bash"] }),
      ],
    },
    ctx(),
  )!;
  assert.deepEqual(parsed.proposals, []);
  assert.equal(parsed.warnings.length, 3);
  assert.match(parsed.warnings[0], /"prompt".*not a tunable setting/);
});

test("unknown step names, off-roster models and equal values are dropped", () => {
  const parsed = parseTuningResponse(
    {
      proposals: [
        proposal({ step: "Implement" }), // case matters: exact match only
        proposal({ value: "claude-fable-5-1" }),
        proposal({ value: "sonnet" }), // equals the inherited current value
      ],
    },
    ctx(),
  )!;
  assert.deepEqual(parsed.proposals, []);
  assert.equal(parsed.warnings.length, 2);
  assert.match(parsed.warnings[0], /unknown step/);
  assert.match(parsed.warnings[1], /not in the claude roster/);
});

test("reasoningEffort is refused on a runtime with no efforts and accepted on one with", () => {
  const none = parseTuningResponse(
    { proposals: [proposal({ field: "reasoningEffort", value: "high" })] },
    ctx(),
  )!;
  assert.deepEqual(none.proposals, []);
  assert.match(none.warnings[0], /has no effort setting/);

  const codex = parseTuningResponse(
    { proposals: [proposal({ field: "reasoningEffort", value: "high" })] },
    ctx(def({ runtime: "codex", model: "gpt-5-codex" })),
  )!;
  assert.equal(codex.proposals.length, 1);
  assert.equal(codex.proposals[0].proposed, "high");
  assert.equal(codex.proposals[0].before, "unset");
});

test("integer fields must sit inside the authoring validator's bounds", () => {
  const parsed = parseTuningResponse(
    {
      proposals: [
        proposal({ field: "timeoutSeconds", value: 0 }),
        proposal({ field: "timeoutSeconds", value: 999_999 }),
        proposal({ field: "timeoutSeconds", value: 1.5 }),
        proposal({ field: "maxTurns", value: 0 }),
        proposal({ field: "maxTurns", value: 1001 }),
        proposal({ field: "timeoutSeconds", value: 1800 }),
        proposal({ field: "maxTurns", value: "60" }),
      ],
    },
    ctx(),
  )!;
  assert.equal(parsed.proposals.length, 2);
  assert.equal(parsed.proposals[0].proposed, 1800);
  assert.equal(parsed.proposals[1].proposed, 60);
  assert.equal(parsed.warnings.length, 5);
});

test("a phase-scoped proposal may only touch timeout and maxTurns", () => {
  const parsed = parseTuningResponse(
    {
      proposals: [
        proposal({ scope: "phase", step: null, field: "model" }),
        proposal({ scope: "phase", step: null, field: "timeoutSeconds", value: 900 }),
      ],
    },
    ctx(),
  )!;
  assert.equal(parsed.proposals.length, 1);
  assert.equal(parsed.proposals[0].scope, "phase");
  assert.equal(parsed.proposals[0].stepName, null);
  assert.equal(parsed.proposals[0].inheritedFrom, "cli");
  assert.match(parsed.warnings[0], /a phase has no model/);
});

test("a proposal without a reason is dropped and the list is capped", () => {
  const many = Array.from({ length: MAX_PROPOSALS_PER_PHASE + 3 }, (_, i) =>
    proposal({ field: "timeoutSeconds", value: 100 + i }),
  );
  const parsed = parseTuningResponse({ proposals: [proposal({ reason: "" }), ...many] }, ctx())!;
  assert.equal(parsed.proposals.length, MAX_PROPOSALS_PER_PHASE);
  assert.ok(parsed.warnings.some((w) => /no reason/.test(w)));
  assert.equal(parsed.warnings.filter((w) => /more than/.test(w)).length, 3);
});

// ── Store ───────────────────────────────────────────────────────────────────

test("writeTuningReport upserts by id, newest first, pruned to TUNING_KEEP", async () => {
  const d = def();
  for (let i = 0; i < TUNING_KEEP + 5; i++) {
    const at = new Date(NOW.getTime() + i * 1000);
    await writeTuningReport({ ...seedTuningReport(d, `r-${i}`, at), status: "ready" });
  }
  const all = await readTuningReports();
  assert.equal(all.length, TUNING_KEEP);
  assert.equal(all[0].id, `r-${TUNING_KEEP + 4}`);
  assert.equal((await readTuningReport("p1"))?.id, `r-${TUNING_KEEP + 4}`);

  await writeTuningReport({ ...all[0], status: "failed" });
  assert.equal((await readTuningReports()).filter((r) => r.id === all[0].id).length, 1);
  assert.equal((await readTuningReport("p1"))?.status, "failed");
});

test("isTuningInFlight is true for a fresh running report and false past the stale window", () => {
  const seed = seedTuningReport(def(), "r", NOW);
  assert.equal(isTuningInFlight(seed, new Date(NOW.getTime() + 60_000)), true);
  assert.equal(isTuningInFlight(seed, new Date(NOW.getTime() + 20 * 60_000)), false);
  assert.equal(isTuningInFlight({ ...seed, status: "ready" }, NOW), false);
  assert.equal(isTuningInFlight(null, NOW), false);
});

// ── The pass ────────────────────────────────────────────────────────────────

type Answer =
  | { ok: true; value: unknown; costUsd?: number }
  | { ok: false; failure: NonNullable<AnalysisResult<unknown>["failure"]>; error: string };

/** A runner that answers from a script and records concurrency. */
function fakeRunner(answers: Answer[]) {
  const calls: AnalysisRequest[] = [];
  let inFlight = 0;
  let peak = 0;
  const runner: AnalysisRunner = {
    inFlight: () => inFlight,
    async run(req, parse) {
      calls.push(req);
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      const a = answers[calls.length - 1] ?? { ok: false, failure: "no-output", error: "none" };
      const base = { raw: "", costUsd: null, tokens: null, durationMs: 5 };
      if (!a.ok) {
        return { ...base, ok: false, value: null, failure: a.failure, error: a.error };
      }
      const value = parse(a.value);
      if (value === null) {
        return { ...base, ok: false, value: null, failure: "unparseable", error: "wrong shape" };
      }
      return {
        ...base,
        ok: true,
        value,
        costUsd: a.costUsd ?? null,
        failure: null,
        error: null,
      };
    },
  };
  return { runner, calls, peak: () => peak };
}

function threePhases(): PipelineDefinition {
  return def({
    phases: [
      phase({ id: "a", name: "A" }),
      phase({ id: "b", name: "B" }),
      phase({ id: "c", name: "C" }),
    ],
  });
}

function run(d: PipelineDefinition, answers: Answer[]) {
  const { runner, calls, peak } = fakeRunner(answers);
  const progress: TuningReport[] = [];
  const seed = seedTuningReport(d, "r1", NOW);
  const done = performPipelineTuning(d, seed, {
    runner,
    now: () => NOW,
    onProgress: async (r) => {
      progress.push(r);
    },
  });
  return { done, calls, peak, progress };
}

test("one pass per phase, in order, never two at once", async () => {
  const d = threePhases();
  const { done, calls, peak, progress } = run(d, [
    { ok: true, value: { summary: "fine", proposals: [] }, costUsd: 0.01 },
    { ok: true, value: { summary: "fine", proposals: [proposal({})] }, costUsd: 0.02 },
    { ok: true, value: { summary: "fine", proposals: [] } },
  ]);
  const report = await done;
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.kind === "tune"));
  assert.equal(calls[0].cwd, "/repo");
  assert.match(calls[1].prompt, /name: B/);
  assert.equal(peak(), 1);
  assert.equal(report.status, "ready");
  assert.equal(report.phasesDone, 3);
  assert.equal(report.endedAt, NOW.toISOString());
  assert.deepEqual(
    report.phases.map((p) => p.status),
    ["ready", "ready", "ready"],
  );
  assert.equal(report.phases[1].proposals.length, 1);
  assert.equal(report.costUsd, 0.03);
  // seed + running/ready per phase + final
  assert.ok(progress.length >= d.phases.length + 2);
  assert.equal(progress[0].status, "running");
  assert.equal((await readTuningReport("p1"))?.status, "ready");
});

test("one failed phase leaves the others ready and the report ready", async () => {
  const { done, calls } = run(threePhases(), [
    { ok: true, value: { summary: "ok", proposals: [] } },
    { ok: false, failure: "timeout", error: "timed out after 90000ms" },
    { ok: true, value: { summary: "ok", proposals: [] } },
  ]);
  const report = await done;
  assert.equal(calls.length, 3);
  assert.deepEqual(
    report.phases.map((p) => p.status),
    ["ready", "failed", "ready"],
  );
  assert.equal(report.phases[1].error, "timed out after 90000ms");
  assert.equal(report.status, "ready");
  assert.equal(report.error, null);
});

test("a disabled runner skips every remaining phase without calling it again", async () => {
  const { done, calls } = run(threePhases(), [
    { ok: false, failure: "disabled", error: "analysis passes are disabled (ARGUS_ANALYSIS=off)" },
  ]);
  const report = await done;
  assert.equal(calls.length, 1);
  assert.deepEqual(
    report.phases.map((p) => p.status),
    ["skipped", "skipped", "skipped"],
  );
  assert.equal(report.status, "skipped");
  assert.match(report.error ?? "", /disabled/);
  assert.equal(report.phasesDone, 3);
});

test("every phase failing makes the report failed", async () => {
  const { done } = run(def(), [{ ok: false, failure: "spawn-failed", error: "ENOENT" }]);
  const report = await done;
  assert.equal(report.status, "failed");
  assert.equal(report.error, "ENOENT");
});

test("a wrong-shape answer is an unparseable failure for that phase", async () => {
  const { done } = run(def(), [{ ok: true, value: { nothing: true } }]);
  const report = await done;
  assert.equal(report.phases[0].status, "failed");
  assert.equal(report.status, "failed");
});
