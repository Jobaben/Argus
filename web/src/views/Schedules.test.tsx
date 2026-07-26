import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Run, ScheduleWithNext } from "../types";
import Schedules from "./Schedules";

const mockState: {
  schedules: ScheduleWithNext[];
  runs: Run[];
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
} = {
  schedules: [],
  runs: [],
  create: vi.fn().mockResolvedValue(undefined),
  update: vi.fn().mockResolvedValue(undefined),
};

vi.mock("../useSchedules", () => ({
  useSchedules: () => ({
    schedules: mockState.schedules,
    loading: false,
    error: null,
    create: mockState.create,
    update: mockState.update,
    remove: vi.fn(),
    runNow: vi.fn(),
    cancelRun: vi.fn(),
  }),
}));

vi.mock("../useRuns", () => ({
  useRuns: () => ({ runs: mockState.runs, loading: false, error: null }),
}));

const schedule = (over: Partial<ScheduleWithNext> = {}): ScheduleWithNext => ({
  id: "s1",
  name: "Nightly audit",
  prompt: "p",
  cwd: "/tmp",
  trigger: { kind: "daily", time: "02:00" },
  enabled: true,
  overlapPolicy: "skip",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
  lastRunAt: null,
  lastRunId: null,
  nextRun: null,
  ...over,
});

const run = (over: Partial<Run> = {}): Run => ({
  id: "r1",
  scheduleId: "s1",
  scheduleName: "Nightly audit",
  prompt: "p",
  cwd: "/tmp",
  status: "succeeded",
  trigger: "scheduled",
  queuedAt: "2026-07-26T11:00:00.000Z",
  startedAt: "2026-07-26T11:00:00.000Z",
  endedAt: "2026-07-26T11:00:30.000Z",
  durationMs: 30_000,
  pid: null,
  exitCode: 0,
  sessionId: null,
  project: null,
  resultSummary: null,
  error: null,
  ...over,
});

describe("Schedules catch-up", () => {
  beforeEach(() => {
    mockState.schedules = [];
    mockState.runs = [];
    mockState.create = vi.fn().mockResolvedValue(undefined);
  });

  it("submits catchUp: true when the checkbox is ticked", async () => {
    const user = userEvent.setup();
    render(<Schedules />);
    await user.click(screen.getByRole("button", { name: /new schedule/i }));
    await user.type(screen.getByPlaceholderText("Nightly audit"), "Morning briefing");
    await user.type(screen.getByPlaceholderText(/Review yesterday/), "brief me");
    await user.type(screen.getByPlaceholderText("/home/you/project"), "/tmp");
    await user.click(screen.getByRole("checkbox", { name: /catch up/i }));
    await user.click(screen.getByRole("button", { name: /save schedule/i }));

    expect(mockState.create).toHaveBeenCalledTimes(1);
    expect(mockState.create.mock.calls[0][0]).toMatchObject({ catchUp: true });
  });

  it("defaults the checkbox off so catchUp stays falsy", async () => {
    const user = userEvent.setup();
    render(<Schedules />);
    await user.click(screen.getByRole("button", { name: /new schedule/i }));
    await user.type(screen.getByPlaceholderText("Nightly audit"), "Morning briefing");
    await user.type(screen.getByPlaceholderText(/Review yesterday/), "brief me");
    await user.type(screen.getByPlaceholderText("/home/you/project"), "/tmp");
    await user.click(screen.getByRole("button", { name: /save schedule/i }));

    expect(mockState.create.mock.calls[0][0].catchUp).toBeFalsy();
  });

  it("shows a catch-up chip on schedules that opted in", () => {
    mockState.schedules = [schedule({ catchUp: true })];
    render(<Schedules />);
    expect(screen.getByText(/catch-up/i)).toBeTruthy();
  });
});

describe("Schedules health", () => {
  beforeEach(() => {
    mockState.schedules = [];
    mockState.runs = [];
  });

  it("humanises an interval instead of printing raw minutes", () => {
    // "every 360 min" is arithmetic left for the reader.
    mockState.schedules = [schedule({ trigger: { kind: "interval", everyMinutes: 360 } })];
    render(<Schedules />);
    expect(screen.getByText("every 6h")).toBeTruthy();
  });

  it("states a failure streak instead of leaving it to be counted", () => {
    mockState.schedules = [schedule()];
    mockState.runs = [
      run({ id: "a", status: "failed", error: "prereq missing: gh\nstack…" }),
      run({ id: "b", status: "failed" }),
      run({ id: "c", status: "failed" }),
    ];
    render(<Schedules />);
    expect(screen.getByText("3 consecutive failures")).toBeTruthy();
    // The reason is on the card, so triage does not require expanding a run.
    expect(screen.getByText("prereq missing: gh")).toBeTruthy();
  });

  it("does not shout about a single failure a run row already shows", () => {
    mockState.schedules = [schedule()];
    mockState.runs = [run({ status: "failed" }), run({ id: "b", status: "succeeded" })];
    render(<Schedules />);
    expect(screen.queryByText(/consecutive failures/)).toBeNull();
  });

  it("filters to the failing schedules when the failing count is clicked", async () => {
    const user = userEvent.setup();
    mockState.schedules = [
      schedule({ id: "ok", name: "Healthy one" }),
      schedule({ id: "bad", name: "Broken one" }),
    ];
    mockState.runs = [
      run({ id: "1", scheduleId: "ok", status: "succeeded" }),
      run({ id: "2", scheduleId: "bad", status: "failed" }),
    ];
    render(<Schedules />);
    expect(screen.getByText("Healthy one")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /1 failing/i }));
    expect(screen.queryByText("Healthy one")).toBeNull();
    expect(screen.getByText("Broken one")).toBeTruthy();
  });

  it("omits a zero count rather than showing a grey nothing", () => {
    mockState.schedules = [schedule()];
    mockState.runs = [run({ status: "succeeded" })];
    render(<Schedules />);
    expect(screen.queryByRole("button", { name: /failing/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /paused/i })).toBeNull();
  });

  it("says a paused schedule will not fire, next slot or not", () => {
    mockState.schedules = [schedule({ enabled: false, nextRun: "2099-01-01T00:00:00.000Z" })];
    render(<Schedules />);
    expect(screen.getByText(/will not fire/)).toBeTruthy();
    expect(screen.queryByText(/^fires/)).toBeNull();
  });

  it("teaches what a schedule is when there are none", () => {
    render(<Schedules />);
    expect(screen.getByText(/No schedules yet/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /create your first schedule/i })).toBeTruthy();
  });

  it("tells a schedule with no history how to test it", () => {
    mockState.schedules = [schedule()];
    render(<Schedules />);
    expect(screen.getByText(/No runs recorded yet/)).toBeTruthy();
  });
});
