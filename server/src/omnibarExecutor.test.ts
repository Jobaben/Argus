import test from "node:test";
import assert from "node:assert/strict";
import type { BudgetConfig, Plan, PlannedMutation } from "@argus/contracts";
import type { Schedule } from "./sources/scheduleTypes.js";
import type { Issue } from "./sources/issues.js";
import type { PipelineInstance } from "./sources/pipelineTypes.js";
import type { OmnibarContext } from "./sources/omnibar.js";
import { executePlan, inverseOf, parseLimit, type ExecutorDeps } from "./omnibarExecutor.js";

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
    title: "ECONNREFUSED",
    count: 2,
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
    schedules: [schedule(), schedule({ id: "s2", name: "Weekly audit" })],
    issues: [issue()],
    instances: [instance()],
    budget,
    now: NOW,
    ...over,
  };
}

function plan(mutations: PlannedMutation[]): Plan {
  return {
    id: "plan-1",
    status: "ready",
    intent: "do the thing",
    mutations,
    warnings: [],
    summary: "",
    createdAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
  };
}

const disable = (id: string, label: string): PlannedMutation => ({
  kind: "schedule.disable",
  targetId: id,
  targetLabel: label,
  value: null,
  before: "enabled",
  after: "disabled",
});

interface Recorder extends ExecutorDeps {
  calls: string[];
}

function recorder(fail?: (call: string) => boolean, failRollback?: boolean): Recorder {
  const calls: string[] = [];
  const record = (call: string) => {
    calls.push(call);
    if (fail?.(call)) throw new Error(`boom: ${call}`);
  };
  return {
    calls,
    setScheduleEnabled: async (id, enabled) => {
      if (failRollback && enabled) throw new Error("rollback failed");
      record(`schedule:${id}:${enabled}`);
    },
    setIssueState: async (fp, state) => record(`issue:${fp}:${state}`),
    abortInstance: async (id) => record(`abort:${id}`),
    setBudget: async (patch) => record(`budget:${JSON.stringify(patch)}`),
  };
}

test("a plan applies in order and reports what landed", async () => {
  const deps = recorder();
  const result = await executePlan(
    plan([disable("s1", "Nightly triage"), disable("s2", "Weekly audit")]),
    ctx(),
    deps,
  );
  assert.equal(result.status, "applied");
  assert.equal(result.applied.length, 2);
  assert.deepEqual(deps.calls, ["schedule:s1:false", "schedule:s2:false"]);
  assert.match(result.summary, /2 changes applied/);
});

test("an empty plan is a clean no-op", async () => {
  const result = await executePlan(plan([]), ctx(), recorder());
  assert.equal(result.status, "applied");
  assert.match(result.summary, /Nothing to do/);
});

test("regression: state that drifted since the preview stops the whole plan", async () => {
  const deps = recorder();
  // The user previewed "disable Nightly triage"; someone disabled it by hand in
  // the meantime. Applying anyway would mean confirming a plan that no longer
  // describes reality.
  const result = await executePlan(
    plan([disable("s1", "Nightly triage"), disable("s2", "Weekly audit")]),
    ctx({
      schedules: [schedule({ enabled: false }), schedule({ id: "s2", name: "Weekly audit" })],
    }),
    deps,
  );
  assert.equal(result.status, "stale");
  assert.deepEqual(deps.calls, [], "nothing at all is attempted");
  assert.match(result.summary, /Nothing was changed/);
});

test("regression: a target deleted since the preview stops the whole plan", async () => {
  const deps = recorder();
  const result = await executePlan(plan([disable("gone", "Ghost schedule")]), ctx(), deps);
  assert.equal(result.status, "stale");
  assert.deepEqual(deps.calls, []);
});

test("a failure part-way through reverses what already landed", async () => {
  const deps = recorder((call) => call === "schedule:s2:false");
  const result = await executePlan(
    plan([disable("s1", "Nightly triage"), disable("s2", "Weekly audit")]),
    ctx(),
    deps,
  );
  assert.equal(result.status, "rolled-back");
  assert.equal(result.applied.length, 0);
  assert.equal(result.reversed.length, 1);
  assert.equal(deps.calls.at(-1), "schedule:s1:true", "the first change was undone");
  assert.match(result.summary, /Nothing is in effect/);
});

test("rollback runs in reverse order", async () => {
  const deps = recorder((call) => call === "schedule:s3:false");
  const three = [disable("s1", "One"), disable("s2", "Two"), { ...disable("s3", "Three") }];
  await executePlan(
    plan(three),
    ctx({
      schedules: [
        schedule({ id: "s1", name: "One" }),
        schedule({ id: "s2", name: "Two" }),
        schedule({ id: "s3", name: "Three" }),
      ],
    }),
    deps,
  );
  // Later mutations can depend on earlier ones having landed, so the undo has
  // to unwind rather than replay.
  assert.deepEqual(deps.calls.slice(-2), ["schedule:s2:true", "schedule:s1:true"]);
});

test("regression: a rollback that itself fails is reported as partial, loudly", async () => {
  const deps = recorder((call) => call === "schedule:s2:false", true);
  const result = await executePlan(
    plan([disable("s1", "Nightly triage"), disable("s2", "Weekly audit")]),
    ctx(),
    deps,
  );
  // The one outcome that leaves the system part-changed. Folding it into a
  // generic error would be the most expensive lie this feature could tell.
  assert.equal(result.status, "partial");
  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0].targetLabel, "Nightly triage");
  assert.match(result.summary, /still in effect — check them by hand/);
  assert.ok(result.error);
});

test("an abort has no inverse, so a plan containing one can only be partly undone", async () => {
  const abort: PlannedMutation = {
    kind: "instance.abort",
    targetId: "inst1",
    targetLabel: "Release train",
    value: null,
    before: "running",
    after: "aborted",
  };
  assert.equal(inverseOf(abort), null);

  const deps = recorder((call) => call === "schedule:s2:false");
  const result = await executePlan(plan([abort, disable("s2", "Weekly audit")]), ctx(), deps);
  assert.equal(result.status, "partial");
  assert.equal(result.applied[0].kind, "instance.abort");
  // A killed process does not come back; claiming otherwise would make the
  // rollback report say more than happened.
  assert.match(result.summary, /could not be reversed/);
});

test("undoing a triage restores the state the issue actually had", () => {
  const resolved: PlannedMutation = {
    kind: "issue.resolve",
    targetId: "fp1",
    targetLabel: "ECONNREFUSED",
    value: null,
    before: "open",
    after: "resolved",
  };
  assert.deepEqual(inverseOf(resolved), { do: "issue.setState", id: "fp1", state: "open" });

  const wasIgnored: PlannedMutation = { ...resolved, before: "ignored" };
  assert.deepEqual(inverseOf(wasIgnored), { do: "issue.setState", id: "fp1", state: "ignored" });
});

test("undoing a budget change restores the previous limit, including 'no limit'", () => {
  const set: PlannedMutation = {
    kind: "budget.setDaily",
    targetId: "daily",
    targetLabel: "Daily budget",
    value: 25,
    before: "$10.00",
    after: "$25.00",
  };
  assert.deepEqual(inverseOf(set), { do: "budget.set", window: "daily", usd: 10 });

  const cleared: PlannedMutation = { ...set, value: null, before: "no limit", after: "no limit" };
  assert.deepEqual(inverseOf(cleared), { do: "budget.set", window: "daily", usd: null });
});

test("parseLimit reads the display string back, and refuses nonsense", () => {
  assert.equal(parseLimit("$12.50"), 12.5);
  assert.equal(parseLimit("no limit"), null);
  assert.equal(parseLimit(""), null);
  assert.equal(parseLimit("$0.00"), null);
});
