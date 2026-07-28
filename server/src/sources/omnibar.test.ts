import test from "node:test";
import assert from "node:assert/strict";
import type { BudgetConfig } from "@argus/contracts";
import type { Schedule } from "./scheduleTypes.js";
import type { Issue } from "./issues.js";
import type { PipelineInstance } from "./pipelineTypes.js";
import {
  buildCatalogue,
  buildPrompt,
  buildResponse,
  compileIntent,
  resolveMutation,
  unavailablePlan,
  type OmnibarContext,
} from "./omnibar.js";
import type { AnalysisResult, AnalysisRunner } from "./analysis.js";

const NOW = new Date("2026-07-20T12:00:00.000Z");

const schedule = (over: Partial<Schedule> = {}): Schedule =>
  ({
    id: "s1",
    name: "Nightly triage",
    prompt: "p",
    cwd: "/tmp",
    trigger: { kind: "daily", at: "02:00" },
    enabled: true,
    overlapPolicy: "skip",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    lastRunAt: null,
    lastRunId: null,
    ...over,
  }) as Schedule;

const issue = (over: Partial<Issue> = {}): Issue =>
  ({
    fingerprint: "fp1",
    title: "ECONNREFUSED talking to the registry",
    count: 4,
    firstSeen: NOW.toISOString(),
    lastSeen: NOW.toISOString(),
    schedules: ["Nightly triage"],
    state: "open",
    lastRunId: "r1",
    members: ["fp1"],
    ...over,
  }) as Issue;

const instance = (over: Partial<PipelineInstance> = {}): PipelineInstance =>
  ({
    id: "inst1",
    pipelineId: "p1",
    pipelineName: "Release train",
    status: "running",
    phases: [],
    startedAt: NOW.toISOString(),
    endedAt: null,
    ...over,
  }) as PipelineInstance;

const budget: BudgetConfig = {
  dailyUsd: 10,
  monthlyUsd: null,
  blockScheduled: false,
  updatedAt: null,
};

function ctx(over: Partial<OmnibarContext> = {}): OmnibarContext {
  return {
    schedules: [schedule()],
    issues: [issue()],
    instances: [instance()],
    budget,
    now: NOW,
    ...over,
  };
}

// ── The catalogue and the prompt ────────────────────────────────────────────

test("the catalogue names ids first, and only what the planner may touch", () => {
  const text = buildCatalogue(
    ctx({
      schedules: [schedule(), schedule({ id: "s2", name: "Off one", enabled: false })],
      issues: [issue(), issue({ fingerprint: "fp2", state: "resolved" })],
      instances: [instance(), instance({ id: "inst2", status: "succeeded" })],
    }),
  );
  assert.match(text, /s1 \| Nightly triage \| enabled/);
  assert.match(text, /s2 \| Off one \| disabled/);
  // Resolved issues and finished instances are not actionable, so offering them
  // to the planner only invites a mutation that would be dropped.
  assert.doesNotMatch(text, /fp2/);
  assert.doesNotMatch(text, /inst2/);
});

test("an empty catalogue says so rather than leaving a blank section", () => {
  const text = buildCatalogue(ctx({ schedules: [], issues: [], instances: [] }));
  assert.equal(text.match(/\(none\)/g)?.length, 3);
});

test("the prompt carries the catalogue and caps the intent", () => {
  const prompt = buildPrompt("x".repeat(1000), ctx());
  assert.match(prompt, /Nightly triage/);
  assert.match(prompt, /targetId MUST be copied exactly/);
  assert.ok(prompt.length < 6000, "the prompt stays small enough to be cheap");
  assert.equal(/x{500}/.test(prompt), false, "the intent is truncated");
});

// ── Validation: the trust boundary ──────────────────────────────────────────

test("an unknown verb is dropped and explained, never executed", () => {
  const out = resolveMutation({ kind: "schedule.delete", targetId: "s1" }, ctx());
  assert.ok("dropped" in out);
  assert.match(out.dropped, /unsupported action/);
});

test("regression: a target the planner invented is dropped", () => {
  const out = resolveMutation({ kind: "schedule.disable", targetId: "does-not-exist" }, ctx());
  // This is the whole trust boundary. A plan that names a schedule which does
  // not exist must never reach the executor with a plausible-looking label.
  assert.ok("dropped" in out);
  assert.match(out.dropped, /no schedule with id does-not-exist/);
});

test("labels come from live state, not from the model", () => {
  const out = resolveMutation(
    // A planner that tries to write its own label has nowhere to put it: the
    // shape only carries kind, targetId and value.
    { kind: "schedule.disable", targetId: "s1", value: "Something Else" },
    ctx(),
  );
  assert.ok("mutation" in out);
  assert.equal(out.mutation.targetLabel, "Nightly triage");
  assert.equal(out.mutation.before, "enabled");
  assert.equal(out.mutation.after, "disabled");
});

test("a no-op is reported as a no-op rather than applied", () => {
  const out = resolveMutation(
    { kind: "schedule.disable", targetId: "s2" },
    ctx({ schedules: [schedule({ id: "s2", name: "Off one", enabled: false })] }),
  );
  assert.ok("dropped" in out);
  assert.match(out.dropped, /already disabled/);
});

test("issue triage resolves against the open issue, carrying its real state", () => {
  const out = resolveMutation({ kind: "issue.ignore", targetId: "fp1" }, ctx());
  assert.ok("mutation" in out);
  assert.equal(out.mutation.before, "open");
  assert.equal(out.mutation.after, "ignored");
  assert.match(out.mutation.targetLabel, /ECONNREFUSED/);
});

test("aborting something that is not live is dropped", () => {
  const out = resolveMutation(
    { kind: "instance.abort", targetId: "inst1" },
    ctx({ instances: [instance({ status: "succeeded" })] }),
  );
  assert.ok("dropped" in out);
  assert.match(out.dropped, /already succeeded/);
});

test("a gated instance can be aborted; a finished one cannot", () => {
  const out = resolveMutation(
    { kind: "instance.abort", targetId: "inst1" },
    ctx({ instances: [instance({ status: "awaiting-approval" })] }),
  );
  assert.ok("mutation" in out);
  assert.equal(out.mutation.after, "aborted");
});

test("a budget limit must be a positive number, and null clears it", () => {
  const bad = resolveMutation({ kind: "budget.setDaily", targetId: "", value: "lots" }, ctx());
  assert.ok("dropped" in bad);
  assert.match(bad.dropped, /is not a limit/);

  const negative = resolveMutation({ kind: "budget.setDaily", targetId: "", value: -5 }, ctx());
  assert.ok("dropped" in negative);

  const cleared = resolveMutation({ kind: "budget.setDaily", targetId: "", value: null }, ctx());
  assert.ok("mutation" in cleared);
  assert.equal(cleared.mutation.before, "$10.00");
  assert.equal(cleared.mutation.after, "no limit");

  const set = resolveMutation({ kind: "budget.setMonthly", targetId: "", value: 150 }, ctx());
  assert.ok("mutation" in set);
  assert.equal(set.mutation.after, "$150.00");
});

// ── Assembling the response ─────────────────────────────────────────────────

test("a plan keeps the good mutations and warns about the rest", () => {
  const res = buildResponse(
    {
      mode: "plan",
      summary: "Pause the nightly triage",
      mutations: [
        { kind: "schedule.disable", targetId: "s1" },
        { kind: "schedule.disable", targetId: "ghost" },
        { kind: "rm -rf", targetId: "s1" },
      ],
    },
    "pause nightly triage",
    ctx(),
  );
  assert.equal(res.plan?.status, "ready");
  assert.equal(res.plan?.mutations.length, 1);
  assert.equal(res.plan?.warnings.length, 2);
  assert.ok(res.plan?.id);
  assert.equal(res.plan?.expiresAt, "2026-07-20T12:05:00.000Z");
});

test("regression: the same change proposed twice is one change", () => {
  const res = buildResponse(
    {
      mode: "plan",
      mutations: [
        { kind: "schedule.disable", targetId: "s1" },
        { kind: "schedule.disable", targetId: "s1" },
      ],
    },
    "pause it",
    ctx(),
  );
  // A repeated mutation would make the preview say "2 changes" for one change,
  // which is exactly the kind of small lie that makes a confirm step useless.
  assert.equal(res.plan?.mutations.length, 1);
});

test("a plan with nothing to do is `empty`, and says why", () => {
  const res = buildResponse(
    { mode: "plan", summary: "It is already paused.", mutations: [] },
    "pause it",
    ctx(),
  );
  assert.equal(res.plan?.status, "empty");
  assert.equal(res.plan?.summary, "It is already paused.");
});

test("more mutations than the cap are truncated, not honoured", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    kind: "schedule.disable",
    targetId: `s${i}`,
  }));
  const schedules = Array.from({ length: 40 }, (_, i) => schedule({ id: `s${i}`, name: `S${i}` }));
  const res = buildResponse(
    { mode: "plan", mutations: many },
    "disable everything",
    ctx({ schedules }),
  );
  assert.equal(res.plan?.mutations.length, 25);
});

test("an answer comes back as an answer, with only in-app links", () => {
  const res = buildResponse(
    {
      mode: "answer",
      text: "Nightly triage last failed on Tuesday.",
      links: [
        { label: "Open it", href: "#/schedules" },
        { label: "Phish", href: "https://example.com/steal" },
        { label: "", href: "#/issues" },
      ],
    },
    "when did nightly triage last fail",
    ctx(),
  );
  assert.equal(res.mode, "answer");
  // An off-site link in a command bar is either confusion or an attempt to put
  // one in front of the user; neither is a thing this feature needs.
  assert.deepEqual(res.answer?.links, [{ label: "Open it", href: "#/schedules" }]);
});

test("an unavailable plan is still a plan the UI can render", () => {
  const res = unavailablePlan("do a thing", "the planner is off", NOW);
  assert.equal(res.plan?.status, "unavailable");
  assert.equal(res.plan?.id, "");
  assert.equal(res.plan?.mutations.length, 0);
});

// ── The pass ────────────────────────────────────────────────────────────────

function runner(result: Partial<AnalysisResult<unknown>>): AnalysisRunner {
  return {
    inFlight: () => 0,
    run: async <T>(): Promise<AnalysisResult<T>> =>
      ({
        ok: true,
        value: null,
        raw: "",
        costUsd: null,
        tokens: null,
        durationMs: 1,
        failure: null,
        error: null,
        ...result,
      }) as AnalysisResult<T>,
  };
}

test("compileIntent turns a parsed plan into a response", async () => {
  const res = await compileIntent("pause nightly triage", ctx(), {
    runner: runner({
      value: { mode: "plan", mutations: [{ kind: "schedule.disable", targetId: "s1" }] },
    }),
    cwd: "/tmp",
  });
  assert.equal(res.plan?.status, "ready");
  assert.equal(res.plan?.mutations[0].targetLabel, "Nightly triage");
});

test("a refused pass explains which bound stopped it, in words", async () => {
  for (const [failure, phrase] of [
    ["budget-blocked", /hard stop/],
    ["busy", /another analysis pass/],
    ["timeout", /too long/],
    ["disabled", /ARGUS_ANALYSIS=off/],
  ] as const) {
    const res = await compileIntent("pause it", ctx(), {
      runner: runner({ ok: false, value: null, failure }),
      cwd: "/tmp",
    });
    assert.equal(res.plan?.status, "unavailable", failure);
    assert.match(res.plan!.summary, phrase, failure);
  }
});

test("too short an intent never reaches the model", async () => {
  let called = false;
  const res = await compileIntent("hi", ctx(), {
    runner: {
      inFlight: () => 0,
      run: async () => {
        called = true;
        throw new Error("should not run");
      },
    } as unknown as AnalysisRunner,
    cwd: "/tmp",
  });
  assert.equal(called, false);
  assert.equal(res.plan?.status, "unavailable");
});
