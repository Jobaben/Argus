import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Incident, SentinelState } from "../types";
import Sentinel from "./Sentinel";

const act = vi.fn(async () => {});
const savePolicy = vi.fn(async () => {});

const state: {
  state: SentinelState;
  loading: boolean;
  error: string | null;
  actionError: string | null;
} = {
  state: emptyState(),
  loading: false,
  error: null,
  actionError: null,
};

vi.mock("../useSentinel", () => ({
  useSentinel: () => ({ ...state, busyId: null, act, savePolicy, refresh: vi.fn() }),
}));

function emptyState(): SentinelState {
  return {
    generatedAt: "2026-07-20T12:00:00.000Z",
    policy: {
      enabled: true,
      levels: [
        { afterMinutes: 0, label: "Notify" },
        { afterMinutes: 30, label: "Escalate" },
      ],
      quietHours: null,
      quietHoursOverrideCritical: true,
      autoDiagnose: false,
    },
    incidents: [],
    summary: { open: 0, acknowledged: 0, resolved: 0, critical: 0 },
    inQuietHours: false,
  };
}

function incident(over: Partial<Incident> = {}): Incident {
  return {
    id: "i1",
    key: "monitor:s1",
    source: "monitor-down",
    severity: "critical",
    title: "Nightly triage",
    detail: "no run covered the slot expected at 02:00",
    status: "open",
    openedAt: "2026-07-20T11:00:00.000Z",
    updatedAt: "2026-07-20T11:00:00.000Z",
    acknowledgedAt: null,
    acknowledgedBy: null,
    resolvedAt: null,
    level: 0,
    nextEscalationAt: "2026-07-20T13:00:00.000Z",
    timeline: [
      {
        at: "2026-07-20T11:00:00.000Z",
        kind: "opened",
        detail: "no run covered the slot",
        by: "sentinel",
      },
    ],
    diagnosis: null,
    scheduleId: "s1",
    runId: null,
    fingerprint: null,
    ...over,
  };
}

beforeEach(() => {
  state.state = emptyState();
  state.loading = false;
  state.error = null;
  state.actionError = null;
  act.mockClear();
  savePolicy.mockClear();
});

describe("Sentinel", () => {
  it("teaches what opens an incident when nothing is on fire", () => {
    render(<Sentinel />);
    expect(screen.getByText(/Nothing is on fire/)).toBeInTheDocument();
    expect(screen.getByText(/escalates it on a clock/)).toBeInTheDocument();
  });

  it("shows a live incident with its status, severity and timeline", () => {
    state.state = { ...emptyState(), incidents: [incident()] };
    render(<Sentinel />);
    expect(screen.getByText("Nightly triage")).toBeInTheDocument();
    expect(screen.getByText("open")).toBeInTheDocument();
    expect(screen.getByText("critical")).toBeInTheDocument();
    expect(screen.getByText("no run covered the slot")).toBeInTheDocument();
  });

  it("acknowledging and resolving call through", async () => {
    const user = userEvent.setup();
    state.state = { ...emptyState(), incidents: [incident()] };
    render(<Sentinel />);
    await user.click(screen.getByRole("button", { name: "Acknowledge" }));
    expect(act).toHaveBeenCalledWith("i1", "ack", undefined);
    await user.click(screen.getByRole("button", { name: "Resolve" }));
    expect(act).toHaveBeenCalledWith(
      "i1",
      "resolve",
      expect.objectContaining({ note: expect.any(String) }),
    );
  });

  it("an acknowledged incident no longer offers acknowledgement", () => {
    state.state = {
      ...emptyState(),
      incidents: [
        incident({ status: "acknowledged", acknowledgedBy: "ada", nextEscalationAt: null }),
      ],
    };
    render(<Sentinel />);
    expect(screen.queryByRole("button", { name: "Acknowledge" })).not.toBeInTheDocument();
    expect(screen.getByText(/acknowledged by ada/)).toBeInTheDocument();
  });

  it("regression: the diagnostic's remediation is labelled as proposed, not done", () => {
    state.state = {
      ...emptyState(),
      incidents: [
        incident({
          diagnosis: {
            at: "2026-07-20T11:05:00.000Z",
            status: "ready",
            findings: "The CLI is not on PATH.",
            remediation: "Fix PATH and re-run the schedule.",
            confidence: 0.7,
            costUsd: 0.001,
            tokens: 800,
            error: null,
          },
        }),
      ],
    };
    render(<Sentinel />);
    expect(screen.getByText(/Diagnostic — read-only/)).toBeInTheDocument();
    expect(screen.getByText("The CLI is not on PATH.")).toBeInTheDocument();
    expect(screen.getByText(/Proposed, not done/)).toBeInTheDocument();
    expect(screen.getByText(/70% confident/)).toBeInTheDocument();
  });

  it("a diagnostic that didn't complete says why", () => {
    state.state = {
      ...emptyState(),
      incidents: [
        incident({
          diagnosis: {
            at: "2026-07-20T11:05:00.000Z",
            status: "failed",
            findings: null,
            remediation: null,
            confidence: null,
            costUsd: null,
            tokens: null,
            error: "timed out after 90000ms",
          },
        }),
      ],
    };
    render(<Sentinel />);
    expect(screen.getByText(/timed out after 90000ms/)).toBeInTheDocument();
  });

  it("adding a note posts it and clears the field", async () => {
    const user = userEvent.setup();
    state.state = { ...emptyState(), incidents: [incident()] };
    render(<Sentinel />);
    const field = screen.getByLabelText(/add a note to nightly triage/i);
    await user.type(field, "PATH fixed on the host");
    await user.click(screen.getByRole("button", { name: "Note" }));
    expect(act).toHaveBeenCalledWith("i1", "note", { note: "PATH fixed on the host" });
    expect(field).toHaveValue("");
  });

  it("an empty note cannot be submitted", async () => {
    state.state = { ...emptyState(), incidents: [incident()] };
    render(<Sentinel />);
    expect(screen.getByRole("button", { name: "Note" })).toBeDisabled();
  });

  it("resolved incidents are listed separately and offer no actions", () => {
    state.state = {
      ...emptyState(),
      incidents: [incident({ status: "resolved", resolvedAt: "2026-07-20T11:30:00.000Z" })],
      summary: { open: 0, acknowledged: 0, resolved: 1, critical: 0 },
    };
    render(<Sentinel />);
    expect(screen.getByText("Resolved (1)")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Acknowledge" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resolve" })).not.toBeInTheDocument();
  });

  it("the policy panel says what quiet hours do to the record", async () => {
    const user = userEvent.setup();
    state.state = {
      ...emptyState(),
      policy: { ...emptyState().policy, quietHours: { start: "22:00", end: "07:00" } },
      inQuietHours: true,
    };
    render(<Sentinel />);
    expect(screen.getByText(/records still land, the bell stays silent/i)).toBeInTheDocument();
    expect(screen.getByText(/Notify/)).toBeInTheDocument();
    expect(screen.getByText(/after 30m/)).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: /criticals still ring/i }));
    expect(savePolicy).toHaveBeenCalledWith({ quietHoursOverrideCritical: false });
  });

  it("auto-diagnose says plainly that it never executes anything", () => {
    render(<Sentinel />);
    expect(screen.getByText(/never executes one/i)).toBeInTheDocument();
  });

  it("regression: a 401 tells the reader to sign in rather than showing a bare error", () => {
    state.actionError = "auth required";
    render(<Sentinel />);
    expect(screen.getByRole("alert")).toHaveTextContent(/sign in to act on incidents/i);
  });

  it("an escalated incident shows the level it reached", () => {
    state.state = { ...emptyState(), incidents: [incident({ level: 2 })] };
    render(<Sentinel />);
    expect(screen.getByText("level 2")).toBeInTheDocument();
  });

  it("an incident carrying a run links straight to its recording", () => {
    state.state = { ...emptyState(), incidents: [incident({ runId: "r9", scheduleId: null })] };
    render(<Sentinel />);
    expect(screen.getByRole("link", { name: /replay the run/i })).toHaveAttribute(
      "href",
      "#/run/r9",
    );
  });

  it("a note left by a person is attributed in the timeline", () => {
    state.state = {
      ...emptyState(),
      incidents: [
        incident({
          timeline: [
            {
              at: "2026-07-20T11:10:00.000Z",
              kind: "note",
              detail: "PATH fixed",
              by: "user:ada",
            },
          ],
        }),
      ],
    };
    render(<Sentinel />);
    const list = screen.getByRole("list");
    expect(within(list).getByText("ada")).toBeInTheDocument();
  });
});

describe("Sentinel — policy edges and states", () => {
  it("toggling Sentinel off, and auto-diagnose on, both save", async () => {
    const user = userEvent.setup();
    render(<Sentinel />);
    await user.click(screen.getByRole("checkbox", { name: /sentinel is on/i }));
    expect(savePolicy).toHaveBeenCalledWith({ enabled: false });
    await user.click(screen.getByRole("checkbox", { name: /diagnose new incidents/i }));
    expect(savePolicy).toHaveBeenCalledWith({ autoDiagnose: true });
  });

  it("enabling quiet hours sends the times currently in the fields", async () => {
    const user = userEvent.setup();
    render(<Sentinel />);
    await user.click(screen.getByRole("checkbox", { name: /^quiet hours$/i }));
    expect(savePolicy).toHaveBeenCalledWith({
      quietHours: { start: "22:00", end: "07:00" },
    });
  });

  it("disabling quiet hours clears them rather than sending empty times", async () => {
    const user = userEvent.setup();
    state.state = {
      ...emptyState(),
      policy: { ...emptyState().policy, quietHours: { start: "22:00", end: "07:00" } },
    };
    render(<Sentinel />);
    await user.click(screen.getByRole("checkbox", { name: /^quiet hours$/i }));
    expect(savePolicy).toHaveBeenCalledWith({ quietHours: null });
  });

  it("shows a skeleton on the very first load, not an empty state", () => {
    state.loading = true;
    render(<Sentinel />);
    expect(screen.queryByText(/Nothing is on fire/)).not.toBeInTheDocument();
  });

  it("a load error is reported without hiding the policy panel", () => {
    state.error = "HTTP 500";
    render(<Sentinel />);
    expect(screen.getByText(/Couldn't load Sentinel: HTTP 500/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /sentinel is on/i })).toBeInTheDocument();
  });

  it("a diagnostic switched off server-side explains itself", () => {
    state.state = {
      ...emptyState(),
      incidents: [
        incident({
          diagnosis: {
            at: "2026-07-20T11:05:00.000Z",
            status: "skipped",
            findings: null,
            remediation: null,
            confidence: null,
            costUsd: null,
            tokens: null,
            error: null,
          },
        }),
      ],
    };
    render(<Sentinel />);
    expect(screen.getByText(/switched off on this server/i)).toBeInTheDocument();
  });

  it("an incident carrying a fingerprint links to Issues", () => {
    state.state = {
      ...emptyState(),
      incidents: [
        incident({ source: "issue-regression", fingerprint: "abc123", scheduleId: null }),
      ],
    };
    render(<Sentinel />);
    expect(screen.getByRole("link", { name: "issue" })).toHaveAttribute("href", "#/issues");
  });

  it("dispatching a diagnostic calls through, and says re-diagnose once one exists", async () => {
    const user = userEvent.setup();
    state.state = { ...emptyState(), incidents: [incident()] };
    const { rerender } = render(<Sentinel />);
    await user.click(screen.getByRole("button", { name: "Diagnose" }));
    expect(act).toHaveBeenCalledWith("i1", "diagnose", undefined);

    state.state = {
      ...emptyState(),
      incidents: [
        incident({
          diagnosis: {
            at: "2026-07-20T11:05:00.000Z",
            status: "ready",
            findings: "f",
            remediation: null,
            confidence: null,
            costUsd: null,
            tokens: null,
            error: null,
          },
        }),
      ],
    };
    rerender(<Sentinel />);
    expect(screen.getByRole("button", { name: "Re-diagnose" })).toBeInTheDocument();
  });
});
