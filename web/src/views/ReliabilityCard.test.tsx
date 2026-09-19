import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { PipelineReliability } from "../types";
import { ReliabilityCard } from "./ReliabilityCard";

const state: {
  reliability: PipelineReliability | null;
  loading: boolean;
  error: string | null;
} = {
  reliability: null,
  loading: false,
  error: null,
};

vi.mock("../useReliability", () => ({
  useReliability: () => ({ ...state, updatedAt: null }),
}));

function report(over: Partial<PipelineReliability> = {}): PipelineReliability {
  return {
    pipelineId: "p1",
    windowDays: 30,
    instances: 4,
    succeeded: 3,
    failed: 1,
    aborted: 0,
    firstAttemptSuccessRate: 0.5,
    luckyPassRate: 1 / 3,
    phases: [
      {
        phaseId: "build",
        name: "Build",
        instances: 4,
        firstAttemptPass: 2,
        luckyPass: 1,
        failed: 1,
        meanAttempts: 1.5,
        failureClasses: { verification: 1 },
        verificationFailRate: 0.25,
        stalls: 0,
        meanDurationMs: 12_000,
        meanCostUsd: 0.12,
      },
    ],
    trend: [
      { day: "2026-09-18", succeeded: 1, failed: 0 },
      { day: "2026-09-19", succeeded: 2, failed: 1 },
    ],
    computedAt: "2026-09-19T12:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  state.reliability = null;
  state.loading = false;
  state.error = null;
});

describe("ReliabilityCard", () => {
  it("shows an honest empty state when nothing settled in the window", () => {
    state.reliability = report({ instances: 0, succeeded: 0, failed: 0, phases: [], trend: [] });
    render(<ReliabilityCard pipelineId="p1" />);
    expect(screen.getByText(/No settled runs in the last 30 days/)).toBeInTheDocument();
  });

  it("shows the same empty state before any data has arrived", () => {
    state.reliability = null;
    state.loading = false;
    render(<ReliabilityCard pipelineId="p1" />);
    expect(screen.getByText(/No settled runs/)).toBeInTheDocument();
  });

  it("renders the first-attempt and lucky-pass rates, and the per-phase table", () => {
    state.reliability = report();
    render(<ReliabilityCard pipelineId="p1" />);
    expect(screen.getByText("50%")).toBeInTheDocument(); // first-attempt
    expect(screen.getByText("33%")).toBeInTheDocument(); // lucky pass
    expect(screen.getByText("Build")).toBeInTheDocument();
    expect(screen.getByText(/verification \(1\)/)).toBeInTheDocument();
  });

  it("names the aborted count when there were any", () => {
    state.reliability = report({ aborted: 2 });
    render(<ReliabilityCard pipelineId="p1" />);
    expect(screen.getByText("Aborted")).toBeInTheDocument();
  });

  it("says nothing about aborted instances when there were none", () => {
    state.reliability = report({ aborted: 0 });
    render(<ReliabilityCard pipelineId="p1" />);
    expect(screen.queryByText("Aborted")).not.toBeInTheDocument();
  });

  it("surfaces a load error", () => {
    state.reliability = null;
    state.error = "boom";
    render(<ReliabilityCard pipelineId="p1" />);
    expect(screen.getByText(/Couldn't load reliability: boom/)).toBeInTheDocument();
  });
});
