import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChronicle, packRows, type ChronicleSpan } from "./chronicle.js";
import type { Run } from "./scheduleTypes.js";
import type { Agent } from "./types.js";
import type { SessionSummary } from "./sessions.js";

const NOW = new Date("2026-07-09T12:00:00.000Z");
const HOUR = 3_600_000;

function run(id: string, over: Partial<Run> = {}): Run {
  return {
    id,
    scheduleId: "sched-1",
    scheduleName: "Nightly triage",
    prompt: "triage the queue",
    cwd: "/repo",
    status: "succeeded",
    trigger: "scheduled",
    queuedAt: "2026-07-09T10:00:00.000Z",
    startedAt: "2026-07-09T10:00:05.000Z",
    endedAt: "2026-07-09T10:12:00.000Z",
    durationMs: 715_000,
    pid: null,
    exitCode: 0,
    sessionId: null,
    project: null,
    resultSummary: "done",
    error: null,
    ...over,
  };
}

function agent(short: string, over: Partial<Agent> = {}): Agent {
  return {
    short,
    sessionId: null,
    name: `agent-${short}`,
    status: "done",
    tempo: null,
    detail: null,
    result: null,
    template: null,
    cwd: null,
    cliVersion: null,
    inFlight: null,
    createdAt: "2026-07-09T09:00:00.000Z",
    updatedAt: "2026-07-09T09:30:00.000Z",
    firstTerminalAt: "2026-07-09T09:25:00.000Z",
    live: false,
    pid: null,
    ...over,
  };
}

function session(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    project: "-home-user-proj",
    projectLabel: "home/user/proj",
    title: `Session ${id}`,
    messageCount: 4,
    toolUseCount: 1,
    model: "claude-sonnet-5",
    firstActivity: "2026-07-09T11:00:00.000Z",
    lastActivity: "2026-07-09T11:20:00.000Z",
    ...over,
  };
}

function span(id: string, startedAt: string, endedAt: string | null): ChronicleSpan {
  return {
    id,
    kind: "run",
    label: id,
    status: "done",
    startedAt,
    endedAt,
    href: null,
    detail: null,
    costUsd: null,
    tokens: null,
  };
}

test("maps runs, agents, and sessions into grouped spans", () => {
  const out = buildChronicle(
    { runs: [run("r1")], agents: [agent("a1")], sessions: [session("s1")] },
    NOW,
    24 * HOUR,
  );
  assert.equal(out.totals.spans, 3);
  const keys = out.groups.map((g) => g.key).sort();
  assert.deepEqual(keys, ["agents", "run:sched-1", "session:-home-user-proj"]);
  const runGroup = out.groups.find((g) => g.key === "run:sched-1");
  assert.equal(runGroup?.label, "Nightly triage");
  assert.equal(runGroup?.rows[0][0].status, "done");
  assert.equal(runGroup?.rows[0][0].endedAt, "2026-07-09T10:12:00.000Z");
});

test("running runs and live working agents are open-ended (endedAt null)", () => {
  const out = buildChronicle(
    {
      runs: [run("r1", { status: "running", endedAt: null })],
      agents: [agent("a1", { status: "working", live: true })],
      sessions: [],
    },
    NOW,
    24 * HOUR,
  );
  for (const g of out.groups) {
    assert.equal(g.rows[0][0].endedAt, null);
  }
  assert.equal(out.totals.active, 2);
});

test("a working-but-dead agent is closed at firstTerminalAt/updatedAt", () => {
  const out = buildChronicle(
    {
      runs: [],
      agents: [agent("a1", { status: "working", live: false, firstTerminalAt: null })],
      sessions: [],
    },
    NOW,
    24 * HOUR,
  );
  assert.equal(out.groups[0].rows[0][0].endedAt, "2026-07-09T09:30:00.000Z");
});

test("a session active within the last two minutes reads as in flight", () => {
  const out = buildChronicle(
    {
      runs: [],
      agents: [],
      sessions: [session("s1", { lastActivity: "2026-07-09T11:59:30.000Z" })],
    },
    NOW,
    24 * HOUR,
  );
  const s = out.groups[0].rows[0][0];
  assert.equal(s.status, "working");
  assert.equal(s.endedAt, null);
});

test("spans outside the window are dropped; overlapping ones survive", () => {
  const out = buildChronicle(
    {
      runs: [
        run("old", {
          startedAt: "2026-07-08T00:00:00.000Z",
          endedAt: "2026-07-08T00:10:00.000Z",
        }),
        // Started before the window but ended inside it — must survive.
        run("straddle", {
          startedAt: "2026-07-09T10:30:00.000Z",
          endedAt: "2026-07-09T11:30:00.000Z",
        }),
      ],
      agents: [],
      sessions: [],
    },
    NOW,
    1 * HOUR,
  );
  assert.equal(out.totals.spans, 1);
  assert.equal(out.groups[0].rows[0][0].id, "run:straddle");
});

test("failed outcome trumps a clean exit status", () => {
  const out = buildChronicle(
    { runs: [run("r1", { status: "succeeded", outcome: "failed" })], agents: [], sessions: [] },
    NOW,
    24 * HOUR,
  );
  assert.equal(out.groups[0].rows[0][0].status, "failed");
  assert.equal(out.totals.failed, 1);
});

test("totals sum cost and tokens, staying null when nothing reports them", () => {
  const withCost = buildChronicle(
    {
      runs: [run("r1", { costUsd: 0.25, tokens: 1000 }), run("r2", { costUsd: 0.5, tokens: 500 })],
      agents: [],
      sessions: [],
    },
    NOW,
    24 * HOUR,
  );
  assert.equal(withCost.totals.costUsd, 0.75);
  assert.equal(withCost.totals.tokens, 1500);

  const noCost = buildChronicle({ runs: [], agents: [agent("a1")], sessions: [] }, NOW, 24 * HOUR);
  assert.equal(noCost.totals.costUsd, null);
  assert.equal(noCost.totals.tokens, null);
});

test("groups with in-flight work sort first, then by recency", () => {
  const out = buildChronicle(
    {
      runs: [run("r1", { endedAt: "2026-07-09T11:55:00.000Z" })],
      agents: [agent("a1", { status: "working", live: true })],
      sessions: [session("s1", { lastActivity: "2026-07-09T11:00:00.000Z" })],
    },
    NOW,
    24 * HOUR,
  );
  assert.deepEqual(
    out.groups.map((g) => g.key),
    ["agents", "run:sched-1", "session:-home-user-proj"],
  );
});

test("packRows stacks overlapping spans and reuses freed rows", () => {
  const nowMs = NOW.getTime();
  const rows = packRows(
    [
      span("a", "2026-07-09T10:00:00.000Z", "2026-07-09T10:30:00.000Z"),
      span("b", "2026-07-09T10:15:00.000Z", "2026-07-09T10:45:00.000Z"), // overlaps a
      span("c", "2026-07-09T10:40:00.000Z", "2026-07-09T11:00:00.000Z"), // fits after a
    ],
    nowMs,
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows[0].map((s) => s.id),
    ["a", "c"],
  );
  assert.deepEqual(
    rows[1].map((s) => s.id),
    ["b"],
  );
});

test("an open-ended span blocks its row through now", () => {
  const nowMs = NOW.getTime();
  const rows = packRows(
    [
      span("live", "2026-07-09T10:00:00.000Z", null),
      span("later", "2026-07-09T11:00:00.000Z", "2026-07-09T11:10:00.000Z"),
    ],
    nowMs,
  );
  assert.equal(rows.length, 2);
});

test("invalid timestamps are skipped instead of crashing", () => {
  const out = buildChronicle(
    {
      runs: [run("r1", { startedAt: "not-a-date", queuedAt: "also-bad" })],
      agents: [agent("a1", { createdAt: null })],
      sessions: [session("s1", { firstActivity: null })],
    },
    NOW,
    24 * HOUR,
  );
  assert.equal(out.totals.spans, 0);
  assert.deepEqual(out.groups, []);
});

test("one-off launches share a single lane labeled 'One-off runs'", () => {
  const out = buildChronicle(
    {
      runs: [
        run("r1", { scheduleId: "oneoff", scheduleName: "Quick audit" }),
        run("r2", {
          scheduleId: "oneoff",
          scheduleName: "Fix lint",
          startedAt: "2026-07-09T11:00:00.000Z",
          endedAt: "2026-07-09T11:05:00.000Z",
        }),
      ],
      agents: [],
      sessions: [],
    },
    NOW,
    24 * HOUR,
  );
  const group = out.groups.find((g) => g.key === "run:oneoff");
  assert.equal(group?.label, "One-off runs");
  const labels = group!.rows
    .flat()
    .map((s) => s.label)
    .sort();
  assert.deepEqual(labels, ["Fix lint", "Quick audit"]);
});
