import { useState } from "react";
import { Card, formatMs, formatUsd } from "../ds";
import { useAutopsy } from "../useAutopsy";
import type { FailureClass } from "../types";

/**
 * The postmortem, attached to the run it explains.
 *
 * Everything here is a *proposal*, and the panel is built so that reads as
 * true rather than as a caveat nobody notices: the class carries a confidence
 * figure, the span quotes the timeline line it is claiming about (so the claim
 * is checkable against the track right below it), and the proposed prompt is
 * shown in full before anything can be launched with it. The relaunch fires a
 * one-off — it never edits the schedule — because a model's rewrite of a prompt
 * that spends money unattended is a suggestion, not a migration.
 */

const CLASS_LABEL: Record<FailureClass, string> = {
  "prompt-ambiguity": "Ambiguous prompt",
  "missing-context": "Missing context",
  "tool-error": "Tool error",
  "permission-denied": "Permission denied",
  environment: "Environment",
  timeout: "Timeout",
  "rate-limit": "Rate limit",
  "model-refusal": "Model declined",
  "bad-output-format": "Bad output format",
  infrastructure: "Infrastructure",
  other: "Unclassified",
};

function Confidence({ value }: { value: number | null }) {
  if (value == null) return null;
  const pct = Math.round(value * 100);
  // Low confidence is shown, not hidden: an invisible caveat is not a caveat.
  const tone = pct >= 70 ? "text-ok" : pct >= 40 ? "text-await" : "text-ink-faint";
  return (
    <span
      className={`font-mono text-[10px] uppercase tracking-[0.12em] ${tone}`}
      title="How sure the postmortem is"
    >
      {pct}% confident
    </span>
  );
}

export function AutopsyPanel({
  runId,
  onSeek,
}: {
  runId: string;
  /** Move the Flight Recorder's playhead to the span the postmortem cites. */
  onSeek?: (atMs: number) => void;
}) {
  const { autopsy, eligible, unavailable, loading, busy, actionError, analyse, relaunch } =
    useAutopsy(runId);
  const [launched, setLaunched] = useState<string | null>(null);

  if (!eligible && !autopsy) return null;

  const heading = (
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <span className="font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-ink-faint">
        Autopsy
      </span>
      {autopsy?.failureClass && (
        <span className="rounded-full border border-await/40 bg-await/12 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-await">
          {CLASS_LABEL[autopsy.failureClass]}
        </span>
      )}
      {autopsy && <Confidence value={autopsy.confidence} />}
      {autopsy?.costUsd != null && (
        <span className="font-mono text-[10px] text-ink-faint" title="What this postmortem cost">
          {formatUsd(autopsy.costUsd)}
          {autopsy.durationMs != null && ` · ${formatMs(autopsy.durationMs)}`}
        </span>
      )}
    </div>
  );

  if (loading && !autopsy) {
    return (
      <Card>
        {heading}
        <p className="text-sm text-ink-faint">Looking for a postmortem…</p>
      </Card>
    );
  }

  if (!autopsy) {
    return (
      <Card>
        {heading}
        <p className="mb-3 max-w-prose text-sm text-ink-dim">
          {unavailable ??
            "No postmortem yet. Argus writes one automatically for recent failures; you can also ask for one now."}
        </p>
        <ActionRow busy={busy} error={actionError}>
          <button
            type="button"
            disabled={busy || unavailable != null}
            onClick={() => void analyse()}
            className="rounded-md border border-line px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.1em] text-ink-dim transition hover:text-ink disabled:opacity-50"
          >
            {busy ? "Analysing…" : "Analyse this failure"}
          </button>
        </ActionRow>
      </Card>
    );
  }

  if (autopsy.status !== "ready") {
    return (
      <Card>
        {heading}
        <p className="mb-3 max-w-prose text-sm text-ink-dim">
          {autopsy.status === "skipped"
            ? "Postmortems are switched off on this server (ARGUS_ANALYSIS=off)."
            : `The postmortem pass didn't produce an explanation: ${autopsy.error ?? "unknown reason"}`}
        </p>
        <ActionRow busy={busy} error={actionError}>
          <button
            type="button"
            disabled={busy}
            onClick={() => void analyse()}
            className="rounded-md border border-line px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.1em] text-ink-dim transition hover:text-ink disabled:opacity-50"
          >
            {busy ? "Retrying…" : "Try again"}
          </button>
        </ActionRow>
      </Card>
    );
  }

  return (
    <Card>
      {heading}
      <p className="mb-3 max-w-prose text-sm leading-relaxed text-ink">{autopsy.why}</p>

      {autopsy.span && (
        <div className="mb-3 rounded-md border border-line bg-ground-2 px-3 py-2">
          <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
            Where it went wrong
          </p>
          {autopsy.span.quote && (
            <p className="mb-1.5 break-words font-mono text-[11px] text-ink-dim">
              “{autopsy.span.quote}”
            </p>
          )}
          {onSeek && (
            <button
              type="button"
              onClick={() => onSeek(autopsy.span!.fromMs)}
              className="font-mono text-[11px] text-eye hover:underline"
            >
              ▶ scrub to {(autopsy.span.fromMs / 1000).toFixed(1)}s
            </button>
          )}
        </div>
      )}

      {autopsy.promptDelta && (
        <details className="mb-3 rounded-md border border-line">
          <summary className="cursor-pointer px-3 py-2 font-mono text-[11px] uppercase tracking-[0.12em] text-ink-dim">
            Proposed prompt
            {autopsy.deltaRationale && (
              <span className="ml-2 font-sans text-[11px] normal-case tracking-normal text-ink-faint">
                — {autopsy.deltaRationale}
              </span>
            )}
          </summary>
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words border-t border-line bg-ground-2 p-3 font-mono text-[11px] leading-relaxed text-ink-dim">
            {autopsy.promptDelta}
          </pre>
        </details>
      )}

      <ActionRow busy={busy} error={actionError}>
        {autopsy.promptDelta && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void relaunch().then((id) => setLaunched(id));
            }}
            className="rounded-md border border-eye/40 bg-eye/10 px-2.5 py-1 font-mono text-[11px] font-bold uppercase tracking-[0.1em] text-eye transition hover:bg-eye/20 disabled:opacity-50"
            title="Fire the proposed prompt once, as a one-off. Your schedule is not changed."
          >
            {busy ? "Launching…" : "Relaunch with fix"}
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => void analyse()}
          className="rounded-md border border-line px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.1em] text-ink-dim transition hover:text-ink disabled:opacity-50"
        >
          Re-analyse
        </button>
        {autopsy.promptDelta && (
          <span className="font-mono text-[10px] text-ink-faint">
            fires once as a one-off — your schedule is untouched
          </span>
        )}
      </ActionRow>

      {launched && (
        <p className="mt-2 text-sm text-ok">
          Launched.{" "}
          <a href={`#/run/${encodeURIComponent(launched)}`} className="text-eye hover:underline">
            Watch it here.
          </a>
        </p>
      )}
    </Card>
  );
}

function ActionRow({
  busy,
  error,
  children,
}: {
  busy: boolean;
  error: string | null;
  children: React.ReactNode;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-fail">
          {error}
          {/* The server's 401 body says "auth required", which is true and
              unhelpful; say what to do about it. */}
          {/auth/i.test(error) && " — sign in to run agent actions."}
        </p>
      )}
      {busy && <span className="sr-only">Working…</span>}
    </>
  );
}
