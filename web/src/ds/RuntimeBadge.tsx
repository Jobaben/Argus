import { runtimeLabel } from "../useRuntimes";
import type { AgentRuntimeId } from "../types";
import { chipClass } from "./controls";

/**
 * Which agent produced this run.
 *
 * Shown only for runs that are *not* on the given baseline — the server default
 * for a run list, the pipeline's runtime for a step. A badge on every row when
 * every row says the same thing is noise; a badge on the one row that differs
 * is the whole point, and answers "why does this phase behave differently" at a
 * glance.
 *
 * A neutral chip: which CLI ran something is a category, not a status, so it
 * takes no status colour.
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
  const named = runtimeLabel(runtime);
  return (
    <span
      className={chipClass()}
      title={title ?? (named ? `Run by the ${named} CLI` : `Run by the ${runtime} CLI`)}
    >
      {runtime}
    </span>
  );
}
