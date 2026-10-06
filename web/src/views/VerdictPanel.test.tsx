import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Rubric, Verdict, VerdictPoint } from "../types";
import { VerdictPanel, VerdictSparkline } from "./VerdictPanel";

const score = vi.fn(async () => {});

const state: {
  verdict: Verdict | null;
  trajectory: Verdict | null;
  rubric: Rubric | null;
  unavailable: string | null;
  loading: boolean;
  busy: boolean;
  actionError: string | null;
} = {
  verdict: null,
  trajectory: null,
  rubric: null,
  unavailable: null,
  loading: false,
  busy: false,
  actionError: null,
};

vi.mock("../useVerdict", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useVerdict: () => ({ ...state, error: null, score, refresh: vi.fn() }),
}));

const RUBRIC: Rubric = {
  goal: "Names every failure and proposes a next step.",
  criteria: [
    { id: "coverage", label: "Names every new failure", weight: 2 },
    { id: "actionable", label: "Proposes a concrete next step" },
  ],
  minScore: 6,
};

function verdict(over: Partial<Verdict> = {}): Verdict {
  return {
    runId: "run-1",
    scheduleId: "s1",
    scheduleName: "Nightly triage",
    phaseId: null,
    status: "ready",
    at: "2026-07-20T12:00:00.000Z",
    score: 7.3,
    criteria: [
      { id: "coverage", label: "Names every new failure", score: 8, note: "Both named." },
      { id: "actionable", label: "Proposes a concrete next step", score: 6, note: "One missing." },
    ],
    summary: "Solid but incomplete.",
    regression: false,
    minScore: 6,
    costUsd: 0.001,
    tokens: 900,
    durationMs: 3100,
    error: null,
    ...over,
  };
}

beforeEach(() => {
  state.verdict = null;
  state.trajectory = null;
  state.rubric = null;
  state.unavailable = null;
  state.loading = false;
  state.busy = false;
  state.actionError = null;
  score.mockClear();
});

describe("VerdictPanel", () => {
  it("renders nothing when this unit of work declared no rubric", () => {
    const { container } = render(<VerdictPanel runId="run-1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the per-criterion breakdown, not just the headline number", () => {
    state.rubric = RUBRIC;
    state.verdict = verdict();
    render(<VerdictPanel runId="run-1" />);
    expect(screen.getByText("Names every new failure")).toBeInTheDocument();
    expect(screen.getByText("Proposes a concrete next step")).toBeInTheDocument();
    expect(screen.getByText("8.0")).toBeInTheDocument();
    expect(screen.getByText("6.0")).toBeInTheDocument();
  });

  it("shows the overall next to the bar it is judged against", () => {
    state.rubric = RUBRIC;
    state.verdict = verdict();
    render(<VerdictPanel runId="run-1" />);
    expect(screen.getByText("7.3")).toBeInTheDocument();
    expect(screen.getByText(/bar 6\.0/)).toBeInTheDocument();
  });

  it("marks a run under the bar as a regression", () => {
    state.rubric = RUBRIC;
    state.verdict = verdict({ score: 3.1, regression: true });
    render(<VerdictPanel runId="run-1" />);
    expect(screen.getByText(/below the bar/i)).toBeInTheDocument();
  });

  it("a rubric with no score yet explains itself and offers to score", async () => {
    const user = userEvent.setup();
    state.rubric = RUBRIC;
    render(<VerdictPanel runId="run-1" />);
    expect(screen.getByText(/not scored yet/i)).toBeInTheDocument();
    expect(screen.getByText(/Names every failure and proposes/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /score this output/i }));
    expect(score).toHaveBeenCalled();
  });

  it("a failed scoring pass says why and offers a re-score", () => {
    state.rubric = RUBRIC;
    state.verdict = verdict({ status: "failed", score: null, error: "timed out" });
    render(<VerdictPanel runId="run-1" />);
    expect(screen.getByText(/timed out/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /re-score/i })).toBeInTheDocument();
  });

  it("regression: a 401 tells the reader to sign in", () => {
    state.rubric = RUBRIC;
    state.verdict = verdict();
    state.actionError = "auth required";
    render(<VerdictPanel runId="run-1" />);
    expect(screen.getByRole("alert")).toHaveTextContent(/sign in to run agent actions/i);
  });

  it("the score bar is readable to a screen reader as a number out of ten", () => {
    state.rubric = RUBRIC;
    state.verdict = verdict();
    render(<VerdictPanel runId="run-1" />);
    expect(screen.getByRole("img", { name: "8.0 out of 10" })).toBeInTheDocument();
  });
});

describe("VerdictPanel trajectory", () => {
  const TRAJ: Rubric = { ...RUBRIC, trajectory: { criteria: [{ id: "focus", label: "Focus" }] } };
  const signals = (observed: string[]) => ({
    version: 1,
    transcript: "present" as const,
    events: 4,
    truncated: false,
    signals: (["repetition", "errors", "destructive-command"] as const).map((kind) => ({
      kind,
      count: observed.includes(kind) ? 2 : 0,
      observed: observed.includes(kind),
      examples: [],
    })),
  });

  it("says nothing about trajectories when the rubric declares none", () => {
    state.rubric = RUBRIC;
    state.verdict = verdict();
    render(<VerdictPanel runId="run-1" />);
    expect(screen.queryByTestId("trajectory-note")).toBeNull();
  });

  it("shows the trajectory score and observed heuristics apart from the output score", () => {
    state.rubric = TRAJ;
    state.verdict = verdict();
    state.trajectory = verdict({
      kind: "trajectory",
      score: 4,
      trajectory: { signals: signals(["errors"]), held: [], judged: true },
    });
    render(<VerdictPanel runId="run-1" />);
    const note = screen.getByTestId("trajectory-note");
    expect(note.textContent).toMatch(/4\.0\/10/);
    expect(note.textContent).toMatch(/heuristics observed: errors/);
  });

  it("a truncated recording with nothing observed is never presented as clean", () => {
    state.rubric = TRAJ;
    state.verdict = verdict();
    state.trajectory = verdict({
      kind: "trajectory",
      score: null,
      trajectory: { signals: { ...signals([]), truncated: true }, held: [], judged: false },
    });
    render(<VerdictPanel runId="run-1" />);
    const note = screen.getByTestId("trajectory-note").textContent ?? "";
    expect(note).toMatch(/truncated/);
    expect(note).not.toMatch(/no heuristic signal observed in the recorded events/);
  });

  it("a skipped trajectory says an automated approval waits for a person", () => {
    state.rubric = TRAJ;
    state.verdict = verdict();
    state.trajectory = verdict({ kind: "trajectory", status: "skipped", error: "no transcript" });
    render(<VerdictPanel runId="run-1" />);
    expect(screen.getByTestId("trajectory-note").textContent).toMatch(/waits for a person/);
  });

  it("a declared trajectory with no judgment yet says so", () => {
    state.rubric = TRAJ;
    render(<VerdictPanel runId="run-1" />);
    expect(screen.getByTestId("trajectory-note").textContent).toMatch(/Not analysed yet/);
  });
});

describe("VerdictSparkline", () => {
  const point = (score: number, regression = false): VerdictPoint => ({
    runId: `r${score}`,
    at: "2026-07-20T12:00:00.000Z",
    score,
    regression,
  });

  it("reads out the whole history for a screen reader, oldest first", () => {
    render(<VerdictSparkline points={[point(8), point(4, true)]} minScore={6} />);
    expect(
      screen.getByRole("img", { name: /Last 2 scores, oldest first: 8.0, 4.0/ }),
    ).toBeInTheDocument();
    expect(screen.getByText(/bar 6\.0/)).toBeInTheDocument();
  });

  it("renders nothing rather than an empty frame with no points", () => {
    const { container } = render(<VerdictSparkline points={[]} minScore={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("VerdictPanel — in-between states", () => {
  it("says it is looking while the first read is in flight", () => {
    state.rubric = RUBRIC;
    state.loading = true;
    render(<VerdictPanel runId="run-1" />);
    expect(screen.getByText(/looking for a score/i)).toBeInTheDocument();
  });

  it("disables scoring, with the reason, when it is switched off server-side", () => {
    state.rubric = RUBRIC;
    state.unavailable = "scoring is disabled (ARGUS_ANALYSIS=off)";
    render(<VerdictPanel runId="run-1" />);
    expect(screen.getByText(/ARGUS_ANALYSIS=off/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /score this output/i })).toBeDisabled();
  });

  it("a skipped verdict explains itself rather than looking like a failure", () => {
    state.rubric = RUBRIC;
    state.verdict = verdict({ status: "skipped", score: null, error: null });
    render(<VerdictPanel runId="run-1" />);
    expect(screen.getByText(/switched off on this server/i)).toBeInTheDocument();
  });

  it("shows progress on the button while a score is running", () => {
    state.rubric = RUBRIC;
    state.busy = true;
    render(<VerdictPanel runId="run-1" />);
    expect(screen.getByRole("button", { name: /scoring…/i })).toBeDisabled();
  });

  it("a criterion with no note renders without an empty line", () => {
    state.rubric = RUBRIC;
    state.verdict = verdict({
      criteria: [{ id: "coverage", label: "Names every new failure", score: 9, note: "" }],
      summary: null,
    });
    render(<VerdictPanel runId="run-1" />);
    expect(screen.getByText("9.0")).toBeInTheDocument();
  });
});
