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
    <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 transition hover:border-white/20 hover:bg-white/[0.05]">
      <span className="min-w-0 flex-1 truncate font-mono text-sm text-white/80">
        {task.id}
      </span>

      {task.highwatermark !== null && (
        <span className="shrink-0 rounded-full bg-sky-500/15 px-2.5 py-0.5 text-xs font-medium text-sky-300 ring-1 ring-sky-500/30">
          hwm {task.highwatermark}
        </span>
      )}

      <span className="shrink-0 text-xs text-white/45">
        {task.fileCount} {task.fileCount === 1 ? "file" : "files"}
      </span>

      <span
        className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium uppercase tracking-wide ring-1 ${
          task.locked
            ? "bg-amber-500/15 text-amber-300 ring-amber-500/30"
            : "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30"
        }`}
      >
        {task.locked ? "locked" : "open"}
      </span>

      <span className="w-20 shrink-0 text-right text-xs text-white/40">
        {timeAgo(task.updatedAt)}
      </span>
    </div>
  );
}

export default function Tasks() {
  const { tasks, loading, error } = useTasks();

  return (
    <div>
      <header className="mb-6">
        <h2 className="text-2xl font-bold text-white">Tasks</h2>
        <p className="mt-1 text-sm text-white/45">
          Task workspaces under ~/.claude/tasks
        </p>
      </header>

      {error && (
        <div className="mb-6 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          Couldn’t reach the Argus server: {error}
        </div>
      )}

      {loading ? (
        <p className="text-white/40">Loading tasks…</p>
      ) : tasks.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/15 px-6 py-16 text-center text-white/40">
          No task directories found yet.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {tasks.map((t) => (
            <TaskRow key={t.id} task={t} />
          ))}
        </div>
      )}
    </div>
  );
}
