import { AlertStrip, EmptyState, Page } from "../ds";
import { useTasks, type Task } from "../useTasks";

function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function TaskRow({ task }: { task: Task }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 transition hover:border-ink-faint/40">
      <span className="min-w-0 flex-1 truncate font-mono text-sm text-ink-dim">
        {task.id}
      </span>

      {task.highwatermark !== null && (
        <span className="shrink-0 rounded-full bg-queue/12 px-2.5 py-0.5 text-xs font-medium text-queue ring-1 ring-queue/30">
          hwm {task.highwatermark}
        </span>
      )}

      <span className="shrink-0 text-xs text-ink-faint">
        {task.fileCount} {task.fileCount === 1 ? "file" : "files"}
      </span>

      <span
        className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium uppercase tracking-wide ring-1 ${
          task.locked
            ? "bg-fail/14 text-fail ring-fail/30"
            : "bg-ok/12 text-ok ring-ok/30"
        }`}
      >
        {task.locked ? "locked" : "open"}
      </span>

      <span className="w-20 shrink-0 text-right text-xs text-ink-faint">
        {timeAgo(task.updatedAt)}
      </span>
    </div>
  );
}

export default function Tasks() {
  const { tasks, loading, error } = useTasks();

  return (
    <Page title="Tasks">
      <p className="mb-6 text-sm text-ink-faint">Task workspaces under ~/.claude/tasks</p>

      {error && (
        <div className="mb-6">
          <AlertStrip subject="Tasks" message={`Couldn't reach the Argus server: ${error}`} />
        </div>
      )}

      {loading ? (
        <p className="text-ink-faint">Loading tasks…</p>
      ) : tasks.length === 0 ? (
        <EmptyState>No task directories found yet.</EmptyState>
      ) : (
        <div className="flex flex-col gap-2">
          {tasks.map((t) => (
            <TaskRow key={t.id} task={t} />
          ))}
        </div>
      )}
    </Page>
  );
}
