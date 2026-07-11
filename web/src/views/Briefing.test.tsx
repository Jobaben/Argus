import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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
    },
    ...over,
  };
}

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
    expect(links.some((l) => l.getAttribute("href") === "#/monitors")).toBe(true);
    expect(links.some((l) => l.getAttribute("href") === "#/pipelines")).toBe(true);
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
            lastRunId: "r1",
          },
        ],
        finishedPipelines: [],
      },
    });
    render(<Briefing briefing={data} loading={false} error={null} ack={async () => {}} />);
    expect(screen.getAllByText("14").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/timeout after 42s/).length).toBeGreaterThan(0);
    expect(screen.getByText(/\$1\.84/)).toBeInTheDocument();
  });

  it("Mark caught up calls ack", () => {
    const ack = vi.fn(async () => {});
    render(<Briefing briefing={briefing()} loading={false} error={null} ack={ack} />);
    fireEvent.click(screen.getByRole("button", { name: /mark caught up/i }));
    expect(ack).toHaveBeenCalledOnce();
  });
});
