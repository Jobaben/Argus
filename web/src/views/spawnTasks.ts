import type { DsStatus, OverviewRow, SpawnPill } from "../ds";
import type { PhaseChildrenReview, SpawnTask, SpawnTaskState } from "../types";
import type { GateSelection } from "./GateDrawer";
import { attentionPhase } from "./phaseAttention";

/**
 * A spawn phase's tasks as the board and the review drawer draw them (DL-A2).
 *
 * Pure, and imported only by the lazily loaded task list and the drawer: a
 * board with no spawn phase never fetches it. The parent's record says where
 * each task stands; the child's own row on the board, when it is there, says
 * where its child is.
 */

/** Every task state as the board shows it: the pill's colour and its word. */
export const TASK_STATE: Record<SpawnTaskState, { status: DsStatus; label: string }> = {
  pending: { status: "queued", label: "Pending" },
  planned: { status: "queued", label: "Starting" },
  reviving: { status: "working", label: "Re-running" },
  running: { status: "working", label: "Working" },
  "awaiting-approval": { status: "await", label: "Waiting for you" },
  succeeded: { status: "done", label: "Done" },
  failed: { status: "failed", label: "Failed" },
  aborted: { status: "stopped", label: "Stopped" },
  blocked: { status: "idle", label: "Blocked" },
};

export interface TaskCounts {
  total: number;
  succeeded: number;
  /** Children waiting at one of their own gates. */
  waiting: number;
  /** Failed or aborted. */
  halted: number;
  blocked: number;
}

export function taskCounts(tasks: readonly Pick<SpawnTask, "state">[]): TaskCounts {
  const count = (...states: SpawnTaskState[]) =>
    tasks.filter((t) => states.includes(t.state)).length;
  return {
    total: tasks.length,
    succeeded: count("succeeded"),
    waiting: count("awaiting-approval"),
    halted: count("failed", "aborted"),
    blocked: count("blocked"),
  };
}

/** "2 of 5 done · 1 waiting for you · 1 failed or stopped · 1 blocked", empty parts left out. */
export function countsLine(c: TaskCounts): string {
  return [
    `${c.succeeded} of ${c.total} done`,
    c.waiting > 0 && `${c.waiting} waiting for you`,
    c.halted > 0 && `${c.halted} failed or stopped`,
    c.blocked > 0 && `${c.blocked} blocked`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** "b", "b and c", "b, c and d"; past `max` keys, "b, c, d, e, f and 3 more". */
export function keyList(keys: readonly string[], max = 5): string {
  if (keys.length > max) return `${keys.slice(0, max).join(", ")} and ${keys.length - max} more`;
  if (keys.length < 2) return keys.join("");
  return `${keys.slice(0, -1).join(", ")} and ${keys[keys.length - 1]}`;
}

/** The child phase a person would act on now, and where it is. */
export interface TaskGate {
  instanceId: string;
  phaseId: string;
  phaseName: string;
  /** A gate waiting for approval; false for a failed phase, which is revised. */
  canApprove: boolean;
}

/** One task, ready to draw: shared by the board's tile and the review drawer. */
export interface TaskRowModel {
  key: string;
  title: string | null;
  state: SpawnTaskState;
  status: DsStatus;
  label: string;
  detail: string | null;
  /** The task's current child; null while it has none. */
  instanceId: string | null;
  /** Its waiting gate, or its failed phase. Null when there is none to open from here. */
  gate: TaskGate | null;
  /** The child's section is on this board ("Show"). */
  onBoard: boolean;
}

/** The keys of the tasks this one waits for that have not succeeded. */
function unmetKeys(task: SpawnTask, tasks: readonly SpawnTask[]): string[] {
  return (task.dependsOn ?? [])
    .filter((i) => tasks[i]?.state !== "succeeded")
    .map((i) => tasks[i]?.key ?? String(i));
}

/** The one line under a task: what it waits for, where its child is, why it stopped. */
function detailOf(
  task: SpawnTask,
  tasks: readonly SpawnTask[],
  halted: number,
  child: OverviewRow | undefined,
  gateName: string | null,
): string | null {
  switch (task.state) {
    case "pending": {
      const unmet = unmetKeys(task, tasks);
      if (unmet.length > 0) return `Waits for ${keyList(unmet)}`;
      return halted > 0
        ? "Not started: nothing new starts after a task fails"
        : "Waits for a free slot";
    }
    case "planned":
      return task.deferred ? `Start put off: ${task.deferred.reason}` : "Starting its child";
    case "reviving":
      return task.deferred
        ? `Re-run put off: ${task.deferred.reason}`
        : "Running its failed phase again";
    case "running": {
      const at = child && attentionPhase(child.phases);
      const name = child?.phases.find((p) => p.id === at)?.name;
      return name ? `At ${name}` : null;
    }
    case "awaiting-approval":
      return gateName ? `Waiting for you at ${gateName}` : "Waiting for you at one of its gates";
    case "succeeded":
      return null;
    case "blocked": {
      const unmet = unmetKeys(task, tasks);
      return task.reason ?? (unmet.length > 0 ? `Needs ${keyList(unmet)} to succeed first` : null);
    }
    case "failed":
    case "aborted":
      return task.reason ?? null;
  }
}

function rowModel(
  task: SpawnTask,
  tasks: readonly SpawnTask[],
  halted: number,
  board: readonly OverviewRow[],
  /** The spawn phase still waits for its children: running, or at its
   *  `children` pause. Once it is accepted, stopped or failed, the server
   *  refuses a child's approve or revise (`409 parent-decided`), so no task
   *  opens its child's gate. */
  waits: boolean,
  /** The child phase to act on, if any; its name from the child's row when not given. */
  gateOf: (
    child: OverviewRow | undefined,
  ) => (Omit<TaskGate, "instanceId" | "phaseName"> & { phaseName?: string }) | null,
): TaskRowModel {
  const instanceId = task.instanceId ?? null;
  const child = instanceId ? board.find((r) => r.instanceId === instanceId) : undefined;
  const found = instanceId && waits ? gateOf(child) : null;
  const gate: TaskGate | null =
    instanceId && found
      ? {
          ...found,
          instanceId,
          phaseName:
            found.phaseName ??
            child?.phases.find((p) => p.id === found.phaseId)?.name ??
            found.phaseId,
        }
      : null;
  return {
    key: task.key,
    title: task.title ?? null,
    state: task.state,
    ...TASK_STATE[task.state],
    detail: detailOf(task, tasks, halted, child, gate?.phaseName ?? null),
    instanceId,
    gate,
    onBoard: child !== undefined,
  };
}

/** The tile's rows: tasks from the parent's record, children from the board.
 *  `waits`: the spawn phase still waits for its children (see `rowModel`). */
export function boardTaskRows(
  spawn: SpawnPill,
  board: readonly OverviewRow[],
  waits: boolean,
): TaskRowModel[] {
  return spawn.tasks.map((task) =>
    rowModel(task, spawn.tasks, spawn.halted, board, waits, (child) => {
      // A child of a deleted pipeline is stopped from its own card, not decided.
      const live = child && !child.orphaned ? child : undefined;
      if (task.state === "awaiting-approval") {
        const phaseId = task.waitingPhaseId ?? live?.gates.find((g) => g.canApprove)?.phaseId;
        return phaseId ? { phaseId, canApprove: true } : null;
      }
      // A failed child's phase is known only from its row, which the board
      // shows while the child is its pipeline's latest instance.
      const failed = task.state === "failed" && live?.badge === "failed";
      const phaseId = failed ? live.gates.find((g) => !g.canApprove)?.phaseId : undefined;
      return phaseId ? { phaseId, canApprove: false } : null;
    }),
  );
}

/** The drawer's rows: tasks and each child's decision phase from the review.
 *  `waits`: the spawn phase still waits for its children (see `rowModel`). */
export function reviewTaskRows(
  children: PhaseChildrenReview,
  board: readonly OverviewRow[],
  waits: boolean,
): TaskRowModel[] {
  const { halted } = taskCounts(children.tasks);
  return children.tasks.map((task) =>
    rowModel(task, children.tasks, halted, board, waits, () => {
      const at = task.child?.decisionPhase;
      // The tile's rule: a stopped task's child can keep a failed phase, but
      // revising it would run a child its parent no longer counts.
      const open =
        at?.status === "awaiting-approval"
          ? task.state === "awaiting-approval"
          : at?.status === "failed" && task.state === "failed";
      return at && open
        ? {
            phaseId: at.phaseId,
            phaseName: at.phaseName,
            canApprove: at.status === "awaiting-approval",
          }
        : null;
    }),
  );
}

/** The selection that opens a task's child gate, named like the child's row. */
export function childSelection(
  gate: TaskGate,
  key: string,
  childPipelineName: string,
  originY?: number,
): GateSelection {
  return {
    instanceId: gate.instanceId,
    phaseId: gate.phaseId,
    pipelineName: `${childPipelineName} [${key}]`,
    originY,
  };
}

/** The child pipeline's name from the board, for sentences and selections. */
export function childPipelineName(pipelineId: string, board: readonly OverviewRow[]): string {
  return board.find((r) => r.pipelineId === pipelineId)?.name ?? "the child pipeline";
}
