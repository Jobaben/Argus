import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SessionSummary } from "../useSessions";
import Sessions from "./Sessions";

const mockState: { sessions: SessionSummary[]; loading: boolean; error: string | null } = {
  sessions: [],
  loading: false,
  error: null,
};

vi.mock("../useSessions", () => ({
  useSessions: () => ({ ...mockState, refresh: vi.fn() }),
}));

vi.mock("../useHashRoute", () => ({ useHashRoute: () => ["sessions"] }));

/**
 * Anchored to midday rather than offset from `Date.now()`.
 *
 * "Two hours ago" is only reliably *today* if the suite does not run between
 * midnight and 02:00 — which is exactly when CI does. Pinning to noon makes the
 * day the fixture claims the day it actually lands in, at every hour.
 */
const dayAtNoon = (daysAgo: number, hour = 12) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

const session = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  id: "s1",
  project: "-home-me-api",
  projectLabel: "/home/me/api",
  title: "Fix the migration",
  messageCount: 12,
  toolUseCount: 4,
  model: "claude-sonnet-4-5",
  firstActivity: dayAtNoon(0, 11),
  lastActivity: dayAtNoon(0),
  ...over,
});

describe("Sessions", () => {
  beforeEach(() => {
    mockState.sessions = [];
    mockState.loading = false;
    mockState.error = null;
  });

  it("teaches where transcripts come from when there are none", () => {
    render(<Sessions />);
    expect(screen.getByText(/No transcripts yet/)).toBeInTheDocument();
    expect(screen.getByText(/~\/\.claude\/projects/)).toBeInTheDocument();
  });

  it("counts transcripts and the projects they span", () => {
    mockState.sessions = [
      session({ id: "a" }),
      session({ id: "b", project: "-home-me-web", projectLabel: "/home/me/web" }),
    ];
    render(<Sessions />);
    expect(screen.getByText("2 transcripts across 2 projects")).toBeInTheDocument();
  });

  it("groups by day so a transcript can be found by when it happened", () => {
    mockState.sessions = [
      session({ id: "now" }),
      session({ id: "old", lastActivity: dayAtNoon(1) }),
    ];
    render(<Sessions />);
    expect(screen.getByRole("heading", { name: /Today/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Yesterday/ })).toBeInTheDocument();
  });

  it("filters with the same fuzzy matching the palette uses", async () => {
    const user = userEvent.setup();
    mockState.sessions = [
      session({ id: "a", title: "Fix the migration" }),
      session({ id: "b", title: "Rewrite the README" }),
    ];
    render(<Sessions />);
    await user.type(screen.getByRole("searchbox"), "ftm");
    expect(screen.getByText("Fix the migration")).toBeInTheDocument();
    expect(screen.queryByText("Rewrite the README")).not.toBeInTheDocument();
    expect(screen.getByText("1 of 2 transcripts")).toBeInTheDocument();
  });

  it("drops the day headings while searching, because rank order is the answer", async () => {
    const user = userEvent.setup();
    mockState.sessions = [session()];
    render(<Sessions />);
    expect(screen.getByRole("heading", { name: /Today/ })).toBeInTheDocument();
    await user.type(screen.getByRole("searchbox"), "fix");
    expect(screen.queryByRole("heading", { name: /Today/ })).not.toBeInTheDocument();
  });

  it("says what the filter searches when nothing matches", async () => {
    const user = userEvent.setup();
    mockState.sessions = [session()];
    render(<Sessions />);
    await user.type(screen.getByRole("searchbox"), "zzzzq");
    expect(screen.getByText(/Nothing matches/)).toBeInTheDocument();
    expect(screen.getByText(/titles, project paths and model names/)).toBeInTheDocument();
  });

  it("keeps the list visible while a refresh is in flight", () => {
    // A poll that sets `loading` must not blank a list we already have.
    mockState.sessions = [session()];
    mockState.loading = true;
    render(<Sessions />);
    expect(screen.getByText("Fix the migration")).toBeInTheDocument();
  });

  it("surfaces a fetch error", () => {
    mockState.error = "boom";
    render(<Sessions />);
    expect(screen.getByText(/Couldn't reach the Argus server: boom/)).toBeInTheDocument();
  });
});
