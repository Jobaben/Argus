import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Activity } from "../useActivity";
import ActivityFeed from "./ActivityFeed";

const mockState: { activity: Activity[]; loading: boolean; error: string | null } = {
  activity: [],
  loading: false,
  error: null,
};

vi.mock("../useActivity", () => ({
  useActivity: () => ({ ...mockState, refresh: vi.fn() }),
}));

const entry = (over: Partial<Activity> = {}): Activity => ({
  ts: new Date(Date.now() - 5 * 60_000).toISOString(),
  text: "refactor the scheduler",
  project: "api",
  cwd: "/home/me/api",
  ...over,
});

describe("ActivityFeed", () => {
  beforeEach(() => {
    mockState.activity = [];
    mockState.loading = false;
    mockState.error = null;
  });

  it("renders a prompt with its project and a live relative timestamp", () => {
    mockState.activity = [entry()];
    render(<ActivityFeed />);
    expect(screen.getByText("refactor the scheduler")).toBeInTheDocument();
    expect(screen.getByTitle("/home/me/api")).toBeInTheDocument();
    expect(screen.getByText(/[45]m ago/)).toBeInTheDocument();
  });

  it("truncates a very long prompt rather than flooding the row", () => {
    mockState.activity = [entry({ text: "x".repeat(400) })];
    render(<ActivityFeed />);
    expect(screen.getByText(/^x+…$/)).toBeInTheDocument();
  });

  it("shows the empty state and surfaces an error", () => {
    render(<ActivityFeed />);
    expect(screen.getByText(/No prompt history found yet/)).toBeInTheDocument();
    mockState.error = "boom";
    render(<ActivityFeed />);
    expect(screen.getByText(/Couldn't load activity: boom/)).toBeInTheDocument();
  });
});
