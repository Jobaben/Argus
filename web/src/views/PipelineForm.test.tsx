import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PipelineForm, EMPTY_PIPELINE } from "./PipelineForm";

vi.mock("../useRuntimes", () => ({
  useRuntimes: () => ({
    default: "claude",
    runtimes: [
      {
        id: "claude",
        label: "Claude Code",
        available: true,
        models: ["opus", "sonnet", "haiku"],
        reasoningEfforts: [],
      },
      {
        id: "codex",
        label: "Codex",
        available: true,
        models: ["gpt-5.6-sol", "gpt-5.6-terra"],
        reasoningEfforts: ["low", "medium", "high", "xhigh"],
      },
    ],
  }),
}));

describe("PipelineForm", () => {
  it("renders a single phase by default and adds another on '+ add phase'", async () => {
    const user = userEvent.setup();
    render(<PipelineForm initial={EMPTY_PIPELINE} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText("Phase 1")).toBeTruthy();
    expect(screen.queryByText("Phase 2")).toBeNull();
    await user.click(screen.getByRole("button", { name: /add phase/i }));
    expect(screen.getByText("Phase 2")).toBeTruthy();
  });

  it("submits a well-formed PipelineInput with a manual trigger", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<PipelineForm initial={EMPTY_PIPELINE} onSubmit={onSubmit} onCancel={vi.fn()} />);

    await user.type(screen.getByPlaceholderText("Pipeline name"), "Ship it");
    await user.type(screen.getByPlaceholderText("Phase name"), "Build");
    await user.type(screen.getByPlaceholderText(/Working directory/), "/tmp");
    await user.type(screen.getByPlaceholderText("Step name"), "compile");
    await user.type(screen.getByPlaceholderText("Step prompt"), "run the build");

    await user.click(screen.getByRole("button", { name: /save pipeline/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const arg = onSubmit.mock.calls[0][0];
    expect(arg).toMatchObject({
      name: "Ship it",
      trigger: null,
      overlapPolicy: "skip",
      phases: [
        {
          name: "Build",
          cwd: "/tmp",
          gated: false,
          steps: [{ name: "compile", prompt: "run the build" }],
        },
      ],
    });
    expect(typeof arg.phases[0].id).toBe("string");
    expect(arg.phases[0].id.length).toBeGreaterThan(0);
  });

  it("keeps Save disabled until required fields are filled", () => {
    render(<PipelineForm initial={EMPTY_PIPELINE} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole("button", { name: /save pipeline/i })).toBeDisabled();
  });

  it("submits pipeline-level and step-level model selections", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<PipelineForm initial={EMPTY_PIPELINE} onSubmit={onSubmit} onCancel={vi.fn()} />);

    await user.type(screen.getByPlaceholderText("Pipeline name"), "Ship it");
    await user.type(screen.getByPlaceholderText("Phase name"), "Build");
    await user.type(screen.getByPlaceholderText(/Working directory/), "/tmp");
    await user.type(screen.getByPlaceholderText("Step name"), "compile");
    await user.type(screen.getByPlaceholderText("Step prompt"), "run the build");

    await user.selectOptions(screen.getByLabelText("Default model (inherit CLI)"), "opus");
    await user.selectOptions(
      screen.getByLabelText("Use pipeline default (phase 1 step 1)"),
      "sonnet",
    );

    await user.click(screen.getByRole("button", { name: /save pipeline/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const arg = onSubmit.mock.calls[0][0];
    expect(arg.model).toBe("opus");
    expect(arg.phases[0].steps[0].model).toBe("sonnet");
  });

  it("submits a custom model id typed into the Custom field", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<PipelineForm initial={EMPTY_PIPELINE} onSubmit={onSubmit} onCancel={vi.fn()} />);

    await user.type(screen.getByPlaceholderText("Pipeline name"), "Ship it");
    await user.type(screen.getByPlaceholderText("Phase name"), "Build");
    await user.type(screen.getByPlaceholderText(/Working directory/), "/tmp");
    await user.type(screen.getByPlaceholderText("Step name"), "compile");
    await user.type(screen.getByPlaceholderText("Step prompt"), "run the build");

    await user.selectOptions(screen.getByLabelText("Default model (inherit CLI)"), "custom");
    await user.type(screen.getByPlaceholderText("model id"), "claude-opus-4-8");

    await user.click(screen.getByRole("button", { name: /save pipeline/i }));

    const arg = onSubmit.mock.calls[0][0];
    expect(arg.model).toBe("claude-opus-4-8");
  });

  it("displays a persisted pipeline-level model when editing an existing pipeline", () => {
    const initial = {
      ...EMPTY_PIPELINE,
      name: "Ship it",
      phases: [
        {
          id: "p1",
          name: "Build",
          cwd: "/tmp",
          gated: false,
          steps: [{ name: "compile", prompt: "run" }],
        },
      ],
      model: "opus",
    };
    render(<PipelineForm initial={initial} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect((screen.getByLabelText("Default model (inherit CLI)") as HTMLSelectElement).value).toBe(
      "opus",
    );
  });

  it("omits model when left on the inherit option", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<PipelineForm initial={EMPTY_PIPELINE} onSubmit={onSubmit} onCancel={vi.fn()} />);

    await user.type(screen.getByPlaceholderText("Pipeline name"), "Ship it");
    await user.type(screen.getByPlaceholderText("Phase name"), "Build");
    await user.type(screen.getByPlaceholderText(/Working directory/), "/tmp");
    await user.type(screen.getByPlaceholderText("Step name"), "compile");
    await user.type(screen.getByPlaceholderText("Step prompt"), "run the build");

    await user.click(screen.getByRole("button", { name: /save pipeline/i }));

    const arg = onSubmit.mock.calls[0][0];
    expect(arg.model).toBeUndefined();
    expect(arg.phases[0].steps[0].model).toBeUndefined();
  });

  it("renders only the selected phase's fields and switches focus via the rail", async () => {
    const user = userEvent.setup();
    const initial = {
      ...EMPTY_PIPELINE,
      phases: [
        { id: "a", name: "Plan", cwd: "/tmp", gated: false, steps: [{ name: "s", prompt: "p" }] },
        { id: "b", name: "Build", cwd: "/tmp", gated: true, steps: [{ name: "s", prompt: "p" }] },
      ],
    };
    render(<PipelineForm initial={initial} onSubmit={vi.fn()} onCancel={vi.fn()} />);

    // Focus starts on the first phase; the second phase's fields are not mounted.
    expect((screen.getByLabelText("Phase 1 name") as HTMLInputElement).value).toBe("Plan");
    expect(screen.queryByLabelText("Phase 2 name")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Phase 2: Build" }));
    expect((screen.getByLabelText("Phase 2 name") as HTMLInputElement).value).toBe("Build");
    expect(screen.queryByLabelText("Phase 1 name")).toBeNull();
  });

  it("materializes implicit linear edges when a dependency is first edited", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const initial = {
      ...EMPTY_PIPELINE,
      name: "Weave",
      phases: [
        { id: "a", name: "Plan", cwd: "/tmp", gated: false, steps: [{ name: "s", prompt: "p" }] },
        { id: "b", name: "Build", cwd: "/tmp", gated: false, steps: [{ name: "s", prompt: "p" }] },
        { id: "c", name: "Docs", cwd: "/tmp", gated: false, steps: [{ name: "s", prompt: "p" }] },
      ],
    };
    render(<PipelineForm initial={initial} onSubmit={onSubmit} onCancel={vi.fn()} />);

    // The linear reading is shown even though nothing declares `needs`.
    await user.click(screen.getByRole("button", { name: "Phase 3: Docs" }));
    expect(screen.getByRole("button", { name: "Starts after phase 2: Build" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // Re-point Docs at Plan: Docs now fans out beside Build.
    await user.click(screen.getByRole("button", { name: "Starts after phase 2: Build" }));
    await user.click(screen.getByRole("button", { name: "Starts after phase 1: Plan" }));
    await user.click(screen.getByRole("button", { name: /save pipeline/i }));

    const arg = onSubmit.mock.calls[0][0];
    // Every phase went explicit in one stroke, preserving the linear shape
    // everywhere the user didn't touch.
    expect(arg.phases.map((p: { needs?: string[] }) => p.needs)).toEqual([[], ["a"], ["a"]]);
  });

  it("keeps an untouched linear pipeline free of needs keys", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<PipelineForm initial={EMPTY_PIPELINE} onSubmit={onSubmit} onCancel={vi.fn()} />);
    await user.type(screen.getByPlaceholderText("Pipeline name"), "Linear");
    await user.type(screen.getByPlaceholderText("Phase name"), "Build");
    await user.type(screen.getByPlaceholderText(/Working directory/), "/tmp");
    await user.type(screen.getByPlaceholderText("Step name"), "compile");
    await user.type(screen.getByPlaceholderText("Step prompt"), "run the build");
    await user.click(screen.getByRole("button", { name: /save pipeline/i }));
    expect(onSubmit.mock.calls[0][0].phases[0].needs).toBeUndefined();
  });

  it("disables dependency choices that would create a cycle", () => {
    const initial = {
      ...EMPTY_PIPELINE,
      phases: [
        {
          id: "a",
          name: "Plan",
          cwd: "/tmp",
          gated: false,
          needs: [],
          steps: [{ name: "s", prompt: "p" }],
        },
        {
          id: "b",
          name: "Build",
          cwd: "/tmp",
          gated: false,
          needs: ["a"],
          steps: [{ name: "s", prompt: "p" }],
        },
      ],
    };
    render(<PipelineForm initial={initial} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    // Plan is focused; Build runs after it, so Plan may not depend on Build.
    expect(screen.getByRole("button", { name: "Starts after phase 2: Build" })).toBeDisabled();
  });

  it("strips a removed phase from every other phase's needs", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const initial = {
      ...EMPTY_PIPELINE,
      name: "Weave",
      phases: [
        {
          id: "a",
          name: "Plan",
          cwd: "/tmp",
          gated: false,
          needs: [],
          steps: [{ name: "s", prompt: "p" }],
        },
        {
          id: "b",
          name: "Build",
          cwd: "/tmp",
          gated: false,
          needs: ["a"],
          steps: [{ name: "s", prompt: "p" }],
        },
        {
          id: "c",
          name: "Review",
          cwd: "/tmp",
          gated: false,
          needs: ["a", "b"],
          steps: [{ name: "s", prompt: "p" }],
        },
      ],
    };
    render(<PipelineForm initial={initial} onSubmit={onSubmit} onCancel={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Phase 2: Build" }));
    await user.click(screen.getByRole("button", { name: "Remove phase" }));
    await user.click(screen.getByRole("button", { name: /save pipeline/i }));

    const arg = onSubmit.mock.calls[0][0];
    expect(arg.phases.map((p: { id: string }) => p.id)).toEqual(["a", "c"]);
    expect(arg.phases[1].needs).toEqual(["a"]);
  });

  it("adds a new phase after the current leaves of an explicit graph", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const initial = {
      ...EMPTY_PIPELINE,
      name: "Weave",
      phases: [
        {
          id: "a",
          name: "Plan",
          cwd: "/tmp",
          gated: false,
          needs: [],
          steps: [{ name: "s", prompt: "p" }],
        },
        {
          id: "b",
          name: "Build",
          cwd: "/tmp",
          gated: false,
          needs: ["a"],
          steps: [{ name: "s", prompt: "p" }],
        },
        {
          id: "c",
          name: "Docs",
          cwd: "/tmp",
          gated: false,
          needs: ["a"],
          steps: [{ name: "s", prompt: "p" }],
        },
      ],
    };
    render(<PipelineForm initial={initial} onSubmit={onSubmit} onCancel={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /add phase/i }));
    // The new phase gets the focus, ready to fill in.
    await user.type(screen.getByLabelText("Phase 4 name"), "Ship");
    await user.type(screen.getByLabelText("Phase 4 working directory"), "/tmp");
    await user.type(screen.getByLabelText("Phase 4 step 1 name"), "release");
    await user.type(screen.getByLabelText("Phase 4 step 1 prompt"), "ship it");
    await user.click(screen.getByRole("button", { name: /save pipeline/i }));

    const arg = onSubmit.mock.calls[0][0];
    expect(arg.phases[3].needs.sort()).toEqual(["b", "c"]);
  });

  it("drops autoApprove when the gate is unchecked", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const initial = {
      ...EMPTY_PIPELINE,
      name: "Gated",
      phases: [
        {
          id: "a",
          name: "Review",
          cwd: "/tmp",
          gated: true,
          rubric: { goal: "good docs", criteria: [{ id: "clear", label: "Clear" }] },
          autoApprove: { verdict: 8 },
          steps: [{ name: "s", prompt: "p" }],
        },
      ],
    };
    render(<PipelineForm initial={initial} onSubmit={onSubmit} onCancel={vi.fn()} />);

    await user.click(screen.getByLabelText(/Requires human approval/i));
    await user.click(screen.getByRole("button", { name: /save pipeline/i }));

    const arg = onSubmit.mock.calls[0][0];
    expect(arg.phases[0].gated).toBe(false);
    expect(arg.phases[0].autoApprove).toBeUndefined();
    // The rubric itself is still preserved — only the gate-dependent knob goes.
    expect(arg.phases[0].rubric).toBeDefined();
  });

  it("submits Codex model and effort defaults and step overrides", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<PipelineForm initial={EMPTY_PIPELINE} onSubmit={onSubmit} onCancel={vi.fn()} />);
    await user.type(screen.getByPlaceholderText("Pipeline name"), "Codex pipeline");
    await user.type(screen.getByPlaceholderText("Phase name"), "Build");
    await user.type(screen.getByPlaceholderText(/Working directory/), "/tmp");
    await user.type(screen.getByPlaceholderText("Step name"), "compile");
    await user.type(screen.getByPlaceholderText("Step prompt"), "run");
    await user.selectOptions(screen.getByLabelText("Runtime (server default)"), "codex");
    await user.selectOptions(screen.getByLabelText("Default model (inherit CLI)"), "gpt-5.6-terra");
    await user.selectOptions(screen.getByLabelText("Default effort (inherit CLI)"), "medium");
    await user.selectOptions(
      screen.getByLabelText("Use pipeline effort (phase 1 step 1)"),
      "xhigh",
    );
    await user.click(screen.getByRole("button", { name: /save pipeline/i }));
    const arg = onSubmit.mock.calls[0][0];
    expect(arg).toMatchObject({
      runtime: "codex",
      model: "gpt-5.6-terra",
      reasoningEffort: "medium",
    });
    expect(arg.phases[0].steps[0].reasoningEffort).toBe("xhigh");
  });
});
