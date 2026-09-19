import { EmptyState, SkeletonText } from "../ds";
import { useReliability } from "../useReliability";
import type { PhaseFailureClass, PhaseReliability } from "../types";

const FAILURE_LABEL: Record<PhaseFailureClass, string> = {
  spawn: "spawn",
  "exit-code": "exit code",
  signal: "signalled failure",
  timeout: "timeout",
  verification: "verification",
  "knowledge-delta": "knowledge delta",
  configuration: "configuration",
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
function Trend({ trend }: { trend: { day: string; succeeded: number; failed: number }[] }) {
  const max = Math.max(1, ...trend.map((d) => d.succeeded + d.failed));
  return (
    <div
      className="flex h-10 items-end gap-px"
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
            className="flex w-1.5 shrink-0 flex-col-reverse overflow-hidden rounded-[1px] bg-ground-2"
            style={{ height: `${heightPct}%` }}
          >
            {d.failed > 0 && (
              <div className="w-full bg-fail" style={{ height: `${(d.failed / total) * 100}%` }} />
            )}
            {d.succeeded > 0 && (
              <div className="w-full bg-ok" style={{ height: `${(d.succeeded / total) * 100}%` }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className={`font-mono text-lg font-extrabold ${tone ?? "text-ink"}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-[0.1em] text-ink-faint">{label}</div>
    </div>
  );
}

function PhaseRow({ p }: { p: PhaseReliability }) {
  return (
    <tr className="border-t border-line">
      <td className="max-w-[9rem] truncate py-1.5 pr-2 text-ink-dim" title={p.name}>
        {p.name}
      </td>
      <td className="py-1.5 pr-2 text-right font-mono text-ok">{p.firstAttemptPass}</td>
      <td className="py-1.5 pr-2 text-right font-mono text-await">{p.luckyPass}</td>
      <td className="py-1.5 pr-2 text-right font-mono text-fail">{p.failed}</td>
      <td className="py-1.5 text-ink-faint">{dominantFailure(p.failureClasses)}</td>
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

  return (
    <div className="mt-3 rounded-lg border border-line bg-ground-2 p-3">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-ink-faint">
          Reliability
        </span>
        <span className="text-[10px] text-ink-faint">last {days}d</span>
      </div>

      {loading && !reliability ? (
        <SkeletonText lines={3} />
      ) : error ? (
        <p className="text-xs text-fail">Couldn't load reliability: {error}</p>
      ) : !reliability || reliability.instances === 0 ? (
        <EmptyState>
          <p className="text-xs text-ink-dim">No settled runs in the last {days} days.</p>
        </EmptyState>
      ) : (
        <>
          <div className="flex flex-wrap gap-6">
            <Stat
              label="First-attempt pass"
              value={pct(reliability.firstAttemptSuccessRate)}
              tone={
                reliability.firstAttemptSuccessRate != null &&
                reliability.firstAttemptSuccessRate < 0.5
                  ? "text-await"
                  : "text-ok"
              }
            />
            <Stat
              label="Lucky pass"
              value={pct(reliability.luckyPassRate)}
              tone={
                reliability.luckyPassRate != null && reliability.luckyPassRate > 0
                  ? "text-await"
                  : "text-ink"
              }
            />
            <Stat label="Settled" value={String(reliability.instances)} />
            {reliability.aborted > 0 && (
              <Stat label="Aborted" value={String(reliability.aborted)} />
            )}
          </div>

          <div className="mt-3">
            <Trend trend={reliability.trend} />
          </div>

          {reliability.phases.length > 0 && (
            <table className="mt-3 w-full text-xs">
              <thead>
                <tr className="text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                  <th className="pb-1 text-left font-normal">Phase</th>
                  <th className="pb-1 text-right font-normal">1st try</th>
                  <th className="pb-1 text-right font-normal">Lucky</th>
                  <th className="pb-1 text-right font-normal">Failed</th>
                  <th className="pb-1 text-left font-normal">Dominant failure</th>
                </tr>
              </thead>
              <tbody>
                {reliability.phases.map((p) => (
                  <PhaseRow key={p.phaseId} p={p} />
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
