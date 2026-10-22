import { useId, useState, useTransition, type ReactNode } from "react";
import {
  Button,
  Icon,
  StatusPill,
  buttonClass,
  chipClass,
  instanceSectionId,
  prefersReducedMotion,
  type DsStatus,
  type OverviewGate,
  type OverviewRow,
  type SpawnPill,
} from "../ds";
import type { InstanceParentRef } from "../types";
// Type-only: a value import would make this chunk load the drawer's.
import type { GateSelection } from "./GateDrawer";
import {
  boardTaskRows,
  childPipelineName,
  childSelection,
  countsLine,
  taskCounts,
  type TaskRowModel,
} from "./spawnTasks";

/**
 * A spawn phase on the board (DL-A2): its tasks in place of step tiles, and the
 * chip that names a spawned child's parent.
 *
 * Its own chunk: most boards have no spawn phase, and the board is the first
 * paint. The review drawer imports the task list from here too, so the
 * drawer's idle prefetch fetches it with it.
 */

/** Scroll an instance's section into view and give it focus, as "Show" and the
 *  parent chip do. Reduced motion jumps instead of gliding. */
function showOnBoard(instanceId: string): void {
  const el = document.getElementById(instanceSectionId(instanceId));
  if (!el) return;
  el.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  el.focus({ preventScroll: true });
}

/** The violet line that leads the tile: what is waited on, and the way to it.
 *  The board's gate callout, in the same skin. */
function Callout({
  testId,
  children,
  action,
}: {
  testId: string;
  children: ReactNode;
  action: ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className="@container rounded-control border border-await/35 bg-await/[0.07] px-3 py-2.5"
    >
      <div className="flex flex-col items-start gap-2 @lg:flex-row @lg:items-center @lg:gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <Icon name="approve" size={18} className="mt-px text-await" />
          <p className="min-w-0 flex-1 text-small text-ink-dim">{children}</p>
        </div>
        {action}
      </div>
    </div>
  );
}

/**
 * One row per task, in list order: its key and title, a status pill, one line
 * on where it stands, and at most one action — **Review** into its child's
 * waiting gate (or failed phase), or **Show** for a child that is working.
 */
export function SpawnTaskList({
  rows,
  label,
  onReview,
  onShow,
}: {
  rows: TaskRowModel[];
  /** The list's accessible name: "Tasks of phase Tasks". */
  label: string;
  /** Open a task's child gate; absent, no Review is offered. */
  onReview?: (row: TaskRowModel, originY: number) => void;
  /** Show a task's child on the board; absent, no Show is offered. */
  onShow?: (row: TaskRowModel) => void;
}) {
  const id = useId();
  // As the board's openers: the drawer may still be loading, and the board
  // should stay as it is until it is in. Only the pressed Review says so.
  const [opening, start] = useTransition();
  const [pressed, setPressed] = useState<string | null>(null);
  return (
    <ol
      aria-label={label}
      data-testid="spawn-tasks"
      className="divide-y divide-line overflow-hidden rounded-tile border border-line bg-ground-2/60"
    >
      {rows.map((row) => {
        const titleId = `${id}-${row.key}`;
        const live = row.state === "running" || row.state === "reviving";
        return (
          <li
            key={row.key}
            data-testid="spawn-task"
            data-state={row.state}
            className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5"
          >
            <div className="min-w-0 flex-1 basis-56">
              <p id={titleId} className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                <span className="font-mono text-caption text-ink-dim">{row.key}</span>
                {row.title && row.title !== row.key && (
                  <span className="min-w-0 break-words text-small text-ink">{row.title}</span>
                )}
              </p>
              {row.detail && (
                <p className="break-words text-caption text-ink-faint">{row.detail}</p>
              )}
            </div>
            <StatusPill status={row.status} size="sm" label={row.label} />
            {row.gate && onReview ? (
              <Button
                variant={row.gate.canApprove ? "attention" : "secondary"}
                size="sm"
                iconRight="arrow-right"
                aria-describedby={titleId}
                aria-busy={(opening && pressed === row.key) || undefined}
                className="aria-busy:cursor-progress"
                title={
                  row.gate.canApprove
                    ? `Review ${row.gate.phaseName}, where this task's child waits for you`
                    : `Review ${row.gate.phaseName}, which failed: revising it re-runs this one task`
                }
                onClick={(e) => {
                  const top = e.currentTarget.getBoundingClientRect().top;
                  setPressed(row.key);
                  start(() => onReview(row, top));
                }}
              >
                Review
              </Button>
            ) : (
              row.onBoard &&
              onShow &&
              live && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Show ${row.key} on the board`}
                  onClick={() => onShow(row)}
                >
                  Show
                </Button>
              )
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * A spawn phase's tile: what it waits for you about, then every task.
 *
 * At a `children` pause the spawn phase's own Review leads (the decision is
 * the parent's); otherwise a child waiting at its own gate does, because the
 * parent is still running and its node cannot say so. Once the phase has moved
 * on, a task's child is no longer decided from here.
 */
export function SpawnChildren({
  spawn,
  phaseName,
  status,
  board,
  gate,
  opening,
  onReview,
  onOpenGate,
}: {
  spawn: SpawnPill;
  phaseName: string;
  /** The spawn phase's own status. */
  status: DsStatus;
  /** Every row on the board: where each task's child is. */
  board: OverviewRow[];
  /** The spawn phase's own gate, when it has one (a `children` pause). */
  gate: OverviewGate | null;
  /** The spawn phase's review is loading (the opener's transition). */
  opening: boolean;
  /** Open the spawn phase's own review. */
  onReview: (originY: number) => void;
  /** Open a task's child's gate. */
  onOpenGate: (selection: GateSelection) => void;
}) {
  const [waitOpening, start] = useTransition();
  const c = taskCounts(spawn.tasks);
  const childName = childPipelineName(spawn.pipelineId, board);
  // It waits for its children while running or at its `children` pause (a
  // spawn phase is never gated, so waiting is that pause); after it, Review on
  // a failed task would lead to a Revise the server refuses.
  const rows = boardTaskRows(spawn, board, status === "working" || status === "await");
  // The first task whose child waits at a gate the board can open.
  const waiting = rows.find((r) => r.state === "awaiting-approval" && r.gate);
  const waitGate = waiting?.gate;
  const label = `Tasks of phase ${phaseName}`;
  return (
    <section
      data-testid="spawn-children"
      aria-label={label}
      className="flex min-w-0 flex-col gap-3"
    >
      {gate?.children ? (
        <Callout
          testId="spawn-halted"
          action={
            <Button
              data-testid="gate-opener"
              variant="attention"
              iconRight="arrow-right"
              className="ml-[30px] aria-busy:cursor-progress @lg:ml-0"
              aria-busy={opening || undefined}
              onClick={(e) => onReview(e.currentTarget.getBoundingClientRect().top)}
            >
              Review
            </Button>
          }
        >
          {`${c.total - c.succeeded} of ${c.total} tasks did not succeed, so nothing more starts. ` +
            "Review them to accept the rest, re-run them, or stop."}
        </Callout>
      ) : (
        c.waiting > 0 && (
          <Callout
            testId="spawn-waiting"
            action={
              waiting &&
              waitGate && (
                <Button
                  variant="attention"
                  iconRight="arrow-right"
                  className="ml-[30px] aria-busy:cursor-progress @lg:ml-0"
                  aria-busy={waitOpening || undefined}
                  onClick={(e) => {
                    const top = e.currentTarget.getBoundingClientRect().top;
                    start(() => onOpenGate(childSelection(waitGate, waiting.key, childName, top)));
                  }}
                >
                  Review
                </Button>
              )
            }
          >
            {c.waiting === 1
              ? "A task is waiting for you."
              : `${c.waiting} tasks are waiting for you.`}
          </Callout>
        )
      )}
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-0.5">
        <h4 className="eyebrow">Tasks</h4>
        {c.total > 0 && <span className="text-caption text-ink-faint">{countsLine(c)}</span>}
      </div>
      {c.total === 0 ? (
        <p className="px-0.5 text-small text-ink-faint">
          {`Starts one child of “${childName}” per task once the task list is ready.`}
        </p>
      ) : (
        <SpawnTaskList
          rows={rows}
          label={label}
          onReview={(row, top) =>
            row.gate && onOpenGate(childSelection(row.gate, row.key, childName, top))
          }
          onShow={(row) => row.instanceId && showOnBoard(row.instanceId)}
        />
      )}
    </section>
  );
}

/**
 * The first line of a spawned child's section: which task it runs, for which
 * parent, and the way to that parent's section on the board.
 */
export function ParentChip({ parent, board }: { parent: InstanceParentRef; board: OverviewRow[] }) {
  const row = board.find((r) => r.instanceId === parent.instanceId);
  // Every pipeline has a card, so its name is there even when this instance is not.
  const pipeline = row?.name ?? board.find((r) => r.pipelineId === parent.pipelineId)?.name;
  const name = pipeline ?? "its parent";
  const task = row?.phases
    .find((p) => p.id === parent.phaseId)
    ?.spawn?.tasks.find((t) => t.key === parent.key);
  const text = (
    <>
      <Icon name="spawn" size={13} />
      <span className="min-w-0 truncate">{`Task ${parent.key} · ${name}`}</span>
    </>
  );
  return (
    <div className="mb-3 flex min-w-0">
      {row ? (
        <button
          type="button"
          className={buttonClass("ghost", "sm", "max-w-full")}
          title={`Started by “${name}” for task “${parent.key}”${task?.title ? `: ${task.title}` : ""}. Show it on the board.`}
          onClick={() => showOnBoard(parent.instanceId)}
        >
          {text}
        </button>
      ) : (
        <span
          className={`${chipClass()} max-w-full`}
          title={`Started by instance ${parent.instanceId.slice(0, 8)}${pipeline ? ` of “${pipeline}”` : ""} for task “${parent.key}”`}
        >
          {text}
        </span>
      )}
    </div>
  );
}
