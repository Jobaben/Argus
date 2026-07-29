import { AlertStrip, EmptyState, Handoff, Page, SkeletonRows, TimeAgo } from "../ds";
import { useActivity, type Activity } from "../useActivity";

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
        <span className="ml-auto shrink-0">
          <TimeAgo iso={item.ts} />
        </span>
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
    <Page title="Activity" crumbs={[{ label: "Command Center", href: "#/command" }]}>
      <p className="mb-6 text-sm text-ink-faint">Recent prompt history across your projects</p>

      {error && (
        <div className="mb-6">
          <AlertStrip subject="Activity" message={`Couldn't load activity: ${error}`} />
        </div>
      )}

      <Handoff busy={loading} label="activity" skeleton={<SkeletonRows count={6} />}>
        {activity.length === 0 ? (
          <EmptyState>No prompt history found yet.</EmptyState>
        ) : (
          <ol className="flex flex-col gap-3">
            {activity.map((item, i) => (
              <ActivityRow key={`${item.ts}-${i}`} item={item} />
            ))}
          </ol>
        )}
      </Handoff>
    </Page>
  );
}
