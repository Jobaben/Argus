import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CONTEXT_RUNS,
  PROMPT_MAX_CHARS,
  buildDiagnosePrompt,
  parseDiagnoseResponse,
  performDiagnosis,
} from "./diagnose.js";
import { createAnalysisRunner, type AnalysisSpawn } from "./analysis.js";
import type { Incident } from "@argus/contracts";
import type { Run } from "./scheduleTypes.js";

beforeEach(() => {
  const home = mkdtempSync(path.join(tmpdir(), "argus-diagnose-"));
  mkdirSync(path.join(home, "argus"), { recursive: true });
  process.env.ARGUS_CLAUDE_HOME = home;
  delete process.env.ARGUS_ANALYSIS;
});

const NOW = new Date("2026-07-20T12:00:00.000Z");

const INCIDENT: Incident = {
  id: "i1",
  key: "monitor:s1",
  source: "monitor-down",
  severity: "critical",
  title: "Nightly triage",
  detail: "no run covered the slot expected at 02:00",
  status: "open",
  openedAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
  acknowledgedAt: null,
  acknowledgedBy: null,
  resolvedAt: null,
  level: 1,
  nextEscalationAt: null,
  timeline: [
    { at: NOW.toISOString(), kind: "opened", detail: "no run covered the slot", by: "sentinel" },
    { at: NOW.toISOString(), kind: "escalated", detail: "Escalate", by: "sentinel" },
  ],
  diagnosis: null,
  scheduleId: "s1",
  runId: null,
  fingerprint: null,
};

function run(over: Partial<Run> = {}): Run {
  return {
    id: "r1",
    scheduleId: "s1",
    scheduleName: "Nightly triage",
    prompt: "p",
    cwd: "/tmp",
    status: "failed",
    trigger: "scheduled",
    queuedAt: NOW.toISOString(),
    startedAt: NOW.toISOString(),
    endedAt: NOW.toISOString(),
    durationMs: 1000,
    pid: null,
    exitCode: 1,
    sessionId: null,
    project: null,
    resultSummary: null,
    error: "spawn claude ENOENT",
    ...over,
  };
}

const GOOD = JSON.stringify({
  findings:
    "The CLI is not on PATH for the scheduler's environment, so every spawn fails immediately.",
  remediation: "Check that `claude` resolves in the daemon's PATH, then re-run the schedule.",
  confidence: 0.8,
});

const envelope = (result: string) =>
  JSON.stringify({
    result,
    total_cost_usd: 0.001,
    usage: { input_tokens: 700, output_tokens: 90 },
  });

const respond =
  (stdout: string): AnalysisSpawn =>
  () => ({ kill: () => {}, done: Promise.resolve({ code: 0, stdout, error: null }) });

const deps = (spawn: AnalysisSpawn, context: Run[] = [run()]) => ({
  runner: createAnalysisRunner({ spawn, now: () => NOW, meter: async () => {} }),
  now: () => NOW,
  context: async () => context,
});

test("regression: the prompt inlines everything, so the pass has nothing to reach for", () => {
  const prompt = buildDiagnosePrompt(INCIDENT, [run()]);
  assert.match(prompt, /You have no tools/);
  assert.match(prompt, /no run covered the slot expected at 02:00/);
  assert.match(prompt, /escalated/, "the timeline is evidence too");
  assert.match(prompt, /spawn claude ENOENT/, "so are the recent runs");
});

test("the prompt is bounded however long the incident has been running", () => {
  const noisy: Incident = {
    ...INCIDENT,
    detail: "x".repeat(5000),
    timeline: Array.from({ length: 500 }, () => ({
      at: NOW.toISOString(),
      kind: "note" as const,
      detail: "y".repeat(500),
      by: "user:ada",
    })),
  };
  const context = Array.from({ length: 50 }, (_, i) =>
    run({ id: `r${i}`, error: "z".repeat(500) }),
  );
  const prompt = buildDiagnosePrompt(noisy, context);
  assert.ok(prompt.length <= PROMPT_MAX_CHARS, `prompt was ${prompt.length}`);
  assert.ok(
    (prompt.match(/^ {2}\d{4}-/gm) ?? []).length <= CONTEXT_RUNS + 20,
    "both the timeline and the run list are trimmed",
  );
});

test("a good answer parses, clamping confidence", () => {
  const parsed = parseDiagnoseResponse(JSON.parse(GOOD));
  assert.match(parsed?.findings ?? "", /not on PATH/);
  assert.match(parsed?.remediation ?? "", /re-run the schedule/);
  assert.equal(parsed?.confidence, 0.8);
  assert.equal(parseDiagnoseResponse({ findings: "f", confidence: 5 })?.confidence, 1);
  assert.equal(parseDiagnoseResponse({ findings: "f", confidence: "high" })?.confidence, null);
});

test("an answer with no findings is rejected — a diagnosis with no diagnosis is not one", () => {
  assert.equal(parseDiagnoseResponse({ remediation: "restart it" }), null);
  assert.equal(parseDiagnoseResponse({ findings: "  " }), null);
  assert.equal(parseDiagnoseResponse(null), null);
  assert.equal(parseDiagnoseResponse("text"), null);
});

test("a null remediation is honoured — 'I cannot tell' is a valid answer", () => {
  const parsed = parseDiagnoseResponse({ findings: "Not enough evidence.", remediation: null });
  assert.equal(parsed?.remediation, null);
});

test("a successful pass attaches findings, a proposal, and what it cost", async () => {
  const d = await performDiagnosis(INCIDENT, deps(respond(envelope(GOOD))));
  assert.equal(d.status, "ready");
  assert.match(d.findings ?? "", /not on PATH/);
  assert.equal(d.costUsd, 0.001);
  assert.equal(d.error, null);
});

test("a failed pass reports why rather than pretending to a finding", async () => {
  const d = await performDiagnosis(INCIDENT, deps(respond(envelope("no json"))));
  assert.equal(d.status, "failed");
  assert.equal(d.findings, null);
  assert.match(d.error ?? "", /JSON/);
});

test("with analysis disabled the diagnosis is skipped, not failed", async () => {
  const runner = createAnalysisRunner({
    spawn: respond(envelope(GOOD)),
    now: () => NOW,
    meter: async () => {},
    enabled: () => false,
  });
  const d = await performDiagnosis(INCIDENT, {
    runner,
    now: () => NOW,
    context: async () => [],
  });
  assert.equal(d.status, "skipped");
});
