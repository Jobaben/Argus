import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { vi } from "vitest";
import type { Chronicle as ChronicleData, ChronicleSpan, FleetMachine } from "../types";
import Chronicle from "./Chronicle";

const mockState: { chronicle: ChronicleData; loading: boolean; error: string | null } = {
  chronicle: {
    windowStart: "",
    windowEnd: "",
    groups: [],
    totals: { spans: 0, active: 0, failed: 0, costUsd: null, tokens: null },
  },
  loading: false,
  error: null,
};
const mockHours: number[] = [];

// This machine unless a test picks a peer.
const facet: { peer: FleetMachine | null } = { peer: null };
vi.mock("../fleet/useMachineFacet", () => ({
  useMachineFacet: () => ({
    selected: facet.peer?.peer.id ?? null,
    select: vi.fn(),
    machines: facet.peer ? [facet.peer] : [],
    peer: facet.peer,
    soloMode: facet.peer == null,
  }),
}));

vi.mock("../useChronicle", () => ({
  useChronicle: (hours: number) => {
    mockHours.push(hours);
    return { ...mockState, refresh: vi.fn() };
  },
}));

function span(id: string, over: Partial<ChronicleSpan> = {}): ChronicleSpan {
  return {
    id,
    kind: "run",
    label: `Span ${id}`,
    status: "done",
    startedAt: "2026-07-09T06:00:00.000Z",
    endedAt: "2026-07-09T07:00:00.000Z",
    href: "#/schedules",
    detail: null,
    costUsd: null,
    tokens: null,
    ...over,
  };
}

function withData(): void {
  mockState.chronicle = {
    windowStart: "2026-07-09T00:00:00.000Z",
    windowEnd: "2026-07-09T12:00:00.000Z",
    groups: [
      {
        key: "run:s1",
        label: "Nightly triage",
        kind: "run",
        rows: [[span("a"), span("b", { startedAt: "2026-07-09T08:00:00.000Z", endedAt: null })]],
      },
      {
        key: "session:proj",
        label: "home/user/proj",
        kind: "session",
        rows: [[span("c", { kind: "session", href: null })]],
      },
    ],
    totals: { spans: 3, active: 1, failed: 0, costUsd: 1.25, tokens: 42_000 },
  };
}

describe("Chronicle", () => {
  beforeEach(() => {
    mockHours.length = 0;
    facet.peer = null;
    mockState.loading = false;
    mockState.error = null;
    mockState.chronicle = {
      windowStart: "",
      windowEnd: "",
      groups: [],
      totals: { spans: 0, active: 0, failed: 0, costUsd: null, tokens: null },
    };
  });

  it("shows the empty state when the window has no spans", () => {
    render(<Chronicle />);
    expect(screen.getByText(/Nothing happened in this window/)).toBeInTheDocument();
  });

  it("renders group lanes, linked bars, and totals", () => {
    withData();
    render(<Chronicle />);
    expect(screen.getByText("Nightly triage")).toBeInTheDocument();
    // A path lane is shortened to its identifying tail, with the full path kept
    // as a tooltip rather than wrapped across two lines.
    expect(screen.getByText("…/user/proj")).toBeInTheDocument();
    expect(screen.getByTitle("home/user/proj")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Span a, Succeeded" })).toHaveAttribute(
      "href",
      "#/schedules",
    );
    // Spanless href renders a plain div, not a link.
    expect(screen.queryByRole("link", { name: "Span c, Succeeded" })).not.toBeInTheDocument();
    expect(screen.getByText("$1.25")).toBeInTheDocument();
  });

  it("names a bar's status in the key's words, in its name and its tooltip", () => {
    withData();
    mockState.chronicle.groups[0].rows[0][1] = span("b", {
      status: "working",
      startedAt: "2026-07-09T08:00:00.000Z",
      endedAt: null,
    });
    render(<Chronicle />);
    const live = screen.getByRole("link", { name: "Span b, Still running" });
    expect(live.getAttribute("title")).toContain("\nStill running");
    expect(live.getAttribute("title")).not.toMatch(/\bworking\b/);
    expect(screen.getByRole("link", { name: "Span a, Succeeded" }).getAttribute("title")).toContain(
      "\nSucceeded",
    );
  });

  it("calls a run that was cut short Stopped, in the key, its name and its tooltip", () => {
    // An interrupted run's tooltip said "Idle" over "interrupted: Argus restarted…".
    withData();
    mockState.chronicle.groups[0].rows[0][0] = span("a", {
      status: "stopped",
      detail: "interrupted: Argus restarted while this run was in progress",
    });
    render(<Chronicle />);
    const bar = screen.getByRole("link", { name: "Span a, Stopped" });
    expect(bar.getAttribute("title")).toContain("\nStopped\ninterrupted: Argus restarted");
    expect(bar.getAttribute("title")).not.toContain("Idle");
    expect(within(screen.getByLabelText("Run status")).getByText("Stopped")).toBeInTheDocument();
  });

  it("drops the time window in peer mode, where it would change nothing", () => {
    facet.peer = {
      isSelf: false,
      peer: {
        id: "p1",
        label: "Build box",
        url: "http://box.local:7777",
        status: "paired",
        lastSeenAt: "2026-07-20T12:00:00.000Z",
        error: null,
        addedAt: "2026-07-20T10:00:00.000Z",
      },
      summary: {
        machineId: "m2",
        label: "Build box",
        version: "0.4.0",
        generatedAt: "2026-07-20T12:00:00.000Z",
        schedules: 1,
        monitorsDown: 0,
        monitorsFailing: 0,
        openIssues: 0,
        liveInstances: 0,
        gatedInstances: 0,
        runsToday: 1,
        failuresToday: 0,
        spendTodayUsd: 0,
        spendMonthUsd: 0,
        worstIncident: null,
        facets: {
          pipelines: [],
          issues: [],
          recentRuns: [
            {
              id: "r1",
              label: "Nightly triage",
              status: "succeeded",
              at: "2026-07-20T11:00:00.000Z",
              durationMs: 60_000,
            },
          ],
          budget: { state: "ok", dailyLimitUsd: null, monthlyLimitUsd: null },
        },
      },
    };
    render(<Chronicle />);
    // One run, said as one: "The newest 1 runs" read as a typo.
    expect(
      screen.getByText("The newest run that machine reported — not its whole history."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Time window" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "6h" })).not.toBeInTheDocument();
  });

  it("defaults to 24h and refetches when another window is picked", () => {
    withData();
    render(<Chronicle />);
    expect(mockHours[0]).toBe(24);
    const windows = screen.getByRole("radiogroup", { name: "Time window" });
    fireEvent.click(within(windows).getByRole("radio", { name: "6h" }));
    expect(mockHours.at(-1)).toBe(6);
  });

  it("names a pipeline lane after the pipeline, not its latest phase", () => {
    mockState.chronicle = {
      windowStart: "2026-07-09T00:00:00.000Z",
      windowEnd: "2026-07-09T12:00:00.000Z",
      groups: [
        {
          key: "run:pipeline:i1",
          label: "Release Train · Draft release notes",
          kind: "run",
          rows: [[span("p1", { label: "Release Train · Plan" })]],
        },
      ],
      totals: { spans: 1, active: 0, failed: 0, costUsd: null, tokens: null },
    };
    render(<Chronicle />);
    expect(screen.getByText("Release Train")).toBeInTheDocument();
    expect(screen.queryByText("Release Train · Draft release notes")).not.toBeInTheDocument();
    expect(screen.getByText("Runs")).toBeInTheDocument();
  });

  it("never draws two bars over each other, even when they are seconds apart", () => {
    // Both are under the minimum bar width, so they would share pixels; the
    // server, packing by time, put them on one row.
    mockState.chronicle = {
      windowStart: "2026-07-09T00:00:00.000Z",
      windowEnd: "2026-07-16T00:00:00.000Z",
      groups: [
        {
          key: "run:pipeline:i2",
          label: "Audit · Triage",
          kind: "run",
          rows: [
            [
              span("scan", {
                label: "Audit · Scan",
                startedAt: "2026-07-15T10:00:00.000Z",
                endedAt: "2026-07-15T10:00:02.000Z",
              }),
              span("triage", {
                label: "Audit · Triage",
                status: "failed",
                startedAt: "2026-07-15T10:00:03.000Z",
                endedAt: "2026-07-15T10:00:05.000Z",
                detail: "timed out\nARGUS_OUTCOME: failed timed out",
              }),
            ],
          ],
        },
      ],
      totals: { spans: 2, active: 0, failed: 1, costUsd: null, tokens: null },
    };
    render(<Chronicle />);
    const scan = screen.getByRole("link", { name: "Audit · Scan, Succeeded" });
    const triage = screen.getByRole("link", { name: "Audit · Triage, Failed" });
    expect(scan.parentElement).not.toBe(triage.parentElement);
    // The tooltip states the status once, not again as the agent's protocol line.
    expect(triage.getAttribute("title")).toContain("timed out");
    expect(triage.getAttribute("title")).not.toContain("ARGUS_OUTCOME");
  });

  it("keeps the reason when the agent's protocol line is all a span's detail has", () => {
    mockState.chronicle = {
      windowStart: "2026-07-09T00:00:00.000Z",
      windowEnd: "2026-07-09T12:00:00.000Z",
      groups: [
        {
          key: "run:s1",
          label: "Nightly triage",
          kind: "run",
          rows: [[span("x", { status: "failed", detail: "ARGUS_OUTCOME: failed rate limited" })]],
        },
      ],
      totals: { spans: 1, active: 0, failed: 1, costUsd: null, tokens: null },
    };
    render(<Chronicle />);
    const bar = screen.getByRole("link", { name: "Span x, Failed" });
    expect(bar.getAttribute("title")).toContain("rate limited");
    expect(bar.getAttribute("title")).not.toContain("ARGUS_OUTCOME");
  });

  it("surfaces a fetch error", () => {
    mockState.error = "HTTP 500";
    render(<Chronicle />);
    expect(screen.getByText(/HTTP 500/)).toBeInTheDocument();
  });
});
