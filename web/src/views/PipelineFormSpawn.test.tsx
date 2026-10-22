import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PipelineForm } from "./PipelineForm";
import { spawnOptionsText } from "./spawnAuthoring";
import type { PhaseDef, PipelineInput } from "../types";

/**
 * Authoring a spawn phase (DL-A2): a phase that starts one child instance of
 * another pipeline per task, edited as a child-pipeline select and the rest of
 * `spawn` as JSON.
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

const phase = (id: string, name: string, over: Partial<PhaseDef> = {}): PhaseDef => ({
  id,
  name,
  cwd: "/tmp",
  gated: false,
  steps: [{ name: `${id}-step`, prompt: "do it" }],
  ...over,
});

const planResult = {
  artifact: "plan",
  schema: {
    type: "object" as const,
    required: ["tasks"],
    properties: {
      tasks: {
        type: "array" as const,
        items: {
          type: "object" as const,
          required: ["id"],
          properties: { id: { type: "string" as const } },
        },
      },
    },
  },
};

const tasksPhase = phase("tasks", "Tasks", {
  needs: ["plan"],
  steps: [],
  spawn: { pipelineId: "child", items: { phase: "plan", path: ["tasks"] }, key: "id" },
});

/** Plan writes the task list; Tasks spawns one child per task; Ship follows. */
const seeded = (): PipelineInput => ({
  name: "Audit",
  phases: [
    phase("plan", "Plan", { gated: true, result: planResult }),
    tasksPhase,
    phase("ship", "Ship", { needs: ["tasks"] }),
  ],
  trigger: null,
  overlapPolicy: "skip",
});

const pipelines = [
  { id: "child", name: "Task loop" },
  { id: "self", name: "Audit" },
];

function renderForm(initial: PipelineInput = seeded()) {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(
    <PipelineForm
      initial={initial}
      onSubmit={onSubmit}
      onCancel={vi.fn()}
      pipelines={pipelines}
      pipelineId="self"
    />,
  );
  return onSubmit;
}

async function saved(onSubmit: ReturnType<typeof vi.fn>) {
  await userEvent.click(screen.getByRole("button", { name: /save pipeline/i }));
  expect(onSubmit).toHaveBeenCalledTimes(1);
  return onSubmit.mock.calls[0][0] as PipelineInput;
}

const select = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
const json = () => screen.getByLabelText("Task list settings (phase 2)") as HTMLTextAreaElement;
const saveButton = () => screen.getByRole("button", { name: /save pipeline/i });

describe("authoring a spawn phase", () => {
  it("edits a spawn phase's children, not steps, and saves it as it was", async () => {
    const onSubmit = renderForm();
    select("Phase 2: Tasks");
    expect(screen.getByRole("radio", { name: "Spawns children" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByLabelText("Child pipeline (phase 2)")).toHaveValue("child");
    expect(JSON.parse(json().value)).toEqual({
      items: { phase: "plan", path: ["tasks"] },
      key: "id",
    });
    expect(screen.getByTestId("spawn-sources")).toHaveTextContent("Can read from: Plan (plan)");
    expect(screen.queryByLabelText(/Requires human approval/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Add step" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Result" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Candidates" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Runtime and limits" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Starts after" })).toBeInTheDocument();
    expect(saveButton()).not.toBeDisabled();
    const out = await saved(onSubmit);
    expect(out.phases[1]).toEqual(tasksPhase);
  });

  it("marks a spawn phase on the rail", () => {
    renderForm();
    const chip = screen.getByRole("button", { name: "Phase 2: Tasks" });
    expect(within(chip).getByText("Spawn")).toBeInTheDocument();
    expect(chip.getAttribute("title")).toContain("spawns one child instance per task");
  });

  it("offers every other pipeline as the child, never this one", () => {
    renderForm();
    select("Phase 2: Tasks");
    const options = within(screen.getByLabelText("Child pipeline (phase 2)")).getAllByRole(
      "option",
    );
    expect(options.map((o) => o.textContent)).toEqual(["Choose a pipeline", "Task loop"]);
  });

  it("names a child pipeline that is no longer listed", () => {
    const initial = seeded();
    initial.phases[1] = { ...tasksPhase, spawn: { ...tasksPhase.spawn!, pipelineId: "gone" } };
    renderForm(initial);
    select("Phase 2: Tasks");
    expect(screen.getByLabelText("Child pipeline (phase 2)")).toHaveDisplayValue(
      "Unknown pipeline (gone)",
    );
  });

  it("turns a step phase into a spawn phase, keeping only what a spawn phase may declare", async () => {
    const initial = seeded();
    initial.phases[1] = phase("tasks", "Tasks", {
      needs: ["plan"],
      gated: true,
      retry: { attempts: 2, backoffSeconds: 30 },
      timeoutSeconds: 600,
      result: { artifact: "x", schema: { type: "object" } },
      produces: "summary",
    });
    const onSubmit = renderForm(initial);
    select("Phase 2: Tasks");
    fireEvent.click(screen.getByRole("radio", { name: "Spawns children" }));
    // No child pipeline yet: Save says so.
    expect(saveButton()).toBeDisabled();
    expect(screen.getByText(/phase 2 \(Tasks\) needs a child pipeline/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Child pipeline (phase 2)"), {
      target: { value: "child" },
    });
    const out = await saved(onSubmit);
    expect(out.phases[1]).toEqual({
      id: "tasks",
      name: "Tasks",
      cwd: "/tmp",
      needs: ["plan"],
      produces: "summary",
      gated: false,
      steps: [],
      spawn: {
        pipelineId: "child",
        items: { phase: "plan", path: ["tasks"] },
        key: "id",
        dependsOn: "dependsOn",
        title: "title",
      },
    });
  });

  it("keeps text that does not parse, says why, and holds Save until it does", () => {
    renderForm();
    select("Phase 2: Tasks");
    fireEvent.change(json(), { target: { value: '{ "items": ' } });
    expect(json()).toHaveAttribute("aria-invalid", "true");
    expect(json().value).toBe('{ "items": ');
    expect(screen.getByText(/^not valid JSON: /)).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    expect(
      screen.getByText(/phase 2 \(Tasks\) has task-list settings that are not valid/),
    ).toBeInTheDocument();
    // Still so after looking at another phase and coming back.
    select("Phase 1: Plan");
    select("Phase 2: Tasks");
    expect(json().value).toBe('{ "items": ');
    expect(json()).toHaveAttribute("aria-invalid", "true");
    fireEvent.change(json(), {
      target: { value: '{ "items": { "phase": "plan", "path": ["tasks"] }, "key": "slug" }' },
    });
    expect(json()).not.toHaveAttribute("aria-invalid");
    expect(saveButton()).not.toBeDisabled();
  });

  it("refuses the child pipeline in the JSON", () => {
    renderForm();
    select("Phase 2: Tasks");
    fireEvent.change(json(), {
      target: {
        value: '{ "pipelineId": "x", "items": { "phase": "plan", "path": [] }, "key": "id" }',
      },
    });
    expect(
      screen.getByText("choose the child pipeline above rather than in the JSON"),
    ).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
  });

  it("saves the policy from valid JSON", async () => {
    const onSubmit = renderForm();
    select("Phase 2: Tasks");
    fireEvent.change(json(), {
      target: {
        value:
          '{ "items": { "phase": "plan", "path": ["tasks"] }, "key": "id", "maxItems": 30, "base": "origin/main" }',
      },
    });
    const out = await saved(onSubmit);
    expect(out.phases[1].spawn).toEqual({
      pipelineId: "child",
      items: { phase: "plan", path: ["tasks"] },
      key: "id",
      maxItems: 30,
      base: "origin/main",
    });
  });

  it("gives a phase its steps back when switched back in the same sitting", () => {
    renderForm();
    select("Phase 3: Ship");
    fireEvent.click(screen.getByRole("radio", { name: "Spawns children" }));
    expect(screen.queryByLabelText("Phase 3 step 1 prompt")).toBeNull();
    // Its nearest source is two phases up: Tasks declares no result.
    expect(screen.getByTestId("spawn-sources")).toHaveTextContent("Can read from: Plan (plan)");
    fireEvent.click(screen.getByRole("radio", { name: "Runs steps" }));
    expect(screen.getByLabelText("Phase 3 step 1 prompt")).toHaveValue("do it");
    expect(screen.getByLabelText("Phase 3 step 1 name")).toHaveValue("ship-step");
  });

  it("gives a spawn phase its policy and its JSON as typed back when switched back", async () => {
    const initial = seeded();
    initial.phases[1] = {
      ...tasksPhase,
      spawn: { ...tasksPhase.spawn!, key: "slug", maxParallel: 1, base: "origin/main" },
    };
    const onSubmit = renderForm(initial);
    select("Phase 2: Tasks");
    fireEvent.click(screen.getByRole("radio", { name: "Runs steps" }));
    fireEvent.click(screen.getByRole("radio", { name: "Spawns children" }));
    expect(screen.getByLabelText("Child pipeline (phase 2)")).toHaveValue("child");
    expect(saveButton()).not.toBeDisabled();
    // Text that does not parse comes back as typed, and still holds Save.
    fireEvent.change(json(), { target: { value: '{ "items": ' } });
    fireEvent.click(screen.getByRole("radio", { name: "Runs steps" }));
    fireEvent.click(screen.getByRole("radio", { name: "Spawns children" }));
    expect(json().value).toBe('{ "items": ');
    expect(saveButton()).toBeDisabled();
    fireEvent.change(json(), { target: { value: spawnOptionsText(initial.phases[1].spawn!) } });
    const out = await saved(onSubmit);
    expect(out.phases[1]).toEqual(initial.phases[1]);
  });

  it("starts a spawn phase that was saved as one with an empty step when switched to steps", () => {
    renderForm();
    select("Phase 2: Tasks");
    fireEvent.click(screen.getByRole("radio", { name: "Runs steps" }));
    expect(screen.getByLabelText("Phase 2 step 1 prompt")).toHaveValue("");
    expect(screen.getByLabelText(/Requires human approval/)).not.toBeChecked();
  });

  it("says when no earlier phase has a result to read", () => {
    renderForm({ ...seeded(), phases: [phase("solo", "Solo")] });
    fireEvent.click(screen.getByRole("radio", { name: "Spawns children" }));
    expect(screen.getByTestId("spawn-sources")).toHaveTextContent(
      "No earlier phase declares a result yet.",
    );
  });
});
