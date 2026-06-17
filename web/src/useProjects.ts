import { useCallback, useEffect, useRef, useState } from "react";

export interface Project {
  id: string;
  label: string;
  sessionCount: number;
  lastActivity: string | null;
}

interface ProjectsState {
  projects: Project[];
  loading: boolean;
  error: string | null;
}

/** Loads the project overview from /api/projects with polling refresh. */
export function useProjects(): ProjectsState & { refresh: () => void } {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/projects");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { projects: Project[] };
      if (!mounted.current) return;
      setProjects(data.projects);
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

  return { projects, loading, error, refresh };
}
