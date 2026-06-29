import { AlertStrip, EmptyState } from "../ds";
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
    <li className="rounded-xl border border-line bg-surface p-4 transition hover:border-ink-faint/40">
      <div className="flex items-center gap-x-3 text-xs text-ink-faint">
        {item.project && (
          <span className="font-mono text-ink-faint" title={item.cwd}>
            {item.project}
          </span>
        )}
        <span className="ml-auto shrink-0">{timeAgo(item.ts)}</span>
      </div>
      <p className="mt-2 whitespace-pre-wrap break-words text-sm text-ink-dim">
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
        <h2 className="text-xl font-semibold text-ink">Activity</h2>
        <p className="mt-1 text-sm text-ink-faint">Recent prompt history across your projects</p>
      </header>

      {error && (
        <div className="mb-6">
          <AlertStrip subject="Activity" message={`Couldn't load activity: ${error}`} />
        </div>
      )}

      {loading ? (
        <p className="text-ink-faint">Loading activity…</p>
      ) : activity.length === 0 ? (
        <EmptyState>No prompt history found yet.</EmptyState>
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
