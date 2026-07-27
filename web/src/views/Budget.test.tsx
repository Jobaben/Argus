import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BudgetResponse } from "../types";
import Budget from "./Budget";

const mockState: {
  budget: BudgetResponse | null;
  save: ReturnType<typeof vi.fn>;
} = {
  budget: null,
  save: vi.fn().mockResolvedValue(undefined),
};

vi.mock("../useBudget", () => ({
  useBudget: () => ({
    budget: mockState.budget,
    loading: false,
    error: null,
    save: mockState.save,
  }),
}));

const response = (over: Partial<BudgetResponse> = {}): BudgetResponse => ({
  config: { dailyUsd: 10, monthlyUsd: null, blockScheduled: false, updatedAt: null },
  status: {
    state: "warning",
    today: { spentUsd: 8.5, limitUsd: 10, ratio: 0.85 },
    month: { spentUsd: 42, limitUsd: null, ratio: null },
    blockScheduled: false,
  },
  days: [
    { date: "2026-07-12", usd: 3.2, tokens: 1000, runs: 4 },
    { date: "2026-07-13", usd: 8.5, tokens: 2500, runs: 6 },
  ],
  ...over,
});

describe("Budget", () => {
  beforeEach(() => {
    mockState.budget = response();
    mockState.save = vi.fn().mockResolvedValue(undefined);
  });

  it("renders the state pill and both spend windows", () => {
    render(<Budget />);
    expect(screen.getByText("approaching limit")).toBeInTheDocument();
    expect(screen.getByText("Today")).toBeInTheDocument();
    expect(screen.getByText("This month")).toBeInTheDocument();
    expect(screen.getByText("of $10.00 limit")).toBeInTheDocument();
    expect(screen.getByText("no limit set")).toBeInTheDocument();
  });

  it("seeds the form from config and saves an updated budget", async () => {
    const user = userEvent.setup();
    render(<Budget />);
    const dailyInput = screen.getByLabelText(/Daily limit/);
    expect(dailyInput).toHaveValue("10");
    await user.clear(dailyInput);
    await user.type(dailyInput, "25");
    await user.type(screen.getByLabelText(/Monthly limit/), "200");
    await user.click(screen.getByLabelText(/Pause scheduled runs/));
    await user.click(screen.getByRole("button", { name: /save budget/i }));
    expect(mockState.save).toHaveBeenCalledWith({
      dailyUsd: 25,
      monthlyUsd: 200,
      blockScheduled: true,
    });
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
  });

  it("disables Save while a limit is not a positive number", async () => {
    const user = userEvent.setup();
    render(<Budget />);
    const dailyInput = screen.getByLabelText(/Daily limit/);
    await user.clear(dailyInput);
    await user.type(dailyInput, "-5");
    expect(screen.getByRole("button", { name: /save budget/i })).toBeDisabled();
    await user.clear(dailyInput); // empty = no limit = valid
    expect(screen.getByRole("button", { name: /save budget/i })).toBeEnabled();
  });

  it("shows 'over budget' and the overage when exceeded", () => {
    mockState.budget = response({
      status: {
        state: "exceeded",
        today: { spentUsd: 12, limitUsd: 10, ratio: 1.2 },
        month: { spentUsd: 12, limitUsd: null, ratio: null },
        blockScheduled: true,
      },
    });
    render(<Budget />);
    expect(screen.getByText("over budget")).toBeInTheDocument();
    expect(screen.getByText(/\$2\.00 over/)).toBeInTheDocument();
  });

  it("projects the month and names the day a limit would be crossed", () => {
    // Whether the current rate clears the ceiling is the question the page is
    // opened to answer; it used to be arithmetic over a 30-bar chart.
    mockState.budget = response({
      // Deliberately far past the pace, so the crossing day lands inside the
      // month whatever today's date is — the projection is date-dependent and
      // the assertion must not be.
      config: { dailyUsd: null, monthlyUsd: 5, blockScheduled: false, updatedAt: null },
      status: {
        state: "exceeded",
        today: { spentUsd: 2, limitUsd: null, ratio: null },
        month: { spentUsd: 40, limitUsd: 5, ratio: 8 },
        blockScheduled: false,
      },
    });
    render(<Budget />);
    expect(screen.getByText(/On course for/)).toBeInTheDocument();
    expect(screen.getByText(/limit reached around/)).toBeInTheDocument();
  });

  it("says nothing about a month with no spend to project from", () => {
    mockState.budget = response({
      status: {
        state: "ok",
        today: { spentUsd: 0, limitUsd: 10, ratio: 0 },
        month: { spentUsd: 0, limitUsd: 50, ratio: 0 },
        blockScheduled: false,
      },
    });
    render(<Budget />);
    expect(screen.queryByText(/On course for/)).toBeNull();
  });

  it("marks the days that broke the daily limit", () => {
    mockState.budget = response({
      config: { dailyUsd: 5, monthlyUsd: null, blockScheduled: false, updatedAt: null },
    });
    render(<Budget />);
    // One of the two ledger days spent $8.50 against a $5 ceiling.
    expect(screen.getByText("1 day over the daily limit")).toBeInTheDocument();
    expect(screen.getByTitle(/2026-07-13 .* over the daily limit/)).toBeInTheDocument();
  });
});
