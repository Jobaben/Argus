import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Issue, IssuesSummary } from "../types";
import Issues from "./Issues";

const triage = vi.fn(async () => {});
const loadOccurrences = vi.fn(async () => [
  {
    runId: "r9",
    scheduleId: "s1",
    scheduleName: "Nightly triage",
    at: "2026-07-10T06:00:00.000Z",
    status: "failed" as const,
    outcome: null,
    error: "timeout after 42s",
  },
]);

const mockState: {
  issues: Issue[];
  summary: IssuesSummary;
  loading: boolean;
  error: string | null;
} = {
  issues: [],
  summary: { open: 0, resolved: 0, ignored: 0 },
  loading: false,
  error: null,
};

vi.mock("../useIssues", () => ({
  useIssues: () => ({ ...mockState, triage, loadOccurrences }),
}));

function issue(over: Partial<Issue> = {}): Issue {
  return {
    fingerprint: "abcdefabcdefabcd",
    title: "timeout after 42s",
    count: 7,
    firstSeen: "2026-07-09T06:00:00.000Z",
    lastSeen: "2026-07-10T06:00:00.000Z",
    schedules: ["Nightly triage"],
    state: "open",
    lastRunId: "r9",
    ...over,
  };
}

describe("Issues", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.issues = [];
    mockState.summary = { open: 0, resolved: 0, ignored: 0 };
    mockState.loading = false;
    mockState.error = null;
  });

  it("shows the empty state when there are no failures", () => {
    render(<Issues />);
    expect(screen.getByText(/No failures on record/)).toBeInTheDocument();
  });

  it("renders grouped issues with count, state, and affected schedules", () => {
    mockState.issues = [issue()];
    mockState.summary = { open: 1, resolved: 0, ignored: 0 };
    render(<Issues />);
    expect(screen.getByText("timeout after 42s")).toBeInTheDocument();
    expect(screen.getByText("×7")).toBeInTheDocument();
    expect(screen.getByText("open")).toBeInTheDocument();
    expect(screen.getByText("Nightly triage")).toBeInTheDocument();
  });

  it("open issues offer Resolve and Ignore; resolved offers Reopen", () => {
    mockState.issues = [issue(), issue({ fingerprint: "bbbbbbbbbbbbbbbb", state: "resolved" })];
    render(<Issues />);
    expect(screen.getByRole("button", { name: "Resolve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ignore" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reopen" })).toBeInTheDocument();
  });

  it("clicking Resolve calls triage with the fingerprint", () => {
    mockState.issues = [issue()];
    render(<Issues />);
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
    expect(triage).toHaveBeenCalledWith("abcdefabcdefabcd", "resolve");
  });

  it("expanding an issue loads and shows its occurrences", async () => {
    mockState.issues = [issue()];
    render(<Issues />);
    fireEvent.click(screen.getByRole("button", { name: /timeout after 42s/ }));
    await waitFor(() => {
      expect(loadOccurrences).toHaveBeenCalledWith("abcdefabcdefabcd");
      expect(screen.getAllByText(/timeout after 42s/).length).toBeGreaterThan(1);
    });
  });

  it("surfaces a fetch error", () => {
    mockState.error = "boom";
    render(<Issues />);
    expect(screen.getByText(/Couldn't load issues: boom/)).toBeInTheDocument();
  });
});
