import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LedgerReport, WhatIfResult } from "../types";
import { LedgerPanels } from "./LedgerPanels";

const simulate = vi.fn(async () => {});

const state: {
  report: LedgerReport;
  loading: boolean;
  simulation: WhatIfResult | null;
  simulating: boolean;
  simError: string | null;
} = {
  report: emptyReport(),
  loading: false,
  simulation: null,
  simulating: false,
  simError: null,
};

vi.mock("../useLedger", () => ({
  useLedger: () => ({ ...state, error: null, refresh: vi.fn(), simulate }),
}));

function emptyReport(): LedgerReport {
  const none = (dimension: "project" | "schedule" | "pipeline" | "model") => ({
    dimension,
    slices: [],
    totalUsd: 0,
    totalTokens: 0,
    runs: 0,
    unattributedRuns: 0,
  });
  return {
    generatedAt: "2026-07-20T12:00:00.000Z",
    windowDays: 30,
    byProject: none("project"),
    bySchedule: none("schedule"),
    byPipeline: none("pipeline"),
    byModel: none("model"),
    forecast: {
      samples: 0,
      dailyUsd: null,
      monthToDateUsd: 0,
      monthEndUsd: null,
      lowUsd: null,
      highUsd: null,
      confidence: null,
      overLimit: false,
      note: "Only 0 full days of history — not enough to project a month yet.",
    },
    enforcement: { action: null, atRatio: null, model: null, window: null, detail: "" },
  };
}

function withSchedules(): LedgerReport {
  const base = emptyReport();
  return {
    ...base,
    bySchedule: {
      dimension: "schedule",
      slices: [
        {
          key: "s1",
          label: "Nightly triage",
          usd: 6,
          tokens: 90_000,
          runs: 30,
          share: 0.75,
          perRunUsd: 0.2,
        },
        {
          key: "s2",
          label: "Dependency audit",
          usd: 2,
          tokens: 20_000,
          runs: 10,
          share: 0.25,
          perRunUsd: 0.2,
        },
      ],
      totalUsd: 8,
      totalTokens: 110_000,
      runs: 40,
      unattributedRuns: 3,
    },
  };
}

beforeEach(() => {
  state.report = emptyReport();
  state.loading = false;
  state.simulation = null;
  state.simulating = false;
  state.simError = null;
  simulate.mockClear();
});

describe("LedgerPanels", () => {
  it("teaches what attribution needs when there is nothing to attribute", () => {
    render(<LedgerPanels />);
    expect(screen.getByText(/No costed runs in this window yet/)).toBeInTheDocument();
  });

  it("shows the forecast note when there is not enough history, without a fake number", () => {
    render(<LedgerPanels />);
    expect(screen.getByText(/not enough to project a month yet/)).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("shows the projection with its band and confidence", () => {
    state.report = {
      ...emptyReport(),
      forecast: {
        samples: 19,
        dailyUsd: 5,
        monthToDateUsd: 95,
        monthEndUsd: 150,
        lowUsd: 140,
        highUsd: 175,
        confidence: 0.82,
        overLimit: false,
        note: "On this pace the month ends near $150.00, inside the $200.00 limit.",
      },
    };
    render(<LedgerPanels />);
    expect(screen.getByText("$150.00")).toBeInTheDocument();
    expect(screen.getByText(/band \$140\.00 – \$175\.00/)).toBeInTheDocument();
    expect(screen.getByText("82% confidence")).toBeInTheDocument();
    expect(screen.getByText(/19 full days/)).toBeInTheDocument();
  });

  it("lists slices with share, per-run rate and the unattributed remainder", () => {
    state.report = withSchedules();
    render(<LedgerPanels />);
    expect(screen.getByText("Nightly triage")).toBeInTheDocument();
    expect(screen.getByText("$6.00")).toBeInTheDocument();
    expect(screen.getByText("75%")).toBeInTheDocument();
    expect(screen.getByText(/3 outside this grouping/)).toBeInTheDocument();
  });

  it("switching dimension changes what is grouped", async () => {
    const user = userEvent.setup();
    state.report = withSchedules();
    render(<LedgerPanels />);
    expect(screen.getByText("Nightly triage")).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Model" }));
    expect(screen.queryByText("Nightly triage")).not.toBeInTheDocument();
    expect(screen.getByText(/No costed runs in this window yet/)).toBeInTheDocument();
  });

  it("the simulator asks the server, with the slice and the target model", async () => {
    const user = userEvent.setup();
    state.report = withSchedules();
    render(<LedgerPanels />);
    await user.click(screen.getAllByRole("button", { name: /what if/i })[0]);
    await user.click(screen.getByRole("button", { name: /simulate/i }));
    expect(simulate).toHaveBeenCalledWith({
      dimension: "schedule",
      key: "s1",
      toModel: "haiku",
    });
  });

  it("regression: an unanswerable what-if shows the reason, not a zero saving", async () => {
    const user = userEvent.setup();
    state.report = withSchedules();
    state.simulation = {
      ok: false,
      unavailable:
        'no runs on "haiku" to compare against — Argus estimates from what a model has actually cost here, never from a price list',
      label: "Nightly triage",
      fromModel: "opus",
      toModel: "haiku",
      affectedRuns: 30,
      currentPerRunUsd: null,
      projectedPerRunUsd: null,
      monthlySavingUsd: null,
      currentMonthlyUsd: null,
      projectedMonthlyUsd: null,
      verdictDelta: null,
      verdictSamples: 0,
      summary: "",
    };
    render(<LedgerPanels />);
    // The panel only opens once a slice is targeted, so open it first.
    expect(screen.queryByText(/never from a price list/)).not.toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: /what if/i })[0]);
    expect(screen.getByText(/never from a price list/)).toBeInTheDocument();
    // No headline, no per-run arrow, no "$0.00 saved" — an unknown is shown as unknown.
    expect(screen.queryByText(/per month/)).not.toBeInTheDocument();
  });

  it("a failed request surfaces the server's message as an alert", async () => {
    const user = userEvent.setup();
    state.report = withSchedules();
    state.simError = "unknown dimension";
    render(<LedgerPanels />);
    await user.click(screen.getAllByRole("button", { name: /what if/i })[0]);
    expect(screen.getByRole("alert")).toHaveTextContent("unknown dimension");
  });

  it("the simulate button is held while a pass is in flight", async () => {
    const user = userEvent.setup();
    state.report = withSchedules();
    state.simulating = true;
    render(<LedgerPanels />);
    await user.click(screen.getAllByRole("button", { name: /what if/i })[0]);
    expect(screen.getByRole("button", { name: /working/i })).toBeDisabled();
  });

  it("closing the simulator puts the panel away", async () => {
    const user = userEvent.setup();
    state.report = withSchedules();
    render(<LedgerPanels />);
    await user.click(screen.getAllByRole("button", { name: /what if/i })[0]);
    expect(screen.getByRole("button", { name: /simulate/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /close/i }));
    expect(screen.queryByRole("button", { name: /simulate/i })).not.toBeInTheDocument();
  });

  it("says it is still reading before the first report lands", () => {
    state.loading = true;
    render(<LedgerPanels />);
    expect(screen.getByText(/Reading the run history…/)).toBeInTheDocument();
  });

  it("a completed simulation shows the headline and says whether quality was measured", async () => {
    const user = userEvent.setup();
    state.report = withSchedules();
    state.simulation = {
      ok: true,
      unavailable: null,
      label: "Nightly triage",
      fromModel: "opus",
      toModel: "haiku",
      affectedRuns: 30,
      currentPerRunUsd: 0.2,
      projectedPerRunUsd: 0.02,
      monthlySavingUsd: 41,
      currentMonthlyUsd: 45,
      projectedMonthlyUsd: 4,
      verdictDelta: -0.2,
      verdictSamples: 24,
      summary: "haiku on Nightly triage saves $41.00/mo at -0.2 Verdict",
    };
    render(<LedgerPanels />);
    await user.click(screen.getAllByRole("button", { name: /what if/i })[0]);
    expect(
      screen.getByText("haiku on Nightly triage saves $41.00/mo at -0.2 Verdict"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Measured across 24 Verdict scores/)).toBeInTheDocument();
    expect(screen.getByText(/never estimates from a published price list/)).toBeInTheDocument();
  });

  it("regression: an unmeasured quality effect says 'unmeasured', not 'no change'", async () => {
    const user = userEvent.setup();
    state.report = withSchedules();
    state.simulation = {
      ok: true,
      unavailable: null,
      label: "Nightly triage",
      fromModel: "opus",
      toModel: "haiku",
      affectedRuns: 30,
      currentPerRunUsd: 0.2,
      projectedPerRunUsd: 0.02,
      monthlySavingUsd: 41,
      currentMonthlyUsd: 45,
      projectedMonthlyUsd: 4,
      verdictDelta: null,
      verdictSamples: 0,
      summary: "haiku on Nightly triage saves $41.00/mo at quality effect unmeasured",
    };
    render(<LedgerPanels />);
    await user.click(screen.getAllByRole("button", { name: /what if/i })[0]);
    expect(screen.getByText(/unmeasured — not zero/)).toBeInTheDocument();
  });

  it("an enforcement in force is explained, including that runs record it", () => {
    state.report = {
      ...withSchedules(),
      enforcement: {
        action: "downgrade",
        atRatio: 0.9,
        model: "haiku",
        window: "daily",
        detail: "daily spend is at 95% of its limit — scheduled runs moved to haiku",
      },
    };
    render(<LedgerPanels />);
    expect(screen.getByText(/Move scheduled runs to a cheaper model/)).toBeInTheDocument();
    expect(screen.getByText(/records this on its own record/)).toBeInTheDocument();
  });

  it("no enforcement means no policy panel at all", () => {
    state.report = withSchedules();
    render(<LedgerPanels />);
    expect(screen.queryByText(/Budget policy in force/)).not.toBeInTheDocument();
  });
});
