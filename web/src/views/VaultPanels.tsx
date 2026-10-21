import {
  AlertStrip,
  Button,
  EmptyState,
  Icon,
  Section,
  Skeleton,
  formatMs,
  formatTokens,
  formatUsd,
} from "../ds";
import { useVaultQuarters, useVaultStatus } from "../useVault";
import type { VaultQuarter, VaultStatus } from "../types";
import { loadError } from "../live/loadError";

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

/** "1 event", "1,240 runs". */
function count(n: number, noun: string): string {
  return `${n.toLocaleString()} ${noun}${n === 1 ? "" : "s"}`;
}

function StatusLine({ status, error }: { status: VaultStatus; error: string | null }) {
  // A status that never arrived is not a Vault that is unavailable.
  if (!status.available && error) {
    return (
      <p className="flex items-start gap-2 text-caption text-ink-dim">
        <Icon name="alert" size={14} className="mt-px text-ink-faint" />
        <span>{loadError("the Vault's status", error, "read")}.</span>
      </p>
    );
  }
  if (!status.available) {
    return (
      <p className="flex items-start gap-2 text-caption text-ink-dim">
        <Icon name="alert" size={14} className="mt-px text-ink-faint" />
        <span>
          Vault unavailable — {status.detail}. Everything above is derived from the JSON files,
          which keep the newest 50 runs per schedule.
        </span>
      </p>
    );
  }
  return (
    <p className="flex items-start gap-2 text-caption text-ink-faint">
      <Icon name="layers" size={14} className="mt-px text-ink-faint" />
      <span>
        {count(status.rows.runs, "run")} · {count(status.rows.events, "event")} ·{" "}
        {count(status.rows.scores, "score")} · {bytes(status.sizeBytes)}
        {status.beyondRetention > 0 && (
          <>
            {" · "}
            <span className="font-semibold text-ink-dim">
              {status.beyondRetention.toLocaleString()} past JSON retention
            </span>
          </>
        )}
      </span>
    </p>
  );
}

// Numerals right-aligned so a column of them lines up; the first column, the
// quarter, reads from the left.
const CELL = "whitespace-nowrap px-3 text-right first:pl-4 first:text-left last:pr-4";
const TH = `${CELL} eyebrow py-2.5 font-semibold`;
const TD = `${CELL} py-3 text-small`;
const DIM = `${TD} text-ink-dim`;

/** A column a phone folds into the caption line under the quarter. */
const WIDE = "hidden sm:table-cell";

function QuarterRow({ quarter }: { quarter: VaultQuarter }) {
  const rate = quarter.runs > 0 ? quarter.succeeded / quarter.runs : null;
  const median = quarter.medianDurationMs == null ? "—" : formatMs(quarter.medianDurationMs);
  return (
    <tr>
      <th scope="row" className={`${TD} align-top font-semibold text-ink`}>
        {quarter.label}
        {/* The other columns, on a phone, as one line under the quarter: each
            figure with its unit, wrapping between pairs. */}
        <span className="mt-1 block whitespace-normal text-caption font-normal text-ink-faint sm:hidden">
          <span className="whitespace-nowrap">{count(quarter.runs, "run")}</span> ·{" "}
          <span
            className={`whitespace-nowrap ${quarter.failed > 0 ? "font-semibold text-fail" : ""}`}
          >
            {`${quarter.failed.toLocaleString()} failed`}
          </span>{" "}
          ·{" "}
          <span className="whitespace-nowrap">
            {rate == null ? "no success rate" : `${Math.round(rate * 100)}% success`}
          </span>{" "}
          · <span className="whitespace-nowrap">{`median ${median}`}</span> ·{" "}
          <span className="whitespace-nowrap">{`${formatTokens(quarter.tokens)} tok`}</span> ·{" "}
          <span className="whitespace-nowrap">
            {quarter.medianScore == null ? "unscored" : `verdict ${quarter.medianScore.toFixed(1)}`}
          </span>
        </span>
      </th>
      <td className={`${DIM} ${WIDE}`}>{quarter.runs.toLocaleString()}</td>
      <td className={`${DIM} ${WIDE}`}>
        {/* A zero is neutral; only a failure count is a claim worth colouring. */}
        <span className={quarter.failed > 0 ? "font-semibold text-fail" : "text-ink-faint"}>
          {quarter.failed.toLocaleString()}
        </span>
      </td>
      <td className={`${DIM} ${WIDE}`}>{rate == null ? "—" : `${Math.round(rate * 100)}%`}</td>
      <td className={`${DIM} ${WIDE}`}>{median}</td>
      <td className={`${TD} align-top font-semibold text-ink`}>{formatUsd(quarter.costUsd)}</td>
      <td className={`${TD} ${WIDE} text-ink-faint`}>{formatTokens(quarter.tokens)}</td>
      <td className={`${DIM} ${WIDE}`}>
        {/* Absent, not zero: an unscored quarter has not been judged badly. */}
        {quarter.medianScore == null ? "—" : quarter.medianScore.toFixed(1)}
      </td>
    </tr>
  );
}

export function VaultPanels() {
  const {
    data: status,
    loading: statusLoading,
    error: statusError,
    refresh: refreshStatus,
  } = useVaultStatus();
  const { data: report, loading, error, refresh } = useVaultQuarters();
  // Until the status has answered, "unavailable" is only the placeholder's
  // default — not something the Vault said about itself.
  const statusKnown = status.available || (!statusLoading && !statusError);
  // A failed load with nothing on screen is unknown, not empty: one error
  // with a retry, rather than an empty state claiming the long view is offline.
  const readError = error ?? (status.available ? null : statusError);
  const failed = readError != null && report.quarters.length === 0;

  return (
    <Section title="Argus runs by quarter">
      {/* A different ledger from everything above it on the Stats page, so the
          switch is named: these are the runs Argus launched, not Claude Code's
          own usage. */}
      <p className="-mt-1 mb-3 max-w-3xl text-small text-ink-dim">
        What Argus itself launched, from the Vault — every run it has fired, kept past the JSON
        files&apos; retention. Spend in detail is on{" "}
        <a href="#/budget" className="font-semibold text-ink underline underline-offset-2">
          Budget
        </a>
        .
      </p>
      {/* A store that quietly stopped ingesting is the failure this feature
          must not hide, so its state is announced and not only drawn — once it
          has actually been read. */}
      <div aria-live="polite" role="status" className="sr-only">
        {failed || !statusKnown
          ? ""
          : status.available
            ? `Vault holding ${status.rows.runs} runs, ${report.detail}`
            : `Vault unavailable: ${status.detail}`}
      </div>
      {failed ? (
        <AlertStrip
          subject="Vault"
          message={loadError("the Vault", readError, "read")}
          action={
            <Button
              size="sm"
              icon="retry"
              onClick={() => {
                refresh();
                refreshStatus();
              }}
            >
              Retry
            </Button>
          }
        />
      ) : (loading || !statusKnown) && report.quarters.length === 0 ? (
        // Plain placeholders rather than `Loading`: the live region above is
        // this panel's one announcement, and a second status would talk over it.
        <div className="rounded-tile border border-line bg-surface px-4 py-3.5 shadow-raised">
          <p className="text-caption text-ink-faint">Reading the Vault…</p>
          <div className="mt-3 flex flex-col gap-3.5">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-6">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="ml-auto h-3 w-12" />
                <Skeleton className="h-3 w-12" />
                <Skeleton className="hidden h-3 w-12 sm:block" />
              </div>
            ))}
          </div>
        </div>
      ) : report.quarters.length === 0 ? (
        <EmptyState
          compact
          icon="layers"
          title={status.available ? "No quarters yet" : "The long view is offline"}
        >
          {status.available
            ? "The Vault fills in as runs complete — it keeps every one, so this view grows past the fifty-per-schedule the JSON files hold."
            : `The long view needs the Vault, and it is unavailable: ${status.detail || "no reason reported"}.`}
        </EmptyState>
      ) : (
        <div className="overflow-hidden rounded-tile border border-line bg-surface shadow-raised">
          {/* The table may scroll sideways on a phone; the page never does. */}
          <div className="overflow-x-auto">
            <table className="w-full border-collapse sm:min-w-[40rem]">
              <caption className="sr-only">
                Runs, failures, duration, cost and quality score by calendar quarter
              </caption>
              <thead>
                <tr className="border-b border-line">
                  <th scope="col" className={TH}>
                    Quarter
                  </th>
                  <th scope="col" className={`${TH} ${WIDE}`}>
                    Runs
                  </th>
                  <th scope="col" className={`${TH} ${WIDE}`}>
                    Failed
                  </th>
                  <th scope="col" className={`${TH} ${WIDE}`}>
                    Success
                  </th>
                  <th scope="col" className={`${TH} ${WIDE}`}>
                    Median
                  </th>
                  <th scope="col" className={TH}>
                    Cost
                  </th>
                  <th scope="col" className={`${TH} ${WIDE}`}>
                    Tokens
                  </th>
                  <th scope="col" className={`${TH} ${WIDE}`}>
                    Verdict
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {report.quarters.map((q) => (
                  <QuarterRow key={q.key} quarter={q} />
                ))}
              </tbody>
            </table>
          </div>
          <div className="border-t border-line bg-ground-2/40 px-4 py-2.5">
            <StatusLine status={status} error={statusError} />
          </div>
        </div>
      )}
    </Section>
  );
}
