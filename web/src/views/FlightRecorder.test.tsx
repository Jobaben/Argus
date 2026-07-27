import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RecorderEvent, Recording } from "../types";
import FlightRecorder from "./FlightRecorder";

const state: { recording: Recording | null; loading: boolean; error: string | null } = {
  recording: null,
  loading: false,
  error: null,
};

vi.mock("../useRecording", () => ({
  useRecording: () => ({ ...state, refresh: vi.fn() }),
}));

const ev = (atMs: number, over: Partial<RecorderEvent> = {}): RecorderEvent => ({
  id: `e-${atMs}-${over.kind ?? "text"}`,
  atMs,
  at: new Date(Date.parse("2026-07-01T10:00:00.000Z") + atMs).toISOString(),
  lane: "agent",
  kind: "text",
  label: `event at ${atMs}`,
  ...over,
});

function recording(over: Partial<Recording> = {}): Recording {
  const events = over.events ?? [
    ev(0, { kind: "start", label: "Run started — Nightly triage" }),
    ev(30_000, { lane: "tool", kind: "tool", label: "Bash: npm test", tool: "Bash" }),
    ev(60_000, {
      lane: "tool",
      kind: "tool",
      label: "Bash: npm run build",
      tool: "Bash",
      errored: true,
      detail: "build failed",
    }),
    ev(90_000, { kind: "error", label: "Failed — exit code 1" }),
  ];
  return {
    runId: "run-1",
    scheduleId: "s1",
    scheduleName: "Nightly triage",
    status: "failed",
    outcome: null,
    sessionId: "sess-1",
    project: "-repo",
    startedAt: "2026-07-01T10:00:00.000Z",
    endedAt: "2026-07-01T10:01:30.000Z",
    durationMs: 90_000,
    events,
    lanes: [
      { lane: "agent", label: "Agent", count: 2 },
      { lane: "tool", label: "Tools", count: 2 },
    ],
    failureIndex: 2,
    totals: { tools: 2, files: 0, errors: 1, tokens: 1200, costUsd: 0.42 },
    costEstimated: true,
    truncated: false,
    unavailable: null,
    ...over,
  };
}

beforeEach(() => {
  window.location.hash = "#/run/run-1";
  state.recording = recording();
  state.loading = false;
  state.error = null;
});

describe("FlightRecorder", () => {
  it("renders the run's totals and a scrubber over the full duration", () => {
    render(<FlightRecorder />);
    expect(screen.getByRole("heading", { name: "Nightly triage" })).toBeInTheDocument();
    const scrubber = screen.getByRole("slider", { name: /scrub the recording/i });
    expect(scrubber).toHaveAttribute("max", "90000");
    expect(screen.getByText("Tool calls").nextSibling).toHaveTextContent("2");
    expect(screen.getByText("Cost").nextSibling).toHaveTextContent("$0.42");
  });

  it("jump-to-failure moves the playhead to the errored tool call, not the end", async () => {
    const user = userEvent.setup();
    render(<FlightRecorder />);
    await user.click(screen.getByRole("button", { name: /jump to failure/i }));

    const scrubber = screen.getByRole("slider", { name: /scrub the recording/i });
    expect(scrubber).toHaveValue("60000");
    // The detail pane shows the failing call, with its error body.
    const now = screen.getByRole("complementary", { name: /current event/i });
    expect(within(now).getByText("Bash: npm run build")).toBeInTheDocument();
    expect(within(now).getByText("build failed")).toBeInTheDocument();
  });

  it("hides jump-to-failure on a run that did not fail", () => {
    state.recording = recording({ status: "succeeded", failureIndex: null });
    render(<FlightRecorder />);
    expect(screen.queryByRole("button", { name: /jump to failure/i })).not.toBeInTheDocument();
  });

  it("a deep link restores the exact scrubber position", () => {
    window.location.hash = "#/run/run-1/45000";
    render(<FlightRecorder />);
    expect(screen.getByRole("slider", { name: /scrub the recording/i })).toHaveValue("45000");
  });

  it("regression: a deep link past the end is clamped rather than overflowing the track", () => {
    window.location.hash = "#/run/run-1/999999999";
    render(<FlightRecorder />);
    expect(screen.getByRole("slider", { name: /scrub the recording/i })).toHaveValue("90000");
  });

  it("clicking an event in the list seeks to it", async () => {
    const user = userEvent.setup();
    render(<FlightRecorder />);
    await user.click(screen.getByRole("button", { name: /Bash: npm test/ }));
    expect(screen.getByRole("slider", { name: /scrub the recording/i })).toHaveValue("30000");
  });

  it("the scrubber announces the moment and the event under the playhead", async () => {
    const user = userEvent.setup();
    render(<FlightRecorder />);
    await user.click(screen.getByRole("button", { name: /jump to failure/i }));
    expect(screen.getByRole("slider", { name: /scrub the recording/i })).toHaveAttribute(
      "aria-valuetext",
      expect.stringContaining("01:00 of 01:30"),
    );
  });

  it("says why there is nothing to replay instead of showing an empty track", () => {
    state.recording = recording({
      events: [],
      lanes: [],
      failureIndex: null,
      unavailable: "no-transcript",
    });
    render(<FlightRecorder />);
    expect(screen.getByText(/couldn't find this run's transcript/i)).toBeInTheDocument();
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
  });

  it("labels apportioned cost as apportioned", () => {
    render(<FlightRecorder />);
    expect(screen.getByText(/apportioned by token share/i)).toBeInTheDocument();
  });

  it("explains a truncated recording rather than silently starting partway in", () => {
    state.recording = recording({ truncated: true });
    render(<FlightRecorder />);
    expect(screen.getByText(/the earliest events were dropped/i)).toBeInTheDocument();
  });

  it("regression: space on the focused Play button toggles playback once, not twice", async () => {
    const user = userEvent.setup();
    render(<FlightRecorder />);
    const play = screen.getByRole("button", { name: /play the replay/i });
    play.focus();
    await user.keyboard(" ");
    // The browser's synthesized click and the window key handler both used to
    // fire, cancelling out and leaving the button apparently dead.
    expect(screen.getByRole("button", { name: /pause the replay/i })).toBeInTheDocument();
  });

  it("space anywhere else on the page still starts the replay", async () => {
    const user = userEvent.setup();
    render(<FlightRecorder />);
    await user.keyboard(" ");
    expect(screen.getByRole("button", { name: /pause the replay/i })).toBeInTheDocument();
  });

  it("f jumps to the failure from the keyboard", async () => {
    const user = userEvent.setup();
    render(<FlightRecorder />);
    await user.keyboard("f");
    expect(screen.getByRole("slider", { name: /scrub the recording/i })).toHaveValue("60000");
  });

  it("without a run id it teaches where recordings come from", () => {
    window.location.hash = "#/run";
    render(<FlightRecorder />);
    expect(screen.getByText(/open a run from the chronicle/i)).toBeInTheDocument();
  });
});
