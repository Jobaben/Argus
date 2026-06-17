import { useActivity, type Activity } from "../useActivity";

function timeAgo(iso: string): string {
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

function truncate(text: string, max = 240): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

function ActivityRow({ item }: { item: Activity }) {
  return (
    <li className="rounded-xl border border-white/10 bg-white/[0.03] p-4 transition hover:border-white/20 hover:bg-white/[0.05]">
      <div className="flex items-center gap-x-3 text-xs text-white/40">
        {item.project && (
          <span className="font-mono text-sky-300/80" title={item.cwd}>
            {item.project}
          </span>
        )}
        <span className="ml-auto shrink-0">{timeAgo(item.ts)}</span>
      </div>
      <p className="mt-2 whitespace-pre-wrap break-words text-sm text-white/80">
        {truncate(item.text)}
      </p>
    </li>
  );
}

export default function ActivityFeed() {
  const { activity, loading, error } = useActivity();

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <header className="mb-6">
        <h2 className="text-xl font-semibold text-white">Activity</h2>
        <p className="mt-1 text-sm text-white/45">Recent prompt history across your projects</p>
      </header>

      {error && (
        <div className="mb-6 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          Couldn’t load activity: {error}
        </div>
      )}

      {loading ? (
        <p className="text-white/40">Loading activity…</p>
      ) : activity.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/15 px-6 py-16 text-center text-white/40">
          No prompt history found yet.
        </div>
      ) : (
        <ol className="flex flex-col gap-3">
          {activity.map((item, i) => (
            <ActivityRow key={`${item.ts}-${i}`} item={item} />
          ))}
        </ol>
      )}
    </div>
  );
}
