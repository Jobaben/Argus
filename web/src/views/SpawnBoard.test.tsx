import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import type { OverviewGate, OverviewRow, PhasePill, SpawnPill } from "../ds";
import type { InstanceParentRef, SpawnTask } from "../types";
import { ParentChip, SpawnChildren } from "./SpawnBoard";

afterEach(() => {
  vi.restoreAllMocks();
});

function pill(
  id: string,
  name: string,
  status: PhasePill["status"],
  over: Partial<PhasePill> = {},
) {
  return {
    id,
    name,
    status,
    activeStep: null,
    steps: [],
    reason: null,
    gated: false,
    needs: [],
    attempt: 0,
    retryAt: null,
    ...over,
  } satisfies PhasePill;
}

function row(over: Partial<OverviewRow> & Pick<OverviewRow, "pipelineId" | "name">): OverviewRow {
  return {
    badge: "working",
    updatedAt: null,
    phases: [],
    instanceId: null,
    gates: [],
    failure: null,
    cost: null,
    model: null,
    instanceLabel: null,
    trigger: "manual",
    ...over,
  };
}

const tasks: SpawnTask[] = [
  { key: "a", title: "Add the schema", state: "succeeded", instanceId: "c-a0" },
  { key: "b", title: "Add sign-in", state: "awaiting-approval", instanceId: "c-b" },
  { key: "c", title: "Wire the API", state: "running", instanceId: "c-c" },
  { key: "d", title: "Fix the export", state: "failed", instanceId: "c-d", reason: "tests failed" },
  { key: "e", title: "Write the docs", state: "blocked", dependsOn: [3] },
];

const spawn = (list: SpawnTask[] = tasks): SpawnPill => ({
  pipelineId: "child",
  tasks: list,
  succeeded: list.filter((t) => t.state === "succeeded").length,
  waiting: list.filter((t) => t.state === "awaiting-approval").length,
  halted: list.filter((t) => t.state === "failed" || t.state === "aborted").length,
});

/** The board: the parent, and the task pipeline's live children. */
const board: OverviewRow[] = [
  row({
    pipelineId: "delivery",
    name: "Delivery loop",
    instanceId: "p-1",
    phases: [pill("tasks", "Tasks", "working", { spawn: spawn() })],
  }),
  row({
    pipelineId: "child",
    name: "Task loop",
    instanceId: "c-b",
    badge: "await",
    phases: [pill("build", "Build", "done"), pill("pr", "PR", "await")],
    gates: [{ phaseId: "pr", canApprove: true }],
  }),
  row({
    pipelineId: "child",
    name: "Task loop",
    instanceId: "c-c",
    phases: [pill("build", "Build", "working"), pill("pr", "PR", "idle")],
  }),
  row({
    pipelineId: "child",
    name: "Task loop",
    instanceId: "c-d",
    badge: "failed",
    phases: [pill("build", "Build", "failed")],
    gates: [{ phaseId: "build", canApprove: false }],
  }),
];

function Tile({
  list = tasks,
  status = "working",
  gate = null,
  onReview = vi.fn(),
  onOpenGate = vi.fn(),
  rows = board,
}: {
  list?: SpawnTask[];
  status?: PhasePill["status"];
  gate?: OverviewGate | null;
  onReview?: (y: number) => void;
  onOpenGate?: Parameters<typeof SpawnChildren>[0]["onOpenGate"];
  rows?: OverviewRow[];
}) {
  return (
    <SpawnChildren
      spawn={spawn(list)}
      phaseName="Tasks"
      status={status}
      board={rows}
      gate={gate}
      opening={false}
      onReview={onReview}
      onOpenGate={onOpenGate}
    />
  );
}

describe("SpawnChildren", () => {
  it("lists every task with its key, title, state and where it stands", () => {
    render(<Tile />);
    const list = screen.getByRole("list", { name: "Tasks of phase Tasks" });
    const items = within(list).getAllByTestId("spawn-task");
    expect(items.map((li) => li.dataset.state)).toEqual([
      "succeeded",
      "awaiting-approval",
      "running",
      "failed",
      "blocked",
    ]);
    expect(items[0].textContent).toContain("Add the schema");
    expect(items[0].textContent).toContain("Done");
    expect(items[1].textContent).toContain("Waiting for you at PR");
    expect(items[2].textContent).toContain("At Build");
    expect(items[3].textContent).toContain("tests failed");
    expect(items[4].textContent).toContain("Needs d to succeed first");
    expect(
      screen.getByText("1 of 5 done · 1 waiting for you · 1 failed or stopped · 1 blocked"),
    ).toBeInTheDocument();
  });

  it("leads with the task waiting for you, and opens its child's gate", () => {
    const onOpenGate = vi.fn();
    render(<Tile onOpenGate={onOpenGate} />);
    const callout = screen.getByTestId("spawn-waiting");
    expect(callout.textContent).toContain("A task is waiting for you.");
    fireEvent.click(within(callout).getByRole("button", { name: "Review" }));
    expect(onOpenGate).toHaveBeenCalledWith({
      instanceId: "c-b",
      phaseId: "pr",
      pipelineName: "Task loop [b]",
      originY: expect.any(Number),
    });
    expect(screen.queryByTestId("gate-opener")).toBeNull();
  });

  it("counts several waiting tasks, and offers no Review when none can be opened", () => {
    const list: SpawnTask[] = [
      { key: "x", state: "awaiting-approval", instanceId: "gone-1" },
      { key: "y", state: "awaiting-approval", instanceId: "gone-2" },
    ];
    render(<Tile list={list} />);
    const callout = screen.getByTestId("spawn-waiting");
    expect(callout.textContent).toContain("2 tasks are waiting for you.");
    expect(within(callout).queryByRole("button")).toBeNull();
  });

  it("offers Review on a task's row: violet for a waiting gate, plain for a failed phase", () => {
    const onOpenGate = vi.fn();
    render(<Tile onOpenGate={onOpenGate} />);
    const items = screen.getAllByTestId("spawn-task");
    const waiting = within(items[1]).getByRole("button", { name: "Review" });
    expect(waiting.className).toContain("bg-await");
    const failed = within(items[3]).getByRole("button", { name: "Review" });
    expect(failed.className).not.toContain("bg-await");
    fireEvent.click(failed);
    expect(onOpenGate).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: "c-d",
        phaseId: "build",
        pipelineName: "Task loop [d]",
      }),
    );
    // A failed task whose child is not on the board has no phase to open.
    expect(within(items[0]).queryByRole("button")).toBeNull();
    expect(within(items[4]).queryByRole("button")).toBeNull();
  });

  it("offers no Review on a failed task whose child left the board", () => {
    render(<Tile rows={board.filter((r) => r.instanceId !== "c-d")} />);
    const items = screen.getAllByTestId("spawn-task");
    expect(within(items[3]).queryByRole("button")).toBeNull();
  });

  it("offers no Review once the spawn phase no longer waits for its tasks", () => {
    // Accepted (done) or stopped: the failed child is still on the board, but
    // revising it would be refused, as its parent has moved on.
    for (const status of ["done", "stopped"] as const) {
      const { unmount } = render(<Tile status={status} />);
      const items = screen.getAllByTestId("spawn-task");
      expect(within(items[3]).queryByRole("button"), status).toBeNull();
      expect(within(items[1]).queryByRole("button"), status).toBeNull();
      unmount();
    }
  });

  it("shows a working child's section on the board and gives it focus", () => {
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    render(
      <>
        <section id="instance-c-c" tabIndex={-1} />
        <Tile />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show c on the board" }));
    const target = document.getElementById("instance-c-c");
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.contexts[0]).toBe(target);
    expect(document.activeElement).toBe(target);
  });

  it("does nothing when the section to show is gone", () => {
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    render(<Tile />);
    fireEvent.click(screen.getByRole("button", { name: "Show c on the board" }));
    expect(scroll).not.toHaveBeenCalled();
  });

  it("leads a children pause with the phase's own Review", () => {
    const onReview = vi.fn();
    render(
      <Tile
        status="await"
        gate={{ phaseId: "tasks", canApprove: true, children: true }}
        onReview={onReview}
      />,
    );
    expect(screen.getByTestId("spawn-halted").textContent).toContain(
      "4 of 5 tasks did not succeed, so nothing more starts. Review them to accept the rest, re-run them, or stop.",
    );
    // The pause leads, not the waiting child.
    expect(screen.queryByTestId("spawn-waiting")).toBeNull();
    // The parent still waits, so the failed task's child is revised from here.
    const items = screen.getAllByTestId("spawn-task");
    expect(within(items[3]).getByRole("button", { name: "Review" })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("gate-opener"));
    expect(onReview).toHaveBeenCalledWith(expect.any(Number));
  });

  it("says what it will do before the task list is built", () => {
    render(<Tile list={[]} />);
    expect(
      screen.getByText("Starts one child of “Task loop” per task once the task list is ready."),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("spawn-tasks")).toBeNull();
  });
});

describe("ParentChip", () => {
  const ref: InstanceParentRef = {
    instanceId: "p-1",
    pipelineId: "delivery",
    phaseId: "tasks",
    index: 1,
    key: "b",
  };

  it("names the task and the parent, and shows the parent on the board", () => {
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    render(
      <>
        <section id="instance-p-1" tabIndex={-1} />
        <ParentChip parent={ref} board={board} />
      </>,
    );
    const chip = screen.getByRole("button", { name: /Task b · Delivery loop/ });
    expect(chip.getAttribute("title")).toBe(
      "Started by “Delivery loop” for task “b”: Add sign-in. Show it on the board.",
    );
    fireEvent.click(chip);
    expect(scroll.mock.contexts[0]).toBe(document.getElementById("instance-p-1"));
  });

  it("is a plain chip when the parent is not on the board", () => {
    render(<ParentChip parent={ref} board={board.filter((r) => r.instanceId !== "p-1")} />);
    expect(screen.queryByRole("button")).toBeNull();
    const chip = screen.getByText("Task b · its parent").parentElement!;
    expect(chip.getAttribute("title")).toBe("Started by instance p-1 for task “b”");
  });

  it("names the parent's pipeline from its card when the instance is not on it", () => {
    const other = row({ pipelineId: "delivery", name: "Delivery loop", instanceId: "p-2" });
    render(<ParentChip parent={ref} board={[other]} />);
    expect(screen.getByText("Task b · Delivery loop")).toBeInTheDocument();
  });
});
