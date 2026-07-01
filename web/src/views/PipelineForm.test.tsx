import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PipelineForm, EMPTY_PIPELINE } from "./PipelineForm";

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
      phases: [{ name: "Build", cwd: "/tmp", gated: false, steps: [{ name: "compile", prompt: "run the build" }] }],
    });
    expect(typeof arg.phases[0].id).toBe("string");
    expect(arg.phases[0].id.length).toBeGreaterThan(0);
  });

  it("keeps Save disabled until required fields are filled", () => {
    render(<PipelineForm initial={EMPTY_PIPELINE} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole("button", { name: /save pipeline/i })).toBeDisabled();
  });
});
