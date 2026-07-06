import { useLiveResource } from "./live/useLiveResource";

export interface Task {
  id: string;
  highwatermark: number | null;
  locked: boolean;
  fileCount: number;
  updatedAt: string | null;
}

/** Loads the task-directory list. No push event, so polls on a 10s timer. */
export function useTasks() {
  const { data, loading, error, refresh } = useLiveResource<Task[]>("/api/tasks", {
    select: (j) => (j as { tasks?: Task[] }).tasks ?? [],
    initial: [],
    pollMs: 10000,
  });
  return { tasks: data, loading, error, refresh };
}
