import { useState } from "react";
import {
  AlertStrip,
  Card,
  EmptyState,
  HealthCounter,
  Loading,
  Page,
  SkeletonRows,
  TimeAgo,
} from "../ds";
import { useIssues } from "../useIssues";
import type { FailureClass, Issue, IssueOccurrence, IssueState } from "../types";

/** Autopsy's taxonomy, spelled for humans. */
const CLASS_LABEL: Record<FailureClass, string> = {
  "prompt-ambiguity": "Ambiguous prompt",
  "missing-context": "Missing context",
  "tool-error": "Tool error",
  "permission-denied": "Permission denied",
  environment: "Environment",
  timeout: "Timeout",
  "rate-limit": "Rate limit",
  "model-refusal": "Model declined",
  "bad-output-format": "Bad output format",
  infrastructure: "Infrastructure",
  other: "Unclassified",
};

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
          <span className="min-w-0 flex-1 truncate font-mono text-ink-faint" title={o.error}>
            {o.error}
          </span>
          <a
            href={`#/run/${encodeURIComponent(o.runId)}`}
            className="shrink-0 font-mono text-eye hover:underline"
            title="Replay this run, with its postmortem"
          >
            ▶ replay
          </a>
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
        {issue.failureClass && (
          <span
            className="inline-flex shrink-0 items-center rounded-full border border-await/40 bg-await/12 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-await"
            title="Autopsy's diagnosis for this issue"
          >
            {CLASS_LABEL[issue.failureClass]}
          </span>
        )}
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
        {issue.members.length > 1 && (
          <span
            title="Differently-worded errors judged to be the same problem, merged by Autopsy's failure class plus message overlap"
            className="font-mono text-[10px] uppercase tracking-[0.1em] text-queue"
          >
            {issue.members.length} wordings merged
          </span>
        )}
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
          <Loading label="occurrences">
            <div className="mt-3">
              <SkeletonRows count={2} />
            </div>
          </Loading>
        ) : (
          <Occurrences list={occurrences} />
        ))}
    </Card>
  );
}

export default function Issues() {
  const { issues, summary, loading, error, triage, loadOccurrences } = useIssues();
  const [triageError, setTriageError] = useState<string | null>(null);
  const [filter, setFilter] = useState<IssueState | null>(null);
  const shown = filter === null ? issues : issues.filter((i) => i.state === filter);

  const counters: { state: IssueState; label: string; tone?: "fail" | "live" }[] = [
    { state: "open", label: "Open", tone: summary.open > 0 ? "fail" : undefined },
    { state: "ignored", label: "Ignored" },
    { state: "resolved", label: "Resolved", tone: "live" },
  ];

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
        {counters.map(({ state, label, tone }) => (
          <HealthCounter
            key={state}
            label={label}
            value={summary[state]}
            tone={tone}
            selected={filter === state}
            onClick={
              summary[state] > 0 ? () => setFilter(filter === state ? null : state) : undefined
            }
            title={summary[state] > 0 ? `Show only the ${label.toLowerCase()} issues` : undefined}
          />
        ))}
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

      {filter !== null && (
        <div className="mb-4 flex items-center gap-3 text-xs text-ink-faint">
          <span>
            Showing {shown.length} {filter} of {issues.length}
          </span>
          <button
            type="button"
            onClick={() => setFilter(null)}
            className="text-queue underline hover:text-ink"
          >
            Show all
          </button>
        </div>
      )}

      {loading && issues.length === 0 ? (
        <Loading label="issues">
          <SkeletonRows count={4} />
        </Loading>
      ) : issues.length === 0 ? (
        <EmptyState>
          <p className="text-sm text-ink-dim">No failures on record.</p>
          <p className="mx-auto mt-2 max-w-md text-xs">
            When a scheduled run fails, Argus fingerprints its error and groups every recurrence
            under one issue — so twenty timeouts are one thing to fix, with the first and last
            sighting and every affected schedule attached.
          </p>
        </EmptyState>
      ) : (
        <div className="space-y-4">
          {shown.map((i) => (
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
