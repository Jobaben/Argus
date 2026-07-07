import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentTile } from "./AgentTile";
import type { Agent } from "../types";

const base: Agent = {
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

describe("AgentTile", () => {
  it("renders name, id and status", () => {
    render(<AgentTile agent={base} />);
    expect(screen.getByText("idea-sweep")).toBeInTheDocument();
    expect(screen.getByText("Working")).toBeInTheDocument();
  });

  it("shows an approval gate and fires callbacks when await", async () => {
    const onApprove = vi.fn();
    const onRevise = vi.fn();
    render(
      <AgentTile
        agent={{ ...base, status: "unknown", live: false }}
        dsStatusOverride="await"
        onApprove={onApprove}
        onRevise={onRevise}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /approve/i }));
    await userEvent.click(screen.getByRole("button", { name: /revise/i }));
    expect(onApprove).toHaveBeenCalledOnce();
    expect(onRevise).toHaveBeenCalledOnce();
  });

  it("tints the tile for failed status", () => {
    const { container } = render(<AgentTile agent={{ ...base, status: "failed", live: false }} />);
    expect(container.firstElementChild?.className).toContain("border-fail/40");
    expect(container.firstElementChild?.className).toContain("from-fail/10");
  });
});
