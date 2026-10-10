import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import Health from "./Health";

const route: { segments: string[] } = { segments: ["health"] };
vi.mock("../useHashRoute", () => ({ useHashRoute: () => route.segments }));

vi.mock("../useMonitors", () => ({
  useMonitors: () => ({
    monitors: [],
    summary: { down: 0, failing: 0, late: 0, up: 0, pending: 0, paused: 0 },
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

vi.mock("../useWatchtower", () => ({
  useWatchtower: () => ({
    report: {
      generatedAt: "2026-07-20T12:00:00.000Z",
      baselines: [],
      anomalies: [],
      summary: { ready: 0, warming: 0, anomalies: 0, critical: 0 },
      warmupRuns: 8,
    },
    loading: false,
    error: null,
    refresh: vi.fn(),
    reset: vi.fn(),
    restore: vi.fn(),
  }),
}));

vi.mock("../useVerdict", () => ({
  useVerdictTrends: () => ({
    report: { generatedAt: "", trends: [], summary: { scored: 0, regressions: 0, average: null } },
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

describe("Health", () => {
  it("opens on Monitors and offers Watchtower as the other half", () => {
    route.segments = ["health"];
    render(<Health />);
    expect(screen.getByRole("heading", { name: "Health" })).toBeInTheDocument();
    const monitors = screen.getByRole("link", { name: "Monitors" });
    expect(monitors).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Watchtower" })).toHaveAttribute(
      "href",
      "#/health/watchtower",
    );
    expect(screen.getByText(/No monitors yet/)).toBeInTheDocument();
  });

  it("shows Watchtower when the hash names it", () => {
    route.segments = ["health", "watchtower"];
    render(<Health />);
    expect(screen.getByRole("link", { name: "Watchtower" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByText(/Nothing to learn from yet/)).toBeInTheDocument();
    expect(screen.queryByText(/No monitors yet/)).toBeNull();
  });

  it("treats any other second segment as Monitors", () => {
    route.segments = ["health", "nonsense"];
    render(<Health />);
    expect(screen.getByRole("link", { name: "Monitors" })).toHaveAttribute("aria-current", "page");
  });
});
