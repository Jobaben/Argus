import {
  Card,
  EmptyState,
  Loading,
  Page,
  Section,
  SkeletonGrid,
  SkeletonText,
  TimeAgo,
  formatTokens,
  formatUsd,
} from "../ds";
import type { AttentionKind, Briefing as BriefingData, RunStatus } from "../types";

/** Where each attention kind sends the user to act on it. */
const KIND_META: Record<AttentionKind, { href: string; label: string; tone: "fail" | "await" }> = {
  "monitor-down": { href: "#/monitors", label: "Monitor down", tone: "fail" },
  "gate-waiting": { href: "#/pipelines", label: "Awaiting approval", tone: "await" },
  "monitor-failing": { href: "#/monitors", label: "Monitor failing", tone: "fail" },
  "issue-open": { href: "#/issues", label: "Open issue", tone: "fail" },
  anomaly: { href: "#/watchtower", label: "Anomaly", tone: "await" },
};

const TONE_CLASS = {
  fail: "border-fail/40 text-fail bg-fail/12",
  await: "border-await/40 text-await bg-await/14",
} as const;

const STATUS_ORDER: { key: RunStatus; label: string; className: string }[] = [
  { key: "succeeded", label: "succeeded", className: "text-ok" },
  { key: "failed", label: "failed", className: "text-fail" },
  { key: "interrupted", label: "interrupted", className: "text-fail" },
  { key: "cancelled", label: "cancelled", className: "text-idle" },
  { key: "skipped", label: "skipped", className: "text-idle" },
  { key: "running", label: "still running", className: "text-run" },
];

/** Where a failed run's row goes: its transcript when it has one, else Issues. */
function failureHref(run: BriefingData["window"]["failures"][number]): string {
  return run.sessionId && run.project
    ? `#/sessions/${encodeURIComponent(run.project)}/${encodeURIComponent(run.sessionId)}`
    : "#/issues";
}

function AttentionCard({ item }: { item: BriefingData["attention"][number] }) {
  const meta = KIND_META[item.kind];
  return (
    <a href={meta.href} className="block">
      {/* Border follows the kind's own tone rather than a special case for
          gates: with anomalies added there are now two amber kinds, and the
          old `kind === "gate-waiting"` test would have drawn one of them red. */}
      <Card className={meta.tone === "await" ? "border-await/40" : "border-fail/40"}>
        <div className="flex items-center gap-3">
          <span
            className={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.13em] ${TONE_CLASS[meta.tone]}`}
          >
            {meta.label}
          </span>
          <span className="truncate text-sm font-semibold text-ink" title={item.title}>
            {item.title}
          </span>
          {item.at && (
            <span className="ml-auto shrink-0 text-xs text-ink-faint">
              <TimeAgo iso={item.at} />
            </span>
          )}
        </div>
        <p className="mt-1.5 truncate text-sm text-ink-dim">{item.detail}</p>
      </Card>
    </a>
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
  const calm = briefing != null && briefing.attentionCount === 0 && briefing.window.totalRuns === 0;

  return (
    <Page
      title="Briefing"
      actions={
        <button
          type="button"
          onClick={() => void ack()}
          className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink transition hover:border-ink-faint/40"
        >
          Mark caught up
        </button>
      }
    >
      {error && (
        <div className="mb-6 rounded-tile border border-fail/30 bg-fail/10 px-4 py-3 text-sm text-fail">
          Couldn't reach the Argus server: {error}
        </div>
      )}

      {loading && briefing == null ? (
        <Loading label="your briefing">
          <SkeletonText lines={1} className="mb-6 max-w-sm" />
          <SkeletonGrid count={4} columns={2} lines={2} />
        </Loading>
      ) : briefing == null ? null : (
        <>
          <p className="mb-6 text-sm text-ink-dim">
            Since <TimeAgo iso={briefing.since} /> —{" "}
            <b className="text-ink">{briefing.window.totalRuns}</b> run
            {briefing.window.totalRuns === 1 ? "" : "s"}
            {briefing.window.tokens > 0 && (
              <>
                {" "}
                · <b className="text-ink">{formatTokens(briefing.window.tokens)}</b> tok
              </>
            )}
            {briefing.window.costUsd > 0 && (
              <>
                {" "}
                · <b className="text-ink">{formatUsd(briefing.window.costUsd)}</b>
              </>
            )}
          </p>

          {calm ? (
            <EmptyState>
              All caught up. Nothing needs your attention, and nothing ran since{" "}
              <TimeAgo iso={briefing.since} />.
            </EmptyState>
          ) : (
            <>
              <Section title={`Needs your attention (${briefing.attentionCount})`}>
                {briefing.attentionCount === 0 ? (
                  <EmptyState>Nothing needs you right now.</EmptyState>
                ) : (
                  <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                    {briefing.attention.map((a) => (
                      <AttentionCard key={`${a.kind}:${a.id}`} item={a} />
                    ))}
                  </div>
                )}
              </Section>

              <Section title="While you were away">
                <Card>
                  <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-sm">
                    <span>
                      <b className="text-2xl font-extrabold text-ink">
                        {briefing.window.totalRuns}
                      </b>{" "}
                      <span className="text-ink-faint">runs</span>
                    </span>
                    {STATUS_ORDER.filter(({ key }) => briefing.window.byStatus[key] > 0).map(
                      ({ key, label, className }) => (
                        <span key={key} className={className}>
                          <b>{briefing.window.byStatus[key]}</b> {label}
                        </span>
                      ),
                    )}
                  </div>
                </Card>
              </Section>

              {briefing.window.failures.length > 0 && (
                <Section title="Failures">
                  <div className="flex flex-col gap-2">
                    {/* Every other row on this page is a link to the thing it
                        describes; these were not, which made the most actionable
                        list here the only dead one. A failed run's transcript is
                        where you find out why, so that is the destination when
                        there is one; Issues, which groups it, is the fallback. */}
                    {briefing.window.failures.map((r) => (
                      <a key={r.id} href={failureHref(r)} className="block">
                        <Card>
                          <div className="flex items-center gap-3 text-sm">
                            <span className="font-semibold text-ink">{r.scheduleName}</span>
                            <span className="truncate text-ink-dim" title={r.error ?? undefined}>
                              {(r.error ?? r.resultSummary ?? "failed").split("\n")[0]}
                            </span>
                            {(r.endedAt ?? r.startedAt) && (
                              <span className="ml-auto shrink-0 text-xs text-ink-faint">
                                <TimeAgo iso={(r.endedAt ?? r.startedAt)!} />
                              </span>
                            )}
                          </div>
                        </Card>
                      </a>
                    ))}
                  </div>
                </Section>
              )}

              {briefing.window.newIssues.length > 0 && (
                <Section title="New issues">
                  <div className="flex flex-col gap-2">
                    {briefing.window.newIssues.map((i) => (
                      <a key={i.fingerprint} href="#/issues" className="block">
                        <Card>
                          <div className="flex items-center gap-3 text-sm">
                            <span className="truncate font-semibold text-ink">{i.title}</span>
                            <span className="shrink-0 font-mono text-xs text-fail">×{i.count}</span>
                            <span className="ml-auto shrink-0 text-xs text-ink-faint">
                              first seen <TimeAgo iso={i.firstSeen} />
                            </span>
                          </div>
                        </Card>
                      </a>
                    ))}
                  </div>
                </Section>
              )}

              {briefing.window.anomalies.length > 0 && (
                <Section title="Ran, but not the way it usually runs">
                  <div className="flex flex-col gap-2">
                    {briefing.window.anomalies.map((a) => (
                      <a key={a.id} href="#/watchtower" className="block">
                        <Card>
                          <div className="flex items-center gap-3 text-sm">
                            <span className="shrink-0 font-semibold text-ink">{a.name}</span>
                            <span
                              className={`truncate font-mono text-xs ${
                                a.severity === "critical" ? "text-fail" : "text-await"
                              }`}
                            >
                              {a.detail}
                            </span>
                            <span className="ml-auto shrink-0 text-xs text-ink-faint">
                              <TimeAgo iso={a.at} />
                            </span>
                          </div>
                        </Card>
                      </a>
                    ))}
                  </div>
                </Section>
              )}

              {briefing.window.finishedPipelines.length > 0 && (
                <Section title="Pipelines finished">
                  <div className="flex flex-col gap-2">
                    {briefing.window.finishedPipelines.map((p) => (
                      <a key={p.id} href="#/pipelines" className="block">
                        <Card>
                          <div className="flex items-center gap-3 text-sm">
                            <span className="font-semibold text-ink">{p.pipelineName}</span>
                            <span className={p.status === "succeeded" ? "text-ok" : "text-fail"}>
                              {p.status}
                            </span>
                            {p.endedAt && (
                              <span className="ml-auto shrink-0 text-xs text-ink-faint">
                                <TimeAgo iso={p.endedAt} />
                              </span>
                            )}
                          </div>
                        </Card>
                      </a>
                    ))}
                  </div>
                </Section>
              )}
            </>
          )}
        </>
      )}
    </Page>
  );
}
