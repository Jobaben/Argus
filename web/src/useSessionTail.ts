import { useCallback, useEffect, useRef, useState } from "react";
import { subscribeLive } from "./live/liveSocket";
import { mergeTail } from "./live/mergeTail";
import type { SessionMessage } from "./useSessions";

export interface SessionTailHeader {
  id: string;
  project: string;
  projectLabel: string;
  title: string;
  model: string | null;
  firstActivity: string | null;
  lastActivity: string | null;
}

interface SessionTailResponse extends SessionTailHeader {
  messages: SessionMessage[];
  lastIndex: number;
}

/** Poll cadence used only while following AND the shared socket is down; a live
 *  socket drives updates via the "sessions:changed" ping instead. */
const POLL_MS = 3000;

export interface SessionTailState {
  header: SessionTailHeader | null;
  messages: SessionMessage[];
  following: boolean;
  setFollowing: (v: boolean) => void;
  loading: boolean;
  error: string | null;
  live: boolean;
}

/**
 * Live-tailing transcript reader. Loads the full transcript once, then — while
 * following — appends only newly-written messages as a running agent extends
 * the session file. Pausing freezes the accumulated view and stops all network
 * activity; resuming fetches the catch-up slice. Append diffing is delegated to
 * the pure {@link mergeTail}.
 */
export function useSessionTail(project: string | null, id: string | null): SessionTailState {
  const [messages, setMessages] = useState<SessionMessage[]>([]);
  const [header, setHeader] = useState<SessionTailHeader | null>(null);
  const [following, setFollowing] = useState(true);
  const [loading, setLoading] = useState(project != null && id != null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const lastIndexRef = useRef(-1);
  const mounted = useRef(true);
  // Bumped whenever the selected session changes. A fetch started for a prior
  // selection that resolves after navigation is dropped, so its (accumulated)
  // messages never contaminate the new session — the shared `mounted` flag is
  // not enough because it is true again for the new selection's fetch.
  const epochRef = useRef(0);

  const fetchTail = useCallback(async () => {
    if (!project || !id) return;
    const epoch = epochRef.current;
    const url =
      `/api/sessions/${encodeURIComponent(project)}/${encodeURIComponent(id)}` +
      `/tail?after=${lastIndexRef.current}`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { messages: incoming, lastIndex, ...rest } = (await res.json()) as SessionTailResponse;
      if (!mounted.current || epoch !== epochRef.current) return;
      setHeader(rest);
      if (typeof lastIndex === "number") lastIndexRef.current = lastIndex;
      setMessages((prev) => mergeTail(prev, incoming ?? []));
      setError(null);
    } catch (e) {
      if (mounted.current && epoch === epochRef.current) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (mounted.current && epoch === epochRef.current) setLoading(false);
    }
  }, [project, id]);

  // Reset accumulated state when the selected session changes (external sync on
  // a new resource path — the sanctioned setState-in-effect).
  useEffect(() => {
    epochRef.current += 1;
    lastIndexRef.current = -1;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMessages([]);
    setHeader(null);
    setLoading(project != null && id != null);
  }, [project, id]);

  // Fetch once, and while following keep fresh via the socket (poll only while
  // it is down). Toggling follow re-runs this without resetting the transcript.
  useEffect(() => {
    mounted.current = true;
    if (!project || !id) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLoading(false);
      return () => {
        mounted.current = false;
      };
    }
    void fetchTail();
    if (!following) {
      return () => {
        mounted.current = false;
      };
    }

    let poll: ReturnType<typeof setInterval> | null = null;
    const stopPoll = () => {
      if (poll) {
        clearInterval(poll);
        poll = null;
      }
    };
    const startPoll = () => {
      if (!poll) poll = setInterval(() => void fetchTail(), POLL_MS);
    };
    startPoll();

    const unsubscribe = subscribeLive({
      onMessage: (msg) => {
        if (msg.type === "sessions:changed") void fetchTail();
      },
      onStatus: (isLive) => {
        if (!mounted.current) return;
        setLive(isLive);
        if (isLive) stopPoll();
        else startPoll();
      },
    });

    return () => {
      mounted.current = false;
      stopPoll();
      unsubscribe();
    };
  }, [project, id, following, fetchTail]);

  return { header, messages, following, setFollowing, loading, error, live };
}
