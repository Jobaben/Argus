import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Stats as StatsData } from "../useStats";
import Stats from "./Stats";
import { hasSessionData, hasTokenData } from "./statsGroups";

const mockState: { stats: StatsData | null; loading: boolean; error: string | null } = {
  stats: null,
  loading: false,
  error: null,
};

vi.mock("../useStats", () => ({
  useStats: () => ({ ...mockState, refresh: vi.fn() }),
}));

const headline = (over: Partial<StatsData["headline"]> = {}): StatsData["headline"] => ({
  totalSessions: 184,
  totalMessages: 9400,
  totalToolCalls: 0,
  totalTokens: 0,
  totalOutputTokens: 0,
  totalCacheReadTokens: 0,
  totalCostUSD: 0,
  activeDays: 0,
  modelsUsed: 0,
  ...over,
});

const stats = (over: Partial<StatsData> = {}): StatsData => ({
  available: true,
  lastComputedDate: "2026-07-26",
  firstSessionDate: "2026-01-04T09:00:00.000Z",
  headline: headline(),
  longestSession: null,
  models: [],
  daily: [],
  peakHours: [],
  ...over,
});

describe("statsGroups", () => {
  it("recognises transcript-derived counts", () => {
    expect(hasSessionData(headline())).toBe(true);
    expect(
      hasSessionData(headline({ totalSessions: 0, totalMessages: 0, totalToolCalls: 0 })),
    ).toBe(false);
  });

  it("treats an all-zero token half as absent, not as a measurement", () => {
    // "0 tokens across 184 sessions" is not a thing that happens; it means the
    // usage telemetry has not been written.
    expect(hasTokenData(headline())).toBe(false);
    expect(hasTokenData(headline({ totalTokens: 1 }))).toBe(true);
    expect(hasTokenData(headline({ totalCostUSD: 0.02 }))).toBe(true);
    expect(hasTokenData(headline({ modelsUsed: 2 }))).toBe(true);
  });
});

describe("Stats", () => {
  beforeEach(() => {
    mockState.stats = stats();
    mockState.loading = false;
    mockState.error = null;
  });

  it("explains a missing token half instead of printing zeros", () => {
    render(<Stats />);
    expect(screen.getByText(/No token or cost telemetry yet/)).toBeInTheDocument();
    expect(screen.queryByText("Total tokens")).toBeNull();
    // The counts that are real stay.
    expect(screen.getByText("184")).toBeInTheDocument();
  });

  it("shows the token tiles once there is telemetry, zeros included", () => {
    mockState.stats = stats({
      headline: headline({ totalTokens: 1_200_000, modelsUsed: 2, totalCacheReadTokens: 0 }),
    });
    render(<Stats />);
    expect(screen.getByText("Total tokens")).toBeInTheDocument();
    expect(screen.getByText("1.2M")).toBeInTheDocument();
    // A real zero among real numbers is meaningful and stays.
    expect(screen.getByText("Cache reads")).toBeInTheDocument();
    expect(screen.queryByText(/No token or cost telemetry/)).toBeNull();
  });

  it("falls back to the empty state when stats are unavailable", () => {
    mockState.stats = stats({ available: false });
    render(<Stats />);
    expect(screen.getByText(/No usage stats found yet/)).toBeInTheDocument();
  });

  it("surfaces a fetch error", () => {
    mockState.error = "boom";
    render(<Stats />);
    expect(screen.getByText(/Couldn't reach the Argus server: boom/)).toBeInTheDocument();
  });
});
