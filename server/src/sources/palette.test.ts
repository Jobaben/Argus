import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPalette, describeTrigger, type PaletteInput } from "./palette.js";
import type { Agent } from "./types.js";
import type { Issue } from "./issues.js";
import type { MonitorHealth } from "./monitors.js";
import type { PipelineDefinition, PipelineInstance } from "./pipelineTypes.js";
import type { ScheduleWithNext } from "./scheduleTypes.js";
import type { SessionSummary } from "./sessions.js";

const NOW = new Date("2026-07-07T10:00:00.000Z");

function def(over: Partial<PipelineDefinition> = {}): PipelineDefinition {
  return {
    id: "pl1",
    name: "Release train",
    phases: [
      { id: "p1", name: "Gather", cwd: "/w", steps: [], gated: false },
      { id: "p2", name: "Publish", cwd: "/w", steps: [], gated: true },
    ],
    trigger: { kind: "daily", time: "23:00" },
    enabled: true,
    overlapPolicy: "skip",
    lastStartedAt: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
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
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    endedAt: null,
    ...over,
  };
}

function schedule(over: Partial<ScheduleWithNext> = {}): ScheduleWithNext {
  return {
    id: "s1",
    name: "Dependency audit",
    prompt: "audit",
    cwd: "/home/me/starling",
    trigger: { kind: "interval", everyMinutes: 360 },
    enabled: true,
    overlapPolicy: "skip",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    lastRunAt: null,
    lastRunId: null,
    nextRun: null,
    ...over,
  };
}

function monitor(over: Partial<MonitorHealth> = {}): MonitorHealth {
  return {
    scheduleId: "s1",
    name: "Dependency audit",
    enabled: true,
    status: "failing",
    uptimePct: 33.3,
    lastRunAt: NOW.toISOString(),
    lastRunStatus: "failed",
    expectedAt: null,
    nextExpected: null,
    graceMs: 300_000,
    heartbeats: [],
    ...over,
  };
}

function issue(over: Partial<Issue> = {}): Issue {
  return {
    fingerprint: "abcdef0123456789",
    title: "npm audit: 3 critical vulnerabilities",
    count: 2,
    firstSeen: NOW.toISOString(),
    lastSeen: NOW.toISOString(),
    schedules: ["Dependency audit"],
    state: "open",
    lastRunId: "r1",
    members: ["ffffffffffffffff"],
    failureClass: null,
    ...over,
  };
}

function agent(over: Partial<Agent> = {}): Agent {
  return {
    short: "7f3ac21",
    sessionId: "sess-1",
    name: "Refactor billing adapters",
    status: "working",
    tempo: null,
    detail: "Rewriting StripeAdapter",
    result: null,
    template: null,
    cwd: "/home/me/starling",
    cliVersion: null,
    inFlight: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    firstTerminalAt: null,
    live: true,
    pid: 1,
    ...over,
  };
}

function session(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "sess-1",
    project: "-home-me-starling",
    projectLabel: "home/me/starling",
    title: "Trace the duplicate-charge report",
    messageCount: 12,
    toolUseCount: 4,
    model: null,
    firstActivity: NOW.toISOString(),
    lastActivity: NOW.toISOString(),
    ...over,
  };
}

function input(over: Partial<PaletteInput> = {}): PaletteInput {
  return {
    pipelines: [],
    latestByPipeline: new Map(),
    schedules: [],
    monitors: [],
    issues: [],
    agents: [],
    projects: [],
    sessions: [],
    ...over,
  };
}

describe("describeTrigger", () => {
  it("renders each trigger kind compactly", () => {
    assert.equal(describeTrigger(null), "manual");
    assert.equal(describeTrigger({ kind: "daily", time: "23:00" }), "daily 23:00");
    assert.equal(describeTrigger({ kind: "weekly", weekday: 1, time: "08:00" }), "Mon 08:00");
    assert.equal(describeTrigger({ kind: "interval", everyMinutes: 30 }), "every 30m");
    assert.equal(
      describeTrigger({
        kind: "windowed",
        everyMinutes: 120,
        startTime: "09:00",
        endTime: "18:00",
      }),
      "every 2h 09:00–18:00",
    );
  });

  it("scales interval units so a daily cadence does not read as 1440m", () => {
    assert.equal(describeTrigger({ kind: "interval", everyMinutes: 360 }), "every 6h");
    assert.equal(describeTrigger({ kind: "interval", everyMinutes: 2880 }), "every 2d");
  });

  it("degrades gracefully when a field is missing", () => {
    assert.equal(describeTrigger({ kind: "interval" }), "every —");
    assert.equal(describeTrigger({ kind: "daily" }), "daily —");
  });
});

describe("buildPalette", () => {
  it("stamps the generation time", () => {
    assert.equal(buildPalette(input(), NOW).generatedAt, NOW.toISOString());
  });

  it("lists a pipeline with its phase count, trigger and deep link", () => {
    const { entries } = buildPalette(input({ pipelines: [def()] }), NOW);
    assert.equal(entries.length, 1);
    assert.deepEqual(
      { ...entries[0], keywords: undefined },
      {
        kind: "pipeline",
        id: "pl1",
        title: "Release train",
        subtitle: "2 phases · daily 23:00",
        href: "#/command",
        badge: null,
        severity: "none",
        keywords: undefined,
      },
    );
  });

  it("makes phase names searchable without rendering them", () => {
    const { entries } = buildPalette(input({ pipelines: [def()] }), NOW);
    assert.ok(entries[0].keywords?.includes("Publish"));
    assert.ok(!entries[0].subtitle?.includes("Publish"));
  });

  it("reflects the newest instance's status as the pipeline badge", () => {
    const { entries } = buildPalette(
      input({
        pipelines: [def()],
        latestByPipeline: new Map([["pl1", inst({ status: "failed" })]]),
      }),
      NOW,
    );
    assert.equal(entries[0].badge, "failed");
    assert.equal(entries[0].severity, "error");
  });

  it("exposes the instance id of a pipeline waiting at a gate, so it can be approved", () => {
    const { entries } = buildPalette(
      input({
        pipelines: [def()],
        latestByPipeline: new Map([["pl1", inst({ id: "i9", status: "awaiting-approval" })]]),
      }),
      NOW,
    );
    assert.equal(entries[0].gateInstanceId, "i9");
    assert.equal(entries[0].badge, "needs approval");
  });

  it("does not offer a gate action for a pipeline that is not waiting", () => {
    for (const status of ["running", "failed", "succeeded", "aborted"] as const) {
      const { entries } = buildPalette(
        input({ pipelines: [def()], latestByPipeline: new Map([["pl1", inst({ status })]]) }),
        NOW,
      );
      assert.equal(entries[0].gateInstanceId, undefined, status);
    }
  });

  it("marks every schedule runnable and notes a disabled one", () => {
    const { entries } = buildPalette(
      input({ schedules: [schedule(), schedule({ id: "s2", name: "Paused", enabled: false })] }),
      NOW,
    );
    assert.equal(entries[0].runnableScheduleId, "s1");
    assert.equal(entries[0].subtitle, "every 6h");
    assert.equal(entries[1].subtitle, "every 6h · disabled");
    assert.equal(entries[1].badge, "paused");
  });

  it("makes a schedule findable by its working directory", () => {
    const { entries } = buildPalette(input({ schedules: [schedule()] }), NOW);
    assert.ok(entries[0].keywords?.includes("/home/me/starling"));
  });

  it("only lists a monitor that wants attention, so schedules are not duplicated", () => {
    const { entries } = buildPalette(
      input({
        monitors: [
          monitor({ status: "up" }),
          monitor({ scheduleId: "s2", status: "paused" }),
          monitor({ scheduleId: "s3", status: "down" }),
          monitor({ scheduleId: "s4", status: "late" }),
        ],
      }),
      NOW,
    );
    assert.deepEqual(
      entries.map((e) => e.id),
      ["s3", "s4"],
    );
    assert.deepEqual(
      entries.map((e) => e.severity),
      ["error", "warn"],
    );
  });

  it("says so when a monitor has no completed runs to compute uptime from", () => {
    const { entries } = buildPalette(
      input({ monitors: [monitor({ status: "pending", uptimePct: null })] }),
      NOW,
    );
    assert.equal(entries[0].subtitle, "no completed runs yet");
    assert.equal(entries[0].severity, "info");
  });

  it("lists open issues only — triaged ones are not attention", () => {
    const { entries } = buildPalette(
      input({
        issues: [
          issue(),
          issue({ fingerprint: "1111111111111111", state: "resolved" }),
          issue({ fingerprint: "2222222222222222", state: "ignored" }),
        ],
      }),
      NOW,
    );
    assert.equal(entries.length, 1);
    assert.equal(entries[0].badge, "2×");
    assert.equal(entries[0].severity, "error");
  });

  it("deep-links an agent by its short id, url-encoded", () => {
    const { entries } = buildPalette(input({ agents: [agent({ short: "a b" })] }), NOW);
    assert.equal(entries[0].href, "#/agent/a%20b");
  });

  it("prefers 'live' over the recorded status on an agent that is running now", () => {
    const { entries } = buildPalette(input({ agents: [agent({ live: true })] }), NOW);
    assert.equal(entries[0].badge, "live");
    assert.equal(entries[0].severity, "info");
  });

  it("shows no badge for an agent whose state Argus could not determine", () => {
    const { entries } = buildPalette(
      input({ agents: [agent({ live: false, status: "unknown" })] }),
      NOW,
    );
    assert.equal(entries[0].badge, null);
  });

  it("deep-links a transcript the way the Sessions view reads it", () => {
    const { entries } = buildPalette(input({ sessions: [session()] }), NOW);
    assert.equal(entries[0].href, "#/sessions/-home-me-starling/sess-1");
  });

  it("caps the transcript tail so the index cannot become a session list", () => {
    const many = Array.from({ length: 60 }, (_, i) => session({ id: `s${i}` }));
    const { entries } = buildPalette(input({ sessions: many }), NOW);
    assert.equal(entries.filter((e) => e.kind === "session").length, 25);
  });

  it("orders kinds so the things needing a human come before the long tail", () => {
    const { entries } = buildPalette(
      input({
        pipelines: [def()],
        schedules: [schedule()],
        monitors: [monitor({ status: "down" })],
        issues: [issue()],
        agents: [agent()],
        projects: [{ id: "p", label: "proj", sessionCount: 1, lastActivity: null }],
        sessions: [session()],
      }),
      NOW,
    );
    assert.deepEqual(
      entries.map((e) => e.kind),
      ["pipeline", "schedule", "monitor", "issue", "agent", "project", "session"],
    );
  });

  it("returns an empty index for an empty home rather than throwing", () => {
    assert.deepEqual(buildPalette(input(), NOW).entries, []);
  });
});
