import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Run } from "../types";
import Launch from "./Launch";

const mockState: {
  runs: Run[];
  launch: ReturnType<typeof vi.fn>;
  cancelRun: ReturnType<typeof vi.fn>;
} = {
  runs: [],
  launch: vi.fn().mockResolvedValue(undefined),
  cancelRun: vi.fn().mockResolvedValue(undefined),
};

vi.mock("../useLaunch", () => ({
  useLaunch: () => ({
    runs: mockState.runs,
    loading: false,
    error: null,
    launch: mockState.launch,
    cancelRun: mockState.cancelRun,
  }),
}));

const run = (over: Partial<Run> = {}): Run => ({
  id: "r1",
  scheduleId: "oneoff",
  scheduleName: "Quick audit",
  prompt: "audit the repo",
  cwd: "/tmp/repo",
  status: "succeeded",
  trigger: "manual",
  queuedAt: "2026-07-13T08:00:00.000Z",
  startedAt: "2026-07-13T08:00:00.000Z",
  endedAt: "2026-07-13T08:02:00.000Z",
  durationMs: 120_000,
  pid: null,
  exitCode: 0,
  sessionId: null,
  project: null,
  resultSummary: "all good",
  error: null,
  ...over,
});

describe("Launch", () => {
  beforeEach(() => {
    mockState.runs = [];
    mockState.launch = vi.fn().mockResolvedValue(undefined);
  });

  it("keeps Launch disabled until prompt and cwd are filled", async () => {
    const user = userEvent.setup();
    render(<Launch />);
    const button = screen.getByRole("button", { name: /launch/i });
    expect(button).toBeDisabled();
    await user.type(screen.getByPlaceholderText(/Summarize the open TODOs/), "do things");
    expect(button).toBeDisabled();
    await user.type(screen.getByPlaceholderText("/home/you/project"), "/tmp/repo");
    expect(button).toBeEnabled();
  });

  it("posts the launch input, omitting empty optional fields", async () => {
    const user = userEvent.setup();
    render(<Launch />);
    await user.type(screen.getByPlaceholderText(/Summarize the open TODOs/), "do things");
    await user.type(screen.getByPlaceholderText("/home/you/project"), "/tmp/repo");
    await user.click(screen.getByRole("button", { name: /launch/i }));
    expect(mockState.launch).toHaveBeenCalledWith({ prompt: "do things", cwd: "/tmp/repo" });
  });

  it("sends name and model when provided", async () => {
    const user = userEvent.setup();
    render(<Launch />);
    await user.type(screen.getByPlaceholderText(/Summarize the open TODOs/), "p");
    await user.type(screen.getByPlaceholderText("/home/you/project"), "/tmp/repo");
    await user.type(screen.getByPlaceholderText("Quick repo audit"), "My run");
    await user.selectOptions(screen.getByLabelText("Model (inherit CLI)"), "haiku");
    await user.click(screen.getByRole("button", { name: /launch/i }));
    expect(mockState.launch).toHaveBeenCalledWith({
      prompt: "p",
      cwd: "/tmp/repo",
      name: "My run",
      model: "haiku",
    });
  });

  it("lists recent one-off runs and refills the form on Reuse", async () => {
    mockState.runs = [run({ model: "opus" })];
    const user = userEvent.setup();
    render(<Launch />);
    expect(screen.getByText("Quick audit")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /reuse/i }));
    expect(screen.getByPlaceholderText(/Summarize the open TODOs/)).toHaveValue("audit the repo");
    expect(screen.getByPlaceholderText("/home/you/project")).toHaveValue("/tmp/repo");
    expect(screen.getByPlaceholderText("Quick repo audit")).toHaveValue("Quick audit");
  });

  it("shows the empty state when nothing has been launched", () => {
    render(<Launch />);
    expect(screen.getByText(/Nothing launched yet/)).toBeInTheDocument();
  });
});
