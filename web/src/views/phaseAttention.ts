import type { DsStatus, PhasePill } from "../ds";

/**
 * The phase the reader is most likely asking about, in attention order: a gate
 * waiting on them, then a failure, then live work, then a stop; with nothing
 * moving, the next phase still to run — or, when everything ran, the last one.
 *
 * This is what the focus panel shows when no chip is pinned, so it is also the
 * board's definition of "what matters right now"; kept out of the component so
 * the ordering is testable as the policy it is.
 */
export function attentionPhase(phases: PhasePill[]): string | null {
  if (phases.length === 0) return null;
  const by = (s: DsStatus) => phases.find((p) => p.status === s);
  const hit = by("await") ?? by("failed") ?? by("working") ?? by("stopped");
  if (hit) return hit.id;
  const next = phases.find((p) => p.status !== "done");
  return (next ?? phases[phases.length - 1]).id;
}
