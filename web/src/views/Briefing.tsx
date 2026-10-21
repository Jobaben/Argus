import { useState, type ReactNode } from "react";
import {
  AlertStrip,
  Button,
  ButtonLink,
  buttonClass,
  chipClass,
  EmptyState,
  formatTokens,
  formatUsd,
  Handoff,
  Icon,
  Page,
  Section,
  SkeletonGrid,
  SkeletonText,
  StatusPill,
  TimeAgo,
  useSyncedDelay,
  DURATION,
  type DsStatus,
  type IconName,
} from "../ds";
import type { Briefing as BriefingData, InstanceStatus, RunStatus } from "../types";
import { ATTENTION_KINDS, attentionHref } from "./attentionKinds";
import { firstProseLine } from "./outcome";
import { sentenceStart } from "./text";
import { loadError } from "../live/loadError";

type AttentionItem = BriefingData["attention"][number];

/** The pill's colours, in StatusPill's anatomy. */
const TONE_PILL = {
  fail: "border-fail/35 bg-fail/12 text-fail",
  await: "border-await/40 bg-await/12 text-await",
} as const;

/**
 * Status colours for the window's run tallies. The dot carries the colour and
 * the number stays in ink: a row of coloured numerals is a row of claims, and
 * the claim worth making — "3 failed" — is already made by the Failures list.
 */
const STATUS_ORDER: { key: RunStatus; label: string; dot: string }[] = [
  { key: "succeeded", label: "Succeeded", dot: "bg-ok" },
  { key: "failed", label: "Failed", dot: "bg-fail" },
  { key: "interrupted", label: "Interrupted", dot: "bg-fail/60" },
  { key: "running", label: "Still running", dot: "bg-run" },
  { key: "cancelled", label: "Cancelled", dot: "bg-idle" },
  { key: "skipped", label: "Skipped", dot: "bg-idle/60" },
];

/**
 * The window's tallies, counted the way the Failures list below counts them.
 *
 * `byStatus` is the exit status, and a run can exit 0 and still report a failed
 * (or blocked) outcome. The Failures list, Issues and Chronicle all call that a
 * failure, so the strip did too little: "3 failed" sat right above a list of
 * four. Each such run moves from the bucket it exited in to Failed. The list is
 * capped, so past its cap this can undercount, never overcount.
 */
function windowTally(win: BriefingData["window"]): Record<RunStatus, number> {
  const counts = { ...win.byStatus };
  for (const r of win.failures) {
    if (r.status === "failed" || r.status === "interrupted" || r.status === "running") continue;
    if (counts[r.status] > 0) {
      counts[r.status] -= 1;
      counts.failed += 1;
    }
  }
  return counts;
}

/** A finished pipeline's status in the shared vocabulary, so a pipeline that
 *  was stopped reads as stopped, not as a failure. */
const INSTANCE_STATUS: Record<InstanceStatus, DsStatus> = {
  succeeded: "done",
  failed: "failed",
  aborted: "stopped",
  running: "working",
  "awaiting-approval": "await",
};

/** Where a failed run's row goes: its transcript when it has one, else Issues. */
function failureHref(run: BriefingData["window"]["failures"][number]): string {
  return run.sessionId && run.project
    ? `#/sessions/${encodeURIComponent(run.project)}/${encodeURIComponent(run.sessionId)}`
    : "#/issues";
}

type FailedRun = BriefingData["window"]["failures"][number];

/**
 * Failures that are the same thing happening again — one schedule, one reason
 * — as one row with a count. Three identical "Dependency audit · exit code 1"
 * rows said nothing the first one had not; the count is the news. The newest
 * run leads each group (the list arrives newest first), so its row opens the
 * most recent transcript.
 */
function groupFailures(
  runs: FailedRun[],
): { run: FailedRun; count: number; reason: string | null; summary: string | null }[] {
  const groups = new Map<
    string,
    { run: FailedRun; count: number; reason: string | null; summary: string | null }
  >();
  for (const r of runs) {
    // The first human line of each, without the agent's `ARGUS_OUTCOME` line
    // (or with that line's reason, when the marker is all there is).
    const reason = firstProseLine(r.error) || null;
    const summary = firstProseLine(r.resultSummary) || null;
    const key = [r.scheduleName, reason ?? "", summary ?? ""].join("\u0000");
    const g = groups.get(key);
    if (g) g.count += 1;
    else groups.set(key, { run: r, count: 1, reason, summary });
  }
  return [...groups.values()];
}

/** A count of runs, as a quantity rather than a status: neutral, like the
 *  number it is. */
function RunCount({ n }: { n: number }) {
  return (
    <span className={chipClass("neutral")} title={`${n} failed run${n === 1 ? "" : "s"}`}>
      ×{n}
    </span>
  );
}

/**
 * A card's detail as a line of its own. The server writes it as a clause
 * (`phase "Open the PR" needs approval`), so it gets a capital and the
 * typographic quotes every other line on the page uses.
 */
function cardDetail(detail: string): string {
  return sentenceStart(detail.replace(/"([^"]*)"/g, "“$1”"));
}

function AttentionCard({ item }: { item: AttentionItem }) {
  const meta = ATTENTION_KINDS[item.kind];
  // An issue's title is its signature ("exit code 1"), capitalised as #/issues
  // shows it. The other kinds' titles are names, kept as their owners typed them.
  const title = item.kind === "issue-open" ? sentenceStart(item.title) : item.title;
  const detail = cardDetail(item.detail);
  const beat = useSyncedDelay(DURATION.pulse);
  // Only a gate is *happening* — someone's pipeline is paused on you right now
  // — so only its dot breathes, in phase with every other waiting dot on screen.
  const breathing = item.kind === "gate-waiting";
  const hero = meta.rank === 0;
  return (
    <a
      href={attentionHref(item)}
      className="group block rounded-tile focus-visible:outline-offset-2"
    >
      {/* Border follows the kind's own tone rather than a special case for
          gates: there are two violet kinds, and a `kind === "gate-waiting"`
          test would draw one of them red. The kinds that get worse while
          nobody looks are tinted as well as outlined. */}
      {/* A tinted card deepens its own tint on hover: lifting it to neutral
          grey would drop the status colour just as the pointer arrives. */}
      <div
        className={`relative flex h-full gap-3.5 overflow-hidden rounded-tile border p-4 shadow-raised transition-colors duration-(--duration-quick) ${
          meta.tone === "await"
            ? hero
              ? "border-await/50 bg-await/6 group-hover:border-await/70 group-hover:bg-await/10"
              : "border-await/30 bg-surface group-hover:border-await/50 group-hover:bg-surface-2"
            : hero
              ? "border-fail/45 bg-fail/6 group-hover:border-fail/65 group-hover:bg-fail/10"
              : "border-fail/25 bg-surface group-hover:border-fail/45 group-hover:bg-surface-2"
        }`}
      >
        <span
          aria-hidden="true"
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-control ${
            meta.tone === "await" ? "bg-await/12 text-await" : "bg-fail/12 text-fail"
          }`}
        >
          <Icon name={meta.icon} size={18} />
        </span>
        <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <span
                className={`inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border pl-2 pr-2.5 text-caption font-semibold leading-none ${TONE_PILL[meta.tone]}`}
              >
                <span
                  aria-hidden="true"
                  style={breathing ? { animationDelay: beat } : undefined}
                  className={`h-1.5 w-1.5 shrink-0 rounded-full bg-current ${
                    breathing ? "animate-[pulse_var(--duration-pulse)_ease-in-out_infinite]" : ""
                  }`}
                />
                {meta.label}
              </span>
              {item.at && (
                <span className="text-caption">
                  <TimeAgo iso={item.at} />
                </span>
              )}
            </div>
            <p
              className="mt-2 line-clamp-2 break-words text-heading font-semibold text-ink"
              title={title}
            >
              {title}
            </p>
            {/* Two lines, as on the rows below: the detail is the reason, and
                one line cut it to a few words on a phone. */}
            <p className="mt-0.5 line-clamp-2 break-words text-small text-ink-dim" title={detail}>
              {detail}
            </p>
          </div>
          {/* Not a second control: the whole card is the link. This is where
              it says what clicking does — loudest on the one kind a person is
              actively blocking. */}
          <span
            className={
              item.kind === "gate-waiting"
                ? buttonClass("attention", "sm", "justify-self-start pr-1.5")
                : `inline-flex items-center gap-1 justify-self-start text-small font-semibold transition-colors duration-(--duration-quick) group-hover:text-ink ${
                    meta.tone === "await" ? "text-await-ink" : "text-ink-dim"
                  }`
            }
          >
            {meta.verb}
            <Icon
              name="chevron-right"
              size={15}
              className="transition-transform duration-(--duration-quick) ease-(--ease-out-expo) group-hover:translate-x-0.5"
            />
          </span>
        </div>
      </div>
    </a>
  );
}

/** A count beside a section heading. Violet only when it is a call to act. */
function CountBadge({ n, tone = "neutral" }: { n: number; tone?: "neutral" | "await" }) {
  return (
    <span
      className={`ml-2 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 align-[1px] text-micro font-semibold normal-case tracking-normal ${
        tone === "await" && n > 0 ? "bg-await/15 text-await" : "bg-surface-3 text-ink-dim"
      }`}
    >
      {n}
    </span>
  );
}

/** One panel of rows, each a link to the thing it describes. */
function RowPanel({ children }: { children: ReactNode }) {
  return (
    <div className="divide-y divide-line overflow-hidden rounded-tile border border-line bg-surface shadow-raised">
      {children}
    </div>
  );
}

function Row({
  href,
  icon,
  iconClass,
  title,
  badge,
  detail,
  trailing,
}: {
  href: string;
  icon: IconName;
  iconClass: string;
  title: ReactNode;
  /** A status set right after the title, where it reads as part of the name. */
  badge?: ReactNode;
  detail?: ReactNode;
  /** Right-aligned metadata before the chevron — a time, a count, a status. */
  trailing?: ReactNode;
}) {
  return (
    <a
      href={href}
      className="group flex items-center gap-3 px-4 py-3 transition-colors duration-(--duration-quick) hover:bg-surface-2/60 focus-visible:-outline-offset-2"
    >
      <Icon name={icon} size={16} className={`mt-0.5 self-start ${iconClass}`} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-3">
          {/* Two lines before it clips: on a phone the status and the time
              leave a name a dozen characters, and one line cut most names. */}
          <span className="flex min-w-0 flex-1 items-start gap-2">
            <span className="line-clamp-2 min-w-0 break-words text-small font-semibold text-ink">
              {title}
            </span>
            {badge}
          </span>
          {trailing && (
            <span className="flex shrink-0 items-center gap-2 text-caption text-ink-faint">
              {trailing}
            </span>
          )}
        </div>
        {/* Two lines, not one: the detail is usually the reason, the one part
            of a failure row worth reading, and a phone cut it to a few words. */}
        {detail && (
          <div className="mt-0.5 line-clamp-2 break-words text-caption text-ink-dim">{detail}</div>
        )}
      </div>
      <Icon
        name="chevron-right"
        size={16}
        className="text-ink-faint transition duration-(--duration-quick) group-hover:translate-x-0.5 group-hover:text-ink-dim"
      />
    </a>
  );
}

/**
 * The window's runs as one instrument: what the window was (since when, how
 * many runs, what they cost), then the split as tallies and a bar. The numbers
 * sit here, under "While you were away", rather than in the page subtitle,
 * which keeps saying what the page is for.
 */
function WindowStrip({ since, win }: { since: string; win: BriefingData["window"] }) {
  const counts = windowTally(win);
  const parts = STATUS_ORDER.filter(({ key }) => counts[key] > 0);
  const summary = (
    <p className="text-small text-ink-dim">
      Since <TimeAgo iso={since} /> — <b className="font-semibold text-ink">{win.totalRuns}</b> run
      {win.totalRuns === 1 ? "" : "s"}
      {win.tokens > 0 && (
        <>
          {" "}
          · <b className="font-semibold text-ink">{formatTokens(win.tokens)}</b> tokens
        </>
      )}
      {win.costUsd > 0 && (
        <>
          {" "}
          · <b className="font-semibold text-ink">{formatUsd(win.costUsd)}</b> spent
        </>
      )}
    </p>
  );
  if (win.totalRuns === 0 || parts.length === 0) {
    return (
      <div className="rounded-tile border border-line bg-surface px-4 py-3.5 text-small text-ink-dim shadow-raised">
        Nothing ran since <TimeAgo iso={since} />.
      </div>
    );
  }
  return (
    <div className="rounded-tile border border-line bg-surface px-4 py-4 shadow-raised sm:px-5">
      {summary}
      <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-8">
        <div className="flex flex-wrap gap-x-8 gap-y-3">
          {parts.map(({ key, label, dot }) => (
            <div key={key} className="min-w-0">
              <div className="text-title font-semibold leading-none text-ink">{counts[key]}</div>
              <div className="mt-1.5 flex items-center gap-1.5 text-caption text-ink-dim">
                <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
                {label}
              </div>
            </div>
          ))}
        </div>
        <div
          aria-hidden="true"
          className="flex h-2 w-full min-w-0 gap-0.5 overflow-hidden rounded-full bg-ground-2 sm:w-auto sm:flex-1"
        >
          {parts.map(({ key, label, dot }) => (
            <span
              key={key}
              title={`${counts[key]} ${label.toLowerCase()}`}
              className={`h-full first:rounded-l-full last:rounded-r-full ${dot}`}
              style={{ width: `${(counts[key] / win.totalRuns) * 100}%` }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * The server's window when nobody has ever marked caught up. The briefing
 * carries no lifetime count, so "never caught up, and nothing in the default
 * window" is the nearest honest reading of a first visit: an empty install, or
 * one nobody has briefed from yet. Either way there is nothing to be caught up
 * *on*, and "All caught up" would be good news nobody has earned. Once the
 * window has been reset it starts at the reset, and a quiet one is calm again.
 */
const DEFAULT_WINDOW_MS = 24 * 3_600_000;

function isFirstVisit(b: BriefingData): boolean {
  return (
    b.attentionCount === 0 &&
    b.window.totalRuns === 0 &&
    Date.parse(b.generatedAt) - Date.parse(b.since) === DEFAULT_WINDOW_MS
  );
}

export default function Briefing({
  briefing,
  loading,
  error,
  ack,
  refresh,
}: {
  briefing: BriefingData | null;
  loading: boolean;
  error: string | null;
  ack: () => Promise<void>;
  /** Refetches the briefing; when given, a failed load offers Retry. */
  refresh?: () => void;
}) {
  const [acking, setAcking] = useState(false);
  const [ackError, setAckError] = useState<string | null>(null);
  const firstVisit = briefing != null && isFirstVisit(briefing);
  const calm = briefing != null && briefing.attentionCount === 0 && briefing.window.totalRuns === 0;
  // Unavailable rather than `disabled`: a disabled button drops keyboard focus
  // to the page the moment it is pressed. And there is nothing to mark read
  // until a briefing has loaded — acking a window nobody saw would reset it.
  const ackUnavailable = acking || briefing == null;
  const onAck = () => {
    if (ackUnavailable) return;
    setAcking(true);
    setAckError(null);
    void ack()
      .catch((e: unknown) => setAckError(e instanceof Error ? e.message : String(e)))
      .finally(() => setAcking(false));
  };

  // Sorted here, not trusted from the server's concatenation order: the order
  // is the page's argument about what to do first, so it is stated in the view.
  // A kind this build has no card for (a newer server, a tab left open across
  // an upgrade) is dropped rather than drawn from an undefined entry.
  const attention =
    briefing == null
      ? []
      : briefing.attention
          .filter((a) => a.kind in ATTENTION_KINDS)
          .sort((a, b) => ATTENTION_KINDS[a.kind].rank - ATTENTION_KINDS[b.kind].rank);

  const win = briefing?.window;
  const windowSections: { key: string; node: ReactNode }[] = [];
  if (win && win.failures.length > 0) {
    windowSections.push({
      key: "failures",
      node: (
        <Section
          title={
            <>
              Failures
              <CountBadge n={win.failures.length} />
            </>
          }
        >
          <RowPanel>
            {/* Every other row on this page is a link to the thing it
                describes; these were not, which made the most actionable list
                here the only dead one. A failed run's transcript is where you
                find out why, so that is the destination when there is one;
                Issues, which groups it, is the fallback. */}
            {groupFailures(win.failures).map(({ run: r, count, reason, summary }) => {
              const when = r.endedAt ?? r.startedAt;
              return (
                <Row
                  key={r.id}
                  href={failureHref(r)}
                  icon="x-circle"
                  iconClass="text-fail"
                  title={r.scheduleName}
                  badge={count > 1 ? <RunCount n={count} /> : undefined}
                  trailing={when ? <TimeAgo iso={when} /> : undefined}
                  detail={
                    <span title={[reason, summary].filter(Boolean).join("\n") || undefined}>
                      {reason ?? summary ?? "failed"}
                      {reason && summary && summary !== reason && (
                        <span className="text-ink-faint"> · {summary}</span>
                      )}
                    </span>
                  }
                />
              );
            })}
          </RowPanel>
        </Section>
      ),
    });
  }
  // An issue that is still open is already a card under "Needs your
  // attention"; listing it again here would only repeat it. The section keeps
  // the new issues that are not up there, and goes when there are none.
  const onCards = new Set(attention.filter((a) => a.kind === "issue-open").map((a) => a.id));
  const newIssues = win ? win.newIssues.filter((i) => !onCards.has(i.fingerprint)) : [];
  if (newIssues.length > 0) {
    windowSections.push({
      key: "issues",
      node: (
        <Section
          title={
            <>
              New issues
              <CountBadge n={newIssues.length} />
            </>
          }
        >
          <RowPanel>
            {newIssues.map((i) => (
              <Row
                key={i.fingerprint}
                href="#/issues"
                icon="layers"
                iconClass={i.state === "open" ? "text-fail" : "text-ink-faint"}
                title={<span title={sentenceStart(i.title)}>{sentenceStart(i.title)}</span>}
                // A count only when it is news, as on Failures: "×1" said nothing.
                trailing={i.count > 1 ? <RunCount n={i.count} /> : undefined}
                detail={
                  <>
                    {i.schedules.join(", ")}
                    <span className="text-ink-faint">
                      {" "}
                      · first seen <TimeAgo iso={i.firstSeen} />
                    </span>
                  </>
                }
              />
            ))}
          </RowPanel>
        </Section>
      ),
    });
  }
  // A critical anomaly is a card up there too; the same rule as for issues.
  const anomalyCards = new Set(attention.filter((a) => a.kind === "anomaly").map((a) => a.id));
  const anomalies = win ? win.anomalies.filter((a) => !anomalyCards.has(a.id)) : [];
  if (anomalies.length > 0) {
    windowSections.push({
      key: "anomalies",
      node: (
        <Section
          title="Ran, but not the way it usually runs"
          action={
            <ButtonLink
              href="#/health/watchtower"
              variant="ghost"
              size="sm"
              iconRight="arrow-right"
              className="-my-0.5"
            >
              Watchtower
            </ButtonLink>
          }
        >
          <RowPanel>
            {anomalies.map((a) => (
              <Row
                key={a.id}
                href={`#/run/${encodeURIComponent(a.runId)}`}
                icon={a.direction === "low" ? "arrow-down" : "arrow-up"}
                iconClass={a.severity === "critical" ? "text-fail" : "text-ink-faint"}
                title={a.name}
                trailing={<TimeAgo iso={a.at} />}
                detail={a.detail}
              />
            ))}
          </RowPanel>
        </Section>
      ),
    });
  }
  if (win && win.finishedPipelines.length > 0) {
    windowSections.push({
      key: "pipelines",
      node: (
        <Section
          title={
            <>
              Pipelines finished
              <CountBadge n={win.finishedPipelines.length} />
            </>
          }
        >
          <RowPanel>
            {win.finishedPipelines.map((p) => (
              <Row
                key={p.id}
                href="#/pipelines"
                icon="pipeline"
                iconClass="text-ink-faint"
                title={p.pipelineName}
                badge={<StatusPill status={INSTANCE_STATUS[p.status] ?? "idle"} size="sm" />}
                trailing={p.endedAt ? <TimeAgo iso={p.endedAt} /> : undefined}
              />
            ))}
          </RowPanel>
        </Section>
      ),
    });
  }

  return (
    <Page
      title="Briefing"
      subtitle="What needs you now, and what ran while you were away."
      actions={
        // Nothing to mark read on a first visit: the window is empty and the
        // button would only move its start.
        firstVisit ? undefined : (
          <Button
            icon="check"
            onClick={onAck}
            aria-disabled={ackUnavailable || undefined}
            aria-busy={acking || undefined}
          >
            Mark caught up
          </Button>
        )
      }
    >
      {error && (
        <div className="mb-6">
          <AlertStrip
            subject="Briefing"
            message={loadError("the briefing", error)}
            action={
              refresh && (
                <Button size="sm" icon="retry" onClick={() => refresh()}>
                  Retry
                </Button>
              )
            }
          />
        </div>
      )}
      {ackError && (
        <div className="mb-6">
          <AlertStrip
            subject="Mark caught up"
            message={`The window was not reset: ${ackError}`}
            role="alert"
          />
        </div>
      )}

      <Handoff
        busy={loading && briefing == null}
        label="your briefing"
        skeleton={
          <>
            <SkeletonText lines={1} className="mb-4 max-w-40" />
            <SkeletonGrid count={4} columns={2} lines={2} />
          </>
        }
      >
        {briefing == null ? null : firstVisit ? (
          <EmptyState
            icon="inbox"
            title="Nothing to brief yet"
            action={
              <>
                <ButtonLink href="#/schedules/oneoff" icon="bolt">
                  Launch a task
                </ButtonLink>
                <ButtonLink href="#/schedules" variant="primary" icon="plus">
                  Create a schedule
                </ButtonLink>
              </>
            }
          >
            The briefing fills in once schedules or pipelines run: what needs you first, then what
            ran while you were away and what it cost.
          </EmptyState>
        ) : calm ? (
          <EmptyState
            tone="calm"
            icon="check-circle"
            title="All caught up"
            action={
              <ButtonLink href="#/command" iconRight="arrow-right">
                Command Center
              </ButtonLink>
            }
          >
            Nothing needs your attention, and nothing ran since <TimeAgo iso={briefing.since} />.
          </EmptyState>
        ) : (
          <>
            <Section
              title={
                <>
                  Needs your attention
                  <CountBadge n={briefing.attentionCount} tone="await" />
                </>
              }
            >
              {attention.length === 0 ? (
                <EmptyState
                  compact
                  tone="calm"
                  icon="check-circle"
                  title="Nothing needs you right now"
                >
                  Gates waiting on you, monitors that stop reporting and open issues land here until
                  they are dealt with.
                </EmptyState>
              ) : (
                <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                  {attention.map((a) => (
                    <AttentionCard key={`${a.kind}:${a.id}`} item={a} />
                  ))}
                </div>
              )}
            </Section>

            <Section
              title="While you were away"
              action={
                <ButtonLink
                  href="#/chronicle"
                  variant="ghost"
                  size="sm"
                  iconRight="arrow-right"
                  className="-my-0.5"
                >
                  Timeline
                </ButtonLink>
              }
            >
              <WindowStrip since={briefing.since} win={briefing.window} />
              {/* Said here, under the window it resets, rather than in a tip
                  beside the button: on a phone the actions wrap to the left
                  edge and a tip anchored to them opened off the screen. */}
              <p className="mt-2.5 text-caption text-ink-faint">
                Mark caught up starts a fresh window from now. What needs your attention stays until
                it's resolved.
              </p>
            </Section>

            {/* Two columns that flow, not a grid of rows: the sections differ
                a lot in length, and rows paired a four-item list with a
                two-item one and left the last section beside nothing. */}
            {windowSections.length > 0 && (
              <div className={windowSections.length > 1 ? "gap-x-6 xl:columns-2" : undefined}>
                {windowSections.map((s) => (
                  <div key={s.key} className="min-w-0 break-inside-avoid">
                    {s.node}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </Handoff>
    </Page>
  );
}
