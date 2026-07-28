import { useEffect, useRef } from "react";
import { useOmnibar } from "../useOmnibar";
import type { ExecuteStatus, PlannedMutation } from "../types";

/**
 * Intent mode: the panel that replaces the command list once you have typed a
 * sentence rather than a search term.
 *
 * The whole point is the middle screen. A command bar that acted on the
 * sentence directly would be faster and untrustworthy; this one always shows
 * the exact list of changes — every label and every before/after resolved by
 * the server from live state, never by the model — and does nothing at all
 * until the confirm button is pressed.
 */

const STATUS_TONE: Record<ExecuteStatus, string> = {
  applied: "text-ok",
  stale: "text-await",
  expired: "text-await",
  "rolled-back": "text-await",
  partial: "text-fail",
};

function MutationRow({ mutation }: { mutation: PlannedMutation }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 border-t border-line px-3 py-2 first:border-t-0">
      <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-faint">
        {mutation.kind.replace(".", " ")}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-ink">{mutation.targetLabel}</span>
      <span className="shrink-0 font-mono text-[11px] text-ink-faint">
        {mutation.before} <span aria-hidden="true">→</span>{" "}
        <span className="text-ink-dim">{mutation.after}</span>
      </span>
    </li>
  );
}

export function OmnibarIntent({ intent, onClose }: { intent: string; onClose: () => void }) {
  const { phase, plan, answer, result, error, compile, confirm } = useOmnibar();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const planned = useRef("");

  useEffect(() => {
    // One pass per sentence. A planning pass spends money and holds the single
    // analysis slot, so re-running it on every render would be expensive in a
    // way the user never asked for.
    if (planned.current === intent) return;
    planned.current = intent;
    void compile(intent);
  }, [intent, compile]);

  useEffect(() => {
    // The confirm is the decision, so it is where focus lands — the list above
    // it is readable with the arrow keys either way.
    if (phase === "preview" && plan?.status === "ready") confirmRef.current?.focus();
  }, [phase, plan?.status]);

  const busy = phase === "planning" || phase === "executing";

  return (
    <div className="max-h-[60vh] overflow-y-auto p-3" aria-busy={busy}>
      <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">
        {phase === "planning"
          ? "Working out what that means…"
          : phase === "answered"
            ? "Answer"
            : phase === "done"
              ? "Result"
              : "Proposed changes"}
      </p>

      <div role="status" aria-live="polite">
        {phase === "planning" && (
          <p className="px-1 text-sm text-ink-dim">
            Compiling “{intent}” into an explicit list of changes. Nothing happens until you
            confirm.
          </p>
        )}

        {error && (
          <p role="alert" className="px-1 text-sm text-fail">
            {error}
          </p>
        )}

        {phase === "answered" && answer && (
          <div className="px-1">
            <p className="text-sm text-ink">{answer.text}</p>
            {answer.links.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {answer.links.map((link) => (
                  <a
                    key={link.href}
                    href={link.href}
                    onClick={onClose}
                    className="rounded-md border border-line px-2 py-1 font-mono text-[11px] text-eye hover:border-eye/50"
                  >
                    {link.label}
                  </a>
                ))}
              </div>
            )}
          </div>
        )}

        {phase === "done" && result && (
          <div className="px-1">
            <p className={`text-sm font-semibold ${STATUS_TONE[result.status]}`}>
              {result.summary}
            </p>
            {result.error && (
              <p className="mt-1 font-mono text-[11px] text-ink-faint">{result.error}</p>
            )}
          </div>
        )}
      </div>

      {(phase === "preview" || phase === "executing") && plan && (
        <>
          <p className="mb-2 px-1 text-sm text-ink">{plan.summary}</p>

          {plan.mutations.length > 0 ? (
            <ul className="overflow-hidden rounded-tile border border-line bg-ground-2">
              {plan.mutations.map((m) => (
                <MutationRow key={`${m.kind}:${m.targetId}`} mutation={m} />
              ))}
            </ul>
          ) : (
            <p className="px-1 text-xs text-ink-faint">
              {plan.status === "unavailable"
                ? "No changes were proposed."
                : "Nothing would change, so there is nothing to confirm."}
            </p>
          )}

          {plan.warnings.length > 0 && (
            <ul className="mt-2 space-y-1 px-1">
              {plan.warnings.map((w) => (
                <li key={w} className="font-mono text-[11px] text-await">
                  • {w}
                </li>
              ))}
            </ul>
          )}

          <div className="mt-3 flex items-center gap-2 px-1">
            {plan.mutations.length > 0 && (
              <button
                ref={confirmRef}
                type="button"
                disabled={phase === "executing"}
                onClick={() => void confirm(plan.id)}
                className="rounded-md border border-eye/40 bg-eye/10 px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.1em] text-eye transition hover:bg-eye/20 disabled:opacity-50"
              >
                {phase === "executing"
                  ? "Applying…"
                  : `Apply ${plan.mutations.length} change${plan.mutations.length === 1 ? "" : "s"}`}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-faint hover:text-ink"
            >
              Cancel
            </button>
            <span className="ml-auto font-mono text-[10px] text-ink-faint">
              Argus applies all of it or none of it
            </span>
          </div>
        </>
      )}

      {phase === "done" && (
        <div className="mt-3 px-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-line px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.1em] text-ink-dim hover:text-ink"
          >
            Close
          </button>
        </div>
      )}
    </div>
  );
}
