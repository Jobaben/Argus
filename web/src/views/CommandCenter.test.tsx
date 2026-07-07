import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { OverviewEntry, InstanceStatus, PhaseStatus } from "../types";
import CommandCenter from "./CommandCenter";

const approve = vi.fn(() => new Promise<Response>(() => {})); // never resolves: lets us assert disabled-after-click
const revise = vi.fn(() => new Promise<Response>(() => {}));

// Mutable mock state. The name is "mock"-prefixed so vitest's hoisted factory may close over it.
const mockOverview: { overview: OverviewEntry[]; loading: boolean; error: string | null } = {
  overview: [],
  loading: false,
  error: null,
};

vi.mock("../useOverview", () => ({
  useOverview: () => ({ ...mockOverview, refresh: vi.fn(), approve, revise }),
}));

function entry(name: string, status: InstanceStatus, phaseStatuses: PhaseStatus[]): OverviewEntry {
  return {
    definition: {
      id: name,
      name,
      phases: phaseStatuses.map((_, i) => ({
        id: `ph${i}`,
        name: `Phase${i}`,
        cwd: "/",
        gated: false,
        steps: [{ name: "s", prompt: "x" }],
      })),
      trigger: null,
      enabled: true,
      overlapPolicy: "skip",
      lastStartedAt: null,
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    },
    latest: {
      id: `${name}-i1`,
      pipelineId: name,
      pipelineName: name,
      status,
      currentPhaseIndex: 0,
      phases: phaseStatuses.map((s, i) => ({
        id: `ph${i}`,
        name: `Phase${i}`,
        gated: false,
        status: s,
        steps: s === "running" ? [{ name: "step-x", runId: "r", status: "running" as const }] : [],
        attempt: 1,
        payload: null,
      })),
      trigger: "manual",
      signalToken: "tok",
      createdAt: "2026-06-30T09:00:00.000Z",
      updatedAt: "2026-06-30T10:00:00.000Z",
      endedAt: null,
    },
  };
}

beforeEach(() => {
  approve.mockClear();
  revise.mockClear();
  mockOverview.overview = [];
  mockOverview.loading = false;
  mockOverview.error = null;
});

describe("CommandCenter", () => {
  it("renders a row per pipeline", () => {
    mockOverview.overview = [
      entry("scheduler-prune", "running", ["succeeded", "running"]),
      entry("auth-refactor", "awaiting-approval", ["succeeded", "awaiting-approval"]),
    ];
    render(<CommandCenter />);
    expect(screen.getByText("scheduler-prune")).toBeInTheDocument();
    expect(screen.getByText("auth-refactor")).toBeInTheDocument();
  });

  it("renders a numbered column per phase with step tiles", () => {
    mockOverview.overview = [entry("scheduler-prune", "running", ["succeeded", "running"])];
    render(<CommandCenter />);
    expect(screen.getByText("01")).toBeInTheDocument();
    expect(screen.getByText("02")).toBeInTheDocument();
    expect(screen.getByText("Phase0")).toBeInTheDocument();
    expect(screen.getByText("Phase1")).toBeInTheDocument();
    expect(screen.getByText("step-x")).toBeInTheDocument();
    expect(screen.getByText("job r")).toBeInTheDocument();
  });

  it("shows Approve/Revise only on an awaiting pipeline", () => {
    mockOverview.overview = [entry("scheduler-prune", "running", ["succeeded", "running"])];
    render(<CommandCenter />);
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
  });

  it("fires approve and disables the gate after clicking", () => {
    mockOverview.overview = [
      entry("auth-refactor", "awaiting-approval", ["succeeded", "awaiting-approval"]),
    ];
    render(<CommandCenter />);
    const btn = screen.getByRole("button", { name: /approve/i });
    fireEvent.click(btn);
    expect(approve).toHaveBeenCalledWith("auth-refactor-i1");
    expect(btn).toBeDisabled();
  });

  it("reveals a note field and fires revise", () => {
    mockOverview.overview = [
      entry("auth-refactor", "awaiting-approval", ["succeeded", "awaiting-approval"]),
    ];
    render(<CommandCenter />);
    fireEvent.click(screen.getByRole("button", { name: /revise/i }));
    const note = screen.getByPlaceholderText(/note/i);
    fireEvent.change(note, { target: { value: "tighten the spec" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(revise).toHaveBeenCalledWith("auth-refactor-i1", "tighten the spec");
  });

  it("offers Revise (but not Approve) on a failed pipeline", () => {
    mockOverview.overview = [entry("auth-refactor", "failed", ["succeeded", "failed"])];
    render(<CommandCenter />);
    expect(screen.getByRole("button", { name: /revise/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
  });

  it("shows the failed step and reason on a failed pipeline", () => {
    mockOverview.overview = [
      {
        definition: {
          id: "auth-refactor",
          name: "auth-refactor",
          phases: [
            {
              id: "ph0",
              name: "Implement",
              cwd: "/",
              gated: false,
              steps: [{ name: "s", prompt: "x" }],
            },
          ],
          trigger: null,
          enabled: true,
          overlapPolicy: "skip",
          lastStartedAt: null,
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z",
        },
        latest: {
          id: "auth-refactor-i1",
          pipelineId: "auth-refactor",
          pipelineName: "auth-refactor",
          status: "failed",
          currentPhaseIndex: 0,
          phases: [
            {
              id: "ph0",
              name: "Implement",
              gated: false,
              status: "failed",
              steps: [{ name: "dev", runId: "r0", status: "failed" as const }],
              attempt: 1,
              payload: { reason: "exit code 1" },
            },
          ],
          trigger: "manual",
          signalToken: "tok",
          createdAt: "2026-06-30T09:00:00.000Z",
          updatedAt: "2026-06-30T10:00:00.000Z",
          endedAt: "2026-06-30T10:00:00.000Z",
        },
      },
    ];
    render(<CommandCenter />);
    expect(screen.getByText("dev")).toBeInTheDocument();
    // one "Failed" pill on the row badge, one on the failed step tile
    expect(screen.getAllByText("Failed")).toHaveLength(2);
    expect(screen.getByText(/exit code 1/i)).toBeInTheDocument();
  });

  it("surfaces an action error and re-enables the gate", async () => {
    mockOverview.overview = [
      entry("auth-refactor", "awaiting-approval", ["succeeded", "awaiting-approval"]),
    ];
    approve.mockImplementationOnce(() =>
      Promise.reject(new Error("instance is not awaiting approval")),
    );
    render(<CommandCenter />);
    const btn = screen.getByRole("button", { name: /approve/i });
    fireEvent.click(btn);
    expect(await screen.findByText(/not awaiting approval/i)).toBeInTheDocument();
    expect(btn).not.toBeDisabled();
  });

  it("renders the empty state when there are no pipelines", () => {
    mockOverview.overview = [];
    render(<CommandCenter />);
    expect(screen.getByText(/no pipelines defined yet/i)).toBeInTheDocument();
  });

  it("renders an error banner when the server is unreachable", () => {
    mockOverview.error = "HTTP 500";
    render(<CommandCenter />);
    expect(screen.getByText(/couldn't reach the argus server/i)).toBeInTheDocument();
  });
});
