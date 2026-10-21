import { useState } from "react";
import { createPortal } from "react-dom";
import { Button, Card, Icon, Skeleton, chipClass, formatMs, formatUsd } from "../ds";
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
  // A neutral chip either way — confidence is not a status — with the figure
  // drawn as a three-step gauge so a weak diagnosis reads as weak at a glance.
  const steps = pct >= 70 ? 3 : pct >= 40 ? 2 : 1;
  return (
    <span className={chipClass()} title="How sure the postmortem is">
      <span aria-hidden="true" className="flex items-end gap-px">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={`w-[3px] rounded-[1px] ${i < steps ? "bg-ink-dim" : "bg-line-strong"}`}
            style={{ height: `${5 + i * 2}px` }}
          />
        ))}
      </span>
      {pct}% confident
    </span>
  );
}

/** The card's top line: what it is, and what producing it cost. */
function Header({ children, cost }: { children?: React.ReactNode; cost?: React.ReactNode }) {
  return (
    <div className="mb-3 flex min-h-5 flex-wrap items-center gap-x-3 gap-y-1">
      <h2 className="eyebrow flex items-center gap-1.5">
        <Icon name="activity" size={13} />
        Autopsy
      </h2>
      {children}
      {cost && <span className="ml-auto text-caption text-ink-faint">{cost}</span>}
    </div>
  );
}

export function AutopsyPanel({
  runId,
  onSeek,
  fallbackSlot,
}: {
  runId: string;
  /** Move the Flight Recorder's playhead to the span the postmortem cites. */
  onSeek?: (atMs: number) => void;
  /**
   * Where to render when the postmortem pass produced nothing — switched off,
   * or failed itself. That is a note about the tool, not about the run, so the
   * recorder sends it below the track rather than letting it headline a failed
   * run's page. Rendered in place when absent.
   */
  fallbackSlot?: HTMLElement | null;
}) {
  const { autopsy, eligible, unavailable, loading, busy, actionError, analyse, relaunch } =
    useAutopsy(runId);
  const [launched, setLaunched] = useState<string | null>(null);

  if (!eligible && !autopsy) return null;

  const cost = autopsy?.costUsd != null && (
    <span title="What this postmortem cost">
      {formatUsd(autopsy.costUsd)}
      {autopsy.durationMs != null && ` · ${formatMs(autopsy.durationMs)}`}
    </span>
  );

  if (loading && !autopsy) {
    return (
      <Card>
        <Header />
        <p className="text-small text-ink-faint">Looking for a postmortem…</p>
        <Skeleton className="mt-3 h-3 w-3/5" />
        <Skeleton className="mt-2 h-3 w-2/5" />
      </Card>
    );
  }

  if (!autopsy) {
    return (
      <Card>
        <Header />
        <p className="mb-4 max-w-prose text-small text-ink-dim">
          {unavailable ??
            "No postmortem yet. Argus writes one automatically for recent failures; you can also ask for one now."}
        </p>
        <ActionRow busy={busy} error={actionError}>
          <Button
            variant="primary"
            icon="sparkle"
            disabled={busy || unavailable != null}
            onClick={() => void analyse()}
          >
            {busy ? "Analysing…" : "Analyse this failure"}
          </Button>
        </ActionRow>
      </Card>
    );
  }

  // One quiet line, not a card: the run's own failure is the page's headline,
  // and this pass's error ("did not answer with JSON") used to sit above it in
  // a panel of its own.
  if (autopsy.status !== "ready") {
    const note = (
      <div className="rounded-tile bg-ground-2/60 px-4 py-2">
        <div className="flex flex-wrap items-start gap-x-3 gap-y-1.5 sm:items-center">
          <Icon name="activity" size={14} className="mt-px shrink-0 text-ink-faint sm:mt-0" />
          <p className="min-w-0 flex-1 basis-60 text-caption text-ink-faint">
            <span className="font-semibold text-ink-dim">Autopsy</span>{" "}
            {autopsy.status === "skipped"
              ? "Postmortems are switched off on this server (ARGUS_ANALYSIS=off)."
              : `The postmortem pass didn't produce an explanation: ${autopsy.error ?? "unknown reason"}`}
            {cost && <span className="whitespace-nowrap"> · {cost}</span>}
          </p>
          <Button
            variant="ghost"
            size="sm"
            icon="retry"
            disabled={busy}
            onClick={() => void analyse()}
            className="-my-0.5"
          >
            {busy ? "Retrying…" : "Try again"}
          </Button>
        </div>
        <ActionRow busy={busy} error={actionError} />
      </div>
    );
    return fallbackSlot ? createPortal(note, fallbackSlot) : note;
  }

  return (
    <Card>
      <Header cost={cost} />
      {/* The diagnosis is the headline: its class, how sure it is, then why. */}
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {autopsy.failureClass && (
          <h3 className="text-title font-semibold text-ink">{CLASS_LABEL[autopsy.failureClass]}</h3>
        )}
        <Confidence value={autopsy.confidence} />
      </div>
      <p className="mb-4 max-w-prose text-body text-ink-dim">{autopsy.why}</p>

      {autopsy.span && (
        <div className="mb-4 rounded-tile border border-line bg-ground-2/60 px-3.5 py-3">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <p className="eyebrow">Where it went wrong</p>
            {onSeek && (
              <Button
                size="sm"
                icon="play"
                className="-my-1"
                onClick={() => onSeek(autopsy.span!.fromMs)}
              >
                Scrub to {(autopsy.span.fromMs / 1000).toFixed(1)}s
              </Button>
            )}
          </div>
          {autopsy.span.quote && (
            <p className="mt-2 break-words font-mono text-caption leading-relaxed text-ink-dim">
              “{autopsy.span.quote}”
            </p>
          )}
        </div>
      )}

      {autopsy.promptDelta && (
        <details className="group mb-4 rounded-tile border border-line bg-ground-2/60">
          <summary className="flex cursor-pointer list-none select-none items-start gap-2 rounded-tile px-3.5 py-2.5 text-small transition-colors duration-(--duration-quick) hover:bg-surface-2/50 [&::-webkit-details-marker]:hidden">
            <Icon
              name="chevron-right"
              size={15}
              className="mt-[2px] text-ink-faint transition-transform duration-(--duration-quick) ease-(--ease-out-expo) group-open:rotate-90"
            />
            <span className="min-w-0">
              <span className="text-small font-semibold text-ink">Proposed prompt</span>
              {autopsy.deltaRationale && (
                <span className="text-caption text-ink-faint"> — {autopsy.deltaRationale}</span>
              )}
            </span>
          </summary>
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words border-t border-line p-3.5 font-mono text-caption leading-relaxed text-ink-dim">
            {autopsy.promptDelta}
          </pre>
        </details>
      )}

      <ActionRow busy={busy} error={actionError}>
        {autopsy.promptDelta && (
          <Button
            variant="primary"
            icon="replay"
            disabled={busy}
            onClick={() => {
              void relaunch().then((id) => setLaunched(id));
            }}
            title="Fire the proposed prompt once, as a one-off. Your schedule is not changed."
          >
            {busy ? "Launching…" : "Relaunch with fix"}
          </Button>
        )}
        <Button icon="retry" disabled={busy} onClick={() => void analyse()}>
          Re-analyse
        </Button>
        {autopsy.promptDelta && (
          <span className="text-caption text-ink-faint">
            fires once as a one-off — your schedule is untouched
          </span>
        )}
      </ActionRow>

      {launched && (
        <p className="mt-3 flex items-center gap-2 text-small text-ok">
          <Icon name="check-circle" size={15} />
          <span>
            Launched.{" "}
            <a
              href={`#/run/${encodeURIComponent(launched)}`}
              className="text-eye underline decoration-eye/40 underline-offset-2 hover:decoration-eye"
            >
              Watch it here.
            </a>
          </span>
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
  children?: React.ReactNode;
}) {
  return (
    <>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
      {error && (
        <p role="alert" className="mt-3 flex items-start gap-2 text-small text-fail">
          <Icon name="alert" size={15} className="mt-0.5" />
          <span className="min-w-0 break-words">
            {error}
            {/* The server's 401 body says "auth required", which is true and
                unhelpful; say what to do about it. */}
            {/auth/i.test(error) && " — sign in to run agent actions."}
          </span>
        </p>
      )}
      {busy && <span className="sr-only">Working…</span>}
    </>
  );
}
