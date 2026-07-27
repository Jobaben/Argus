import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Autopsy } from "../types";
import { AutopsyPanel } from "./AutopsyPanel";

const analyse = vi.fn(async () => {});
const relaunch = vi.fn(async () => "new-run-id");

const state: {
  autopsy: Autopsy | null;
  eligible: boolean;
  unavailable: string | null;
  loading: boolean;
  busy: boolean;
  actionError: string | null;
} = {
  autopsy: null,
  eligible: true,
  unavailable: null,
  loading: false,
  busy: false,
  actionError: null,
};

vi.mock("../useAutopsy", () => ({
  useAutopsy: () => ({ ...state, error: null, analyse, relaunch, refresh: vi.fn() }),
}));

function autopsy(over: Partial<Autopsy> = {}): Autopsy {
  return {
    runId: "run-1",
    scheduleId: "s1",
    scheduleName: "Nightly triage",
    status: "ready",
    at: "2026-07-20T12:00:00.000Z",
    failureClass: "missing-context",
    confidence: 0.75,
    why: "The prompt assumed a lockfile the working tree did not contain.",
    span: { fromMs: 61000, toMs: 75000, quote: "61.0s tool [ERROR]: Bash: npm ci" },
    promptDelta: "Triage the overnight failures. Run npm install if no lockfile is present.",
    deltaRationale: "Handles the missing-lockfile case explicitly.",
    costUsd: 0.003,
    tokens: 2200,
    durationMs: 4200,
    error: null,
    ...over,
  };
}

beforeEach(() => {
  state.autopsy = null;
  state.eligible = true;
  state.unavailable = null;
  state.loading = false;
  state.busy = false;
  state.actionError = null;
  analyse.mockClear();
  relaunch.mockClear();
});

describe("AutopsyPanel", () => {
  it("renders nothing at all for a run that did not fail", () => {
    state.eligible = false;
    const { container } = render(<AutopsyPanel runId="run-1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("offers to analyse a failure that has no postmortem yet", async () => {
    const user = userEvent.setup();
    render(<AutopsyPanel runId="run-1" />);
    await user.click(screen.getByRole("button", { name: /analyse this failure/i }));
    expect(analyse).toHaveBeenCalled();
  });

  it("explains rather than offering the button when postmortems are off", () => {
    state.unavailable = "postmortems are disabled (ARGUS_ANALYSIS=off)";
    render(<AutopsyPanel runId="run-1" />);
    expect(screen.getByText(/ARGUS_ANALYSIS=off/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /analyse this failure/i })).toBeDisabled();
  });

  it("shows the diagnosis, its confidence and what the pass cost", () => {
    state.autopsy = autopsy();
    render(<AutopsyPanel runId="run-1" />);
    expect(screen.getByText("Missing context")).toBeInTheDocument();
    expect(screen.getByText("75% confident")).toBeInTheDocument();
    expect(screen.getByText(/assumed a lockfile/)).toBeInTheDocument();
    expect(screen.getByText(/\$0\.0030/)).toBeInTheDocument();
  });

  it("quotes the span it cites and scrubs the recorder to it", async () => {
    const user = userEvent.setup();
    const onSeek = vi.fn();
    state.autopsy = autopsy();
    render(<AutopsyPanel runId="run-1" onSeek={onSeek} />);
    expect(screen.getByText(/61.0s tool \[ERROR\]/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /scrub to 61.0s/i }));
    expect(onSeek).toHaveBeenCalledWith(61000);
  });

  it("relaunch says plainly that the schedule is not being changed", async () => {
    const user = userEvent.setup();
    state.autopsy = autopsy();
    render(<AutopsyPanel runId="run-1" />);
    expect(screen.getByText(/your schedule is untouched/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /relaunch with fix/i }));
    await waitFor(() => expect(relaunch).toHaveBeenCalled());
    expect(await screen.findByRole("link", { name: /watch it here/i })).toHaveAttribute(
      "href",
      "#/run/new-run-id",
    );
  });

  it("hides relaunch when the postmortem proposed no prompt change", () => {
    state.autopsy = autopsy({ promptDelta: null, deltaRationale: null });
    render(<AutopsyPanel runId="run-1" />);
    expect(screen.queryByRole("button", { name: /relaunch with fix/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /re-analyse/i })).toBeInTheDocument();
  });

  it("a pass that itself failed says why, and offers a retry", () => {
    state.autopsy = autopsy({ status: "failed", error: "timed out after 90000ms", why: null });
    render(<AutopsyPanel runId="run-1" />);
    expect(screen.getByText(/timed out after 90000ms/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("regression: a 401 tells the reader to sign in rather than showing a bare error", () => {
    state.autopsy = autopsy();
    state.actionError = "auth required";
    render(<AutopsyPanel runId="run-1" />);
    expect(screen.getByRole("alert")).toHaveTextContent(/sign in to run agent actions/i);
  });

  it("low confidence is shown, not hidden", () => {
    state.autopsy = autopsy({ confidence: 0.2 });
    render(<AutopsyPanel runId="run-1" />);
    expect(screen.getByText("20% confident")).toBeInTheDocument();
  });
});

describe("AutopsyPanel — in-between states", () => {
  it("says it is looking while the first read is in flight", () => {
    state.loading = true;
    render(<AutopsyPanel runId="run-1" />);
    expect(screen.getByText(/looking for a postmortem/i)).toBeInTheDocument();
  });

  it("announces work to a screen reader while an action runs", () => {
    state.autopsy = autopsy();
    state.busy = true;
    render(<AutopsyPanel runId="run-1" />);
    expect(screen.getByText("Working…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /launching/i })).toBeDisabled();
  });

  it("without an onSeek handler the span is still quoted, minus the scrub control", () => {
    state.autopsy = autopsy();
    render(<AutopsyPanel runId="run-1" />);
    expect(screen.getByText(/61.0s tool \[ERROR\]/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /scrub to/i })).not.toBeInTheDocument();
  });

  it("switched-off postmortems still render the panel for an eligible run", () => {
    state.autopsy = autopsy({ status: "skipped", why: null, error: null });
    render(<AutopsyPanel runId="run-1" />);
    expect(screen.getByText(/switched off on this server/i)).toBeInTheDocument();
  });
});
