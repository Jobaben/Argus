import { useLiveResource } from "./live/useLiveResource";
import type { Agent } from "./types";

/**
 * Loads the agent list and keeps it fresh via the shared live socket, with a
 * polling fallback while the socket is down.
 */
export function useAgents() {
  const { data, loading, error, live, refresh } = useLiveResource<Agent[]>("/api/agents", {
    events: ["agents:changed"],
    select: (j) => (j as { agents?: Agent[] }).agents ?? [],
    initial: [],
  });
  return { agents: data, loading, error, live, refresh };
}
