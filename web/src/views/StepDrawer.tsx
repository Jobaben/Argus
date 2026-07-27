import { Fragment, useEffect, useState } from "react";
import type { Run } from "../types";
import type { StepPill } from "../ds";
import {
  Drawer,
  Skeleton,
  StatusPill,
  formatMs,
  formatTokens,
  formatUsd,
  parseRunLog,
} from "../ds";

/**
 * Everything Argus knows about one step of a pipeline, without leaving the board.
 *
 * Before this, a step tile was a dead end: it showed a status, a truncated
 * activity line and a job id, and the only way to see *why* it failed was to
 * find the same run again in another tab. The drawer opens on the tile, tails
 * the live log while the step runs, and links out to the transcript.
 */

export interface StepSelection {
  step: StepPill;
  pipelineName: string;
  phaseName: string;
  /** The failure reason from the phase payload, when the phase failed. */
  reason: string | null;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Fragment>
      <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">{label}</dt>
      <dd className="min-w-0 break-words text-[12.5px] text-ink-dim">{children}</dd>
    </Fragment>
  );
}

/**
 * The run behind a step, fetched on open.
 *
 * Polls only while the step is still running: the log is append-only, so a
 * finished run has nothing more to say and a timer on it would be pure waste.
 */
function useRunDetail(runId: string | null, running: boolean) {
  const [state, setState] = useState<{
    run: Run | null;
    log: string;
    loading: boolean;
    error: string | null;
  }>({ run: null, log: "", loading: runId !== null, error: null });

  useEffect(() => {
    if (runId === null) return;
    let alive = true;
    const controller = new AbortController();
    const load = async () => {
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as Run & { log?: string };
        if (!alive) return;
        setState({ run: body, log: body.log ?? "", loading: false, error: null });
      } catch (e) {
        if (!alive || controller.signal.aborted) return;
        setState((s) => ({
          ...s,
          loading: false,
          error: e instanceof Error ? e.message : String(e),
        }));
      }
    };
    void load();
    const poll = running ? setInterval(() => void load(), 3000) : null;
    return () => {
      alive = false;
      controller.abort();
      if (poll) clearInterval(poll);
    };
  }, [runId, running]);

  return state;
}

function RunLog({ log }: { log: string }) {
  const parsed = parseRunLog(log);
  if (parsed.kind === "empty") {
    return <p className="text-[12px] text-ink-faint">No output recorded yet.</p>;
  }
  return (
    <div className="rounded-lg bg-black/30 p-3">
      {parsed.truncated && (
        <p className="mb-2 text-[10.5px] text-ink-faint">Showing the end of a longer log.</p>
      )}
      {parsed.kind === "envelope" ? (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-[12px]">
          {parsed.fields.map((f) => (
            <Fragment key={f.label}>
              <dt className="text-ink-faint">{f.label}</dt>
              <dd className="break-words font-mono text-ink-dim">{f.value}</dd>
            </Fragment>
          ))}
        </dl>
      ) : (
        <pre className="max-h-[40vh] overflow-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-ink-dim">
          {parsed.text}
        </pre>
      )}
    </div>
  );
}

export function StepDrawer({
  selection,
  onClose,
  onCancelRun,
}: {
  selection: StepSelection | null;
  onClose: () => void;
  /** Cancel the step's run. Absent when the viewer cannot act. */
  onCancelRun?: (runId: string) => Promise<unknown>;
}) {
  const step = selection?.step ?? null;
  const runId = step?.runId ?? null;
  const running = step?.status === "working";
  const detail = useRunDetail(selection ? runId : null, running);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  if (!selection || !step)
    return <Drawer open={false} title="" onClose={onClose} children={null} />;

  const run = detail.run;
  const transcriptHref =
    run?.sessionId && run.project
      ? `#/sessions/${encodeURIComponent(run.project)}/${encodeURIComponent(run.sessionId)}`
      : null;

  return (
    <Drawer
      open
      onClose={onClose}
      title={step.name}
      subtitle={`${selection.pipelineName} · ${selection.phaseName}`}
      footer={
        <div className="flex items-center gap-2">
          {transcriptHref && (
            <a
              href={transcriptHref}
              onClick={onClose}
              className="rounded-md border border-line px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.1em] text-queue transition duration-(--duration-quick) hover:border-queue/50"
            >
              Open transcript
            </a>
          )}
          {running && runId && onCancelRun && (
            <button
              type="button"
              disabled={cancelling}
              onClick={() => {
                setCancelling(true);
                setCancelError(null);
                void onCancelRun(runId)
                  .catch((e: unknown) => setCancelError(e instanceof Error ? e.message : String(e)))
                  .finally(() => setCancelling(false));
              }}
              className="rounded-md border border-fail/40 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.1em] text-fail transition duration-(--duration-quick) hover:bg-fail/10 disabled:opacity-40"
            >
              {cancelling ? "Cancelling…" : "Cancel run"}
            </button>
          )}
          {cancelError && (
            <span role="alert" className="font-mono text-[10px] text-fail">
              {cancelError}
            </span>
          )}
          <span className="ml-auto">
            <StatusPill status={step.status} />
          </span>
        </div>
      }
    >
      <dl className="grid grid-cols-[max-content_1fr] gap-x-5 gap-y-2">
        <Field label="job">
          <span className="font-mono">{runId ?? "—"}</span>
        </Field>
        {step.model && <Field label="model">{step.model}</Field>}
        {step.startedAt && (
          <Field label="started">{new Date(step.startedAt).toLocaleString()}</Field>
        )}
        {step.durationMs != null && <Field label="duration">{formatMs(step.durationMs)}</Field>}
        {step.tokens != null && <Field label="tokens">{formatTokens(step.tokens)}</Field>}
        {step.costUsd != null && <Field label="cost">{formatUsd(step.costUsd)}</Field>}
        {step.currentActivity && <Field label="activity">{step.currentActivity}</Field>}
      </dl>

      {selection.reason && (
        <p className="mt-4 whitespace-pre-wrap rounded-lg border border-fail/30 bg-fail/10 px-3 py-2 text-[12.5px] leading-relaxed text-[#ffc4ca]">
          {selection.reason}
        </p>
      )}

      {run?.resultSummary && (
        <p className="mt-4 whitespace-pre-wrap text-[12.5px] leading-relaxed text-ok">
          {run.resultSummary}
        </p>
      )}

      <section className="mt-5">
        <h3 className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
          {running ? "Log (tailing)" : "Log"}
        </h3>
        {runId === null ? (
          <p className="text-[12px] text-ink-faint">
            This step hasn't started, so there is no run to show yet.
          </p>
        ) : detail.loading ? (
          <div role="status" aria-busy="true">
            <span className="sr-only">Loading the run log…</span>
            <Skeleton className="h-3 w-full" />
            <Skeleton className="mt-2 h-3 w-4/5" />
            <Skeleton className="mt-2 h-3 w-2/3" />
          </div>
        ) : detail.error ? (
          <p role="alert" className="text-[12px] text-fail">
            Couldn't load the run: {detail.error}
          </p>
        ) : (
          <RunLog log={detail.log} />
        )}
      </section>
    </Drawer>
  );
}
