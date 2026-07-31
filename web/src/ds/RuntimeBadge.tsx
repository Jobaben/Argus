import type { AgentRuntimeId } from "../types";

/**
 * Which agent produced this run.
 *
 * Shown only for runs that are *not* on the given baseline — the server default
 * for a run list, the pipeline's runtime for a step. A badge on every row when
 * every row says the same thing is noise; a badge on the one row that differs
 * is the whole point, and answers "why does this phase behave differently" at a
 * glance.
 */
export function RuntimeBadge({
  runtime,
  baseline,
  title,
}: {
  runtime: AgentRuntimeId | null | undefined;
  /** Suppress the badge when the runtime matches this. */
  baseline?: AgentRuntimeId | null;
  title?: string;
}) {
  if (!runtime || (baseline && runtime === baseline)) return null;
  const label = runtime === "codex" ? "codex" : "claude";
  return (
    <span
      className="rounded border border-line px-1 py-px font-mono text-[10px] uppercase tracking-wide text-ink-faint"
      title={title ?? `Run by the ${runtime === "codex" ? "Codex" : "Claude Code"} CLI`}
    >
      {label}
    </span>
  );
}
