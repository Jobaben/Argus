import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ActivityRail } from "./ActivityRail";
import type { Run } from "../types";
import type { OverviewRow } from "../ds";
import type { LiveActivity } from "../useRunActivity";

function run(over: Partial<Run> = {}): Run {
  return {
    id: "r1",
    scheduleId: "s1",
    scheduleName: "Dependency audit",
    prompt: "x",
    cwd: "/w",
    status: "succeeded",
    trigger: "scheduled",
    queuedAt: "2026-07-07T10:00:00.000Z",
    startedAt: "2026-07-07T10:00:00.000Z",
    endedAt: "2026-07-07T10:01:00.000Z",
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

function row(over: Partial<OverviewRow> = {}): OverviewRow {
  return {
    pipelineId: "pl1",
    instanceId: "i1",
    instanceLabel: "i1",
    name: "Release train",
    badge: "working",
    model: null,
    updatedAt: "2026-07-07T10:00:00.000Z",
    cost: null,
    gate: null,
    failure: null,
    phases: [],
    ...over,
  } as OverviewRow;
}

const NO_ACTIVITY = new Map<string, LiveActivity>();

describe("ActivityRail — live", () => {
  it("says nothing is running rather than showing an empty section", () => {
    render(<ActivityRail rows={[]} liveActivity={NO_ACTIVITY} runs={[]} loading={false} />);
    expect(screen.getByText(/nothing is running/i)).toBeInTheDocument();
  });

  it("lists a working step with its pipeline name and live tool call", () => {
    const rows = [
      row({
        phases: [
          {
            id: "p1",
            name: "Implement",
            status: "working",
            reason: null,
            steps: [{ name: "Write the fix", runId: "r9", status: "working" }],
          },
        ],
      } as Partial<OverviewRow>),
    ];
    render(
      <ActivityRail
        rows={rows}
        liveActivity={new Map([["r9", { label: "Edit src/replay.ts", at: "t" }]])}
        runs={[]}
        loading={false}
      />,
    );
    expect(screen.getByText("Release train · Write the fix")).toBeInTheDocument();
    expect(screen.getByText(/Edit src\/replay\.ts/)).toBeInTheDocument();
  });

  it("says 'starting…' for a working step that has not reported activity yet", () => {
    const rows = [
      row({
        phases: [
          {
            id: "p1",
            name: "Implement",
            status: "working",
            reason: null,
            steps: [{ name: "Write the fix", runId: "r9", status: "working" }],
          },
        ],
      } as Partial<OverviewRow>),
    ];
    render(<ActivityRail rows={rows} liveActivity={NO_ACTIVITY} runs={[]} loading={false} />);
    expect(screen.getByText("starting…")).toBeInTheDocument();
  });

  it("includes in-flight runs the board does not own, so the rail cannot lie", () => {
    // A scheduled firing or a one-off Launch is not on the board; without this
    // the rail would claim nothing is running mid-flight.
    render(
      <ActivityRail
        rows={[]}
        liveActivity={NO_ACTIVITY}
        runs={[run({ id: "r5", status: "running", scheduleName: "Nightly code review" })]}
        loading={false}
      />,
    );
    expect(screen.getByText("Nightly code review")).toBeInTheDocument();
    expect(screen.queryByText(/nothing is running/i)).toBeNull();
  });
});

describe("ActivityRail — recent", () => {
  it("lists finished runs with their outcome, duration and cost", () => {
    render(
      <ActivityRail
        rows={[]}
        liveActivity={NO_ACTIVITY}
        runs={[run({ costUsd: 0.42 })]}
        loading={false}
      />,
    );
    expect(screen.getByText("Dependency audit")).toBeInTheDocument();
    expect(screen.getByText("done")).toBeInTheDocument();
    expect(screen.getByText("$0.42")).toBeInTheDocument();
  });

  it("excludes running rows from Recent — they are already in Live", () => {
    render(
      <ActivityRail
        rows={[]}
        liveActivity={NO_ACTIVITY}
        runs={[run({ id: "live", status: "running", scheduleName: "In flight" })]}
        loading={false}
      />,
    );
    // Present once (under Live), not twice.
    expect(screen.getAllByText("In flight")).toHaveLength(1);
    expect(screen.getByText(/no completed runs yet/i)).toBeInTheDocument();
  });

  it("caps the recent list", () => {
    const runs = Array.from({ length: 20 }, (_, i) => run({ id: `r${i}` }));
    render(<ActivityRail rows={[]} liveActivity={NO_ACTIVITY} runs={runs} loading={false} />);
    expect(screen.getAllByText("Dependency audit")).toHaveLength(8);
  });

  it("reads a failing work outcome as failed even when the process exited 0", () => {
    render(
      <ActivityRail
        rows={[]}
        liveActivity={NO_ACTIVITY}
        runs={[run({ status: "succeeded", outcome: "failed" })]}
        loading={false}
      />,
    );
    expect(screen.getByText("failed")).toBeInTheDocument();
  });

  it("shows a skeleton while runs load for the first time", () => {
    render(<ActivityRail rows={[]} liveActivity={NO_ACTIVITY} runs={[]} loading />);
    expect(screen.queryByText(/no completed runs yet/i)).toBeNull();
  });

  it("links to the full run history", () => {
    render(<ActivityRail rows={[]} liveActivity={NO_ACTIVITY} runs={[]} loading={false} />);
    expect(screen.getByRole("link", { name: /all runs/i })).toHaveAttribute("href", "#/launch");
  });
});
