import { useMemo } from "react";
import { useLiveResource } from "./live/useLiveResource";

import type { SessionDetail, SessionMessage, SessionSummary } from "@argus/contracts";

export type { SessionDetail, SessionMessage, SessionSummary };

/** Loads the recent-sessions list, refreshing when agents or transcripts change. */
export function useSessions() {
  const { data, loading, error, refresh } = useLiveResource<SessionSummary[]>("/api/sessions", {
    events: ["agents:changed", "sessions:changed"],
    select: (j) => (j as { sessions?: SessionSummary[] }).sessions ?? [],
    initial: [],
  });
  return { sessions: data, loading, error, refresh };
}

/** Loads the full normalized message list for a single session (no polling —
 *  a transcript is immutable once the run ends). */
export function useSession(project: string | null, id: string | null) {
  const path = useMemo(
    () =>
      project && id
        ? `/api/sessions/${encodeURIComponent(project)}/${encodeURIComponent(id)}`
        : null,
    [project, id],
  );
  const { data, loading, error } = useLiveResource<SessionDetail | null>(path, {
    select: (j) => j as SessionDetail | null,
    initial: null,
    pollMs: 0,
  });
  return { session: data, loading, error };
}
