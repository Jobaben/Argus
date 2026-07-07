import { useLiveResource } from "./live/useLiveResource";

export interface Project {
  id: string;
  label: string;
  sessionCount: number;
  lastActivity: string | null;
}

/** Loads the project overview, refreshing on "agents:changed". */
export function useProjects() {
  const { data, loading, error, refresh } = useLiveResource<Project[]>("/api/projects", {
    events: ["agents:changed"],
    select: (j) => (j as { projects?: Project[] }).projects ?? [],
    initial: [],
  });
  return { projects: data, loading, error, refresh };
}
