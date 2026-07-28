import { Card, EmptyState, Section, formatMs, formatTokens, formatUsd } from "../ds";
import { useVaultQuarters, useVaultStatus } from "../useVault";
import type { VaultQuarter, VaultStatus } from "../types";

/**
 * The Vault's face on the Stats page: the long view, plus an honest account of
 * what is behind it.
 *
 * The status line is not decoration. A store that silently stopped ingesting
 * looks exactly like a quiet month, so the panel says when it last ran, how
 * much it holds, and — the number that justifies the feature — how many runs it
 * is keeping that the JSON files have already pruned.
 */

function bytes(n: number | null): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function StatusLine({ status }: { status: VaultStatus }) {
  if (!status.available) {
    return (
      <p className="font-mono text-[11px] text-ink-faint">
        Vault unavailable — {status.detail}. Everything above is derived from the JSON files, which
        keep the newest 50 runs per schedule.
      </p>
    );
  }
  return (
    <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
      {status.rows.runs.toLocaleString()} runs · {status.rows.events.toLocaleString()} events ·{" "}
      {status.rows.scores.toLocaleString()} scores · {bytes(status.sizeBytes)}
      {status.beyondRetention > 0 && (
        <>
          {" · "}
          <span className="text-eye">
            {status.beyondRetention.toLocaleString()} past JSON retention
          </span>
        </>
      )}
    </p>
  );
}

function QuarterRow({ quarter }: { quarter: VaultQuarter }) {
  const rate = quarter.runs > 0 ? quarter.succeeded / quarter.runs : null;
  return (
    <tr className="border-t border-line">
      <th scope="row" className="py-2 pr-3 text-left font-mono text-xs font-bold text-ink">
        {quarter.label}
      </th>
      <td className="py-2 pr-3 text-right font-mono text-xs text-ink-dim">
        {quarter.runs.toLocaleString()}
      </td>
      <td className="py-2 pr-3 text-right font-mono text-xs">
        <span className={quarter.failed > 0 ? "text-fail" : "text-ink-faint"}>
          {quarter.failed.toLocaleString()}
        </span>
      </td>
      <td className="py-2 pr-3 text-right font-mono text-xs text-ink-dim">
        {rate == null ? "—" : `${Math.round(rate * 100)}%`}
      </td>
      <td className="py-2 pr-3 text-right font-mono text-xs text-ink-dim">
        {quarter.medianDurationMs == null ? "—" : formatMs(quarter.medianDurationMs)}
      </td>
      <td className="py-2 pr-3 text-right font-mono text-xs text-ink-dim">
        {formatUsd(quarter.costUsd)}
      </td>
      <td className="py-2 pr-3 text-right font-mono text-xs text-ink-faint">
        {formatTokens(quarter.tokens)}
      </td>
      <td className="py-2 text-right font-mono text-xs text-ink-dim">
        {/* Absent, not zero: an unscored quarter has not been judged badly. */}
        {quarter.medianScore == null ? "—" : quarter.medianScore.toFixed(1)}
      </td>
    </tr>
  );
}

export function VaultPanels() {
  const { data: status } = useVaultStatus();
  const { data: report, loading } = useVaultQuarters();

  return (
    <Section title="By quarter · the long view">
      {/* A store that quietly stopped ingesting is the failure this feature
          must not hide, so its state is announced and not only drawn. */}
      <div aria-live="polite" role="status" className="sr-only">
        {status.available
          ? `Vault holding ${status.rows.runs} runs, ${report.detail}`
          : `Vault unavailable: ${status.detail}`}
      </div>
      {loading && report.quarters.length === 0 ? (
        <EmptyState>Reading the Vault…</EmptyState>
      ) : report.quarters.length === 0 ? (
        <EmptyState>
          {status.available
            ? "No quarters yet. The Vault fills in as runs complete — it keeps every one, so this view grows past the fifty-per-schedule the JSON files hold."
            : `The long view needs the Vault, and it is unavailable: ${status.detail || "no reason reported"}.`}
        </EmptyState>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[42rem] border-collapse">
              <caption className="sr-only">
                Runs, failures, duration, cost and quality score by calendar quarter
              </caption>
              <thead>
                <tr className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
                  <th scope="col" className="pb-2 pr-3 text-left font-normal">
                    Quarter
                  </th>
                  <th scope="col" className="pb-2 pr-3 text-right font-normal">
                    Runs
                  </th>
                  <th scope="col" className="pb-2 pr-3 text-right font-normal">
                    Failed
                  </th>
                  <th scope="col" className="pb-2 pr-3 text-right font-normal">
                    Success
                  </th>
                  <th scope="col" className="pb-2 pr-3 text-right font-normal">
                    Median
                  </th>
                  <th scope="col" className="pb-2 pr-3 text-right font-normal">
                    Cost
                  </th>
                  <th scope="col" className="pb-2 pr-3 text-right font-normal">
                    Tokens
                  </th>
                  <th scope="col" className="pb-2 text-right font-normal">
                    Verdict
                  </th>
                </tr>
              </thead>
              <tbody>
                {report.quarters.map((q) => (
                  <QuarterRow key={q.key} quarter={q} />
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 border-t border-line pt-2">
            <StatusLine status={status} />
          </div>
        </Card>
      )}
    </Section>
  );
}
