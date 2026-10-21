import { Fragment, useEffect, useState, type ReactNode } from "react";
import type { Run } from "../types";
import {
  Button,
  buttonClass,
  DURATION,
  Icon,
  Loading,
  SkeletonText,
  StatusPill,
  TimeAgo,
  formatMs,
  formatTokens,
  formatUsd,
  parseRunLog,
  runDsStatus,
  useSyncedDelay,
  type RunLogField,
} from "../ds";
import { useRuntimes } from "../useRuntimes";
import { RuntimeBadge } from "../ds/RuntimeBadge";
import { withoutOutcome } from "./outcome";

/**
 * The "something is in flight" dot, breathing in phase with every other live
 * indicator on screen. It was the same four lines of ping markup copied into
 * every place that counted running work; one component keeps them in step.
 */
export function LiveDot({ className = "" }: { className?: string }) {
  const beat = useSyncedDelay(DURATION.pulse);
  return (
    <span
      aria-hidden="true"
      style={{ animationDelay: beat }}
      className={`inline-block h-1.5 w-1.5 shrink-0 animate-[pulse_var(--duration-pulse)_ease-in-out_infinite] rounded-full bg-current ${className}`}
    />
  );
}

/** One fact on a metadata line. A `wide` fact is one a phone can do without;
 *  a `bare` one (a chip) is spaced like the rest but takes no dot. */
export interface Fact {
  key: string;
  node: ReactNode;
  wide?: boolean;
  bare?: boolean;
}

/**
 * A metadata line — "every 6h · fires in 4h · last ran 1h ago" — that wraps
 * fact by fact and never strands a separator at either end of a line.
 *
 * Each fact carries its dot in front of it, so no line can end on one. The line
 * is then pulled left by exactly one separator's width inside a box that clips,
 * so the dot in front of whichever fact happens to start a line falls outside
 * the box: a phone used to show "· $2.10" and "· typically 2.6s" opening a
 * line of their own. `lead` — the trigger, or a status pill and the time —
 * opens the first line and does not wrap.
 */
export function FactLine({
  lead,
  facts,
  className = "",
}: {
  lead?: ReactNode;
  facts: Fact[];
  className?: string;
}) {
  return (
    <span className={`block min-w-0 overflow-hidden ${className}`}>
      <span className="-ml-3.5 block">
        {lead != null && <span className="ml-3.5 whitespace-nowrap">{lead}</span>}
        {facts.map((f) => (
          <Fragment key={f.key}>
            <wbr />
            <span className={`whitespace-nowrap ${f.wide ? "hidden sm:inline" : ""}`}>
              <span aria-hidden="true" className="inline-block w-3.5 text-center">
                {f.bare ? null : "·"}
              </span>
              {f.node}
            </span>
          </Fragment>
        ))}
      </span>
    </span>
  );
}

/** One expandable run entry: status/meta line, error or result, replay and
 * transcript links and a live-tailing log. Shared by the Scheduler cards and
 * the One-off tab's history.
 *
 * A row, not a box: the list it sits in is the panel (a divided well inside a
 * schedule card, a raised panel on the One-off tab), so a stack of runs reads
 * as one history rather than as five separately outlined things. */
export function RunRow({
  run,
  onCancel,
  extraActions,
  label,
}: {
  run: Run;
  onCancel?: (runId: string) => Promise<unknown>;
  /** Rendered on the row's action side — e.g. the One-off tab's "Reuse". */
  extraActions?: ReactNode;
  /** What the run was, when the list mixes several things — the One-off tab
   *  names each run; a schedule card's rows are all the same schedule. */
  label?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const isRunning = run.status === "running";
  const succeeded = runDsStatus(run) === "done";
  // Without the agent's protocol line: the status pill already shows its verdict.
  // An error that is nothing but a bare marker is still the only error on
  // record, so that one is shown as it was stored.
  const summary = withoutOutcome(run.resultSummary);
  const error = run.error ? withoutOutcome(run.error) || run.error : null;
  // Badge only the runs that didn't use this server's default agent: a mark on
  // every row when every row says the same thing is noise.
  const { default: defaultRuntime } = useRuntimes();
  const transcript =
    run.sessionId && run.project
      ? `#/sessions/${encodeURIComponent(run.project)}/${encodeURIComponent(run.sessionId)}`
      : null;

  // The metrics, in the order a reader scans them: when, how long, how much.
  const facts: Fact[] = [];
  if (run.durationMs != null) {
    facts.push({
      key: "dur",
      node: <span title="How long the run took">{formatMs(run.durationMs)}</span>,
    });
  }
  if (run.costUsd != null) {
    facts.push({
      key: "cost",
      node: (
        <span
          title={
            run.runtime === "codex" ? "Estimated from public API token prices" : "Reported run cost"
          }
        >
          {run.runtime === "codex" ? "~" : ""}
          {formatUsd(run.costUsd)}
        </span>
      ),
    });
  }
  if (run.tokens != null) {
    facts.push({
      key: "tok",
      wide: true,
      node: <span title="Total tokens">{formatTokens(run.tokens)} tok</span>,
    });
  }
  // How it was fired, when it was not the schedule's own slot. A category,
  // so it is a word in the metadata line rather than a coloured tag.
  const firedIcon =
    run.trigger === "scheduled"
      ? null
      : run.trigger === "webhook"
        ? "link"
        : run.trigger === "chained"
          ? "pipeline"
          : "user";
  if (firedIcon) {
    facts.push({
      key: "trigger",
      wide: true,
      node: (
        <span
          className="inline-flex items-center gap-1 align-[-1px]"
          title={`Fired: ${run.trigger}`}
        >
          <Icon name={firedIcon} size={12} />
          {run.trigger}
        </span>
      ),
    });
  }
  // On a phone the word gives way and the icon moves up beside the status
  // pill: left at the end of the metrics, it wrapped onto a line of its own as
  // a bare "· [icon]". The word is still read aloud.
  const firedMark = firedIcon && (
    <span className="inline-flex text-ink-faint sm:hidden" title={`Fired: ${run.trigger}`}>
      <Icon name={firedIcon} size={12} />
      <span className="sr-only">{run.trigger}</span>
    </span>
  );

  if (run.runtime && run.runtime !== defaultRuntime) {
    facts.push({
      key: "runtime",
      bare: true,
      node: (
        <span className="inline-flex align-[1px]">
          <RuntimeBadge runtime={run.runtime} baseline={defaultRuntime} />
        </span>
      ),
    });
  }

  // Relative, with the absolute instant on hover: "4m ago" answers the
  // question a run row is read to answer, and "7/26/2026, 4:00:10 PM" made the
  // reader do date arithmetic to get there.
  const when = (
    <span className="text-ink-dim">
      <TimeAgo iso={run.startedAt ?? run.queuedAt} />
    </span>
  );

  return (
    <li className="min-w-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1.5 transition-colors duration-(--duration-quick) hover:bg-surface-2/40 sm:pr-3">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex min-h-8 min-w-0 flex-1 basis-56 items-start gap-2.5 rounded-md py-1 pl-1 text-left"
        >
          <Icon
            name="chevron-right"
            size={14}
            className={`${label != null ? "mt-[3px]" : "mt-[5px]"} text-ink-faint transition-transform duration-(--duration-quick) ease-(--ease-out-expo) ${
              open ? "rotate-90" : ""
            }`}
          />
          {label != null ? (
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-2.5">
                <span className="inline-flex shrink-0 items-center gap-1.5">
                  <StatusPill status={runDsStatus(run)} size="sm" />
                  {firedMark}
                </span>
                <span className="min-w-0 truncate text-small font-semibold text-ink">{label}</span>
              </span>
              <FactLine lead={when} facts={facts} className="mt-1 text-caption text-ink-faint" />
            </span>
          ) : (
            // Running text after the pill rather than a row of flex items, so a
            // narrow row wraps fact by fact instead of dropping the whole line
            // under the pill.
            <FactLine
              lead={
                <>
                  <span className="mr-2.5 inline-flex items-center gap-1.5 align-middle">
                    <StatusPill status={runDsStatus(run)} size="sm" />
                    {firedMark}
                  </span>
                  {when}
                </>
              }
              facts={facts}
              className="flex-1 text-caption leading-6 text-ink-faint"
            />
          )}
        </button>
        {/* Beside the summary when there is room, under it (and to the right)
            when there is not — a narrow row used to squeeze the run's name to
            two letters to keep its buttons on the same line. */}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {/* The recorder is the first stop for "what did it actually do?", so
              it is on the row itself rather than behind the expander; the raw
              transcript stays one click further in, in the expanded detail, for
              anyone who wants the unabridged JSONL. An icon, named in its
              tooltip, at every width: the word "Replay" beside Run now read as
              "run it again", and repeated on every row it was the loudest word
              in the list. */}
          <a
            href={`#/run/${encodeURIComponent(run.id)}`}
            className={buttonClass("ghost", "sm", "w-7 px-0")}
            aria-label="Open the recording"
            title="Open this run's recording on the Flight Recorder"
          >
            {/* The recorder's mark, not a play triangle: "Run now" is the
                triangle, and this starts nothing — it opens a recording. */}
            <Icon name="history" size={14} />
          </a>
          {extraActions}
          {isRunning && onCancel && (
            <Button
              variant="danger"
              size="sm"
              icon="stop"
              disabled={cancelling}
              onClick={async () => {
                setCancelling(true);
                try {
                  await onCancel(run.id);
                } finally {
                  setCancelling(false);
                }
              }}
            >
              {cancelling ? "Cancelling…" : "Cancel"}
            </Button>
          )}
        </div>
      </div>
      {open && (
        <div className="space-y-3 px-3 pb-3 pt-1 sm:pl-[2.375rem] sm:pr-4">
          {error && (
            <div className="flex gap-2.5 rounded-control border border-fail/25 bg-fail/[0.07] px-3 py-2.5">
              <Icon name="alert" size={15} className="mt-px text-fail" />
              <p className="min-w-0 whitespace-pre-wrap break-words font-mono text-caption leading-relaxed text-fail-ink">
                {error}
              </p>
            </div>
          )}
          {summary && (
            <div className="flex gap-2.5">
              {/* The tick only for a run that succeeded: a failed run's summary
                  is its last words, not good news. */}
              <Icon
                name={succeeded ? "check-circle" : "file"}
                size={15}
                className={`mt-0.5 ${succeeded ? "text-ok" : "text-ink-faint"}`}
              />
              <p className="min-w-0 max-w-prose whitespace-pre-wrap break-words text-small leading-relaxed text-ink-dim">
                {summary}
              </p>
            </div>
          )}
          <RunLog id={run.id} running={isRunning} failed={run.status === "failed"} />
          {transcript && run.sessionId && (
            <a
              href={transcript}
              className="inline-flex items-center gap-1.5 rounded-sm text-caption text-ink-dim transition-colors duration-(--duration-quick) hover:text-ink"
              title="Open this run's transcript"
            >
              <Icon name="message" size={14} />
              Transcript{" "}
              <span className="font-mono text-ink-faint">{run.sessionId.slice(0, 8)}</span>
              <Icon name="arrow-right" size={13} className="text-ink-faint" />
            </a>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * The log's fields as this row says them. The envelope's "Status" is the agent
 * CLI's own verdict on its session, not the run's: a run the scheduler failed
 * (a refused outcome, a non-zero exit) read "Status success" under a red pill.
 * It is named for what it is, and explained when the two disagree. Cost uses
 * the row's own money format — the log's four decimals sat under "$0.38".
 */
function logFields(fields: RunLogField[], runFailed: boolean) {
  return fields.map((f) => {
    if (f.label === "Status") {
      const clean = /^(success|completed)/i.test(f.value);
      return {
        label: "Agent exit",
        value: f.value,
        note:
          runFailed && clean ? "The agent exited cleanly; the outcome check failed." : undefined,
      };
    }
    if (f.label === "Cost") {
      const usd = Number(f.value.replace(/^\$/, ""));
      return { ...f, value: Number.isFinite(usd) ? formatUsd(usd) : f.value };
    }
    return f;
  });
}

function RunLog({
  id,
  running,
  failed: runFailed,
}: {
  id: string;
  running: boolean;
  failed: boolean;
}) {
  const [log, setLog] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // Fetch on expand, then poll while the run is live so the log tails in real
  // time (a re-render alone won't refetch — the id prop is unchanged).
  useEffect(() => {
    let alive = true;
    const fetchLog = () =>
      fetch(`/api/runs/${id}`)
        .then((r) => r.json())
        .then((d: { log?: string }) => alive && setLog(d.log ?? ""))
        .catch(() => {
          if (alive) {
            setFailed(true);
            setLog("");
          }
        });
    void fetchLog();
    const poll = running ? setInterval(() => void fetchLog(), 3000) : null;
    return () => {
      alive = false;
      if (poll) clearInterval(poll);
    };
  }, [id, running]);

  if (log === null) {
    return (
      <Loading label="the run log">
        <SkeletonText lines={3} />
      </Loading>
    );
  }
  if (failed) return <p className="text-caption text-ink-faint">Couldn't load the run log.</p>;

  const parsed = parseRunLog(log);
  if (parsed.kind === "empty") return null;
  return (
    <div className="rounded-control border border-line bg-ground/60 p-3">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-2">
        <span className="eyebrow">Log</span>
        {running && (
          <span className="inline-flex items-center gap-1.5 text-caption text-run">
            <LiveDot />
            Tailing
          </span>
        )}
        {parsed.truncated && (
          <span className="text-caption text-ink-faint">Showing the end of a longer log.</span>
        )}
      </div>
      {parsed.kind === "envelope" ? (
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-caption">
          {logFields(parsed.fields, runFailed).map((f) => (
            <Fragment key={f.label}>
              <dt className="text-ink-faint">{f.label}</dt>
              <dd className="break-words text-ink-dim">
                <span className="font-mono">{f.value}</span>
                {"note" in f && f.note && (
                  <span className="mt-0.5 block text-ink-faint">{f.note}</span>
                )}
              </dd>
            </Fragment>
          ))}
        </dl>
      ) : (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-caption leading-relaxed text-ink-dim">
          {parsed.text}
        </pre>
      )}
    </div>
  );
}
