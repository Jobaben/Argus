import { useLiveResource } from "./live/useLiveResource";

import type { Task } from "@argus/contracts";

export type { Task };

/** Loads the task-directory list. No push event, so polls on a 10s timer. */
export function useTasks() {
  const { data, loading, error, refresh } = useLiveResource<Task[]>("/api/tasks", {
    select: (j) => (j as { tasks?: Task[] }).tasks ?? [],
    initial: [],
    pollMs: 10000,
  });
  return { tasks: data, loading, error, refresh };
}
