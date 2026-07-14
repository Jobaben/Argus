import { Fragment, useEffect, useState } from "react";
import type { Run } from "../types";
import { StatusPill, formatTokens, formatUsd, parseRunLog, runDsStatus } from "../ds";

function when(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

/** One expandable run entry: status/meta line, error or result, transcript
 * link and a live-tailing log. Shared by the Scheduler cards and the Launch
 * tab's one-off history. */
export function RunRow({
  run,
  onCancel,
  extraActions,
}: {
  run: Run;
  onCancel?: (runId: string) => Promise<unknown>;
  /** Rendered on the row's action side — e.g. Launch's "Run again". */
  extraActions?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const isRunning = run.status === "running";
  return (
    <li className="rounded-lg border border-line bg-surface">
      <div className="flex w-full items-center gap-3 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex flex-1 items-center gap-3 text-left"
        >
          <StatusPill status={runDsStatus(run)} />
          <span className="text-xs text-ink-dim">{when(run.startedAt ?? run.queuedAt)}</span>
          {run.durationMs != null && (
            <span className="text-xs text-ink-faint">{Math.round(run.durationMs / 1000)}s</span>
          )}
          {run.costUsd != null && (
            <span className="text-xs text-ink-faint" title="Reported run cost">
              {formatUsd(run.costUsd)}
            </span>
          )}
          {run.tokens != null && (
            <span className="text-xs text-ink-faint" title="Total tokens">
              {formatTokens(run.tokens)} tok
            </span>
          )}
          {run.trigger === "manual" && <span className="text-xs text-queue">manual</span>}
        </button>
        {extraActions}
        {isRunning && onCancel && (
          <button
            type="button"
            disabled={cancelling}
            onClick={async () => {
              setCancelling(true);
              try {
                await onCancel(run.id);
              } finally {
                setCancelling(false);
              }
            }}
            className="rounded-md border border-fail/30 px-2 py-0.5 text-xs text-fail hover:bg-fail/10 disabled:opacity-50"
          >
            {cancelling ? "Cancelling…" : "Cancel"}
          </button>
        )}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-label={open ? "Collapse run" : "Expand run"}
          className="text-xs text-ink-faint"
        >
          {open ? "▲" : "▼"}
        </button>
      </div>
      {open && (
        <div className="space-y-3 border-t border-line px-3 py-3 text-sm">
          {run.error && (
            <p className="whitespace-pre-wrap leading-relaxed text-fail">{run.error}</p>
          )}
          {run.resultSummary && (
            <p className="max-w-prose whitespace-pre-wrap leading-relaxed text-ok">
              {run.resultSummary}
            </p>
          )}
          {run.sessionId && run.project && (
            <a
              href={`#/sessions/${encodeURIComponent(run.project)}/${encodeURIComponent(run.sessionId)}`}
              className="inline-block font-mono text-xs text-queue hover:underline"
              title="Open this run's transcript"
            >
              transcript: {run.sessionId.slice(0, 8)}
            </a>
          )}
          <RunLog id={run.id} running={isRunning} />
        </div>
      )}
    </li>
  );
}

function RunLog({ id, running }: { id: string; running: boolean }) {
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

  if (log === null) return <p className="text-xs text-ink-faint">loading…</p>;
  if (failed) return <p className="text-xs text-ink-faint">Couldn't load the run log.</p>;

  const parsed = parseRunLog(log);
  if (parsed.kind === "empty") return null;
  return (
    <div className="rounded-lg bg-black/30 p-3">
      {parsed.truncated && (
        <p className="mb-2 text-[11px] text-ink-faint">Showing the end of a longer log.</p>
      )}
      {parsed.kind === "envelope" ? (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-xs">
          {parsed.fields.map((f) => (
            <Fragment key={f.label}>
              <dt className="text-ink-faint">{f.label}</dt>
              <dd className="font-mono text-ink-dim">{f.value}</dd>
            </Fragment>
          ))}
        </dl>
      ) : (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-ink-dim">
          {parsed.text}
        </pre>
      )}
    </div>
  );
}
