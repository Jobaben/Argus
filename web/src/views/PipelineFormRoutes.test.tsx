import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PipelineForm } from "./PipelineForm";
import type { PipelineInput } from "../types";

/**
 * Authoring the spec's worked example in the editor.
 *
 * The point of the panel is that a condition is picked from the source phase's
 * own declared fields, so an author cannot write a predicate the server will
 * reject — and cannot write one that is accepted but silently never true.
 */

vi.mock("../useRuntimes", () => ({
  useRuntimes: () => ({
    default: "claude",
    runtimes: [
      {
        id: "claude",
        label: "Claude Code",
        available: true,
        models: ["opus"],
        reasoningEfforts: [],
      },
    ],
  }),
}));

const phase = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  name,
  cwd: "/tmp",
  gated: false,
  steps: [{ name: `${id}-step`, prompt: "do it" }],
  ...over,
});

/** Two phases, linear, with the first already declaring a decision. */
const seeded = (): PipelineInput => ({
  name: "Audit",
  phases: [
    phase("evaluate", "Evaluate", {
      result: {
        artifact: "evaluation",
        schema: {
          type: "object",
          required: ["accepted"],
          properties: { accepted: { type: "boolean" } },
        },
      },
    }),
    phase("publish", "Publish"),
  ],
  trigger: null,
  overlapPolicy: "skip",
});

async function saved(onSubmit: ReturnType<typeof vi.fn>) {
  await userEvent.click(screen.getByRole("button", { name: /save pipeline/i }));
  expect(onSubmit).toHaveBeenCalledTimes(1);
  return onSubmit.mock.calls[0][0] as PipelineInput;
}

describe("authoring routes", () => {
  it("declares a result with a typed field and an allowed-value list", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <PipelineForm
        initial={{
          name: "Audit",
          phases: [phase("audit", "Audit")],
          trigger: null,
          overlapPolicy: "skip",
        }}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );

    await user.click(screen.getByLabelText(/Publishes a structured result/i));
    await user.type(screen.getByLabelText("Phase 1 result artifact"), "verdict");
    await user.click(screen.getByRole("button", { name: /add field/i }));
    // A new field arrives named (a nameless property cannot exist in a schema);
    // renaming it is one replacement, as select-all-and-type would send.
    fireEvent.change(screen.getByLabelText("Result field 1 name"), {
      target: { value: "outcome" },
    });
    await user.type(screen.getByLabelText("Result field 1 allowed values"), "pass, fail");

    const input = await saved(onSubmit);
    expect(input.phases[0].result).toEqual({
      artifact: "verdict",
      schema: {
        type: "object",
        required: ["outcome"],
        properties: { outcome: { type: "string", enum: ["pass", "fail"] } },
      },
    });
  });

  it("names the publishing step once a phase has more than one", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <PipelineForm
        initial={{
          name: "Audit",
          phases: [
            phase("audit", "Audit", {
              steps: [
                { name: "gather", prompt: "look" },
                { name: "decide", prompt: "judge" },
              ],
            }),
          ],
          trigger: null,
          overlapPolicy: "skip",
        }}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    await user.click(screen.getByLabelText(/Publishes a structured result/i));
    await user.type(screen.getByLabelText("Phase 1 result artifact"), "verdict");
    await user.selectOptions(screen.getByLabelText("Phase 1 publishing step"), "decide");

    const input = await saved(onSubmit);
    expect(input.phases[0].result?.resultStep).toBe("decide");
  });

  it("offers a condition built from the source phase's own fields", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<PipelineForm initial={seeded()} onSubmit={onSubmit} onCancel={vi.fn()} />);

    // Focus the dependent phase; its one edge offers the decision as a route.
    await user.click(screen.getByRole("button", { name: /Phase 2: Publish/ }));
    await user.selectOptions(screen.getByLabelText("When to run after Evaluate"), "only-if");
    await user.selectOptions(screen.getByLabelText("Condition value for Evaluate"), "true");

    const input = await saved(onSubmit);
    expect(input.phases[1].needs).toEqual([
      {
        phase: "evaluate",
        when: { predicate: { path: ["accepted"], operator: "equals", value: true } },
      },
    ]);
    // Materializing the graph left the root explicit rather than reshaping it.
    expect(input.phases[0].needs).toEqual([]);
  });

  it("does not offer a condition on a phase that decides nothing", async () => {
    const user = userEvent.setup();
    const plain = seeded();
    plain.phases[0].result = undefined;
    render(<PipelineForm initial={plain} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /Phase 2: Publish/ }));
    const mode = screen.getByLabelText("When to run after Evaluate") as HTMLSelectElement;
    expect([...mode.options].map((o) => o.value)).toEqual(["always", "otherwise"]);
  });

  it("authors a default route, a group, and its group-wide flags", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<PipelineForm initial={seeded()} onSubmit={onSubmit} onCancel={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /Phase 2: Publish/ }));
    await user.selectOptions(screen.getByLabelText("When to run after Evaluate"), "otherwise");
    await user.click(screen.getByLabelText("Group routes exclusive"));

    const input = await saved(onSubmit);
    expect(input.phases[1].needs).toEqual([
      { phase: "evaluate", when: { group: "routes", default: true, exclusive: true } },
    ]);
  });

  it("marks a join edge as tolerating a skipped source", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<PipelineForm initial={seeded()} onSubmit={onSubmit} onCancel={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /Phase 2: Publish/ }));
    await user.click(screen.getByLabelText("Accept a skipped Evaluate"));

    const input = await saved(onSubmit);
    expect(input.phases[1].needs).toEqual([{ phase: "evaluate", allowSkipped: true }]);
  });

  it("leaves a hand-authored condition alone and says so", async () => {
    const user = userEvent.setup();
    const nested = seeded();
    nested.phases[0].result = {
      artifact: "evaluation",
      schema: {
        type: "object",
        properties: { detail: { type: "object", properties: { ok: { type: "boolean" } } } },
      },
    };
    nested.phases[1].needs = [
      {
        phase: "evaluate",
        when: { predicate: { path: ["detail", "ok"], operator: "equals", value: true } },
      },
    ];
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<PipelineForm initial={nested} onSubmit={onSubmit} onCancel={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /Phase 2: Publish/ }));
    expect(screen.getByText("detail.ok = true")).toBeTruthy();
    expect(screen.queryByLabelText("When to run after Evaluate")).toBeNull();

    // Focus the deciding phase: its schema is beyond the form, and it says so.
    await user.click(screen.getByRole("button", { name: /Phase 1: Evaluate/ }));
    expect(screen.getByText("schema set via the API")).toBeTruthy();

    const input = await saved(onSubmit);
    expect(input.phases[1].needs).toEqual(nested.phases[1].needs);
    expect(input.phases[0].result).toEqual(nested.phases[0].result);
  });

  it("authors a one-of condition over a typed field, then an existence check", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const graded = seeded();
    graded.phases[0].result = {
      artifact: "evaluation",
      schema: {
        type: "object",
        required: ["verdict"],
        properties: { verdict: { type: "string", enum: ["pass", "warn", "fail"] } },
      },
    };
    render(<PipelineForm initial={graded} onSubmit={onSubmit} onCancel={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /Phase 2: Publish/ }));
    await user.selectOptions(screen.getByLabelText("When to run after Evaluate"), "only-if");
    await user.selectOptions(screen.getByLabelText("Condition operator for Evaluate"), "one-of");
    fireEvent.change(screen.getByLabelText("Condition value for Evaluate"), {
      target: { value: "warn, fail" },
    });

    let input = await saved(onSubmit);
    expect(input.phases[1].needs).toEqual([
      {
        phase: "evaluate",
        when: { predicate: { path: ["verdict"], operator: "one-of", value: ["warn", "fail"] } },
      },
    ]);

    // An existence check needs no value at all, and the input goes away.
    onSubmit.mockClear();
    await user.selectOptions(screen.getByLabelText("Condition operator for Evaluate"), "exists");
    expect(screen.queryByLabelText("Condition value for Evaluate")).toBeNull();
    input = await saved(onSubmit);
    expect(input.phases[1].needs).toEqual([
      { phase: "evaluate", when: { predicate: { path: ["verdict"], operator: "exists" } } },
    ]);
  });

  it("edits a numeric field and removes one it no longer wants", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const scored = seeded();
    scored.phases[0].result = {
      artifact: "evaluation",
      schema: {
        type: "object",
        properties: { accepted: { type: "boolean" }, score: { type: "number" } },
      },
    };
    render(<PipelineForm initial={scored} onSubmit={onSubmit} onCancel={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Result field 2 allowed values"), {
      target: { value: "1, 2, 3" },
    });
    await user.click(screen.getByLabelText("Result field 1 required"));
    await user.click(screen.getByRole("button", { name: "Remove result field 1" }));

    const input = await saved(onSubmit);
    expect(input.phases[0].result?.schema).toEqual({
      type: "object",
      properties: { score: { type: "number", enum: [1, 2, 3] } },
    });
  });

  it("says nothing about routing on a pipeline that has no result to route on", () => {
    const plain = seeded();
    plain.phases[0].result = undefined;
    render(<PipelineForm initial={plain} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    // The selected phase is the root: no incoming edge, so no route row at all.
    expect(screen.queryByTestId("edge-condition")).toBeNull();
  });
});
