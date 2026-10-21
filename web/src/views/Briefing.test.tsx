import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
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

  it("calls a failing monitor what the Health page calls it, and says what to do", () => {
    render(
      <Briefing
        briefing={briefing({
          attention: [
            {
              kind: "monitor-failing",
              id: "s1",
              title: "Dependency audit",
              detail: "3 of the last 5 runs failed",
              at: "2026-07-11T06:00:00.000Z",
            },
          ],
          attentionCount: 1,
        })}
        loading={false}
        error={null}
        ack={async () => {}}
      />,
    );
    const card = screen.getByRole("link", { name: /Dependency audit/ });
    expect(card).toHaveAttribute("href", "#/health");
    expect(within(card).getByText("Monitor failing")).toBeInTheDocument();
    expect(within(card).getByText("Open monitor")).toBeInTheDocument();
  });

  it("skips an attention kind it has no card for instead of failing to draw", () => {
    render(
      <Briefing
        briefing={briefing({
          attention: [
            // As a newer server might send it to a tab opened before an upgrade.
            {
              kind: "quota-exhausted" as never,
              id: "q1",
              title: "Token quota",
              detail: "",
              at: null,
            },
            {
              kind: "monitor-down",
              id: "s2",
              title: "Nightly backup",
              detail: "expected a run, none arrived",
              at: null,
            },
          ],
          attentionCount: 2,
        })}
        loading={false}
        error={null}
        ack={async () => {}}
      />,
    );
    expect(screen.getByRole("link", { name: /Nightly backup/ })).toBeInTheDocument();
    expect(screen.queryByText("Token quota")).not.toBeInTheDocument();
  });

  it("opens an anomaly's own run when its id names one", () => {
    render(
      <Briefing
        briefing={briefing({
          attention: [
            {
              kind: "anomaly",
              id: "schedule:s1|cost|r9",
              title: "Nightly triage",
              detail: "4.2× median cost",
              at: null,
            },
          ],
          attentionCount: 1,
        })}
        loading={false}
        error={null}
        ack={async () => {}}
      />,
    );
    expect(screen.getByRole("link", { name: /Inspect run/ })).toHaveAttribute("href", "#/run/r9");
  });

  it("reads a failure by its prose, never its ARGUS_OUTCOME line", () => {
    render(
      <Briefing
        briefing={briefing({
          window: {
            ...briefing().window,
            totalRuns: 2,
            byStatus: {
              running: 0,
              succeeded: 0,
              failed: 2,
              skipped: 0,
              interrupted: 0,
              cancelled: 0,
            },
            failures: [
              { ...failedRun, error: "lint found 3 errors\nARGUS_OUTCOME: failed lint is red" },
              // Nothing but the marker: its reason is the message.
              {
                ...failedRun,
                id: "r2",
                scheduleName: "Audit",
                error: "ARGUS_OUTCOME: blocked no token",
              },
            ],
          },
        })}
        loading={false}
        error={null}
        ack={async () => {}}
      />,
    );
    expect(screen.queryByText(/ARGUS_OUTCOME/)).toBeNull();
    expect(screen.getByText("lint found 3 errors")).toBeInTheDocument();
    expect(screen.getByText("no token")).toBeInTheDocument();
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
    expect(screen.getAllByText("Timeout after 42s")).toHaveLength(1);
  });

  it("capitalises an issue's signature as #/issues does, and leaves names as typed", () => {
    const newIssue = {
      fingerprint: "1234123412341234",
      title: "interrupted: Argus restarted while the run was in flight",
      count: 1,
      firstSeen: "2026-07-11T02:05:00.000Z",
      lastSeen: "2026-07-11T02:05:00.000Z",
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
              title: "exit code 1",
              detail: "2× across Nightly triage",
              at: "2026-07-11T04:05:00.000Z",
            },
            {
              kind: "monitor-down",
              id: "s9",
              title: "nightly-audit",
              detail: "expected a run, none arrived",
              at: "2026-07-11T04:00:00.000Z",
            },
          ],
          attentionCount: 2,
          window: win({ totalRuns: 1, newIssues: [newIssue] }),
        })}
        loading={false}
        error={null}
        ack={async () => {}}
      />,
    );
    expect(screen.getByText("Exit code 1")).toHaveAttribute("title", "Exit code 1");
    expect(screen.queryByText("exit code 1")).not.toBeInTheDocument();
    const row = screen.getByText("Interrupted: Argus restarted while the run was in flight");
    expect(row.closest("a")).toHaveAttribute("href", "#/issues");
    // A schedule's name is its owner's word, not a clause from the server.
    expect(screen.getByText("nightly-audit")).toBeInTheDocument();
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
        error="database is locked"
        ack={async () => {}}
        refresh={refresh}
      />,
    );
    // The server answered: its reason, not a claim that it was unreachable.
    expect(screen.getByText("Couldn't load the briefing: database is locked")).toBeInTheDocument();
    expect(screen.queryByText(/couldn't reach/i)).toBeNull();
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

describe("Briefing — saying each thing once, in sentence case", () => {
  const anomaly = {
    id: "schedule:s1|cost|r9",
    key: "schedule:s1",
    scope: "schedule" as const,
    name: "Nightly code review",
    runId: "r9",
    scheduleId: "s1",
    metric: "cost" as const,
    direction: "high" as const,
    severity: "critical" as const,
    value: 0.42,
    median: 0.13,
    ratio: 3.2,
    zScore: 18,
    at: "2026-07-11T06:00:00.000Z",
    detail: "3.2× median cost ($0.42 vs $0.13 over 24 runs)",
  };
  const issue = (count: number, fingerprint: string, title: string) => ({
    fingerprint,
    title,
    count,
    firstSeen: "2026-07-11T02:05:00.000Z",
    lastSeen: "2026-07-11T04:05:00.000Z",
    schedules: ["Nightly triage"],
    state: "resolved" as const,
    members: ["abcdef0123456789"],
    failureClass: null,
    lastRunId: "r1",
  });

  it("starts a card's detail with a capital and quotes a name typographically", () => {
    const data = briefing({
      attention: [
        {
          kind: "gate-waiting",
          id: "i1",
          title: "Release train is waiting for you",
          detail: 'phase "Open the PR" needs approval',
          at: "2026-07-11T07:00:00.000Z",
        },
        {
          kind: "monitor-failing",
          id: "s2",
          title: "Docs link check",
          detail: "last completed run failed",
          at: "2026-07-11T06:00:00.000Z",
        },
      ],
      attentionCount: 2,
    });
    render(<Briefing briefing={data} loading={false} error={null} ack={async () => {}} />);
    const gate = screen.getByText("Phase “Open the PR” needs approval");
    expect(screen.getByText("Last completed run failed")).toBeInTheDocument();
    // Two lines before it clips, like the rows below: the reason is the point.
    expect(gate).toHaveClass("line-clamp-2");
    expect(gate).not.toHaveClass("truncate");
  });

  it("does not list a critical anomaly again under the window when it is already a card", () => {
    const data = briefing({
      attention: [
        {
          kind: "anomaly",
          id: anomaly.id,
          title: anomaly.name,
          detail: anomaly.detail,
          at: anomaly.at,
        },
      ],
      attentionCount: 1,
      window: { ...briefing().window, totalRuns: 3, anomalies: [anomaly] },
    });
    render(<Briefing briefing={data} loading={false} error={null} ack={async () => {}} />);
    expect(screen.getAllByText("Nightly code review")).toHaveLength(1);
    expect(screen.queryByText(/Ran, but not the way it usually runs/i)).not.toBeInTheDocument();
  });

  it("counts a new issue only when it happened more than once, as Failures does", () => {
    const data = briefing({
      window: {
        ...briefing().window,
        totalRuns: 3,
        newIssues: [
          issue(1, "1111111111111111", "Lint failed once"),
          issue(3, "2222222222222222", "Deploy timed out"),
        ],
      },
    });
    render(<Briefing briefing={data} loading={false} error={null} ack={async () => {}} />);
    const row = (title: string) => screen.getByText(title).closest("a") as HTMLElement;
    expect(within(row("Lint failed once")).queryByText(/×/)).not.toBeInTheDocument();
    expect(within(row("Deploy timed out")).getByText("×3")).toBeInTheDocument();
  });
});
