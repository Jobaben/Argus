import { afterEach, describe, it, expect, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
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
    gates: [],
    failure: null,
    phases: [],
    ...over,
  } as OverviewRow;
}

const NO_ACTIVITY = new Map<string, LiveActivity>();

/** One pipeline row whose single phase is running these steps. */
function working(steps: { name: string; runId: string | null; startedAt?: string }[]) {
  return [
    row({
      phases: [
        {
          id: "p1",
          name: "Implement",
          status: "working",
          reason: null,
          steps: steps.map((s) => ({ ...s, status: "working" })),
        },
      ],
    } as Partial<OverviewRow>),
  ];
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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

  it("says 'Starting…' for a working step that has not reported activity yet", () => {
    render(
      <ActivityRail
        rows={working([{ name: "Write the fix", runId: "r9" }])}
        liveActivity={NO_ACTIVITY}
        runs={[]}
        loading={false}
      />,
    );
    expect(screen.getByText("Starting…")).toBeInTheDocument();
  });

  it("shows how long each step has been running, and keeps counting", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-07T10:02:05.000Z"));
    render(
      <ActivityRail
        rows={working([
          { name: "Write the fix", runId: "r9", startedAt: "2026-07-07T10:00:00.000Z" },
        ])}
        liveActivity={NO_ACTIVITY}
        runs={[]}
        loading={false}
      />,
    );
    expect(screen.getByTitle("Running for")).toHaveTextContent("02:05");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByTitle("Running for")).toHaveTextContent("02:06");
    // Two minutes in with no tool call is not "starting" any more.
    expect(screen.getByText("Working")).toBeInTheDocument();
    expect(screen.queryByText("Starting…")).toBeNull();
  });

  it("calls a step that began seconds ago 'Starting…', with its time beside it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-07T10:00:04.000Z"));
    render(
      <ActivityRail
        rows={working([
          { name: "Write the fix", runId: "r9", startedAt: "2026-07-07T10:00:00.000Z" },
        ])}
        liveActivity={NO_ACTIVITY}
        runs={[]}
        loading={false}
      />,
    );
    expect(screen.getByTitle("Running for")).toHaveTextContent("00:04");
    expect(screen.getByText("Starting…")).toBeInTheDocument();
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

  it("does not list a pipeline step's run twice — once as the step, once as a run", () => {
    // The engine records each pipeline step as a run named `pipeline · step`,
    // and that run is "running" while the step is working. Only the step line
    // (which carries the live tool call) should appear, not a second line for
    // the same run under its schedule name.
    const rows = [
      row({
        name: "Backend Autopilot",
        phases: [
          {
            id: "p1",
            name: "Read the specification",
            status: "working",
            reason: null,
            steps: [{ name: "Read the specification", runId: "r9", status: "working" }],
          },
        ],
      } as Partial<OverviewRow>),
    ];
    render(
      <ActivityRail
        rows={rows}
        liveActivity={new Map([["r9", { label: "Writing context.md", at: "t" }]])}
        runs={[
          run({
            id: "r9",
            status: "running",
            scheduleName: "Backend Autopilot · Claim the ticket",
          }),
          run({ id: "r5", status: "running", scheduleName: "Nightly code review" }),
        ]}
        loading={false}
      />,
    );
    expect(screen.getByText("Backend Autopilot · Read the specification")).toBeInTheDocument();
    expect(screen.queryByText("Backend Autopilot · Claim the ticket")).toBeNull();
    expect(screen.getAllByText(/Writing context\.md/)).toHaveLength(1);
    // The unrelated scheduled run still shows, and the count is 2 not 3.
    expect(screen.getByText("Nightly code review")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^live ?2$/i })).toBeInTheDocument();
  });

  it("lists a run once when its activity frame repeats", () => {
    // Every frame that moves any run's line hands the rail a fresh map, and
    // each poll hands it fresh rows and runs. None of that is a new run.
    const rows = working([{ name: "Write the fix", runId: "r9" }]);
    const runs = [run({ id: "r9", status: "running", scheduleName: "Release train · Write" })];
    const frame = () => new Map([["r9", { label: "Edit src/replay.ts", at: "t" }]]);
    const { rerender } = render(
      <ActivityRail rows={rows} liveActivity={frame()} runs={runs} loading={false} />,
    );
    rerender(
      <ActivityRail rows={[...rows]} liveActivity={frame()} runs={[...runs]} loading={false} />,
    );
    rerender(
      <ActivityRail rows={[...rows]} liveActivity={frame()} runs={[...runs]} loading={false} />,
    );
    expect(screen.getAllByText("Release train · Write the fix")).toHaveLength(1);
    expect(screen.getAllByText(/Edit src\/replay\.ts/)).toHaveLength(1);
    expect(screen.getByRole("heading", { name: /^live ?1$/i })).toBeInTheDocument();
  });

  it("keeps one row per best-of-N candidate as the board updates", () => {
    // Candidates are copies of one step, so they share its name. Keyed by
    // name, React was handed two rows with one key and could duplicate or
    // drop them on the next update.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { rerender } = render(
      <ActivityRail
        rows={working([
          { name: "Draft", runId: "run-aaaa1111" },
          { name: "Draft", runId: "run-bbbb2222" },
        ])}
        liveActivity={NO_ACTIVITY}
        runs={[]}
        loading={false}
      />,
    );
    rerender(
      <ActivityRail
        rows={working([
          { name: "Draft", runId: "run-bbbb2222" },
          { name: "Draft", runId: "run-cccc3333" },
        ])}
        liveActivity={new Map([["run-bbbb2222", { label: "Edit src/a.ts", at: "t" }]])}
        runs={[]}
        loading={false}
      />,
    );
    expect(screen.getAllByText("Release train · Draft")).toHaveLength(2);
    expect(screen.getAllByText(/Edit src\/a\.ts/)).toHaveLength(1);
    // The quiet twin names its run, so two identical labels can be told apart.
    expect(screen.getByText("run-cccc")).toBeInTheDocument();
    expect(screen.queryByText("run-aaaa")).toBeNull();
    const keyWarnings = error.mock.calls.filter((c) => String(c[0]).includes("same key"));
    expect(keyWarnings).toEqual([]);
  });

  it("keeps one row for a run the board reports on two steps", () => {
    render(
      <ActivityRail
        rows={working([
          { name: "Write the fix", runId: "r9" },
          { name: "Write the fix", runId: "r9" },
        ])}
        liveActivity={NO_ACTIVITY}
        runs={[]}
        loading={false}
      />,
    );
    expect(screen.getAllByText("Release train · Write the fix")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: /^live ?1$/i })).toBeInTheDocument();
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
    // In words, sentence case, like every other status in the app.
    expect(screen.getByText("Done")).toBeInTheDocument();
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
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });

  it("shows a skeleton while runs load for the first time", () => {
    render(<ActivityRail rows={[]} liveActivity={NO_ACTIVITY} runs={[]} loading />);
    expect(screen.queryByText(/no completed runs yet/i)).toBeNull();
  });

  it("links to the full run history", () => {
    render(<ActivityRail rows={[]} liveActivity={NO_ACTIVITY} runs={[]} loading={false} />);
    expect(screen.getByRole("link", { name: /all runs/i })).toHaveAttribute(
      "href",
      "#/schedules/oneoff",
    );
  });
});
