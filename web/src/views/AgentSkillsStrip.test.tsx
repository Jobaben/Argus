import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { AgentSkillStatus } from "@argus/contracts";
import type { AgentSkillsInstallResponse } from "../useAgentSkills";
import AgentSkillsStrip from "./AgentSkillsStrip";

const install = vi.fn<() => Promise<AgentSkillsInstallResponse>>();
const mock: {
  skills: AgentSkillStatus[];
  upToDate: boolean;
  loading: boolean;
  error: string | null;
} = { skills: [], upToDate: true, loading: false, error: null };

vi.mock("../useAgentSkills", () => ({ useAgentSkills: () => ({ ...mock, install }) }));

const row = (over: Partial<AgentSkillStatus>): AgentSkillStatus => ({
  skill: "argus-pipeline",
  runtime: "claude",
  dir: "/home/you/.claude/skills/argus-pipeline",
  state: "outdated",
  installedVersion: null,
  managed: true,
  ...over,
});

beforeEach(() => {
  install.mockReset();
  mock.skills = [];
  mock.upToDate = true;
  mock.loading = false;
  mock.error = null;
});

describe("AgentSkillsStrip", () => {
  it("renders nothing while every skill is up to date, loading, or unreadable", () => {
    const { container, rerender } = render(<AgentSkillsStrip isAdmin />);
    expect(container).toBeEmptyDOMElement();
    mock.upToDate = false;
    mock.loading = true;
    rerender(<AgentSkillsStrip isAdmin />);
    expect(container).toBeEmptyDOMElement();
    mock.loading = false;
    mock.error = "HTTP 500";
    rerender(<AgentSkillsStrip isAdmin />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists what is behind and installs only when the button is pressed", async () => {
    mock.upToDate = false;
    mock.skills = [
      row({}),
      row({ skill: "argus-tail", runtime: "codex", state: "missing" }),
      row({ skill: "argus-tail", runtime: "claude", state: "current" }),
    ];
    install.mockResolvedValue({
      ok: true,
      upToDate: true,
      skills: [],
      results: [
        {
          skill: "argus-pipeline",
          runtime: "claude",
          dir: "/d",
          action: "updated",
          was: "unmanaged",
          backup: "/home/you/.claude/argus/skill-backups/claude/argus-pipeline-x",
        },
      ],
    });
    render(<AgentSkillsStrip isAdmin />);
    expect(screen.getByText(/older than this build/)).toBeInTheDocument();
    expect(screen.getByText(/not installed/)).toBeInTheDocument();
    expect(screen.queryByText(/up to date/)).not.toBeInTheDocument();
    expect(install).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /install skills/i }));
    expect(install).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /installing/i })).toBeDisabled();
    await waitFor(() => expect(screen.getByText(/argus-pipeline-x/)).toBeInTheDocument());
  });

  it("offers no button to someone who is not signed in", () => {
    mock.upToDate = false;
    mock.skills = [row({ state: "missing" })];
    render(<AgentSkillsStrip isAdmin={false} />);
    expect(screen.queryByRole("button", { name: /install skills/i })).not.toBeInTheDocument();
    expect(screen.getByText(/argus skills install/)).toBeInTheDocument();
  });

  it("says why an install failed", async () => {
    mock.upToDate = false;
    mock.skills = [row({})];
    install.mockRejectedValue(new Error("login required"));
    render(<AgentSkillsStrip isAdmin />);
    fireEvent.click(screen.getByRole("button", { name: /install skills/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Install failed: login required");
    expect(screen.getByRole("button", { name: /install skills/i })).not.toBeDisabled();
  });
});
