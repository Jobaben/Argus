import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ScheduleWithNext } from "../types";
import Schedules from "./Schedules";

const mockState: {
  schedules: ScheduleWithNext[];
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
} = {
  schedules: [],
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
  useRuns: () => ({ runs: [], loading: false, error: null }),
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

describe("Schedules catch-up", () => {
  beforeEach(() => {
    mockState.schedules = [];
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
