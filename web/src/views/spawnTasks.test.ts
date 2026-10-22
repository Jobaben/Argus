import { describe, it, expect } from "vitest";
import type { OverviewGate, OverviewRow, PhasePill, SpawnPill } from "../ds";
import type { PhaseChildrenReview, SpawnTask, SpawnTaskReview, SpawnTaskState } from "../types";
import {
  TASK_STATE,
  boardTaskRows,
  childPipelineName,
  childSelection,
  countsLine,
  keyList,
  reviewTaskRows,
  taskCounts,
} from "./spawnTasks";

function task(key: string, state: SpawnTaskState, over: Partial<SpawnTask> = {}): SpawnTask {
  return { key, state, ...over };
}

function pill(id: string, name: string, status: PhasePill["status"]): PhasePill {
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
  };
}

/** A child's row on the board: the task pipeline's instance, two phases. */
function child(
  instanceId: string,
  badge: OverviewRow["badge"],
  phases: PhasePill[],
  gates: OverviewGate[] = [],
  over: Partial<OverviewRow> = {},
): OverviewRow {
  return {
    pipelineId: "child",
    name: "Task loop",
    badge,
    updatedAt: null,
    phases,
    instanceId,
    gates,
    failure: null,
    cost: null,
    model: null,
    instanceLabel: null,
    trigger: "spawned",
    ...over,
  };
}

function spawnOf(tasks: SpawnTask[]): SpawnPill {
  const c = taskCounts(tasks);
  return {
    pipelineId: "child",
    tasks,
    succeeded: c.succeeded,
    waiting: c.waiting,
    halted: c.halted,
  };
}

describe("TASK_STATE", () => {
  it("gives every task state a status and a word", () => {
    const states: SpawnTaskState[] = [
      "pending",
      "planned",
      "reviving",
      "running",
      "awaiting-approval",
      "succeeded",
      "failed",
      "aborted",
      "blocked",
    ];
    for (const s of states) {
      expect(TASK_STATE[s].status, s).toBeTruthy();
      expect(TASK_STATE[s].label, s).toMatch(/^[A-Z]/);
    }
    expect(TASK_STATE["awaiting-approval"]).toEqual({ status: "await", label: "Waiting for you" });
    expect(TASK_STATE.aborted).toEqual({ status: "stopped", label: "Stopped" });
  });
});

describe("taskCounts and countsLine", () => {
  it("counts by what a person cares about", () => {
    const c = taskCounts([
      task("a", "succeeded"),
      task("b", "awaiting-approval"),
      task("c", "failed"),
      task("d", "aborted"),
      task("e", "blocked"),
      task("f", "pending"),
    ]);
    expect(c).toEqual({ total: 6, succeeded: 1, waiting: 1, halted: 2, blocked: 1 });
    expect(countsLine(c)).toBe("1 of 6 done · 1 waiting for you · 2 failed or stopped · 1 blocked");
  });

  it("leaves out the parts with nothing in them", () => {
    expect(countsLine(taskCounts([task("a", "succeeded"), task("b", "running")]))).toBe(
      "1 of 2 done",
    );
    expect(countsLine(taskCounts([]))).toBe("0 of 0 done");
  });
});

describe("keyList", () => {
  it("lists keys as a sentence does, and cuts a long list short", () => {
    expect(keyList([])).toBe("");
    expect(keyList(["b"])).toBe("b");
    expect(keyList(["b", "c"])).toBe("b and c");
    expect(keyList(["b", "c", "d"])).toBe("b, c and d");
    expect(keyList(["a", "b", "c", "d", "e", "f", "g"])).toBe("a, b, c, d, e and 2 more");
    expect(keyList(["a", "b", "c"], 2)).toBe("a, b and 1 more");
  });
});

describe("boardTaskRows: the detail line", () => {
  const detail = (tasks: SpawnTask[], board: OverviewRow[] = [], at = tasks.length - 1) =>
    boardTaskRows(spawnOf(tasks), board, true)[at].detail;

  it("says what a pending task waits for", () => {
    const deps = [task("a", "running"), task("b", "succeeded"), task("c", "pending")];
    expect(detail([...deps, task("d", "pending", { dependsOn: [0, 1, 2] })])).toBe(
      "Waits for a and c",
    );
    expect(detail([task("a", "failed"), task("b", "pending")])).toBe(
      "Not started: nothing new starts after a task fails",
    );
    expect(detail([task("a", "running"), task("b", "pending")])).toBe("Waits for a free slot");
  });

  it("says a planned or reviving task's start was put off, and why", () => {
    const deferred = { reason: "the spend budget is exceeded", at: "2026-10-22T00:00:00Z" };
    expect(detail([task("a", "planned", { deferred })])).toBe(
      "Start put off: the spend budget is exceeded",
    );
    expect(detail([task("a", "planned")])).toBe("Starting its child");
    expect(detail([task("a", "reviving", { deferred })])).toBe(
      "Re-run put off: the spend budget is exceeded",
    );
    expect(detail([task("a", "reviving")])).toBe("Running its failed phase again");
  });

  it("names the phase a running child is at, when its row is on the board", () => {
    const row = child("c-a", "working", [
      pill("build", "Build", "done"),
      pill("pr", "PR", "working"),
    ]);
    expect(detail([task("a", "running", { instanceId: "c-a" })], [row])).toBe("At PR");
    expect(detail([task("a", "running", { instanceId: "c-a" })])).toBeNull();
  });

  it("names the gate a child waits at, or says it waits at one of its gates", () => {
    const row = child(
      "c-b",
      "await",
      [pill("pr", "PR", "await")],
      [{ phaseId: "pr", canApprove: true }],
    );
    expect(
      detail([task("b", "awaiting-approval", { instanceId: "c-b", waitingPhaseId: "pr" })], [row]),
    ).toBe("Waiting for you at PR");
    // No row and no recorded phase: nothing to name, nothing to open.
    expect(detail([task("b", "awaiting-approval", { instanceId: "c-b" })])).toBe(
      "Waiting for you at one of its gates",
    );
  });

  it("gives why a task failed, stopped or is blocked", () => {
    expect(detail([task("a", "succeeded")])).toBeNull();
    expect(detail([task("a", "failed", { reason: "tests failed" })])).toBe("tests failed");
    expect(detail([task("a", "aborted", { reason: "parent-aborted" })])).toBe("parent-aborted");
    expect(detail([task("a", "aborted")])).toBeNull();
    expect(detail([task("a", "failed"), task("b", "blocked", { dependsOn: [0] })])).toBe(
      "Needs a to succeed first",
    );
    expect(detail([task("b", "blocked", { reason: "a failed" })])).toBe("a failed");
    expect(detail([task("b", "blocked")])).toBeNull();
  });
});

describe("boardTaskRows: where a task's Review goes", () => {
  it("opens a waiting child at its recorded phase, or at its row's gate", () => {
    const row = child(
      "c-b",
      "await",
      [pill("pr", "PR", "await")],
      [{ phaseId: "pr", canApprove: true }],
    );
    const [recorded] = boardTaskRows(
      spawnOf([task("b", "awaiting-approval", { instanceId: "c-b", waitingPhaseId: "pr" })]),
      [],
      true,
    );
    // Named by its id when the child's row is not on the board.
    expect(recorded.gate).toEqual({
      instanceId: "c-b",
      phaseId: "pr",
      phaseName: "pr",
      canApprove: true,
    });
    expect(recorded.onBoard).toBe(false);
    const [fromRow] = boardTaskRows(
      spawnOf([task("b", "awaiting-approval", { instanceId: "c-b" })]),
      [row],
      true,
    );
    expect(fromRow.gate).toEqual({
      instanceId: "c-b",
      phaseId: "pr",
      phaseName: "PR",
      canApprove: true,
    });
    expect(fromRow.onBoard).toBe(true);
    expect(fromRow).toMatchObject({ key: "b", status: "await", label: "Waiting for you" });
  });

  it("opens a failed child's failed phase only when its failed row is on the board", () => {
    const failed = child(
      "c-c",
      "failed",
      [pill("build", "Build", "failed")],
      [{ phaseId: "build", canApprove: false }],
    );
    const tasks = [task("c", "failed", { instanceId: "c-c" })];
    expect(boardTaskRows(spawnOf(tasks), [failed], true)[0].gate).toEqual({
      instanceId: "c-c",
      phaseId: "build",
      phaseName: "Build",
      canApprove: false,
    });
    expect(boardTaskRows(spawnOf(tasks), [], true)[0].gate).toBeNull();
    // A newer instance of the task pipeline took the card: no failed phase to name.
    const moved = { ...failed, badge: "working" as const };
    expect(boardTaskRows(spawnOf(tasks), [moved], true)[0].gate).toBeNull();
    // A deleted pipeline's child is stopped from its own card, not decided.
    const orphaned = { ...failed, orphaned: true as const };
    expect(boardTaskRows(spawnOf(tasks), [orphaned], true)[0].gate).toBeNull();
  });

  it("opens no child once the spawn phase stopped waiting for its tasks", () => {
    // Accepted or stopped, the parent keeps the failed task and the board its
    // failed child, but the server refuses deciding it (`parent-decided`).
    const failed = child(
      "c-c",
      "failed",
      [pill("build", "Build", "failed")],
      [{ phaseId: "build", canApprove: false }],
    );
    const tasks = [
      task("b", "awaiting-approval", { instanceId: "c-b", waitingPhaseId: "pr" }),
      task("c", "failed", { instanceId: "c-c", reason: "tests failed" }),
    ];
    const rows = boardTaskRows(spawnOf(tasks), [failed], false);
    expect(rows.map((r) => r.gate)).toEqual([null, null]);
    // Where it stands is still said.
    expect(rows[1]).toMatchObject({ detail: "tests failed", label: "Failed", onBoard: true });
  });

  it("offers nothing for a task with no child, or one that is not waiting or failed", () => {
    const rows = boardTaskRows(
      spawnOf([
        task("a", "pending"),
        task("b", "awaiting-approval"),
        task("c", "running", { instanceId: "c-c" }),
      ]),
      [],
      true,
    );
    expect(rows.map((r) => r.gate)).toEqual([null, null, null]);
    expect(rows.map((r) => r.instanceId)).toEqual([null, null, "c-c"]);
  });

  it("keeps a task's title, and none when it has none", () => {
    const rows = boardTaskRows(spawnOf([task("a", "pending", { title: "Add sign-in" })]), [], true);
    expect(rows[0].title).toBe("Add sign-in");
    expect(boardTaskRows(spawnOf([task("a", "pending")]), [], true)[0].title).toBeNull();
  });
});

describe("reviewTaskRows", () => {
  const review = (tasks: SpawnTaskReview[]): PhaseChildrenReview => ({
    pipelineId: "child",
    source: { phaseId: "plan", attempt: 0 },
    maxParallel: 1,
    tasks,
    notSucceeded: tasks.filter((t) => t.state !== "succeeded").map((t) => t.key),
  });

  it("opens each child at the phase the review names", () => {
    const rows = reviewTaskRows(
      review([
        { key: "a", state: "succeeded", instanceId: "c-a", child: { status: "succeeded" } },
        {
          key: "b",
          state: "failed",
          instanceId: "c-b",
          reason: "tests failed",
          child: {
            status: "failed",
            decisionPhase: { phaseId: "build", phaseName: "Build", attempt: 0, status: "failed" },
          },
        },
        {
          key: "c",
          state: "awaiting-approval",
          instanceId: "c-c",
          child: {
            status: "awaiting-approval",
            decisionPhase: {
              phaseId: "pr",
              phaseName: "PR",
              attempt: 1,
              status: "awaiting-approval",
            },
          },
        },
      ]),
      [],
      true,
    );
    expect(rows.map((r) => r.gate)).toEqual([
      null,
      { instanceId: "c-b", phaseId: "build", phaseName: "Build", canApprove: false },
      { instanceId: "c-c", phaseId: "pr", phaseName: "PR", canApprove: true },
    ]);
    expect(rows[1].detail).toBe("tests failed");
    expect(rows[2].detail).toBe("Waiting for you at PR");
  });

  it("opens no child when the spawn phase itself failed", () => {
    // Its review is not a `children` pause: the parent no longer waits.
    const [r] = reviewTaskRows(
      review([
        {
          key: "b",
          state: "failed",
          instanceId: "c-b",
          child: {
            status: "failed",
            decisionPhase: { phaseId: "build", phaseName: "Build", attempt: 0, status: "failed" },
          },
        },
      ]),
      [],
      false,
    );
    expect(r.gate).toBeNull();
    expect(r.label).toBe("Failed");
  });

  it("opens nothing on a stopped task whose child still has a failed phase", () => {
    // Revising it would run a child the parent no longer counts.
    const [r] = reviewTaskRows(
      review([
        {
          key: "a",
          state: "aborted",
          instanceId: "c-a",
          child: {
            status: "aborted",
            decisionPhase: { phaseId: "pr", phaseName: "PR", attempt: 0, status: "failed" },
          },
        },
      ]),
      [],
      true,
    );
    expect(r.gate).toBeNull();
    expect(r.label).toBe("Stopped");
  });

  it("reads where a running child is from its row on the board", () => {
    const row = child("c-a", "working", [pill("build", "Build", "working")]);
    const [r] = reviewTaskRows(
      review([{ key: "a", state: "running", instanceId: "c-a", child: { status: "running" } }]),
      [row],
      true,
    );
    expect(r.detail).toBe("At Build");
    expect(r.onBoard).toBe(true);
  });
});

describe("childSelection and childPipelineName", () => {
  it("names the child like its row: the pipeline, then the task", () => {
    const gate = { instanceId: "c-b", phaseId: "pr", phaseName: "PR", canApprove: true };
    expect(childSelection(gate, "b", "Task loop", 120)).toEqual({
      instanceId: "c-b",
      phaseId: "pr",
      pipelineName: "Task loop [b]",
      originY: 120,
    });
  });

  it("finds the child pipeline's name on the board, or says what it is", () => {
    expect(childPipelineName("child", [child("c-a", "working", [])])).toBe("Task loop");
    expect(childPipelineName("gone", [])).toBe("the child pipeline");
  });
});
