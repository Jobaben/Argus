import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Anomaly, Baseline, MetricBaseline, WatchtowerReport } from "../types";
import Watchtower from "./Watchtower";

const reset = vi.fn(async () => {});
const restore = vi.fn(async () => {});

const state: { report: WatchtowerReport; loading: boolean; error: string | null } = {
  report: emptyReport(),
  loading: false,
  error: null,
};

vi.mock("../useWatchtower", () => ({
  useWatchtower: () => ({ ...state, refresh: vi.fn(), reset, restore }),
}));

function emptyReport(): WatchtowerReport {
  return {
    generatedAt: "2026-07-20T12:00:00.000Z",
    baselines: [],
    anomalies: [],
    summary: { ready: 0, warming: 0, anomalies: 0, critical: 0 },
    warmupRuns: 8,
  };
}

const metric = (over: Partial<MetricBaseline> = {}): MetricBaseline => ({
  metric: "cost",
  median: 0.1,
  mad: 0.01,
  p05: 0.09,
  p95: 0.13,
  min: 0.09,
  max: 0.13,
  samples: 20,
  ...over,
});

const baseline = (over: Partial<Baseline> = {}): Baseline => ({
  key: "schedule:s1",
  scope: "schedule",
  name: "Nightly triage",
  samples: 20,
  warmupRemaining: 0,
  since: "2026-07-01T00:00:00.000Z",
  resetAt: null,
  duration: metric({ metric: "duration", median: 60_000, p05: 55_000, p95: 70_000 }),
  cost: metric(),
  tokens: metric({ metric: "tokens", median: 1000, p05: 900, p95: 1200 }),
  ...over,
});

const anomaly = (over: Partial<Anomaly> = {}): Anomaly => ({
  id: "schedule:s1|cost|r9",
  key: "schedule:s1",
  scope: "schedule",
  name: "Nightly triage",
  runId: "r9",
  scheduleId: "s1",
  metric: "cost",
  direction: "high",
  severity: "critical",
  value: 0.42,
  median: 0.1,
  ratio: 4.2,
  zScore: 21.6,
  at: "2026-07-20T11:00:00.000Z",
  detail: "4.2× median cost ($0.42 vs $0.10 over 20 runs)",
  ...over,
});

beforeEach(() => {
  state.report = emptyReport();
  state.loading = false;
  state.error = null;
  reset.mockClear();
  restore.mockClear();
});

describe("Watchtower", () => {
  it("teaches what it does when there is nothing to learn from yet", () => {
    render(<Watchtower />);
    expect(screen.getByText(/builds an envelope from each schedule/i)).toBeInTheDocument();
    expect(screen.getByText(/8 successes/i)).toBeInTheDocument();
  });

  it("shows an anomaly as the multiple, with a link to replay the run", () => {
    state.report = {
      ...emptyReport(),
      baselines: [baseline()],
      anomalies: [anomaly()],
      summary: { ready: 1, warming: 0, anomalies: 1, critical: 1 },
    };
    render(<Watchtower />);
    expect(screen.getByText("4.2× median cost ($0.42 vs $0.10 over 20 runs)")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /replay this run/i })).toHaveAttribute(
      "href",
      "#/run/r9",
    );
  });

  it("says the good outcome plainly when every run landed inside its envelope", () => {
    state.report = {
      ...emptyReport(),
      baselines: [baseline()],
      summary: { ready: 1, warming: 0, anomalies: 0, critical: 0 },
    };
    render(<Watchtower />);
    expect(screen.getByText(/landed inside its learned envelope/i)).toBeInTheDocument();
  });

  it("distinguishes 'nothing wrong' from 'nothing judged yet'", () => {
    state.report = {
      ...emptyReport(),
      baselines: [baseline({ warmupRemaining: 3, samples: 5 })],
      summary: { ready: 0, warming: 1, anomalies: 0, critical: 0 },
    };
    render(<Watchtower />);
    expect(screen.getByText(/No envelope is warm yet/i)).toBeInTheDocument();
    expect(screen.getByText(/warming · 3 to go/i)).toBeInTheDocument();
  });

  it("filters to critical anomalies without losing the count of the rest", async () => {
    const user = userEvent.setup();
    state.report = {
      ...emptyReport(),
      baselines: [baseline()],
      anomalies: [
        anomaly(),
        anomaly({ id: "b", runId: "r8", severity: "warn", detail: "1.7× median duration" }),
      ],
      summary: { ready: 1, warming: 0, anomalies: 2, critical: 1 },
    };
    render(<Watchtower />);
    expect(screen.getByText("1.7× median duration")).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /critical 1/i }));
    expect(screen.queryByText("1.7× median duration")).not.toBeInTheDocument();
    expect(screen.getByText(/4.2× median cost/)).toBeInTheDocument();
  });

  it("resetting a baseline calls through with its key", async () => {
    const user = userEvent.setup();
    state.report = {
      ...emptyReport(),
      baselines: [baseline()],
      summary: { ready: 1, warming: 0, anomalies: 0, critical: 0 },
    };
    render(<Watchtower />);
    await user.click(screen.getByRole("button", { name: /reset baseline/i }));
    expect(reset).toHaveBeenCalledWith("schedule:s1");
  });

  it("offers to restore full history only once a reset exists", async () => {
    const user = userEvent.setup();
    state.report = {
      ...emptyReport(),
      baselines: [baseline()],
      summary: { ready: 1, warming: 0, anomalies: 0, critical: 0 },
    };
    const { rerender } = render(<Watchtower />);
    expect(screen.queryByRole("button", { name: /restore full history/i })).not.toBeInTheDocument();

    state.report = {
      ...state.report,
      baselines: [baseline({ resetAt: "2026-07-19T00:00:00.000Z" })],
    };
    rerender(<Watchtower />);
    await user.click(screen.getByRole("button", { name: /restore full history/i }));
    expect(restore).toHaveBeenCalledWith("schedule:s1");
  });

  it("regression: a failed reset surfaces the server's message instead of failing silently", async () => {
    const user = userEvent.setup();
    reset.mockRejectedValueOnce(new Error("invalid baseline key"));
    state.report = {
      ...emptyReport(),
      baselines: [baseline()],
      summary: { ready: 1, warming: 0, anomalies: 0, critical: 0 },
    };
    render(<Watchtower />);
    await user.click(screen.getByRole("button", { name: /reset baseline/i }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("invalid baseline key"),
    );
  });

  it("a metric the runs never reported reads as 'not reported', not as zero", () => {
    state.report = {
      ...emptyReport(),
      baselines: [baseline({ cost: null })],
      summary: { ready: 1, warming: 0, anomalies: 0, critical: 0 },
    };
    render(<Watchtower />);
    const cells = screen.getAllByText("not reported");
    expect(cells).toHaveLength(1);
  });

  it("phase envelopes are labelled as phases", () => {
    state.report = {
      ...emptyReport(),
      baselines: [
        baseline({ key: "phase:pipeline:p1:build", scope: "phase", name: "Release › build" }),
      ],
      summary: { ready: 1, warming: 0, anomalies: 0, critical: 0 },
    };
    render(<Watchtower />);
    const card = screen.getByText("Release › build").closest("div");
    expect(within(card!.parentElement!).getByText("phase")).toBeInTheDocument();
  });
});
