import { useLiveResource } from "./live/useLiveResource";
import type { PipelineReliability } from "./types";

/**
 * A pipeline's first-attempt pass rate, lucky passes and stalls over a
 * trailing window. Refetches on `pipelines:changed` — the same broadcast the
 * board reacts to — since a finished instance is exactly what moves this.
 *
 * `pipelineId` of null (no selection yet) fetches nothing, matching the other
 * per-id resources in this file's neighbourhood (`useAutopsy`, `useVerdict`).
 */
export function useReliability(pipelineId: string | null, days = 30) {
  const { data, loading, error, updatedAt } = useLiveResource<PipelineReliability | null>(
    pipelineId ? `/api/pipelines/${encodeURIComponent(pipelineId)}/reliability?days=${days}` : null,
    {
      events: ["pipelines:changed"],
      select: (j) => j as PipelineReliability,
      initial: null,
    },
  );

  return { reliability: data, loading, error, updatedAt };
}
