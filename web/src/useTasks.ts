import { useCallback, useEffect, useRef, useState } from "react";

export interface Task {
  id: string;
  highwatermark: number | null;
  locked: boolean;
  fileCount: number;
  updatedAt: string | null;
}

interface TasksState {
  tasks: Task[];
  loading: boolean;
  error: string | null;
}

/** Loads the task-directory list with loading/error state and refresh. */
export function useTasks(): TasksState & { refresh: () => void } {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/tasks");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { tasks: Task[] };
      if (!mounted.current) return;
      setTasks(data.tasks);
      setError(null);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const poll = setInterval(() => void refresh(), 10000);
    return () => {
      mounted.current = false;
      clearInterval(poll);
    };
  }, [refresh]);

  return { tasks, loading, error, refresh };
}
