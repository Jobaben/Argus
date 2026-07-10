import { useState } from "react";
import { AlertStrip, Card, EmptyState, HealthCounter, Page, TimeAgo } from "../ds";
import { useIssues } from "../useIssues";
import type { Issue, IssueOccurrence, IssueState } from "../types";

const STATE_BADGE: Record<IssueState, string> = {
  open: "text-fail bg-fail/14",
  resolved: "text-ok bg-ok/12",
  ignored: "text-idle bg-idle/12",
};

function StateBadge({ state }: { state: IssueState }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border border-current px-2.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.12em] ${STATE_BADGE[state]}`}
    >
      {state}
    </span>
  );
}

const ACTIONS: Record<IssueState, { label: string; action: "resolve" | "ignore" | "reopen" }[]> = {
  open: [
    { label: "Resolve", action: "resolve" },
    { label: "Ignore", action: "ignore" },
  ],
  resolved: [{ label: "Reopen", action: "reopen" }],
  ignored: [{ label: "Reopen", action: "reopen" }],
};

function Occurrences({ list }: { list: IssueOccurrence[] }) {
  return (
    <ul className="mt-3 space-y-2 border-t border-line pt-3">
      {list.map((o) => (
        <li key={o.runId} className="flex items-baseline gap-3 text-xs">
          <span className="shrink-0 text-ink-faint">
            <TimeAgo iso={o.at} />
          </span>
          <span className="shrink-0 font-medium text-ink">{o.scheduleName}</span>
          <span className="truncate font-mono text-ink-faint" title={o.error}>
            {o.error}
          </span>
        </li>
      ))}
    </ul>
  );
}

function IssueCard({
  issue,
  onTriage,
  loadOccurrences,
}: {
  issue: Issue;
  onTriage: (fp: string, action: "resolve" | "ignore" | "reopen") => Promise<void>;
  loadOccurrences: (fp: string) => Promise<IssueOccurrence[]>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [occurrences, setOccurrences] = useState<IssueOccurrence[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const toggle = async () => {
    const next = !expanded;
    setExpanded(next);
    if (next && occurrences === null) {
      try {
        setOccurrences(await loadOccurrences(issue.fingerprint));
      } catch (e) {
        setFailed(e instanceof Error ? e.message : String(e));
      }
    }
  };

  return (
    <Card className={issue.state === "open" ? "border-fail/30" : undefined}>
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={() => void toggle()}
          className="min-w-0 flex-1 text-left"
          aria-expanded={expanded}
        >
          <span className="block truncate font-mono text-sm text-ink" title={issue.title}>
            {issue.title}
          </span>
        </button>
        <span className="inline-flex shrink-0 items-center rounded-md bg-fail/12 px-2 py-0.5 font-mono text-xs font-bold text-fail ring-1 ring-fail/20">
          ×{issue.count}
        </span>
        <StateBadge state={issue.state} />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-faint">
        <span className="truncate" title={issue.schedules.join(", ")}>
          {issue.schedules.join(", ")}
        </span>
        <span>
          First seen <TimeAgo iso={issue.firstSeen} />
        </span>
        <span>
          Last seen <TimeAgo iso={issue.lastSeen} />
        </span>
        <span className="ml-auto flex gap-2">
          {ACTIONS[issue.state].map(({ label, action }) => (
            <button
              key={action}
              type="button"
              onClick={() => void onTriage(issue.fingerprint, action).catch(() => {})}
              className="rounded-md border border-line px-2 py-0.5 text-xs text-ink hover:bg-ground-2"
            >
              {label}
            </button>
          ))}
        </span>
      </div>

      {expanded &&
        (failed ? (
          <p className="mt-3 text-xs text-fail">Couldn't load occurrences: {failed}</p>
        ) : occurrences === null ? (
          <p className="mt-3 text-xs text-ink-faint">Loading occurrences…</p>
        ) : (
          <Occurrences list={occurrences} />
        ))}
    </Card>
  );
}

export default function Issues() {
  const { issues, summary, loading, error, triage, loadOccurrences } = useIssues();
  const [triageError, setTriageError] = useState<string | null>(null);

  const onTriage = async (fp: string, action: "resolve" | "ignore" | "reopen") => {
    try {
      setTriageError(null);
      await triage(fp, action);
    } catch (e) {
      setTriageError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Page title="Issues" crumbs={[{ label: "Scheduler", href: "#/schedules" }]}>
      <p className="mb-6 text-sm text-ink-faint">
        Failed runs grouped by root cause — twenty timeouts read as one issue, not twenty rows
      </p>

      <section className="mb-8 grid grid-cols-3 gap-3 sm:max-w-md">
        <HealthCounter label="Open" value={summary.open} tone={summary.open ? "fail" : undefined} />
        <HealthCounter label="Ignored" value={summary.ignored} />
        <HealthCounter label="Resolved" value={summary.resolved} tone="live" />
      </section>

      {error && (
        <div className="mb-6">
          <AlertStrip subject="Issues" message={`Couldn't load issues: ${error}`} />
        </div>
      )}
      {triageError && (
        <div className="mb-6">
          <AlertStrip subject="Triage" message={triageError} />
        </div>
      )}

      {loading ? (
        <p className="text-ink-faint">Loading issues…</p>
      ) : issues.length === 0 ? (
        <EmptyState>No failures on record. When scheduled runs fail, they group here.</EmptyState>
      ) : (
        <div className="space-y-4">
          {issues.map((i) => (
            <IssueCard
              key={i.fingerprint}
              issue={i}
              onTriage={onTriage}
              loadOccurrences={loadOccurrences}
            />
          ))}
        </div>
      )}
    </Page>
  );
}
