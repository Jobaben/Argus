import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Agent, TimelineEntry } from "../types";
import AgentDetail from "./AgentDetail";

const agent: Agent = {
  short: "c3d4",
  sessionId: null,
  name: "Upgrade lodash",
  status: "working",
  tempo: null,
  detail: "Running the test suite",
  result: null,
  template: null,
  cwd: null,
  cliVersion: null,
  inFlight: null,
  createdAt: null,
  updatedAt: new Date().toISOString(),
  firstTerminalAt: null,
  live: true,
  pid: null,
};

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
let timeline: TimelineEntry[] = [];

vi.mock("../useAgents", () => ({
  useAgents: () => ({
    agents: [agent],
    loading: false,
    error: null,
    live: true,
    refresh: vi.fn(),
  }),
}));
vi.mock("../useTimeline", () => ({
  useTimeline: () => ({ timeline, loading: false, error: null, refresh: vi.fn() }),
}));

afterEach(() => {
  timeline = [];
});

describe("AgentDetail", () => {
  it("heads a progress note with no state as an update, not as Idle", () => {
    timeline = [
      { at: minutesAgo(30), state: "working", detail: "Started" },
      { at: minutesAgo(19), detail: "Edited 3 files" },
    ];
    render(<AgentDetail short="c3d4" />);
    const note = screen.getByText("Edited 3 files").closest("li");
    expect(note).toHaveTextContent(/^Update/);
    expect(note).not.toHaveTextContent("Idle");
    expect(screen.getByText("Started").closest("li")).toHaveTextContent(/^Working/);
  });

  it("names the browser tab after the agent, as its heading does", () => {
    render(<AgentDetail short="c3d4" />);
    expect(screen.getByRole("heading", { name: "Upgrade lodash", level: 1 })).toBeInTheDocument();
    expect(document.title).toBe("Upgrade lodash — Argus");
  });
});
