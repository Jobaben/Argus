import { Icon, Loading, Skeleton } from "../ds";
import { useReliability } from "../useReliability";
import type { PhaseFailureClass, PhaseReliability } from "../types";
import { loadError } from "../live/loadError";

const FAILURE_LABEL: Record<PhaseFailureClass, string> = {
  spawn: "spawn",
  "exit-code": "exit code",
  signal: "signalled failure",
  timeout: "timeout",
  verification: "verification",
  "knowledge-delta": "knowledge delta",
  "knowledge-context-integrity": "knowledge context integrity",
  "rule-verification": "rule verification",
  "change-proposal": "change proposal",
  "change-context-integrity": "change context integrity",
  "acceptance-verification": "acceptance verification",
  // A completion with no (or contradictory) ARGUS_OUTCOME marker — the agent
  // reported nothing Argus could accept. Not "failed verification": no check
  // was involved.
  unverified: "unverified completion",
  configuration: "configuration",
  // The gate's approveWhen command exited with its failOnExit code.
  "approval-condition": "approval condition",
};

function pct(n: number | null): string {
  return n == null ? "—" : `${Math.round(n * 100)}%`;
}

/** The failure class this phase hit most, with its count — "—" when the phase
 *  has never failed with a classified reason. */
function dominantFailure(classes: Partial<Record<PhaseFailureClass, number>>): string {
  const entries = Object.entries(classes) as [PhaseFailureClass, number][];
  if (entries.length === 0) return "—";
  entries.sort((a, b) => b[1] - a[1]);
  const [cls, count] = entries[0];
  return `${FAILURE_LABEL[cls] ?? cls} (${count})`;
}

/**
 * Succeeded-vs-failed by day, stacked. Deliberately not a line chart: a day
 * with zero runs and a day that hasn't happened yet should both read as
 * "nothing", and a stacked bar collapses to a hairline for either without a
 * connecting line implying a trend between two unrelated gaps.
 */
function Trend({
  trend,
  days,
}: {
  trend: { day: string; succeeded: number; failed: number }[];
  days: number;
}) {
  const max = Math.max(1, ...trend.map((d) => d.succeeded + d.failed));
  return (
    <div>
      {/* The chart says what it counts and over what window; the axis below
          says where the window starts and ends. */}
      <div className="mb-1.5 flex items-baseline justify-between gap-3 text-caption text-ink-faint">
        <span>Settled runs per day</span>
        <span>last {days} days</span>
      </div>
      <div
        className="flex h-12 items-end gap-0.5"
        role="img"
        aria-label={`Settled runs over the last ${trend.length} days, oldest first: ${trend
          .map((d) => `${d.day} ${d.succeeded} succeeded ${d.failed} failed`)
          .join("; ")}`}
      >
        {trend.map((d) => {
          const total = d.succeeded + d.failed;
          const heightPct = total === 0 ? 4 : Math.max(8, (total / max) * 100);
          return (
            <div
              key={d.day}
              aria-hidden="true"
              title={`${d.day}: ${d.succeeded} succeeded, ${d.failed} failed`}
              className="flex min-w-0 max-w-5 flex-1 flex-col-reverse overflow-hidden rounded-[2px] bg-line"
              style={{ height: `${heightPct}%` }}
            >
              {d.failed > 0 && (
                <div
                  className="w-full bg-fail"
                  style={{ height: `${(d.failed / total) * 100}%` }}
                />
              )}
              {d.succeeded > 0 && (
                <div
                  className="w-full bg-ok"
                  style={{ height: `${(d.succeeded / total) * 100}%` }}
                />
              )}
            </div>
          );
        })}
      </div>
      {trend.length > 1 && (
        <div aria-hidden="true" className="mt-1 flex justify-between text-micro text-ink-faint">
          <span>{trend[0].day}</span>
          <span>{trend[trend.length - 1].day}</span>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <div className={`text-title font-semibold leading-none ${tone ?? "text-ink"}`}>{value}</div>
      <div className="mt-1.5 text-caption text-ink-dim">{label}</div>
    </div>
  );
}

/** A count in the table: coloured only when it is not zero, because a column of
 *  green and red zeros is a table shouting about nothing. */
function Count({ n, tone }: { n: number; tone: string }) {
  return (
    <td className={`py-2 pr-3 text-right last:pr-0 ${n > 0 ? tone : "text-ink-faint"}`}>{n}</td>
  );
}

/** One phase. Where it loses attempts sits under its name rather than in a
 *  fifth column, which on a phone was the column scrolled out of view. */
function PhaseRow({ p }: { p: PhaseReliability }) {
  const dominant = dominantFailure(p.failureClasses);
  return (
    <tr className="border-t border-line align-top">
      <td className="max-w-0 py-2 pr-3">
        <div className="truncate text-ink" title={p.name}>
          {p.name}
        </div>
        {dominant !== "—" && (
          <div className="mt-0.5 truncate text-caption text-ink-faint">
            Mostly <span className="text-ink-dim">{dominant}</span>
          </div>
        )}
      </td>
      <Count n={p.firstAttemptPass} tone="text-ok" />
      <Count n={p.luckyPass} tone="text-ink-dim" />
      <Count n={p.failed} tone="text-fail" />
    </tr>
  );
}

/**
 * How reliably a pipeline passes its own checks on the first attempt, and
 * where it loses attempts when it doesn't — see `docs/API.md`'s Reliability
 * section for the derivation. Reads nothing until `pipelineId` is given, so a
 * collapsed disclosure costs one fetch only once it's opened.
 */
export function ReliabilityCard({ pipelineId, days = 30 }: { pipelineId: string; days?: number }) {
  const { reliability, loading, error } = useReliability(pipelineId, days);
  const firstRate = reliability?.firstAttemptSuccessRate ?? null;

  return (
    <div className="mt-1.5 min-w-0 rounded-tile border border-line bg-ground-2/60 p-4 motion-safe:animate-[slide-up_var(--duration-base)_var(--ease-out-expo)_both]">
      {/* Named by the disclosure that opens it, so no heading of its own: the
          window is the one thing that toggle does not say. */}
      {loading && !reliability ? (
        <Loading label="reliability">
          <div className="flex gap-8">
            {[0, 1, 2].map((i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-5 w-12" />
                <Skeleton className="h-2.5 w-20" />
              </div>
            ))}
          </div>
          <Skeleton className="mt-4 h-12 w-full" />
        </Loading>
      ) : error ? (
        <p className="flex items-start gap-1.5 text-small text-fail-ink">
          <Icon name="alert" size={15} className="mt-px shrink-0 text-fail" />
          <span className="min-w-0 break-words">{loadError("reliability", error)}</span>
        </p>
      ) : !reliability || reliability.instances === 0 ? (
        <p className="flex items-center gap-2 text-small text-ink-dim">
          <Icon name="activity" size={15} className="shrink-0 text-ink-faint" />
          <span>No settled runs in the last {days} days.</span>
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-start gap-x-8 gap-y-3">
            {/* A rate is a score, not a status, so it is set in ink. Green is
                kept for a pipeline that is healthy by any reading — nine first
                passes in ten — where a 64% in green read as "fine". */}
            <Stat
              label="First-attempt pass"
              value={pct(firstRate)}
              tone={firstRate != null && firstRate >= 0.9 ? "text-ok" : "text-ink"}
            />
            <Stat label="Lucky pass" value={pct(reliability.luckyPassRate)} />
            <Stat label="Settled" value={String(reliability.instances)} />
            {reliability.aborted > 0 && (
              <Stat label="Aborted" value={String(reliability.aborted)} />
            )}
          </div>

          <div className="mt-4">
            <Trend trend={reliability.trend} days={days} />
          </div>

          {reliability.phases.length > 0 && (
            <div className="mt-4">
              <table className="w-full text-small">
                <thead>
                  <tr>
                    <th className="eyebrow w-full pb-1.5 pr-3 text-left">Phase</th>
                    <th
                      className="eyebrow whitespace-nowrap pb-1.5 pr-3 text-right"
                      title="Passed its checks on the first attempt"
                    >
                      1st try
                    </th>
                    <th
                      className="eyebrow pb-1.5 pr-3 text-right"
                      title="Passed only after a retry or a revision"
                    >
                      Lucky
                    </th>
                    <th className="eyebrow pb-1.5 text-right">Failed</th>
                  </tr>
                </thead>
                <tbody>
                  {reliability.phases.map((p) => (
                    <PhaseRow key={p.phaseId} p={p} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
