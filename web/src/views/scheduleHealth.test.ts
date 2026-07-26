import { describe, expect, it } from "vitest";
import type { Run, ScheduleWithNext } from "../types";
import {
  runVerdict,
  scheduleHealth,
  scheduleHealthById,
  summarizeSchedules,
} from "./scheduleHealth";

const NOW = Date.parse("2026-07-26T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

function schedule(over: Partial<ScheduleWithNext> = {}): ScheduleWithNext {
  return {
    id: "s1",
    name: "Nightly audit",
    prompt: "audit",
    cwd: "/repo",
    trigger: { kind: "interval", everyMinutes: 360 },
    enabled: true,
    overlapPolicy: "skip",
    createdAt: minutesAgo(10_000),
    updatedAt: minutesAgo(10_000),
    lastRunAt: null,
    lastRunId: null,
    nextRun: new Date(NOW + 30 * 60_000).toISOString(),
    ...over,
  };
}

function run(over: Partial<Run> = {}): Run {
  const ended = over.endedAt ?? minutesAgo(60);
  return {
    id: "r1",
    scheduleId: "s1",
    scheduleName: "Nightly audit",
    prompt: "audit",
    cwd: "/repo",
    status: "succeeded",
    trigger: "scheduled",
    queuedAt: ended,
    startedAt: ended,
    endedAt: ended,
    durationMs: 12_000,
    pid: null,
    exitCode: 0,
    sessionId: null,
    project: null,
    resultSummary: null,
    error: null,
    ...over,
  };
}

describe("runVerdict", () => {
  it("prefers a failing work outcome over a clean exit code", () => {
    // A phase can exit 0 and still signal that the work failed; if the row says
    // failed, the health summary has to agree or the two contradict each other.
    expect(runVerdict(run({ status: "succeeded", outcome: "failed" }))).toBe("failure");
    expect(runVerdict(run({ status: "succeeded", outcome: "blocked" }))).toBe("failure");
  });

  it("treats machine-level endings as inconclusive, not failures", () => {
    // An overlap-skipping schedule would otherwise look permanently broken.
    for (const status of ["skipped", "cancelled", "interrupted"] as const) {
      expect(runVerdict(run({ status }))).toBe("inconclusive");
    }
  });

  it("reads plain successes and failures", () => {
    expect(runVerdict(run({ status: "succeeded" }))).toBe("success");
    expect(runVerdict(run({ status: "failed" }))).toBe("failure");
    expect(runVerdict(run({ status: "running" }))).toBe("running");
  });
});

describe("scheduleHealth", () => {
  it("counts only the failures at the head of the history", () => {
    const health = scheduleHealth(schedule(), [
      run({ id: "a", status: "failed" }),
      run({ id: "b", status: "failed" }),
      run({ id: "c", status: "succeeded" }),
      run({ id: "d", status: "failed" }),
    ]);
    expect(health.consecutiveFailures).toBe(2);
    expect(health.failures).toBe(3);
    expect(health.conclusive).toBe(4);
    expect(health.state).toBe("failing");
  });

  it("does not let an inconclusive run break a failure streak", () => {
    // A skipped slot between two failures is not a recovery.
    const health = scheduleHealth(schedule(), [
      run({ id: "a", status: "failed" }),
      run({ id: "b", status: "skipped" }),
      run({ id: "c", status: "failed" }),
    ]);
    expect(health.consecutiveFailures).toBe(2);
  });

  it("ignores other schedules' runs", () => {
    const health = scheduleHealth(schedule({ id: "mine" }), [
      run({ id: "a", scheduleId: "theirs", status: "failed" }),
      run({ id: "b", scheduleId: "mine", status: "succeeded" }),
    ]);
    expect(health.runs).toHaveLength(1);
    expect(health.state).toBe("healthy");
  });

  it("reports the newest conclusive run, skipping the one in flight", () => {
    const health = scheduleHealth(schedule(), [
      run({ id: "live", status: "running", endedAt: null }),
      run({ id: "done", status: "succeeded", endedAt: minutesAgo(90) }),
    ]);
    expect(health.lastConclusive?.id).toBe("done");
    expect(health.running).toHaveLength(1);
    expect(health.state).toBe("running");
  });

  it("says paused before anything else, because a paused schedule will not fire", () => {
    const health = scheduleHealth(schedule({ enabled: false }), [run({ status: "failed" })]);
    expect(health.state).toBe("paused");
  });

  it("distinguishes never-run from healthy", () => {
    expect(scheduleHealth(schedule(), []).state).toBe("unproven");
    expect(scheduleHealth(schedule(), [run({ status: "skipped" })]).state).toBe("unproven");
    expect(scheduleHealth(schedule(), [run({ status: "succeeded" })]).state).toBe("healthy");
  });
});

describe("scheduleHealthById", () => {
  it("groups in one pass and matches the per-schedule computation", () => {
    const schedules = [schedule({ id: "a" }), schedule({ id: "b", enabled: false })];
    const runs = [
      run({ id: "1", scheduleId: "a", status: "failed" }),
      run({ id: "2", scheduleId: "b", status: "succeeded" }),
      run({ id: "3", scheduleId: "gone", status: "succeeded" }),
    ];
    const map = scheduleHealthById(schedules, runs);
    expect(map.size).toBe(2);
    expect(map.get("a")).toEqual(scheduleHealth(schedules[0], runs));
    expect(map.get("b")?.state).toBe("paused");
  });
});

describe("summarizeSchedules", () => {
  it("tallies each state exactly once", () => {
    const schedules = [
      schedule({ id: "ok" }),
      schedule({ id: "bad" }),
      schedule({ id: "off", enabled: false }),
      schedule({ id: "new" }),
    ];
    const runs = [
      run({ id: "1", scheduleId: "ok", status: "succeeded" }),
      run({ id: "2", scheduleId: "bad", status: "failed" }),
      run({ id: "3", scheduleId: "off", status: "succeeded" }),
    ];
    const summary = summarizeSchedules(schedules, runs, NOW);
    expect(summary).toMatchObject({ total: 4, failing: 1, paused: 1, unproven: 1, running: 0 });
  });

  it("never promises a firing a paused schedule will not deliver", () => {
    const soon = new Date(NOW + 60_000).toISOString();
    const later = new Date(NOW + 600_000).toISOString();
    const summary = summarizeSchedules(
      [
        schedule({ id: "off", enabled: false, nextRun: soon }),
        schedule({ id: "on", nextRun: later }),
      ],
      [],
      NOW,
    );
    expect(summary.nextFiring?.schedule.id).toBe("on");
    expect(summary.nextFiring?.at).toBe(later);
  });

  it("has no next firing when nothing is armed", () => {
    const summary = summarizeSchedules([schedule({ nextRun: null })], [], NOW);
    expect(summary.nextFiring).toBeNull();
  });

  it("survives an unparseable nextRun rather than ordering by NaN", () => {
    const good = new Date(NOW + 120_000).toISOString();
    const summary = summarizeSchedules(
      [schedule({ id: "junk", nextRun: "not a date" }), schedule({ id: "good", nextRun: good })],
      [],
      NOW,
    );
    expect(summary.nextFiring?.schedule.id).toBe("good");
  });

  it("counts the 24h window by when a verdict landed, across every schedule", () => {
    const runs = [
      run({ id: "1", scheduleId: "a", status: "succeeded", endedAt: minutesAgo(30) }),
      run({ id: "2", scheduleId: "b", status: "failed", endedAt: minutesAgo(600) }),
      // Older than the window.
      run({ id: "3", scheduleId: "a", status: "failed", endedAt: minutesAgo(2000) }),
      // Never reached a verdict.
      run({ id: "4", scheduleId: "a", status: "running", endedAt: null }),
      run({ id: "5", scheduleId: "a", status: "skipped", endedAt: minutesAgo(5) }),
    ];
    const summary = summarizeSchedules([schedule({ id: "a" }), schedule({ id: "b" })], runs, NOW);
    expect(summary.recentRuns).toBe(2);
    expect(summary.recentFailures).toBe(1);
  });

  it("falls back to the queue instant when a run has no end", () => {
    // A failed run can be recorded without an endedAt; dropping it would
    // undercount the day.
    const summary = summarizeSchedules(
      [schedule()],
      [run({ status: "failed", endedAt: null, startedAt: null, queuedAt: minutesAgo(20) })],
      NOW,
    );
    expect(summary.recentRuns).toBe(1);
    expect(summary.recentFailures).toBe(1);
  });
});
