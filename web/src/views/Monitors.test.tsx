import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MonitorHealth, MonitorsSummary } from "../types";
import Monitors from "./Monitors";

const mockState: {
  monitors: MonitorHealth[];
  summary: MonitorsSummary;
  loading: boolean;
  error: string | null;
} = {
  monitors: [],
  summary: { up: 0, late: 0, down: 0, failing: 0, paused: 0, pending: 0 },
  loading: false,
  error: null,
};

vi.mock("../useMonitors", () => ({
  useMonitors: () => ({ ...mockState, refresh: vi.fn() }),
}));

function monitor(over: Partial<MonitorHealth> = {}): MonitorHealth {
  return {
    scheduleId: "s1",
    name: "Nightly triage",
    enabled: true,
    status: "up",
    uptimePct: 96.7,
    lastRunAt: "2026-07-10T06:00:00.000Z",
    lastRunStatus: "succeeded",
    expectedAt: null,
    nextExpected: "2026-07-10T07:00:00.000Z",
    graceMs: 300000,
    heartbeats: [
      {
        runId: "r1",
        status: "succeeded",
        outcome: null,
        at: "2026-07-10T05:00:00.000Z",
        durationMs: 5,
      },
      {
        runId: "r2",
        status: "failed",
        outcome: null,
        at: "2026-07-10T06:00:00.000Z",
        durationMs: 5,
      },
    ],
    ...over,
  };
}

describe("Monitors", () => {
  beforeEach(() => {
    mockState.monitors = [];
    mockState.summary = { up: 0, late: 0, down: 0, failing: 0, paused: 0, pending: 0 };
    mockState.loading = false;
    mockState.error = null;
  });

  it("shows the empty state when there are no schedules", () => {
    render(<Monitors />);
    expect(screen.getByText(/No monitors yet/)).toBeInTheDocument();
  });

  it("renders a card per monitor with status pill, uptime, and heartbeats", () => {
    mockState.monitors = [
      monitor(),
      monitor({ scheduleId: "s2", name: "Backup", status: "down", uptimePct: 50 }),
    ];
    mockState.summary = { up: 1, late: 0, down: 1, failing: 0, paused: 0, pending: 0 };
    render(<Monitors />);
    expect(screen.getByText("Nightly triage")).toBeInTheDocument();
    expect(screen.getByText("Backup")).toBeInTheDocument();
    // Both the summary counter label and the card pill say "Up"/"Down".
    expect(screen.getAllByText("Up").length).toBe(2);
    expect(screen.getAllByText("Down").length).toBe(2);
    expect(screen.getByText("96.7%")).toBeInTheDocument();
    expect(screen.getAllByRole("img", { name: /Last 2 runs/ }).length).toBeGreaterThan(0);
  });

  it("says how overdue a down monitor is, not merely when the slot was", () => {
    // A slot two hours in the past used to render as "Next: -7138s ago".
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000 - 5 * 60_000).toISOString();
    mockState.monitors = [monitor({ status: "down", expectedAt: twoHoursAgo, nextExpected: null })];
    render(<Monitors />);
    expect(screen.getByText(/Overdue by/)).toBeInTheDocument();
    expect(screen.getByText("2h 5m")).toBeInTheDocument();
  });

  it("shows the next slot as a forward-looking time for a healthy monitor", () => {
    const inThirtyMinutes = new Date(Date.now() + 30 * 60_000).toISOString();
    mockState.monitors = [
      monitor({ status: "up", expectedAt: null, nextExpected: inThirtyMinutes }),
    ];
    render(<Monitors />);
    expect(screen.getByText(/Next run:/)).toBeInTheDocument();
    expect(screen.getByText(/in (29|30)m/)).toBeInTheDocument();
  });

  it("filters to one status when its counter is pressed", async () => {
    const user = userEvent.setup();
    mockState.monitors = [
      monitor(),
      monitor({ scheduleId: "s2", name: "Backup", status: "down", uptimePct: 50 }),
    ];
    mockState.summary = { up: 1, late: 0, down: 1, failing: 0, paused: 0, pending: 0 };
    render(<Monitors />);

    await user.click(screen.getByRole("button", { name: /down/i }));
    expect(screen.queryByText("Nightly triage")).not.toBeInTheDocument();
    expect(screen.getByText("Backup")).toBeInTheDocument();
    expect(screen.getByText(/Showing 1 down monitor of 2/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Show all/ }));
    expect(screen.getByText("Nightly triage")).toBeInTheDocument();
  });

  it("leaves an empty counter inert, so pressing it cannot blank the list", () => {
    mockState.monitors = [monitor()];
    mockState.summary = { up: 1, late: 0, down: 0, failing: 0, paused: 0, pending: 0 };
    render(<Monitors />);
    // "Up" has one behind it and is a control; the five empty ones are not.
    expect(screen.getAllByRole("button").length).toBe(1);
  });

  it("surfaces a fetch error", () => {
    mockState.error = "boom";
    render(<Monitors />);
    expect(screen.getByText(/Couldn't load monitors: boom/)).toBeInTheDocument();
  });
});
