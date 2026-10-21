import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
    members: ["abcdef0123456789"],
    failureClass: null,
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

  it("clicking Resolve calls triage with the fingerprint", async () => {
    mockState.issues = [issue()];
    render(<Issues />);
    const button = screen.getByRole("button", { name: "Resolve" });
    fireEvent.click(button);
    expect(triage).toHaveBeenCalledWith("abcdefabcdefabcd", "resolve");
    // Available again once the triage settles.
    await waitFor(() => expect(button).not.toHaveAttribute("aria-disabled"));
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

  it("filters to one state when its counter is pressed", () => {
    // With thirty resolved issues, the two open ones were needles in a haystack.
    mockState.issues = [
      issue({ fingerprint: "open1", title: "still broken", state: "open" }),
      issue({ fingerprint: "done1", title: "was fixed", state: "resolved" }),
    ];
    mockState.summary = { open: 1, resolved: 1, ignored: 0 };
    render(<Issues />);
    expect(screen.getByText("was fixed")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "1 Open" }));
    expect(screen.queryByText("was fixed")).not.toBeInTheDocument();
    expect(screen.getByText("still broken")).toBeInTheDocument();
    expect(screen.getByText(/Showing 1 open of 2/)).toBeInTheDocument();
  });

  it("does not badge an open issue, and never colours its count as a status", () => {
    mockState.issues = [issue(), issue({ fingerprint: "bbbbbbbbbbbbbbbb", state: "resolved" })];
    mockState.summary = { open: 1, resolved: 1, ignored: 0 };
    render(<Issues />);
    // The resolved row is badged; the open one is open by default, said to a
    // screen reader rather than as one more red pill.
    expect(screen.getByText("resolved").className).toMatch(/text-ok/);
    expect(screen.getByText("open").className).toMatch(/sr-only/);
    for (const count of screen.getAllByText("×7")) {
      expect(count.className).not.toMatch(/fail/);
    }
  });

  it("strips the scheduler's outcome marker from an occurrence's error", async () => {
    const user = userEvent.setup();
    loadOccurrences.mockResolvedValueOnce([
      {
        runId: "r9",
        scheduleId: "s1",
        scheduleName: "Nightly triage",
        at: "2026-07-10T06:00:00.000Z",
        status: "failed" as const,
        outcome: null,
        error: "could not reach the database\nARGUS_OUTCOME: failed db timeout",
      },
    ]);
    mockState.issues = [issue()];
    render(<Issues />);
    await user.click(screen.getByRole("button", { expanded: false }));
    expect(await screen.findByText("could not reach the database")).toBeInTheDocument();
    expect(screen.queryByText(/ARGUS_OUTCOME/)).not.toBeInTheDocument();
  });

  it("hides the counter row when there is nothing on record", () => {
    render(<Issues />);
    expect(screen.queryByRole("region", { name: "Issues by state" })).not.toBeInTheDocument();
  });

  it("leaves a zero counter inert", () => {
    mockState.issues = [issue()];
    mockState.summary = { open: 1, resolved: 0, ignored: 0 };
    render(<Issues />);
    // The two empty tiles are not controls; the open tile and the two triage
    // buttons on the card are.
    expect(screen.queryAllByRole("button", { name: /Ignored|Resolved/ })).toHaveLength(0);
  });
});

describe("Issues — Autopsy integration", () => {
  it("shows the failure class Autopsy assigned", () => {
    mockState.issues = [issue({ failureClass: "rate-limit" })];
    render(<Issues />);
    expect(screen.getByText("Rate limit")).toBeInTheDocument();
  });

  it("says when several wordings were merged into one issue", () => {
    mockState.issues = [issue({ members: ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"] })];
    render(<Issues />);
    expect(screen.getByText(/2 wordings merged/i)).toBeInTheDocument();
  });

  it("a single-wording issue says nothing about merging", () => {
    mockState.issues = [issue()];
    render(<Issues />);
    expect(screen.queryByText(/wordings merged/i)).not.toBeInTheDocument();
  });

  it("each occurrence links to its own recording", async () => {
    const user = userEvent.setup();
    mockState.issues = [issue()];
    render(<Issues />);
    await user.click(screen.getByRole("button", { expanded: false }));
    // "Open run", not "Replay": the link opens the recording, and "Replay" on
    // a failure read as "run it again".
    const link = await screen.findByRole("link", { name: /open run/i });
    expect(link).toHaveAttribute("href", "#/run/r9");
    expect(link).toHaveAttribute("title", expect.stringMatching(/replay this run/i));
  });
});
