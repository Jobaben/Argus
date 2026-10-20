import { useState, type ReactNode } from "react";
import {
  AlertStrip,
  Button,
  ButtonLink,
  buttonClass,
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
import type { AttentionKind, Briefing as BriefingData, InstanceStatus, RunStatus } from "../types";

type AttentionItem = BriefingData["attention"][number];

/**
 * Where each attention kind sends the user to act on it, and what acting is
 * called. The verb is on the card because a card that only names a problem
 * leaves the reader to work out what to do about it; "Review gate" is the
 * next step, said once, where the eye already is.
 *
 * `rank` is the order the cards are read in. Something blocked on a person (a
 * gate) or silently not running (a monitor that is down) comes before
 * something that ran and went wrong: the first two get worse every minute
 * nobody looks, the rest will still be there.
 */
const KIND_META: Record<
  AttentionKind,
  {
    href: string;
    label: string;
    tone: "fail" | "await";
    verb: string;
    icon: IconName;
    rank: number;
  }
> = {
  "gate-waiting": {
    href: "#/command",
    label: "Awaiting approval",
    tone: "await",
    verb: "Review gate",
    icon: "approve",
    rank: 0,
  },
  "monitor-down": {
    href: "#/health",
    label: "Monitor down",
    tone: "fail",
    verb: "Open monitor",
    icon: "activity",
    rank: 0,
  },
  "monitor-failing": {
    href: "#/health",
    label: "Monitor failing",
    tone: "fail",
    verb: "Open monitor",
    icon: "x-circle",
    rank: 1,
  },
  anomaly: {
    href: "#/health/watchtower",
    label: "Anomaly",
    tone: "await",
    verb: "Inspect run",
    icon: "bolt",
    rank: 2,
  },
  "issue-open": {
    href: "#/issues",
    label: "Open issue",
    tone: "fail",
    verb: "Triage issue",
    icon: "layers",
    rank: 3,
  },
};

/**
 * A gate is acted on in the Command Center's review drawer and nowhere else —
 * the Pipelines page can only stop an instance — so the card deep-links to the
 * drawer for *this* instance, the same link the palette and `argus tail` use.
 *
 * An anomaly's id is `<key>|<metric>|<runId>` by contract, so its card can open
 * the run it is about ("Inspect run") instead of the Watchtower list, which is
 * kept as the fallback for an id that does not have that shape.
 */
function attentionHref(item: AttentionItem): string {
  if (item.kind === "gate-waiting") return `#/command/${encodeURIComponent(item.id)}`;
  if (item.kind === "anomaly") {
    const parts = item.id.split("|");
    const runId = parts.length >= 3 ? parts[parts.length - 1] : "";
    if (runId) return `#/run/${encodeURIComponent(runId)}`;
  }
  return KIND_META[item.kind].href;
}

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

function firstLine(s: string | null | undefined): string | null {
  const line = s?.split("\n")[0]?.trim();
  return line ? line : null;
}

function AttentionCard({ item }: { item: AttentionItem }) {
  const meta = KIND_META[item.kind];
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
              title={item.title}
            >
              {item.title}
            </p>
            <p className="mt-0.5 truncate text-small text-ink-dim" title={item.detail}>
              {item.detail}
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
        {detail && <div className="mt-0.5 truncate text-caption text-ink-dim">{detail}</div>}
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
 * The window's runs as one instrument: the split as a bar, then the tallies.
 * The total is not repeated here — it is in the line under the page title,
 * beside the spend it produced.
 */
function WindowStrip({ win }: { win: BriefingData["window"] }) {
  const parts = STATUS_ORDER.filter(({ key }) => win.byStatus[key] > 0);
  if (win.totalRuns === 0 || parts.length === 0) {
    return (
      <div className="rounded-tile border border-line bg-surface px-4 py-3.5 text-small text-ink-dim shadow-raised">
        Nothing ran in this window.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4 rounded-tile border border-line bg-surface px-4 py-4 shadow-raised sm:flex-row sm:items-center sm:gap-8 sm:px-5">
      <div className="flex flex-wrap gap-x-8 gap-y-3">
        {parts.map(({ key, label, dot }) => (
          <div key={key} className="min-w-0">
            <div className="text-title font-semibold leading-none text-ink">
              {win.byStatus[key]}
            </div>
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
            title={`${win.byStatus[key]} ${label.toLowerCase()}`}
            className={`h-full first:rounded-l-full last:rounded-r-full ${dot}`}
            style={{ width: `${(win.byStatus[key] / win.totalRuns) * 100}%` }}
          />
        ))}
      </div>
    </div>
  );
}

export default function Briefing({
  briefing,
  loading,
  error,
  ack,
}: {
  briefing: BriefingData | null;
  loading: boolean;
  error: string | null;
  ack: () => Promise<void>;
}) {
  const [acking, setAcking] = useState(false);
  const calm = briefing != null && briefing.attentionCount === 0 && briefing.window.totalRuns === 0;
  // Unavailable rather than `disabled`: a disabled button drops keyboard focus
  // to the page the moment it is pressed. And there is nothing to mark read
  // until a briefing has loaded — acking a window nobody saw would reset it.
  const ackUnavailable = acking || briefing == null;
  const onAck = () => {
    if (ackUnavailable) return;
    setAcking(true);
    void ack()
      .catch(() => {})
      .finally(() => setAcking(false));
  };

  // Sorted here, not trusted from the server's concatenation order: the order
  // is the page's argument about what to do first, so it is stated in the view.
  const attention =
    briefing == null
      ? []
      : [...briefing.attention].sort((a, b) => KIND_META[a.kind].rank - KIND_META[b.kind].rank);

  const subtitle =
    briefing == null ? (
      "What needs you now, and what ran while you were away."
    ) : (
      <>
        Since <TimeAgo iso={briefing.since} /> —{" "}
        <b className="font-semibold text-ink">{briefing.window.totalRuns}</b> run
        {briefing.window.totalRuns === 1 ? "" : "s"}
        {briefing.window.tokens > 0 && (
          <>
            {" "}
            · <b className="font-semibold text-ink">{formatTokens(briefing.window.tokens)}</b>{" "}
            tokens
          </>
        )}
        {briefing.window.costUsd > 0 && (
          <>
            {" "}
            · <b className="font-semibold text-ink">{formatUsd(briefing.window.costUsd)}</b> spent
          </>
        )}
      </>
    );

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
            {win.failures.map((r) => {
              const reason = firstLine(r.error);
              const summary = firstLine(r.resultSummary);
              const when = r.endedAt ?? r.startedAt;
              return (
                <Row
                  key={r.id}
                  href={failureHref(r)}
                  icon="x-circle"
                  iconClass="text-fail"
                  title={r.scheduleName}
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
  if (win && win.newIssues.length > 0) {
    windowSections.push({
      key: "issues",
      node: (
        <Section
          title={
            <>
              New issues
              <CountBadge n={win.newIssues.length} />
            </>
          }
        >
          <RowPanel>
            {win.newIssues.map((i) => (
              <Row
                key={i.fingerprint}
                href="#/issues"
                icon="layers"
                iconClass={i.state === "open" ? "text-fail" : "text-ink-faint"}
                title={<span title={i.title}>{i.title}</span>}
                trailing={
                  <span
                    className={`rounded-md px-1.5 py-px text-caption font-semibold ${
                      i.state === "open" ? "bg-fail/12 text-fail" : "bg-surface-3 text-ink-dim"
                    }`}
                  >
                    ×{i.count}
                  </span>
                }
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
  if (win && win.anomalies.length > 0) {
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
            {win.anomalies.map((a) => (
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
      subtitle={subtitle}
      actions={
        <Button
          icon="check"
          onClick={onAck}
          aria-disabled={ackUnavailable || undefined}
          aria-busy={acking || undefined}
        >
          Mark caught up
        </Button>
      }
    >
      {error && (
        <div className="mb-6">
          <AlertStrip subject="Briefing" message={`Couldn't reach the Argus server: ${error}`} />
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
        {briefing == null ? null : calm ? (
          <EmptyState
            tone="calm"
            icon="check-circle"
            title="All caught up."
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
                  title="Nothing needs you right now."
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
              <WindowStrip win={briefing.window} />
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
