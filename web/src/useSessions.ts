import { useCallback, useEffect, useRef, useState } from "react";

export interface SessionSummary {
  id: string;
  project: string;
  projectLabel: string;
  title: string;
  messageCount: number;
  toolUseCount: number;
  model: string | null;
  firstActivity: string | null;
  lastActivity: string | null;
}

export interface SessionMessage {
  index: number;
  type: string;
  role: string | null;
  timestamp: string | null;
  model: string | null;
  text: string | null;
  toolName: string | null;
  isError: boolean;
}

export interface SessionDetail {
  id: string;
  project: string;
  projectLabel: string;
  title: string;
  model: string | null;
  firstActivity: string | null;
  lastActivity: string | null;
  messages: SessionMessage[];
}

interface SessionsState {
  sessions: SessionSummary[];
  loading: boolean;
  error: string | null;
}

/** Loads the recent-sessions list with loading/error state and refresh. */
export function useSessions(): SessionsState & { refresh: () => void } {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/sessions");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { sessions: SessionSummary[] };
      if (!mounted.current) return;
      setSessions(data.sessions);
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

  return { sessions, loading, error, refresh };
}

interface SessionDetailState {
  session: SessionDetail | null;
  loading: boolean;
  error: string | null;
}

/** Loads the full normalized message list for a single session. */
export function useSession(
  project: string | null,
  id: string | null,
): SessionDetailState {
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    if (!project || !id) {
      setSession(null);
      setLoading(false);
      setError(null);
      return () => {
        mounted.current = false;
      };
    }

    setLoading(true);
    (async () => {
      try {
        const res = await fetch(
          `/api/sessions/${encodeURIComponent(project)}/${encodeURIComponent(id)}`,
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as SessionDetail | null;
        if (!mounted.current) return;
        setSession(data);
        setError(null);
      } catch (e) {
        if (mounted.current) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (mounted.current) setLoading(false);
      }
    })();

    return () => {
      mounted.current = false;
    };
  }, [project, id]);

  return { session, loading, error };
}
