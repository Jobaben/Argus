import { useLayoutEffect, useRef, useState } from "react";
import { useMachineFacet } from "../fleet/useMachineFacet";
import { MachinePicker, PeerBanner, PeerEmpty } from "../fleet/MachineFacet";
import {
  AlertStrip,
  Button,
  ButtonLink,
  chipClass,
  EmptyState,
  Handoff,
  HealthCounter,
  Icon,
  Page,
  Skeleton,
  SkeletonRows,
  TimeAgo,
  useFlip,
  type ButtonVariant,
  type IconName,
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

/** StatusPill's anatomy and colours: open is a failure still standing,
 *  resolved is done, ignored is set aside. */
const STATE_BADGE: Record<IssueState, string> = {
  open: "border-fail/35 bg-fail/12 text-fail",
  resolved: "border-ok/25 bg-ok/10 text-ok",
  ignored: "border-line-strong bg-ink-faint/8 text-ink-dim",
};

function StateBadge({ state }: { state: IssueState }) {
  // The word stays lower-case in the DOM — it is the state's own name — and is
  // set in sentence case, like every other status on screen.
  return (
    <span
      className={`inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border pl-2 pr-2.5 text-caption font-semibold capitalize leading-none ${STATE_BADGE[state]}`}
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
      {state}
    </span>
  );
}

type TriageAction = "resolve" | "ignore" | "reopen";

const ACTIONS: Record<
  IssueState,
  { label: string; busy: string; action: TriageAction; variant: ButtonVariant; icon?: IconName }[]
> = {
  open: [
    {
      label: "Resolve",
      busy: "Resolving…",
      action: "resolve",
      variant: "secondary",
      icon: "check",
    },
    { label: "Ignore", busy: "Ignoring…", action: "ignore", variant: "ghost" },
  ],
  resolved: [
    { label: "Reopen", busy: "Reopening…", action: "reopen", variant: "ghost", icon: "retry" },
  ],
  ignored: [
    { label: "Reopen", busy: "Reopening…", action: "reopen", variant: "ghost", icon: "retry" },
  ],
};

function Occurrences({ list }: { list: IssueOccurrence[] }) {
  if (list.length === 0) {
    return (
      <p className="mt-3 rounded-control bg-ground-2/60 px-3 py-2.5 text-caption text-ink-faint">
        No individual runs are on record for this issue any more.
      </p>
    );
  }
  return (
    <ul className="mt-3 divide-y divide-line overflow-hidden rounded-control border border-line bg-ground-2/60">
      {list.map((o) => (
        <li
          key={o.runId}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 pl-3 pr-1.5 text-caption sm:flex-nowrap"
        >
          <span className="shrink-0 sm:w-24">
            <TimeAgo iso={o.at} />
          </span>
          <span
            className="min-w-0 truncate font-semibold text-ink-dim sm:w-44 sm:shrink-0"
            title={o.scheduleName}
          >
            {o.scheduleName}
          </span>
          {/* The raw line, in mono and allowed a second line: merged wordings
              usually differ only at the end — config.yml against config.yaml —
              and a one-line clip on a phone cut off exactly that. */}
          <span
            className="order-last line-clamp-2 min-w-0 basis-full break-words font-mono text-ink-faint sm:order-none sm:basis-auto sm:flex-1"
            title={o.error}
          >
            {o.error}
          </span>
          <ButtonLink
            href={`#/run/${encodeURIComponent(o.runId)}`}
            variant="ghost"
            size="sm"
            icon="replay"
            className="ml-auto"
            title="Replay this run, with its postmortem"
          >
            Replay
          </ButtonLink>
        </li>
      ))}
    </ul>
  );
}

function IssueCard({
  issue,
  onTriage,
  loadOccurrences,
  ref,
}: {
  issue: Issue;
  /** Resolves true once the server has taken the change. */
  onTriage: (fp: string, action: TriageAction) => Promise<boolean>;
  loadOccurrences: (fp: string) => Promise<IssueOccurrence[]>;
  ref?: React.Ref<HTMLDivElement>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [occurrences, setOccurrences] = useState<IssueOccurrence[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [pending, setPending] = useState<TriageAction | null>(null);
  const open = issue.state === "open";

  const toggle = async () => {
    const next = !expanded;
    setExpanded(next);
    if (next && occurrences === null) {
      // Re-opening after a failed load is the retry, so the old failure goes.
      setFailed(null);
      try {
        setOccurrences(await loadOccurrences(issue.fingerprint));
      } catch (e) {
        setFailed(e instanceof Error ? e.message : String(e));
      }
    }
  };

  const actionsRef = useRef<HTMLSpanElement>(null);
  // Set while a triage pressed from a focused button is on its way to
  // changing this issue's state; cleared when it lands or fails.
  const handFocusOn = useRef(false);

  const triage = (action: TriageAction) => {
    if (pending !== null) return;
    handFocusOn.current = actionsRef.current?.contains(document.activeElement) ?? false;
    setPending(action);
    void onTriage(issue.fingerprint, action)
      .then((ok) => {
        if (!ok) handFocusOn.current = false;
      })
      .catch(() => {})
      .finally(() => setPending(null));
  };

  // A triage that lands swaps the buttons — Resolve and Ignore give way to
  // Reopen — and the one that was pressed goes with them, dropping focus to
  // the page. It is handed to this issue's first action instead. Keyed on the
  // state, not on the request settling: the refreshed list can arrive after.
  useLayoutEffect(() => {
    if (!handFocusOn.current) return;
    handFocusOn.current = false;
    const el = document.activeElement;
    if (el == null || el === document.body) {
      actionsRef.current?.querySelector("button")?.focus({ preventScroll: true });
    }
  }, [issue.state]);

  return (
    <div ref={ref} className="px-4 py-3.5 sm:px-5">
      <div className="flex items-start gap-3">
        {/* The error *is* the issue's name, so it is set as a title — in the
            brand face, not as a log line — and it is the disclosure: the
            chevron says it opens, and turns to say it is open. */}
        <button
          type="button"
          onClick={() => void toggle()}
          className="group flex min-w-0 flex-1 items-start gap-2 rounded-sm text-left"
          aria-expanded={expanded}
        >
          <Icon
            name="chevron-right"
            size={16}
            className={`mt-0.5 text-ink-faint transition-transform duration-(--duration-quick) ease-(--ease-out-expo) group-hover:text-ink ${
              expanded ? "rotate-90" : ""
            }`}
          />
          <span
            className={`min-w-0 break-words text-sm font-semibold transition-colors duration-(--duration-quick) group-hover:text-ink ${
              open ? "text-ink" : "text-ink-dim"
            } ${expanded ? "" : "line-clamp-2"}`}
            title={issue.title}
          >
            {issue.title}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          {/* Red only while it is still happening to you: a resolved issue's
              count is history, and a red number on it said otherwise. */}
          <span
            className={`inline-flex h-6 items-center rounded-md px-2 text-caption font-semibold leading-none ${
              open ? "bg-fail/12 text-fail" : "bg-surface-3 text-ink-dim"
            }`}
            title={`${issue.count} failed run${issue.count === 1 ? "" : "s"}`}
          >
            ×{issue.count}
          </span>
          <StateBadge state={issue.state} />
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 pl-6 text-caption text-ink-faint">
        {issue.failureClass && (
          <span className={chipClass("neutral")} title="Autopsy's diagnosis for this issue">
            <Icon name="sparkle" size={12} className="text-ink-faint" />
            {CLASS_LABEL[issue.failureClass]}
          </span>
        )}
        <span className="min-w-0 truncate text-ink-dim" title={issue.schedules.join(", ")}>
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
            className="inline-flex items-center gap-1"
          >
            <Icon name="layers" size={13} />
            {issue.members.length} wordings merged
          </span>
        )}
        {/* Unavailable while a triage is in flight, not `disabled`: disabling
            the button that was just pressed drops keyboard focus to the page. */}
        <span ref={actionsRef} className="ml-auto flex gap-1.5">
          {ACTIONS[issue.state].map(({ label, busy, action, variant, icon }) => (
            <Button
              key={action}
              variant={variant}
              size="sm"
              icon={icon}
              aria-disabled={pending !== null || undefined}
              onClick={() => triage(action)}
            >
              {pending === action ? busy : label}
            </Button>
          ))}
        </span>
      </div>

      {expanded && (
        <div className="pl-6">
          {failed ? (
            <p className="mt-3 flex items-center gap-2 text-caption text-fail-ink">
              <Icon name="alert" size={14} className="text-fail" />
              Couldn't load occurrences: {failed}
            </p>
          ) : (
            <Handoff
              busy={occurrences === null}
              label="occurrences"
              skeleton={
                <div className="mt-3">
                  <SkeletonRows count={2} />
                </div>
              }
            >
              <Occurrences list={occurrences ?? []} />
            </Handoff>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A peer's issues, rendered from its bounded summary.
 *
 * Read-only by construction: triage is a mutation on the machine that owns the
 * issue, and offering the button here would either lie or need a second control
 * plane. The link out is the honest affordance.
 */
function PeerIssues({ facet }: { facet: ReturnType<typeof useMachineFacet> }) {
  const issues = facet.peer?.summary?.facets.issues ?? [];
  if (issues.length === 0) return <PeerEmpty what="open issues" />;
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-tile border border-line bg-surface shadow-raised">
      {issues.map((i) => (
        <li key={i.fingerprint} className="flex flex-wrap items-baseline gap-x-3 px-4 py-3">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink" title={i.title}>
            {i.title}
          </span>
          <span className="shrink-0 text-caption text-ink-faint">
            ×{i.count}
            {i.lastSeen && " · "}
            {i.lastSeen && <TimeAgo iso={i.lastSeen} />}
          </span>
        </li>
      ))}
    </ul>
  );
}

const COUNTER_GRID = "mb-8 grid grid-cols-3 gap-3 md:max-w-xl";

export default function Issues() {
  // Rows come and go and change places as health changes; FLIP glides them
  // there instead of letting the list teleport under the reader.
  const flip = useFlip();
  const facet = useMachineFacet();
  const { issues, summary, loading, error, triage, loadOccurrences } = useIssues();
  const [triageError, setTriageError] = useState<string | null>(null);
  const [filter, setFilter] = useState<IssueState | null>(null);
  const shown = filter === null ? issues : issues.filter((i) => i.state === filter);

  const counters: { state: IssueState; label: string; tone?: "fail" | "ok" }[] = [
    { state: "open", label: "Open", tone: "fail" },
    { state: "ignored", label: "Ignored" },
    { state: "resolved", label: "Resolved", tone: "ok" },
  ];

  const onTriage = async (fp: string, action: TriageAction) => {
    try {
      setTriageError(null);
      await triage(fp, action);
      return true;
    } catch (e) {
      setTriageError(e instanceof Error ? e.message : String(e));
      return false;
    }
  };

  // A failed load with nothing to show is reported once, by the strip: zeroed
  // counters and "No failures on record" under it would be two false claims.
  const nothingLoaded = error != null && issues.length === 0;

  return (
    <Page
      title="Issues"
      subtitle="Failed runs grouped by root cause — twenty timeouts read as one issue, not twenty rows."
    >
      <MachinePicker facet={facet} label="Show issues from" />
      <PeerBanner facet={facet} />

      {facet.peer ? (
        <PeerIssues facet={facet} />
      ) : (
        <>
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

          <Handoff
            busy={loading && issues.length === 0}
            label="issues"
            skeleton={
              <>
                <div aria-hidden="true" className={COUNTER_GRID}>
                  {counters.map(({ state }) => (
                    <div
                      key={state}
                      className="rounded-tile border border-line bg-surface px-4 py-3.5"
                    >
                      <Skeleton className="h-7 w-8" />
                      <Skeleton className="mt-2.5 h-3 w-14" />
                    </div>
                  ))}
                </div>
                <SkeletonRows count={4} />
              </>
            }
          >
            {nothingLoaded ? null : (
              <>
                <section aria-label="Issues by state" className={COUNTER_GRID}>
                  {counters.map(({ state, label, tone }) => (
                    <HealthCounter
                      key={state}
                      label={label}
                      value={summary[state]}
                      tone={tone}
                      selected={filter === state}
                      onClick={
                        summary[state] > 0
                          ? () => setFilter(filter === state ? null : state)
                          : undefined
                      }
                      title={
                        summary[state] > 0
                          ? `Show only the ${label.toLowerCase()} issues`
                          : undefined
                      }
                    />
                  ))}
                </section>

                {filter !== null && (
                  <div className="mb-3 flex items-center gap-2 text-caption text-ink-faint">
                    <span>
                      Showing {shown.length} {filter} of {issues.length}
                    </span>
                    <Button variant="ghost" size="sm" icon="close" onClick={() => setFilter(null)}>
                      Show all
                    </Button>
                  </div>
                )}

                {issues.length === 0 ? (
                  <EmptyState tone="calm" icon="check-circle" title="No failures on record.">
                    When a scheduled run fails, Argus fingerprints its error and groups every
                    recurrence under one issue — so twenty timeouts are one thing to fix, with the
                    first and last sighting and every affected schedule attached.
                  </EmptyState>
                ) : (
                  <div className="divide-y divide-line rounded-tile border border-line bg-surface shadow-raised">
                    {shown.map((i) => (
                      <IssueCard
                        key={i.fingerprint}
                        ref={flip(i.fingerprint)}
                        issue={i}
                        onTriage={onTriage}
                        loadOccurrences={loadOccurrences}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </Handoff>
        </>
      )}
    </Page>
  );
}
