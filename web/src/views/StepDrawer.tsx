import { Drawer } from "../ds/Drawer";
import { Fragment, useEffect, useState } from "react";
import { runtimeLabel } from "../useRuntimes";
import type { Run, StepCompletion } from "../types";
import type { StepPill } from "../ds";
import {
  Button,
  ButtonLink,
  Icon,
  Skeleton,
  StatusPill,
  formatMs,
  formatTokens,
  formatUsd,
  parseRunLog,
} from "../ds";
import { withoutOutcome } from "./outcome";

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
  /**
   * Viewport Y of the step tile this came from, so the drawer grows out of that
   * row rather than out of an anonymous point at the screen's edge. Optional:
   * a selection made from the keyboard has no row to grow from, and a drawer
   * that invented one would be lying about where you were.
   */
  originY?: number;
}

/**
 * One line for how the run's own completion report was received. Worded as the
 * agent's report on purpose: a marker is never independent verification, so
 * nothing here says "verified".
 */
function completionLabel(c: StepCompletion): string {
  const marker =
    c.marker === "missing"
      ? "no outcome marker"
      : c.marker === "conflicting"
        ? "conflicting outcome markers"
        : `agent reported ${c.marker}`;
  const via = c.source === "run-record" ? " (read from the run record)" : "";
  const hook =
    c.hook && !c.hook.agrees ? `; hook reported ${c.hook.marker ?? "malformed metadata"}` : "";
  if (c.verdict === "accepted") {
    return `${marker}${via} — accepted${c.marker === "missing" ? " under the lenient policy" : ""}${hook}`;
  }
  if (c.verdict === "refused") return `${marker}${via} — completion refused${hook}`;
  return `${marker}${via}${hook}`;
}

/**
 * A labelled value. The labels are lower-case in the DOM — they are the
 * vocabulary the rest of Argus (and its tests) uses — and set in sentence case
 * on screen.
 */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Fragment>
      <dt className="text-caption text-ink-faint first-letter:uppercase">{label}</dt>
      <dd className="min-w-0 break-words text-small text-ink-dim">{children}</dd>
    </Fragment>
  );
}

/** One figure in the readout strip at the top of the drawer. */
function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-caption text-ink-faint">{label}</span>
      <span className="flex min-h-6 items-center text-heading font-semibold text-ink">
        {children}
      </span>
    </div>
  );
}

/** Nested regions are inset wells, not more outlined boxes. */
const WELL = "rounded-tile border border-line bg-ground-2/60";

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
        // The record and its log tail arrive side by side, not merged.
        const body = (await res.json()) as { run: Run; log?: string };
        if (!alive) return;
        setState({ run: body.run, log: body.log ?? "", loading: false, error: null });
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

/**
 * The envelope's fields that are not already in the readout above it.
 *
 * Its cost and tokens are the stat row's figures again (in other units), and
 * its "Status" is the CLI process's exit — a failed step whose process exited
 * cleanly showed a red "Failed" pill over a log reading "Status success". The
 * process's word is kept, said as what it is.
 */
function envelopeFields(
  fields: { label: string; value: string }[],
  shown: { cost: boolean; tokens: boolean; duration: boolean },
) {
  return fields.flatMap((f) => {
    if (f.label === "Cost" && shown.cost) return [];
    if (f.label === "Tokens" && shown.tokens) return [];
    if (f.label === "Duration" && shown.duration) return [];
    // Claude Code's envelope: "success", or "error (<subtype>)".
    if (f.label === "Status" && f.value === "success") {
      return [{ label: "Process", value: "exited cleanly" }];
    }
    if (f.label === "Status" && f.value.startsWith("error")) return [{ ...f, label: "Process" }];
    return [f];
  });
}

/** Envelope fields whose value is an identifier. */
const MACHINE_FIELDS = new Set(["Session", "Thread", "API error"]);

function RunLog({
  log,
  shown,
}: {
  log: string;
  /** Which figures the drawer's readout already shows. */
  shown: { cost: boolean; tokens: boolean; duration: boolean };
}) {
  const parsed = parseRunLog(log);
  if (parsed.kind === "empty") {
    return <p className={`${WELL} px-4 py-4 text-small text-ink-faint`}>No output recorded yet.</p>;
  }
  return (
    <div className={`${WELL} overflow-hidden`}>
      {parsed.truncated && (
        <p className="flex items-center gap-2 border-b border-line px-4 py-2 text-caption text-ink-faint">
          <Icon name="info" size={13} />
          Showing the end of a longer log.
        </p>
      )}
      {parsed.kind === "envelope" ? (
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-6 gap-y-2 px-4 py-3.5">
          {envelopeFields(parsed.fields, shown).map((f) => (
            <Fragment key={f.label}>
              <dt className="text-caption text-ink-faint">{f.label}</dt>
              {/* Mono for the ids only: durations, counts and the process's
                  word are read, not copied. */}
              <dd
                className={`break-words text-caption text-ink-dim ${
                  MACHINE_FIELDS.has(f.label) ? "font-mono" : ""
                }`}
              >
                {f.value}
              </dd>
            </Fragment>
          ))}
        </dl>
      ) : (
        <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words px-4 py-3.5 font-mono text-caption leading-relaxed text-ink-dim">
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
  // The agent's prose without its protocol line, which the status pill below
  // already says; a bare marker with no reason leaves nothing worth a panel.
  const summary = withoutOutcome(run?.resultSummary) || null;
  const transcriptHref =
    run?.sessionId && run.project
      ? `#/sessions/${encodeURIComponent(run.project)}/${encodeURIComponent(run.sessionId)}`
      : null;

  const canCancel = running && runId !== null && onCancelRun !== undefined;

  return (
    <Drawer
      open
      onClose={onClose}
      originY={selection.originY}
      title={step.name}
      subtitle={`${selection.pipelineName} · ${selection.phaseName}`}
      footer={
        transcriptHref || canCancel || cancelError ? (
          <div className="flex flex-wrap items-center gap-2">
            {transcriptHref && (
              <ButtonLink href={transcriptHref} onClick={onClose} icon="terminal">
                Open transcript
              </ButtonLink>
            )}
            {cancelError && (
              <span
                role="alert"
                className="flex min-w-0 items-center gap-1.5 text-caption text-fail"
              >
                <Icon name="alert" size={14} />
                <span className="min-w-0 break-words">{cancelError}</span>
              </span>
            )}
            {canCancel && (
              // Destructive, so it stands apart at the far end rather than
              // beside the way out to the transcript.
              <Button
                variant="danger"
                icon="stop"
                className="ml-auto"
                disabled={cancelling}
                onClick={() => {
                  setCancelling(true);
                  setCancelError(null);
                  void onCancelRun(runId)
                    .catch((e: unknown) =>
                      setCancelError(e instanceof Error ? e.message : String(e)),
                    )
                    .finally(() => setCancelling(false));
                }}
              >
                {cancelling ? "Cancelling…" : "Cancel run"}
              </Button>
            )}
          </div>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-6">
        {/* The outcome first: why it failed, or what it produced. */}
        {selection.reason && (
          <div className="flex items-start gap-2.5 rounded-tile border border-fail/30 bg-fail/[0.07] px-4 py-3">
            <Icon name="x-circle" size={17} className="mt-0.5 text-fail" />
            <p className="min-w-0 whitespace-pre-wrap break-words text-small leading-relaxed text-fail-ink">
              {selection.reason}
            </p>
          </div>
        )}

        {summary &&
          (step.status === "done" ? (
            <div className="flex items-start gap-2.5 rounded-tile border border-ok/25 bg-ok/[0.06] px-4 py-3">
              <Icon name="check-circle" size={17} className="mt-0.5 text-ok" />
              <p className="min-w-0 whitespace-pre-wrap break-words text-small leading-relaxed text-ink">
                {summary}
              </p>
            </div>
          ) : (
            // A failed or stopped run still leaves the agent's last word, but
            // that is not a result: it sits in a plain well, so green keeps
            // meaning done.
            <div className={`${WELL} flex items-start gap-2.5 px-4 py-3`}>
              <Icon name="message" size={17} className="mt-0.5 text-ink-faint" />
              <p className="min-w-0 whitespace-pre-wrap break-words text-small leading-relaxed text-ink-dim">
                {summary}
              </p>
            </div>
          ))}

        <div
          className={`${WELL} grid grid-cols-2 gap-x-6 gap-y-4 px-4 py-3.5 sm:flex sm:flex-wrap sm:gap-x-10`}
        >
          <Stat label="Status">
            <StatusPill status={step.status} />
          </Stat>
          {step.durationMs != null && <Stat label="Duration">{formatMs(step.durationMs)}</Stat>}
          {step.tokens != null && <Stat label="Tokens">{formatTokens(step.tokens)}</Stat>}
          {step.costUsd != null && <Stat label="Cost">{formatUsd(step.costUsd)}</Stat>}
        </div>

        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-6 gap-y-2.5">
          <Field label="job">
            {runId === null ? (
              <span className="font-mono text-caption">—</span>
            ) : (
              // The run itself is one click further: its Flight Recorder replay.
              <a
                href={`#/run/${encodeURIComponent(runId)}`}
                onClick={onClose}
                title="Open this run in the Flight Recorder"
                className="break-all rounded-sm font-mono text-caption text-ink-dim underline decoration-line-strong underline-offset-[3px] transition-colors duration-(--duration-quick) hover:text-ink hover:decoration-ink-faint"
              >
                {runId}
              </a>
            )}
          </Field>
          {step.candidate && (
            // Best-of-N: which draft this is, and what became of it. Stated in
            // words rather than as a status token, because "aborted" is exactly
            // the wrong word for a draft that simply was not the one chosen.
            <Field label="candidate">
              <span className="font-mono text-caption">
                c{step.candidate.index + 1} of {step.candidate.total}
              </span>
              {step.selected
                ? " · selected"
                : step.superseded
                  ? " · superseded by the winner"
                  : step.verified === true
                    ? " · checks passed"
                    : step.verified === false
                      ? " · checks failed"
                      : ""}
            </Field>
          )}
          {step.completion && (
            <Field label="completion">
              <span title={step.completion.reason ?? undefined}>
                {completionLabel(step.completion)}
              </span>
            </Field>
          )}
          {step.model && <Field label="model">{step.model}</Field>}
          {step.runtime && (
            <Field label="runtime">{runtimeLabel(step.runtime) || step.runtime}</Field>
          )}
          {step.workspace && (
            // The branch is the deliverable of an isolated phase; the directory it
            // ran in is disposable, so it rides along as the title rather than
            // taking a line of its own.
            <Field label="workspace">
              <span className="break-all font-mono text-caption" title={step.workspace.path}>
                {step.workspace.branch}
              </span>
            </Field>
          )}
          {step.startedAt && (
            <Field label="started">{new Date(step.startedAt).toLocaleString()}</Field>
          )}
          {run?.deadlineAt && run.startedAt && (
            <Field label="timeout">
              {formatMs(Math.max(0, Date.parse(run.deadlineAt) - Date.parse(run.startedAt)))}
            </Field>
          )}
          {run?.stallSeconds != null && (
            <Field label="stall">no output for {run.stallSeconds}s</Field>
          )}
          {step.currentActivity && <Field label="activity">{step.currentActivity}</Field>}
        </dl>

        <section className="flex flex-col gap-3">
          <div className="flex min-h-5 items-center justify-between gap-3">
            <h3 className="eyebrow">Log</h3>
            {running && runId !== null && (
              // Live, so it wears the eye's colour: this is the one thing on the
              // drawer that changes while you watch it.
              <span className="inline-flex items-center gap-1.5 text-caption text-eye">
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 rounded-full bg-current motion-safe:animate-[pulse_var(--duration-pulse)_ease-in-out_infinite]"
                />
                Tailing
              </span>
            )}
          </div>
          {runId === null ? (
            <p className={`${WELL} flex items-center gap-2 px-4 py-4 text-small text-ink-faint`}>
              <Icon name="clock" size={15} />
              This step hasn't started, so there is no run to show yet.
            </p>
          ) : detail.loading ? (
            <div role="status" aria-busy="true" className={`${WELL} px-4 py-4`}>
              <span className="sr-only">Loading the run log…</span>
              <Skeleton className="h-3 w-full" />
              <Skeleton className="mt-2 h-3 w-4/5" />
              <Skeleton className="mt-2 h-3 w-2/3" />
            </div>
          ) : detail.error ? (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-tile border border-fail/30 bg-fail/[0.07] px-4 py-3 text-small text-fail-ink"
            >
              <Icon name="alert" size={15} className="mt-0.5 text-fail" />
              <span className="min-w-0 break-words">Couldn't load the run: {detail.error}</span>
            </p>
          ) : (
            <RunLog
              log={detail.log}
              shown={{
                cost: step.costUsd != null,
                tokens: step.tokens != null,
                duration: step.durationMs != null,
              }}
            />
          )}
        </section>
      </div>
    </Drawer>
  );
}
