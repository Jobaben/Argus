import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Briefing as BriefingData } from "../types";
import Briefing from "./Briefing";

function briefing(over: Partial<BriefingData> = {}): BriefingData {
  return {
    since: "2026-07-10T18:00:00.000Z",
    generatedAt: "2026-07-11T08:00:00.000Z",
    attention: [],
    attentionCount: 0,
    window: {
      totalRuns: 0,
      byStatus: { running: 0, succeeded: 0, failed: 0, skipped: 0, interrupted: 0, cancelled: 0 },
      costUsd: 0,
      tokens: 0,
      failures: [],
      newIssues: [],
      finishedPipelines: [],
      anomalies: [],
    },
    ...over,
  };
}

const failedRun = {
  id: "r1",
  scheduleId: "s1",
  scheduleName: "Nightly triage",
  prompt: "p",
  cwd: "/tmp",
  status: "failed" as const,
  trigger: "scheduled" as const,
  queuedAt: "2026-07-11T02:00:00.000Z",
  startedAt: "2026-07-11T02:00:00.000Z",
  endedAt: "2026-07-11T02:05:00.000Z",
  durationMs: 300000,
  pid: null,
  exitCode: 1,
  sessionId: null,
  project: null,
  resultSummary: null,
  error: "timeout after 42s",
};

describe("Briefing", () => {
  it("renders the all-clear state when nothing needs attention and the window is calm", () => {
    render(<Briefing briefing={briefing()} loading={false} error={null} ack={async () => {}} />);
    expect(screen.getByText(/All caught up/i)).toBeInTheDocument();
  });

  it("renders attention cards with deep links", () => {
    const data = briefing({
      attention: [
        {
          kind: "monitor-down",
          id: "s1",
          title: "Nightly triage",
          detail: "expected a run, none arrived",
          at: "2026-07-11T06:00:00.000Z",
        },
        {
          kind: "gate-waiting",
          id: "i1",
          title: "Release train is waiting for you",
          detail: 'phase "Ship" needs approval',
          at: "2026-07-11T07:00:00.000Z",
        },
      ],
      attentionCount: 2,
    });
    render(<Briefing briefing={data} loading={false} error={null} ack={async () => {}} />);
    expect(screen.getByText("Nightly triage")).toBeInTheDocument();
    expect(screen.getByText(/needs approval/)).toBeInTheDocument();
    const links = screen.getAllByRole("link");
    expect(links.some((l) => l.getAttribute("href") === "#/health")).toBe(true);
    // A gate is acted on in the Command Center's review drawer, so the card
    // deep-links to that instance's drawer — not to the Pipelines page, which
    // can only stop it.
    expect(links.some((l) => l.getAttribute("href") === "#/command/i1")).toBe(true);
  });

  it("summarizes the window: run counts, cost, failures, new issues, finished pipelines", () => {
    const data = briefing({
      window: {
        totalRuns: 14,
        byStatus: {
          running: 1,
          succeeded: 11,
          failed: 2,
          skipped: 0,
          interrupted: 0,
          cancelled: 0,
        },
        costUsd: 1.84,
        tokens: 92000,
        failures: [
          {
            id: "r1",
            scheduleId: "s1",
            scheduleName: "Nightly triage",
            prompt: "p",
            cwd: "/tmp",
            status: "failed",
            trigger: "scheduled",
            queuedAt: "2026-07-11T02:00:00.000Z",
            startedAt: "2026-07-11T02:00:00.000Z",
            endedAt: "2026-07-11T02:05:00.000Z",
            durationMs: 300000,
            pid: null,
            exitCode: 1,
            sessionId: null,
            project: null,
            resultSummary: null,
            error: "timeout after 42s",
          },
        ],
        newIssues: [
          {
            fingerprint: "abcdefabcdefabcd",
            title: "timeout after 42s",
            count: 2,
            firstSeen: "2026-07-11T02:05:00.000Z",
            lastSeen: "2026-07-11T04:05:00.000Z",
            schedules: ["Nightly triage"],
            state: "open",
            members: ["abcdef0123456789"],
            failureClass: null,
            lastRunId: "r1",
          },
        ],
        finishedPipelines: [],
        anomalies: [],
      },
    });
    render(<Briefing briefing={data} loading={false} error={null} ack={async () => {}} />);
    expect(screen.getAllByText("14").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/timeout after 42s/).length).toBeGreaterThan(0);
    expect(screen.getByText(/\$1\.84/)).toBeInTheDocument();
  });

  it("Mark caught up calls ack", async () => {
    const ack = vi.fn(async () => {});
    render(<Briefing briefing={briefing()} loading={false} error={null} ack={ack} />);
    const button = screen.getByRole("button", { name: /mark caught up/i });
    fireEvent.click(button);
    expect(ack).toHaveBeenCalledOnce();
    // Available again once the acknowledgement settles.
    await waitFor(() => expect(button).not.toHaveAttribute("aria-disabled"));
  });

  it("says so when marking caught up fails, rather than failing silently", async () => {
    const ack = vi.fn(async () => {
      throw new Error("HTTP 500");
    });
    render(<Briefing briefing={briefing()} loading={false} error={null} ack={ack} />);
    fireEvent.click(screen.getByRole("button", { name: /mark caught up/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/window was not reset: HTTP 500/);
  });

  it("links a failure to the run's transcript, and to Issues when there is none", () => {
    // Every other row on the page linked to the thing it described; the failures
    // list — the most actionable one — was dead.
    render(
      <Briefing
        briefing={briefing({
          window: {
            totalRuns: 2,
            byStatus: {
              running: 0,
              succeeded: 0,
              failed: 2,
              skipped: 0,
              interrupted: 0,
              cancelled: 0,
            },
            costUsd: 0,
            tokens: 0,
            newIssues: [],
            finishedPipelines: [],
            anomalies: [],
            failures: [
              { ...failedRun, id: "a", sessionId: "sess-1", project: "-home-me-api" },
              // A different failure: the same one twice is one row (below).
              { ...failedRun, id: "b", sessionId: null, project: null, error: "disk full" },
            ],
          },
        })}
        loading={false}
        error={null}
        ack={async () => {}}
      />,
    );
    const links = screen.getAllByRole("link");
    const hrefs = links.map((l) => l.getAttribute("href"));
    expect(hrefs).toContain("#/sessions/-home-me-api/sess-1");
    expect(hrefs).toContain("#/issues");
  });
});

describe("Briefing — numbers that agree", () => {
  const win = (over: Partial<BriefingData["window"]>): BriefingData["window"] => ({
    ...briefing().window,
    ...over,
  });

  it("counts a run that exited cleanly but reported a failed outcome as failed", () => {
    // The Failures list (and Issues, and Chronicle) call it a failure; the
    // strip said "1 succeeded, 1 failed" right above a list of two.
    render(
      <Briefing
        briefing={briefing({
          window: win({
            totalRuns: 2,
            byStatus: {
              running: 0,
              succeeded: 1,
              failed: 1,
              skipped: 0,
              interrupted: 0,
              cancelled: 0,
            },
            failures: [
              failedRun,
              { ...failedRun, id: "r2", scheduleName: "Audit", status: "succeeded", error: null },
            ],
          }),
        })}
        loading={false}
        error={null}
        ack={async () => {}}
      />,
    );
    const failed = screen.getByText("Failed").parentElement!;
    expect(failed).toHaveTextContent("2");
    expect(screen.queryByText("Succeeded")).not.toBeInTheDocument();
  });

  it("collapses the same failure on the same schedule into one row with a count", () => {
    render(
      <Briefing
        briefing={briefing({
          window: win({
            totalRuns: 3,
            byStatus: {
              running: 0,
              succeeded: 0,
              failed: 3,
              skipped: 0,
              interrupted: 0,
              cancelled: 0,
            },
            failures: [failedRun, { ...failedRun, id: "r2" }, { ...failedRun, id: "r3" }],
          }),
        })}
        loading={false}
        error={null}
        ack={async () => {}}
      />,
    );
    expect(screen.getAllByText("timeout after 42s")).toHaveLength(1);
    expect(screen.getByText("×3")).toBeInTheDocument();
  });

  it("does not list a new issue again when it is already an attention card", () => {
    const newIssue = {
      fingerprint: "abcdefabcdefabcd",
      title: "timeout after 42s",
      count: 2,
      firstSeen: "2026-07-11T02:05:00.000Z",
      lastSeen: "2026-07-11T04:05:00.000Z",
      schedules: ["Nightly triage"],
      state: "open" as const,
      members: ["abcdef0123456789"],
      failureClass: null,
      lastRunId: "r1",
    };
    render(
      <Briefing
        briefing={briefing({
          attention: [
            {
              kind: "issue-open",
              id: "abcdefabcdefabcd",
              title: "timeout after 42s",
              detail: "2× across Nightly triage",
              at: "2026-07-11T04:05:00.000Z",
            },
          ],
          attentionCount: 1,
          window: win({ totalRuns: 1, newIssues: [newIssue] }),
        })}
        loading={false}
        error={null}
        ack={async () => {}}
      />,
    );
    expect(screen.queryByText(/New issues/)).not.toBeInTheDocument();
    expect(screen.getAllByText("timeout after 42s")).toHaveLength(1);
  });
});

describe("Briefing — first visit", () => {
  // Never caught up: the window is the server's default day, to the millisecond.
  const fresh = () =>
    briefing({ since: "2026-07-10T08:00:00.000Z", generatedAt: "2026-07-11T08:00:00.000Z" });

  it("welcomes a first visit with the next step instead of claiming all is well", () => {
    render(<Briefing briefing={fresh()} loading={false} error={null} ack={async () => {}} />);
    expect(screen.getByText(/Nothing to brief yet/)).toBeInTheDocument();
    expect(screen.queryByText(/All caught up/i)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /create a schedule/i })).toHaveAttribute(
      "href",
      "#/schedules",
    );
    expect(screen.queryByRole("button", { name: /mark caught up/i })).not.toBeInTheDocument();
  });

  it("keeps saying what the page is for once it has loaded", () => {
    render(<Briefing briefing={fresh()} loading={false} error={null} ack={async () => {}} />);
    expect(screen.getByText(/What needs you now/)).toBeInTheDocument();
  });

  it("offers Retry on a failed load when it can refetch", () => {
    const refresh = vi.fn();
    render(
      <Briefing
        briefing={null}
        loading={false}
        error="HTTP 502"
        ack={async () => {}}
        refresh={refresh}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refresh).toHaveBeenCalledOnce();
  });
});

describe("Briefing — Watchtower anomalies", () => {
  it("lists anomalies from the window under their own heading", () => {
    const data = briefing({
      window: {
        ...briefing().window,
        totalRuns: 3,
        anomalies: [
          {
            id: "schedule:s1|cost|r9",
            key: "schedule:s1",
            scope: "schedule",
            name: "Nightly triage",
            runId: "r9",
            scheduleId: "s1",
            metric: "cost",
            direction: "high",
            severity: "critical",
            value: 0.42,
            median: 0.1,
            ratio: 4.2,
            zScore: 21.6,
            at: "2026-07-10T06:00:00.000Z",
            detail: "4.2× median cost ($0.42 vs $0.10 over 20 runs)",
          },
        ],
      },
    });
    render(<Briefing briefing={data} loading={false} error={null} ack={async () => {}} />);
    expect(screen.getByText(/Ran, but not the way it usually runs/i)).toBeInTheDocument();
    expect(screen.getByText(/4.2× median cost/)).toBeInTheDocument();
  });

  it("regression: an anomaly attention card is amber, not the failure red", () => {
    const data = briefing({
      attention: [
        {
          kind: "anomaly",
          id: "a1",
          title: "Nightly triage",
          detail: "4.2× median cost",
          at: "2026-07-10T06:00:00.000Z",
        },
      ],
      attentionCount: 1,
    });
    render(<Briefing briefing={data} loading={false} error={null} ack={async () => {}} />);
    const label = screen.getByText("Anomaly");
    expect(label.className).toMatch(/await/);
    // The card it sits in follows the same tone rather than defaulting to red.
    expect(label.closest("div.rounded-tile")?.className).toMatch(/border-await/);
  });
});
