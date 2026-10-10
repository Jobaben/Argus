import { useLiveResource } from "./live/useLiveResource";
import type { PhaseArtifactContent, PhaseReview } from "./types";

/**
 * What a paused phase left for a human to decide on — the review the drawer
 * renders. Read-only: the decision itself goes through `useOverview`'s
 * approve/revise, so there is exactly one module that acts on a gate.
 *
 * Refreshes on `pipelines:changed`, which is what approve, revise and a phase
 * running again all emit; a `null` selection fetches nothing.
 */
export function useGateReview(instanceId: string | null, phaseId: string | null) {
  const path =
    instanceId && phaseId
      ? `/api/instances/${encodeURIComponent(instanceId)}/phases/${encodeURIComponent(phaseId)}/review`
      : null;
  const { data, loading, error } = useLiveResource<PhaseReview | null>(path, {
    events: ["pipelines:changed"],
    select: (j) => j as PhaseReview,
    initial: null,
  });
  return { review: path ? data : null, loading, error };
}

/**
 * One artifact's bytes, fetched when it is selected. The caller keys the
 * viewer on the path and the attempt, so a phase that ran again after a revise
 * gets a fresh hook rather than the old file under the new listing.
 */
export function useArtifactContent(
  instanceId: string | null,
  phaseId: string | null,
  path: string | null,
) {
  const url =
    instanceId && phaseId && path
      ? `/api/instances/${encodeURIComponent(instanceId)}/phases/${encodeURIComponent(
          phaseId,
        )}/artifact?path=${encodeURIComponent(path)}`
      : null;
  const { data, loading, error } = useLiveResource<PhaseArtifactContent | null>(url, {
    events: ["pipelines:changed"],
    select: (j) => j as PhaseArtifactContent,
    initial: null,
  });
  return { content: url ? data : null, loading, error };
}
