import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AgentsView from "./Agents";
import type { Agent } from "../types";

const agent: Agent = {
  short: "7a1b",
  sessionId: null,
  name: "idea-sweep",
  status: "working",
  tempo: "fast",
  detail: "red → green on scheduler-prune test",
  result: null,
  template: null,
  cwd: "C:/GIT/argus",
  cliVersion: null,
  inFlight: { tasks: 2, queued: 0, kinds: [] },
  createdAt: null,
  updatedAt: new Date().toISOString(),
  firstTerminalAt: null,
  live: true,
  pid: 1,
};

function renderView(over: Partial<Parameters<typeof AgentsView>[0]> = {}) {
  const props = { agents: [], loading: false, error: null, refresh: vi.fn(), ...over };
  render(<AgentsView {...props} />);
  return props;
}

describe("Agents", () => {
  it("says what the page is for under its title", () => {
    renderView();
    expect(screen.getByRole("heading", { name: "Agents", level: 1 })).toBeInTheDocument();
    expect(screen.getByText(/Tasks launched to run in the background/)).toBeInTheDocument();
  });

  it("shows the empty state alone when there are no agents — no row of zeros", () => {
    renderView();
    expect(screen.getByText("No background agents yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Launch a task/ })).toHaveAttribute(
      "href",
      "#/schedules/oneoff",
    );
    expect(screen.queryByRole("region", { name: "Agent counts" })).toBeNull();
  });

  it("on a failed load, says so once, with a retry, and claims nothing else", async () => {
    const user = userEvent.setup();
    const { refresh } = renderView({ error: "database is locked" });
    // The server answered, so this is its reason, not a connection problem.
    expect(screen.getByText("Couldn't load agents: database is locked")).toBeInTheDocument();
    expect(screen.queryByText(/couldn't reach/i)).toBeNull();
    expect(screen.queryByText("No background agents yet")).toBeNull();
    expect(screen.queryByRole("region", { name: "Agent counts" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("counts the agents over their tiles once there are some", () => {
    renderView({ agents: [agent, { ...agent, short: "9c2d", status: "failed", live: false }] });
    const counts = screen.getByRole("region", { name: "Agent counts" });
    expect(counts).toHaveTextContent("2Agents");
    expect(counts).toHaveTextContent("1Failed");
    expect(screen.getAllByRole("link", { name: /idea-sweep/ })[0]).toHaveAttribute(
      "href",
      "#/agent/7a1b",
    );
  });
});
