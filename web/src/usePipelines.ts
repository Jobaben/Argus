import { useCallback } from "react";
import { useLiveResource } from "./live/useLiveResource";
import type { InstanceStatus, PipelineDefinition, PipelineInput } from "./types";

/**
 * The server refused an edit because instances are still running (or waiting
 * at a gate) under the current definition. They keep the definition they
 * started with, so the edit would only show on the next start; the caller
 * decides whether that is what the author meant and retries with `force`.
 */
export class InstancesRunningError extends Error {
  readonly instances: { id: string; status: InstanceStatus }[];
  constructor(message: string, instances: { id: string; status: InstanceStatus }[]) {
    super(message);
    this.name = "InstancesRunningError";
    this.instances = instances;
  }
}

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
        const msg = (await res.json().catch(() => ({}))) as {
          error?: string;
          code?: string;
          instances?: { id: string; status: InstanceStatus }[];
        };
        if (res.status === 409 && msg.code === "instances-running") {
          throw new InstancesRunningError(msg.error ?? `HTTP ${res.status}`, msg.instances ?? []);
        }
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
  /** `force` saves over the server's running-instances refusal. */
  const update = useCallback(
    (id: string, input: PipelineInput, opts: { force?: boolean } = {}) =>
      mutate(`/api/pipelines/${id}${opts.force ? "?force=1" : ""}`, "PUT", input),
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
  const rotateHookToken = useCallback(
    (id: string) => mutate(`/api/pipelines/${id}/hook-token/rotate`, "POST"),
    [mutate],
  );

  return {
    pipelines: data,
    loading,
    error,
    refresh,
    create,
    update,
    remove,
    setEnabled,
    runNow,
    rotateHookToken,
  };
}
