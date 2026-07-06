import { useCallback, useEffect, useRef, useState } from "react";
import { subscribeLive } from "./liveSocket";

export interface LiveResourceState<T> {
  data: T;
  loading: boolean;
  error: string | null;
  /** Whether the shared WebSocket is currently connected. */
  live: boolean;
}

export interface LiveResourceOptions<T> {
  /** Change-event types (from the server WS) that should trigger a refetch. */
  events?: string[];
  /** Map the parsed JSON body to the resource value. */
  select: (json: unknown) => T;
  /** Initial value before the first successful fetch. */
  initial: T;
  /** Fallback poll interval (ms) used ONLY while the socket is down. 0 disables. */
  pollMs?: number;
}

/**
 * One place that knows how to fetch a JSON resource and keep it fresh:
 *  - fetch once on mount (and whenever `path` changes),
 *  - refetch when the shared socket reports a matching change event,
 *  - poll as a fallback ONLY while the socket is disconnected (so a healthy
 *    live connection means zero background polling — the old hooks polled every
 *    10s regardless).
 *
 * Replaces the ~14 hand-rolled fetch/poll/WS hooks that each opened their own
 * socket. `path` of null means "don't fetch" (used for detail views with no
 * selection yet).
 */
export function useLiveResource<T>(
  path: string | null,
  opts: LiveResourceOptions<T>,
): LiveResourceState<T> & { refresh: () => void } {
  const { events, select, initial, pollMs = 10000 } = opts;
  const [data, setData] = useState<T>(initial);
  const [loading, setLoading] = useState(path != null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const mounted = useRef(true);

  // Keep the latest select/events without re-subscribing on every render.
  // Updated in an effect (never during render) so the async refresh below reads
  // fresh values without violating the refs-during-render rule.
  const selectRef = useRef(select);
  const eventsRef = useRef(events);
  useEffect(() => {
    selectRef.current = select;
    eventsRef.current = events;
  });

  const refresh = useCallback(async () => {
    if (path == null) return;
    try {
      const res = await fetch(path);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as unknown;
      if (!mounted.current) return;
      setData(selectRef.current(json));
      setError(null);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    mounted.current = true;
    if (path == null) {
      setLoading(false);
      return () => {
        mounted.current = false;
      };
    }
    setLoading(true);
    void refresh();

    // A resource with push events only needs polling as a fallback while the
    // socket is down. A resource with no push event (e.g. stats) has no live
    // signal, so it must keep polling regardless of connection state.
    const hasEvents = (eventsRef.current?.length ?? 0) > 0;
    let poll: ReturnType<typeof setInterval> | null = null;
    const stopPoll = () => {
      if (poll) {
        clearInterval(poll);
        poll = null;
      }
    };
    const startPoll = () => {
      if (!poll && pollMs > 0) poll = setInterval(() => void refresh(), pollMs);
    };
    startPoll();

    const unsubscribe = subscribeLive({
      onMessage: (msg) => {
        const want = eventsRef.current;
        if (want && want.length > 0 && msg.type && want.includes(msg.type)) void refresh();
      },
      onStatus: (isLive) => {
        if (!mounted.current) return;
        setLive(isLive);
        if (!hasEvents) return; // keep polling; socket carries no signal for us
        if (isLive) stopPoll();
        else startPoll();
      },
    });

    return () => {
      mounted.current = false;
      stopPoll();
      unsubscribe();
    };
  }, [path, refresh, pollMs]);

  return { data, loading, error, live, refresh };
}
