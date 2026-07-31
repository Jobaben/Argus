import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RuntimeSelect } from "./RuntimeSelect";
import { RuntimeBadge } from "./RuntimeBadge";
import type { AgentRuntimeInfo } from "../types";

const CAPS = {
  presetSessionId: true,
  appendSystemPrompt: true,
  reportsCost: true,
  reportsTokens: true,
  signalHook: true,
  liveActivity: true,
  transcripts: true,
};

const ROSTER: AgentRuntimeInfo[] = [
  {
    id: "claude",
    label: "Claude Code",
    bin: "claude",
    home: "/h/.claude",
    available: true,
    isDefault: true,
    models: ["opus"],
    capabilities: CAPS,
  },
  {
    id: "codex",
    label: "Codex",
    bin: "codex",
    home: "/h/.codex",
    available: false,
    detail: "`codex` was not found on PATH",
    isDefault: false,
    models: [],
    capabilities: { ...CAPS, presetSessionId: false, reportsCost: false },
  },
];

const FIELD = "field";

describe("RuntimeSelect", () => {
  it("offers every runtime plus an inherit option", () => {
    render(
      <RuntimeSelect
        label="Runtime (server default)"
        value={undefined}
        onChange={() => {}}
        fieldClass={FIELD}
        runtimes={ROSTER}
      />,
    );
    const select = screen.getByRole("combobox", { name: "Runtime (server default)" });
    expect(select).toHaveValue("");
    expect(screen.getByRole("option", { name: "Runtime (server default)" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Claude Code" })).toBeInTheDocument();
    // Offered, not hidden — configuring a machine before installing the CLI is
    // a real thing to want, and a silently missing option reads as a bug.
    expect(screen.getByRole("option", { name: "Codex (not installed)" })).toBeInTheDocument();
  });

  it("reports the chosen id, and undefined for inherit", () => {
    const onChange = vi.fn();
    render(
      <RuntimeSelect
        label="Runtime"
        value="codex"
        onChange={onChange}
        fieldClass={FIELD}
        runtimes={ROSTER}
      />,
    );
    const select = screen.getByRole("combobox", { name: "Runtime" });
    fireEvent.change(select, { target: { value: "claude" } });
    expect(onChange).toHaveBeenCalledWith("claude");
    fireEvent.change(select, { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it("warns when the selected runtime isn't installed", () => {
    render(
      <RuntimeSelect
        label="Runtime"
        value="codex"
        onChange={() => {}}
        fieldClass={FIELD}
        runtimes={ROSTER}
      />,
    );
    expect(screen.getByTitle("`codex` was not found on PATH")).toHaveTextContent("not on PATH");
  });

  it("stays usable before the roster arrives", () => {
    render(
      <RuntimeSelect
        label="Runtime"
        value={undefined}
        onChange={() => {}}
        fieldClass={FIELD}
        runtimes={[]}
      />,
    );
    expect(screen.getByRole("option", { name: "Claude Code" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Codex" })).toBeInTheDocument();
  });
});

describe("RuntimeBadge", () => {
  it("marks a run that used something other than the baseline", () => {
    const { container } = render(<RuntimeBadge runtime="codex" baseline="claude" />);
    expect(container).toHaveTextContent("codex");
  });

  it("says nothing when the run matches the baseline, or has no runtime", () => {
    // A badge on every row when every row says the same thing is noise.
    expect(
      render(<RuntimeBadge runtime="claude" baseline="claude" />).container,
    ).toBeEmptyDOMElement();
    expect(
      render(<RuntimeBadge runtime={null} baseline="claude" />).container,
    ).toBeEmptyDOMElement();
  });

  it("shows the runtime when no baseline is given", () => {
    const { container } = render(<RuntimeBadge runtime="claude" />);
    expect(container).toHaveTextContent("claude");
  });
});
