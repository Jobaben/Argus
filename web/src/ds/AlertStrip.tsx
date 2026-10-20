import type { ReactNode } from "react";
import { Icon } from "./Icon";
import { DURATION, useSyncedDelay } from "./motion";

/**
 * A strip that says something went wrong, and with what.
 *
 * Two different messages, which used to look identical: `failed` is a run that
 * failed — an event about your agents, with a pulsing badge because it is news —
 * and `error` is Argus itself not managing something (a load, a save), which is
 * a condition to fix rather than news to notice, and so does not pulse. Every
 * load error in the app used to arrive under a throbbing "FAILED" badge, which
 * read as though an agent had failed when the dashboard had merely lost the
 * server.
 */
export function AlertStrip({
  subject,
  message,
  when,
  tone = "error",
  action,
}: {
  subject: string;
  message: string;
  when?: string;
  tone?: "failed" | "error";
  /** A recovery control — "Retry", "Sign in" — set at the strip's far end. */
  action?: ReactNode;
}) {
  // In phase with every other ambient indicator on screen: several things
  // pulsing on unrelated rhythms reads as clutter, not as liveness.
  const beat = useSyncedDelay(DURATION.alert);
  return (
    <div
      role="status"
      className="flex w-full flex-wrap items-center gap-x-3 gap-y-2 rounded-tile border border-fail/35 bg-gradient-to-r from-fail/14 to-fail/[0.04] px-4 py-3"
    >
      {tone === "failed" ? (
        <span
          style={{ animationDelay: beat }}
          className="animate-[pulse_var(--duration-alert)_ease-in-out_infinite] rounded-full border border-fail/50 bg-fail/20 px-2.5 py-1 text-caption font-semibold leading-none text-fail"
        >
          Failed
        </span>
      ) : (
        <Icon name="alert" size={18} className="text-fail" />
      )}
      <span className="min-w-0 flex-1 text-small">
        <b className="font-semibold text-ink">{subject}</b>{" "}
        <span className="break-words text-fail-ink">{message}</span>
      </span>
      {when && <span className="text-caption text-ink-dim">{when}</span>}
      {action}
    </div>
  );
}
