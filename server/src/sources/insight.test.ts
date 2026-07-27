import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSituation,
  soonestFire,
  throughputBuckets,
  THROUGHPUT_BUCKETS,
  type SituationInput,
} from "./insight.js";
import type { BudgetStatus } from "./budget.js";
import type { Agent } from "./types.js";
import type { Issue } from "./issues.js";
import type { MonitorHealth } from "./monitors.js";
import type { PipelineDefinition, PipelineInstance } from "./pipelineTypes.js";
import type { Run, ScheduleWithNext } from "./scheduleTypes.js";

const NOW = new Date("2026-07-07T10:30:00.000Z");
const iso = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();
const hours = (n: number) => n * 3_600_000;

const BUDGET_OK: BudgetStatus = {
  state: "ok",
  today: { spentUsd: 3.5, limitUsd: 25, ratio: 0.14 },
  month: { spentUsd: 80, limitUsd: 400, ratio: 0.2 },
  blockScheduled: false,
};

function run(over: Partial<Run> = {}): Run {
  return {
    id: "r1",
    scheduleId: "s1",
    scheduleName: "Dependency audit",
    prompt: "x",
    cwd: "/w",
    status: "succeeded",
    trigger: "scheduled",
    queuedAt: iso(hours(1)),
    startedAt: iso(hours(1)),
    endedAt: iso(hours(1) - 60_000),
    durationMs: 60_000,
    pid: 1,
    exitCode: 0,
    sessionId: null,
    project: null,
    resultSummary: null,
    error: null,
    ...over,
  };
}

function inst(over: Partial<PipelineInstance> = {}): PipelineInstance {
  return {
    id: "i1",
    pipelineId: "pl1",
    pipelineName: "Release train",
    status: "running",
    currentPhaseIndex: 0,
    phases: [],
    trigger: "scheduled",
    signalToken: "t",
    createdAt: iso(hours(2)),
    updatedAt: iso(hours(1)),
    endedAt: null,
    ...over,
  };
}

function monitor(over: Partial<MonitorHealth> = {}): MonitorHealth {
  return {
    scheduleId: "s1",
    name: "Dependency audit",
    enabled: true,
    status: "up",
    uptimePct: 100,
    lastRunAt: null,
    lastRunStatus: null,
    expectedAt: null,
    nextExpected: null,
    graceMs: 0,
    heartbeats: [],
    ...over,
  };
}

function agent(over: Partial<Agent> = {}): Agent {
  return {
    short: "a1",
    sessionId: null,
    name: "job",
    status: "working",
    tempo: null,
    detail: null,
    result: null,
    template: null,
    cwd: null,
    cliVersion: null,
    inFlight: null,
    createdAt: null,
    updatedAt: null,
    firstTerminalAt: null,
    live: true,
    pid: 1,
    ...over,
  };
}

function schedule(over: Partial<ScheduleWithNext> = {}): ScheduleWithNext {
  return {
    id: "s1",
    name: "Dependency audit",
    prompt: "x",
    cwd: "/w",
    trigger: { kind: "interval", everyMinutes: 60 },
    enabled: true,
    overlapPolicy: "skip",
    createdAt: iso(hours(100)),
    updatedAt: iso(hours(100)),
    lastRunAt: null,
    lastRunId: null,
    nextRun: iso(-hours(1)), // one hour from now
    ...over,
  };
}

function pipeline(over: Partial<PipelineDefinition> = {}): PipelineDefinition {
  return {
    id: "pl1",
    name: "Release train",
    phases: [],
    trigger: null,
    enabled: true,
    overlapPolicy: "skip",
    lastStartedAt: null,
    createdAt: iso(hours(100)),
    updatedAt: iso(hours(100)),
    ...over,
  };
}

function input(over: Partial<SituationInput> = {}): SituationInput {
  return {
    runs: [],
    instances: [],
    pipelines: [],
    schedules: [],
    monitors: [],
    issues: [],
    agents: [],
    budget: BUDGET_OK,
    ...over,
  };
}

describe("buildSituation — counts", () => {
  it("counts runs in flight", () => {
    const { counts } = buildSituation(
      input({ runs: [run({ status: "running" }), run({ id: "r2" })] }),
      NOW,
    );
    assert.equal(counts.runsInFlight, 1);
  });

  it("counts waiting gates per instance, not per phase", () => {
    // An instance has one current phase; counting phases would double-count a
    // re-run gate and disagree with the board.
    const waiting = inst({
      status: "awaiting-approval",
      phases: [
        {
          id: "p1",
          name: "a",
          gated: true,
          status: "awaiting-approval",
          steps: [],
          attempt: 2,
          payload: null,
        },
        {
          id: "p2",
          name: "b",
          gated: true,
          status: "awaiting-approval",
          steps: [],
          attempt: 1,
          payload: null,
        },
      ],
    });
    const { counts } = buildSituation(input({ instances: [waiting] }), NOW);
    assert.equal(counts.gatesWaiting, 1);
  });

  it("separates down from failing monitors", () => {
    const { counts } = buildSituation(
      input({
        monitors: [
          monitor({ status: "down" }),
          monitor({ scheduleId: "s2", status: "failing" }),
          monitor({ scheduleId: "s3", status: "failing" }),
          monitor({ scheduleId: "s4", status: "late" }),
          monitor({ scheduleId: "s5", status: "up" }),
        ],
      }),
      NOW,
    );
    assert.equal(counts.monitorsDown, 1);
    assert.equal(counts.monitorsFailing, 2);
  });

  it("counts only open issues and only live agents", () => {
    const { counts } = buildSituation(
      input({
        issues: [
          { state: "open" } as Issue,
          { state: "resolved" } as Issue,
          { state: "ignored" } as Issue,
        ],
        agents: [agent(), agent({ short: "a2", live: false })],
      }),
      NOW,
    );
    assert.equal(counts.openIssues, 1);
    assert.equal(counts.liveAgents, 1);
  });

  it("counts failed instances", () => {
    const { counts } = buildSituation(
      input({ instances: [inst({ status: "failed" }), inst({ id: "i2", status: "succeeded" })] }),
      NOW,
    );
    assert.equal(counts.failedInstances, 1);
  });

  it("reports all-zero for an empty home", () => {
    const { counts } = buildSituation(input(), NOW);
    assert.deepEqual(counts, {
      runsInFlight: 0,
      gatesWaiting: 0,
      failedInstances: 0,
      monitorsDown: 0,
      monitorsFailing: 0,
      openIssues: 0,
      liveAgents: 0,
      anomalies: 0,
    });
  });
});

describe("soonestFire", () => {
  it("returns the nearest upcoming schedule", () => {
    const fire = soonestFire(
      input({
        schedules: [
          schedule({ id: "far", name: "Far", nextRun: iso(-hours(5)) }),
          schedule({ id: "near", name: "Near", nextRun: iso(-hours(1)) }),
        ],
      }),
      NOW,
    );
    assert.equal(fire?.id, "near");
    assert.equal(fire?.kind, "schedule");
  });

  it("skips disabled schedules and ones with no next slot", () => {
    assert.equal(soonestFire(input({ schedules: [schedule({ enabled: false })] }), NOW), null);
    assert.equal(soonestFire(input({ schedules: [schedule({ nextRun: null })] }), NOW), null);
  });

  it("projects a pipeline's own trigger, so it agrees with what will fire", () => {
    const fire = soonestFire(
      input({ pipelines: [pipeline({ trigger: { kind: "interval", everyMinutes: 10 } })] }),
      NOW,
    );
    assert.equal(fire?.kind, "pipeline");
    assert.ok(fire && new Date(fire.at).getTime() > NOW.getTime());
  });

  it("ignores a manual or disabled pipeline", () => {
    assert.equal(soonestFire(input({ pipelines: [pipeline({ trigger: null })] }), NOW), null);
    assert.equal(
      soonestFire(
        input({
          pipelines: [
            pipeline({ enabled: false, trigger: { kind: "interval", everyMinutes: 10 } }),
          ],
        }),
        NOW,
      ),
      null,
    );
  });

  it("compares schedules and pipelines against each other", () => {
    const fire = soonestFire(
      input({
        schedules: [schedule({ id: "s", name: "Sched", nextRun: iso(-hours(3)) })],
        pipelines: [pipeline({ trigger: { kind: "interval", everyMinutes: 5 } })],
      }),
      NOW,
    );
    assert.equal(fire?.kind, "pipeline"); // 5 minutes beats 3 hours
  });

  it("returns null when nothing is scheduled", () => {
    assert.equal(soonestFire(input(), NOW), null);
  });
});

describe("throughputBuckets", () => {
  it("always returns a fixed-length window, so a sparkline is comparable", () => {
    assert.equal(throughputBuckets([], NOW).length, THROUGHPUT_BUCKETS);
  });

  it("aligns buckets to the hour so the axis does not slide between requests", () => {
    const a = throughputBuckets([], new Date("2026-07-07T10:00:01.000Z"));
    const b = throughputBuckets([], new Date("2026-07-07T10:59:59.000Z"));
    assert.deepEqual(
      a.map((x) => x.at),
      b.map((x) => x.at),
    );
  });

  it("buckets a run by when it finished, not when it started", () => {
    // A long run's outcome belongs to the hour it landed in.
    const buckets = throughputBuckets(
      [run({ startedAt: iso(hours(5)), endedAt: iso(hours(1)) })],
      NOW,
    );
    const withData = buckets.filter((b) => b.succeeded + b.failed > 0);
    assert.equal(withData.length, 1);
    assert.equal(new Date(withData[0].at).getUTCHours(), 9);
  });

  it("counts a failing outcome as a failure even when the process exited 0", () => {
    const buckets = throughputBuckets([run({ status: "succeeded", outcome: "failed" })], NOW);
    const totals = buckets.reduce(
      (acc, b) => ({ ok: acc.ok + b.succeeded, bad: acc.bad + b.failed }),
      { ok: 0, bad: 0 },
    );
    assert.deepEqual(totals, { ok: 0, bad: 1 });
  });

  it("counts a blocked outcome as a failure", () => {
    const buckets = throughputBuckets([run({ status: "succeeded", outcome: "blocked" })], NOW);
    assert.equal(
      buckets.reduce((n, b) => n + b.failed, 0),
      1,
    );
  });

  it("ignores runs outside the window and unparseable timestamps", () => {
    const buckets = throughputBuckets(
      [
        run({ id: "old", endedAt: iso(hours(48)) }),
        run({ id: "bad", endedAt: "not-a-date", startedAt: null, queuedAt: "also-bad" }),
      ],
      NOW,
    );
    assert.equal(
      buckets.reduce((n, b) => n + b.succeeded + b.failed, 0),
      0,
    );
  });

  it("ignores statuses that are neither success nor failure", () => {
    const buckets = throughputBuckets(
      [run({ status: "skipped" }), run({ id: "r2", status: "cancelled" })],
      NOW,
    );
    assert.equal(
      buckets.reduce((n, b) => n + b.succeeded + b.failed, 0),
      0,
    );
  });

  it("falls back to startedAt then queuedAt when a run never ended", () => {
    const buckets = throughputBuckets(
      [run({ status: "failed", endedAt: null, startedAt: iso(hours(2)) })],
      NOW,
    );
    assert.equal(
      buckets.reduce((n, b) => n + b.failed, 0),
      1,
    );
  });
});

describe("buildSituation — assembly", () => {
  it("stamps the generation time and passes the budget windows through", () => {
    const situation = buildSituation(input(), NOW);
    assert.equal(situation.generatedAt, NOW.toISOString());
    assert.deepEqual(situation.spend, {
      state: "ok",
      today: BUDGET_OK.today,
      month: BUDGET_OK.month,
    });
  });
});
