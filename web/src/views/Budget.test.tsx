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
});
