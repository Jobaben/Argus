import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AUTOPSY_KEEP,
  PROMPT_EVENT_CAP,
  PROMPT_MAX_CHARS,
  buildAutopsyPrompt,
  isAutopsyEligible,
  parseAutopsyResponse,
  performAutopsy,
  readAutopsies,
  readAutopsy,
  readFailureClasses,
  writeAutopsy,
  type Autopsy,
} from "./autopsy.js";
import { buildRecording } from "./recorder.js";
import { createAnalysisRunner, type AnalysisSpawn } from "./analysis.js";
import type { Run } from "./scheduleTypes.js";

beforeEach(() => {
  const home = mkdtempSync(path.join(tmpdir(), "argus-autopsy-"));
  mkdirSync(path.join(home, "argus"), { recursive: true });
  process.env.ARGUS_CLAUDE_HOME = home;
  delete process.env.ARGUS_ANALYSIS;
});

const T0 = Date.parse("2026-07-20T10:00:00.000Z");
const NOW = new Date(T0 + 600_000);
const iso = (offset: number) => new Date(T0 + offset).toISOString();

function run(over: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    scheduleId: "s1",
    scheduleName: "Nightly triage",
    prompt: "Triage the overnight failures and open issues for anything new.",
    cwd: "/tmp",
    status: "failed",
    trigger: "scheduled",
    queuedAt: iso(0),
    startedAt: iso(0),
    endedAt: iso(120_000),
    durationMs: 120_000,
    pid: 1,
    exitCode: 1,
    sessionId: "sess-1",
    project: "-repo",
    resultSummary: null,
    error: "exit code 1",
    ...over,
  };
}

const assistant = (offsetMs: number, content: unknown[]) => ({
  type: "assistant",
  timestamp: iso(offsetMs),
  message: { role: "assistant", content },
});

function envelope(result: string): string {
  return JSON.stringify({
    result,
    total_cost_usd: 0.003,
    usage: { input_tokens: 2000, output_tokens: 200 },
  });
}

const respond =
  (stdout: string): AnalysisSpawn =>
  () => ({ kill: () => {}, done: Promise.resolve({ code: 0, stdout, error: null }) });

const GOOD_ANSWER = JSON.stringify({
  failureClass: "missing-context",
  confidence: 0.7,
  why: "The prompt assumed a lockfile that the working tree did not contain, so the install step had nothing to resolve against and exited non-zero.",
  span: { fromSeconds: 60, toSeconds: 75, quote: "60.0s tool [ERROR]: Bash: npm ci" },
  promptDelta: "Triage the overnight failures. Run `npm install` if no lockfile is present.",
  deltaRationale: "Handles the missing-lockfile case explicitly.",
});

// ── Eligibility ─────────────────────────────────────────────────────────────

test("only real failures are eligible; a cancellation is user intent", () => {
  assert.equal(isAutopsyEligible(run()), true);
  assert.equal(isAutopsyEligible(run({ status: "interrupted" })), true);
  assert.equal(isAutopsyEligible(run({ status: "succeeded", exitCode: 0, error: null })), false);
  assert.equal(isAutopsyEligible(run({ status: "cancelled" })), false);
  assert.equal(
    isAutopsyEligible(run({ status: "succeeded", exitCode: 0, error: null, outcome: "blocked" })),
    true,
  );
});

// ── Prompt ──────────────────────────────────────────────────────────────────

test("the prompt inlines everything, so the pass needs no tools", () => {
  const rec = buildRecording(
    run(),
    [assistant(1_000, [{ type: "text", text: "looking at the lockfile" }])],
    NOW,
  );
  const prompt = buildAutopsyPrompt(run(), rec);
  assert.match(prompt, /Triage the overnight failures/, "the original prompt is quoted");
  assert.match(prompt, /reported error: exit code 1/);
  assert.match(prompt, /looking at the lockfile/, "the timeline is quoted");
  assert.match(prompt, /"failureClass"/, "the required schema is stated");
});

test("regression: a huge transcript cannot write a huge prompt", () => {
  const lines = Array.from({ length: 5000 }, (_, i) =>
    assistant(i * 10, [{ type: "text", text: "x".repeat(500) }]),
  );
  const rec = buildRecording(run(), lines, NOW);
  const prompt = buildAutopsyPrompt(run(), rec);
  assert.ok(prompt.length <= PROMPT_MAX_CHARS, `prompt was ${prompt.length} chars`);
  // Only the tail of the timeline is quoted.
  const timelineLines = prompt.split("\n").filter((l) => /^\d+\.\d+s /.test(l));
  assert.ok(timelineLines.length <= PROMPT_EVENT_CAP);
});

// ── Validation ──────────────────────────────────────────────────────────────

test("a good answer parses into the stored shape", () => {
  const parsed = parseAutopsyResponse(JSON.parse(GOOD_ANSWER), 120_000);
  assert.ok(parsed);
  assert.equal(parsed.failureClass, "missing-context");
  assert.equal(parsed.confidence, 0.7);
  assert.equal(parsed.span?.fromMs, 60_000);
  assert.equal(parsed.span?.toMs, 75_000);
  assert.match(parsed.promptDelta ?? "", /npm install/);
});

test("regression: a class outside the taxonomy is rejected rather than stored", () => {
  const answer = { ...JSON.parse(GOOD_ANSWER), failureClass: "the vibes were off" };
  assert.equal(parseAutopsyResponse(answer, 120_000), null);
});

test("regression: a hallucinated span is clamped into the recording, not trusted", () => {
  // "the failure was at 40 minutes" on a two-minute run would otherwise send the
  // scrubber off the end of the track.
  const answer = {
    ...JSON.parse(GOOD_ANSWER),
    span: { fromSeconds: 2400, toSeconds: 3000, quote: "somewhere" },
  };
  const parsed = parseAutopsyResponse(answer, 120_000);
  assert.equal(parsed?.span?.fromMs, 120_000);
  assert.equal(parsed?.span?.toMs, 120_000);
});

test("regression: an inverted span is ordered rather than stored backwards", () => {
  const answer = {
    ...JSON.parse(GOOD_ANSWER),
    span: { fromSeconds: 90, toSeconds: 10, quote: "q" },
  };
  const parsed = parseAutopsyResponse(answer, 120_000);
  assert.equal(parsed?.span?.fromMs, 90_000);
  assert.equal(parsed?.span?.toMs, 90_000);
});

test("confidence outside 0–1 is clamped, and a non-number becomes null", () => {
  assert.equal(
    parseAutopsyResponse({ ...JSON.parse(GOOD_ANSWER), confidence: 9 }, 1000)?.confidence,
    1,
  );
  assert.equal(
    parseAutopsyResponse({ ...JSON.parse(GOOD_ANSWER), confidence: -2 }, 1000)?.confidence,
    0,
  );
  assert.equal(
    parseAutopsyResponse({ ...JSON.parse(GOOD_ANSWER), confidence: "high" }, 1000)?.confidence,
    null,
  );
});

test("a missing 'why' is rejected — an autopsy with no explanation is not one", () => {
  const { why: _why, ...rest } = JSON.parse(GOOD_ANSWER) as Record<string, unknown>;
  assert.equal(parseAutopsyResponse(rest, 1000), null);
  assert.equal(parseAutopsyResponse({ ...rest, why: "   " }, 1000), null);
});

test("a null promptDelta is honoured, not coerced into an empty string", () => {
  const parsed = parseAutopsyResponse(
    { ...JSON.parse(GOOD_ANSWER), promptDelta: null, deltaRationale: null },
    1000,
  );
  assert.equal(parsed?.promptDelta, null);
  assert.equal(parsed?.deltaRationale, null);
});

test("non-objects are rejected", () => {
  for (const bad of [null, undefined, 42, "text", []]) {
    assert.equal(parseAutopsyResponse(bad, 1000), null);
  }
});

// ── The pass ────────────────────────────────────────────────────────────────

const deps = (spawn: AnalysisSpawn) => ({
  runner: createAnalysisRunner({ spawn, now: () => NOW, meter: async () => {} }),
  now: () => NOW,
  readLines: async () => [assistant(60_000, [{ type: "text", text: "npm ci" }])],
});

test("a successful pass is stored ready, with its cost", async () => {
  const autopsy = await performAutopsy(run(), deps(respond(envelope(GOOD_ANSWER))));
  assert.equal(autopsy.status, "ready");
  assert.equal(autopsy.failureClass, "missing-context");
  assert.equal(autopsy.costUsd, 0.003);
  assert.equal(autopsy.tokens, 2200);
  assert.equal((await readAutopsy("run-1"))?.status, "ready");
});

test("regression: a failed pass is still stored, so the run is not retried forever", async () => {
  const autopsy = await performAutopsy(run(), deps(respond(envelope("no json"))));
  assert.equal(autopsy.status, "failed");
  assert.match(autopsy.error ?? "", /JSON/);
  assert.equal((await readAutopsies()).length, 1);
});

test("with analysis disabled the record says skipped, not failed", async () => {
  const runner = createAnalysisRunner({
    spawn: respond(envelope(GOOD_ANSWER)),
    now: () => NOW,
    meter: async () => {},
    enabled: () => false,
  });
  const autopsy = await performAutopsy(run(), {
    runner,
    now: () => NOW,
    readLines: async () => [],
  });
  assert.equal(autopsy.status, "skipped");
});

test("re-running replaces the previous autopsy rather than accumulating", async () => {
  await performAutopsy(run(), deps(respond(envelope("no json"))));
  await performAutopsy(run(), deps(respond(envelope(GOOD_ANSWER))));
  const all = await readAutopsies();
  assert.equal(all.length, 1);
  assert.equal(all[0].status, "ready");
});

test("the store is capped so it cannot grow without bound", async () => {
  const record = (i: number): Autopsy => ({
    runId: `r${i}`,
    scheduleId: "s1",
    scheduleName: "n",
    status: "ready",
    at: new Date(T0 + i * 1000).toISOString(),
    failureClass: "other",
    confidence: 0.5,
    why: "because",
    span: null,
    promptDelta: null,
    deltaRationale: null,
    costUsd: null,
    tokens: null,
    durationMs: null,
    error: null,
  });
  for (let i = 0; i < AUTOPSY_KEEP + 5; i++) await writeAutopsy(record(i));
  const all = await readAutopsies();
  assert.equal(all.length, AUTOPSY_KEEP);
  // Newest kept, oldest dropped.
  assert.equal(all[0].runId, `r${AUTOPSY_KEEP + 4}`);
});

test("only ready autopsies contribute a failure class to clustering", async () => {
  await writeAutopsy({
    runId: "ready",
    scheduleId: "s1",
    scheduleName: "n",
    status: "ready",
    at: iso(0),
    failureClass: "timeout",
    confidence: 1,
    why: "w",
    span: null,
    promptDelta: null,
    deltaRationale: null,
    costUsd: null,
    tokens: null,
    durationMs: null,
    error: null,
  });
  await writeAutopsy({
    runId: "broken",
    scheduleId: "s1",
    scheduleName: "n",
    status: "failed",
    at: iso(1),
    failureClass: "timeout",
    confidence: null,
    why: null,
    span: null,
    promptDelta: null,
    deltaRationale: null,
    costUsd: null,
    tokens: null,
    durationMs: null,
    error: "timed out",
  });
  const classes = await readFailureClasses();
  assert.equal(classes.get("ready"), "timeout");
  assert.equal(classes.has("broken"), false, "a pass with no diagnosis is not a diagnosis");
});
