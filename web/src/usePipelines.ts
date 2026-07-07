import { useCallback } from "react";
import { useLiveResource } from "./live/useLiveResource";
import type { PipelineDefinition, PipelineInput } from "./types";

/** Lists pipeline definitions, refreshing on "pipelines:changed", plus CRUD. */
export function usePipelines() {
  const { data, loading, error, refresh } = useLiveResource<PipelineDefinition[]>(
    "/api/pipelines",
    {
      events: ["pipelines:changed"],
      select: (j) => (j as { pipelines?: PipelineDefinition[] }).pipelines ?? [],
      initial: [],
    },
  );

  const mutate = useCallback(
    async (path: string, method: string, body?: unknown) => {
      const res = await fetch(path, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const msg = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(msg.error ?? `HTTP ${res.status}`);
      }
      await refresh();
      return res;
    },
    [refresh],
  );

  const create = useCallback(
    (input: PipelineInput) => mutate("/api/pipelines", "POST", input),
    [mutate],
  );
  const update = useCallback(
    (id: string, input: PipelineInput) => mutate(`/api/pipelines/${id}`, "PUT", input),
    [mutate],
  );
  const remove = useCallback((id: string) => mutate(`/api/pipelines/${id}`, "DELETE"), [mutate]);
  const setEnabled = useCallback(
    (id: string, enabled: boolean) => mutate(`/api/pipelines/${id}`, "PATCH", { enabled }),
    [mutate],
  );
  const runNow = useCallback(
    (id: string) => mutate(`/api/pipelines/${id}/start`, "POST"),
    [mutate],
  );

  return { pipelines: data, loading, error, refresh, create, update, remove, setEnabled, runNow };
}
