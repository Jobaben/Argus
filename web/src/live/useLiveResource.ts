import { useCallback, useEffect, useRef, useState } from "react";
import { subscribeLive } from "./liveSocket";

export interface LiveResourceState<T> {
  data: T;
  loading: boolean;
  error: string | null;
  /** Whether the shared WebSocket is currently connected. */
  live: boolean;
  /** When the value on screen last *changed*. Deliberately not "last checked":
   *  stamping every revalidation would re-render the tree the 304 path exists
   *  to leave alone. */
  updatedAt: number | null;
  /** True once a fetch has failed while a previously-good value is on screen:
   *  what you are looking at is the last known state, not the current one. */
  stale: boolean;
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
  /** Keep polling even while the socket is live. For resources that mix pushed
   *  sources with time-decaying ones (e.g. the Chronicle's session activity),
   *  where a healthy socket still can't signal every change. */
  pollAlways?: boolean;
}

/** Retry schedule after a failed fetch: doubling, capped, jittered. */
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30_000;

/**
 * Decorrelated jitter: a random point in the upper half of the backoff window.
 * Without jitter every view that failed on the same server blip retries in
 * lockstep and hammers it back down at exactly the same instant.
 */
export function retryDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling * (0.5 + random() * 0.5));
}

/**
 * One place that knows how to fetch a JSON resource and keep it fresh:
 *
 *  - fetch once on mount (and whenever `path` changes),
 *  - refetch when the shared socket reports a matching change event,
 *  - poll as a fallback ONLY while the socket is disconnected, so a healthy
 *    live connection means zero background polling.
 *
 * Three properties make the push-driven model cheap enough to lean on:
 *
 * **Conditional requests.** Every response carries an `ETag`; the next fetch
 * sends it back as `If-None-Match`. A broadcast that did not actually change
 * this resource comes back `304` with no body — no parse, no `setState`, no
 * re-render. That matters because one `pipelines:changed` ping wakes several
 * hooks at once and the board is the most expensive tree in the app.
 *
 * **Single-flight with coalescing.** A burst of frames (the engine emits one
 * per step transition) used to start a fetch per frame, so an older response
 * could land after a newer one and win. An in-flight fetch now absorbs the
 * burst and re-runs exactly once after it settles.
 *
 * **Backoff with jitter.** A failing server used to be re-polled every 10s
 * forever, by every view at once. Retries now double up to 30s, are
 * de-synchronised, and the last good value stays on screen marked `stale`
 * instead of being blanked.
 *
 * `path` of null means "don't fetch" (used for detail views with no selection).
 */
export function useLiveResource<T>(
  path: string | null,
  opts: LiveResourceOptions<T>,
): LiveResourceState<T> & { refresh: () => void } {
  const { events, select, initial, pollMs = 10000, pollAlways = false } = opts;
  const [data, setData] = useState<T>(initial);
  const [loading, setLoading] = useState(path != null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
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

  // Per-path request state. `etag` validates the value currently on screen;
  // `inFlight`/`pending` implement single-flight coalescing; `attempt` drives
  // the backoff. All of it resets when the path changes.
  const req = useRef({
    etag: null as string | null,
    inFlight: false,
    pending: false,
    attempt: 0,
    abort: null as AbortController | null,
    retry: null as ReturnType<typeof setTimeout> | null,
  });

  // Mirrors of the two flags the revalidation path would otherwise "clear" on
  // every 304. Passing an unchanged value to a setter is not free: React still
  // renders the component once before bailing out, which would undo the whole
  // point of the 304 fast path. These let us skip the call entirely.
  const errorRef = useRef<string | null>(null);
  const loadingRef = useRef(path != null);
  const setErrorOnce = useCallback((next: string | null) => {
    if (errorRef.current === next) return;
    errorRef.current = next;
    setError(next);
  }, []);
  const setLoadingOnce = useCallback((next: boolean) => {
    if (loadingRef.current === next) return;
    loadingRef.current = next;
    setLoading(next);
  }, []);

  // The retry timer and the coalesced re-run both need to invoke the *current*
  // refresh, which is the function being defined — so they go through a ref
  // rather than closing over a stale binding.
  const refreshRef = useRef<() => Promise<void>>(async () => {});

  const refresh = useCallback(
    async function refreshResource(): Promise<void> {
      if (path == null) return;
      const state = req.current;
      // Coalesce: note that another refresh was asked for, and run it once.
      if (state.inFlight) {
        state.pending = true;
        return;
      }
      state.inFlight = true;
      const controller = new AbortController();
      state.abort = controller;

      try {
        const res = await fetch(path, {
          signal: controller.signal,
          // Ask the server every time, but let it answer 304. Browser-managed
          // revalidation would hand us a 200 out of its own cache, which defeats
          // the point: we could not tell "unchanged" from "changed".
          cache: "no-store",
          headers: state.etag ? { "if-none-match": state.etag } : undefined,
        });

        if (res.status === 304) {
          // Unchanged: what is on screen is still correct, so touch *no* state —
          // this is the path that keeps a quiet board at zero re-renders. Even
          // stamping a "last checked" timestamp here would defeat it, which is
          // why `updatedAt` tracks the last *change* rather than the last check.
          state.attempt = 0;
          if (mounted.current) setErrorOnce(null);
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const json = (await res.json()) as unknown;
        state.etag = res.headers?.get?.("etag") ?? null;
        state.attempt = 0;
        if (!mounted.current) return;
        setData(selectRef.current(json));
        setUpdatedAt(Date.now());
        setErrorOnce(null);
      } catch (e) {
        if (controller.signal.aborted) return;
        // A failed response says nothing about what the server holds now, so the
        // validator has to go: revalidating against it could pin us to a stale
        // 304 indefinitely.
        state.etag = null;
        if (!mounted.current) return;
        setErrorOnce(e instanceof Error ? e.message : String(e));
        state.attempt += 1;
        if (state.retry) clearTimeout(state.retry);
        state.retry = setTimeout(() => {
          state.retry = null;
          if (mounted.current) void refreshRef.current();
        }, retryDelay(state.attempt));
      } finally {
        state.inFlight = false;
        state.abort = null;
        // An *aborted* request settled nothing: no data arrived, so the view is
        // still loading. Clearing the flag here would drop a first-load view
        // straight to its empty state — which is exactly what happened on every
        // React StrictMode double-mount and on every path change.
        if (mounted.current && !controller.signal.aborted) setLoadingOnce(false);
        if (state.pending) {
          state.pending = false;
          void refreshRef.current();
        }
      }
    },
    [path, setErrorOnce, setLoadingOnce],
  );

  // Declared before the fetching effect so the ref is current by the time that
  // effect kicks off the first request.
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    mounted.current = true;
    const state = req.current;
    state.etag = null;
    state.attempt = 0;
    state.pending = false;

    const teardownRequest = () => {
      mounted.current = false;
      state.abort?.abort();
      state.abort = null;
      if (state.retry) {
        clearTimeout(state.retry);
        state.retry = null;
      }
    };

    if (path == null) {
      // Reset loading when the resource path becomes null (a detail view with
      // no selection).
      setLoadingOnce(false);
      return teardownRequest;
    }
    setLoadingOnce(true);
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
        if (want && want.length > 0 && want.includes(msg.type)) void refresh();
      },
      onStatus: ({ live: isLive }) => {
        if (!mounted.current) return;
        setLive(isLive);
        if (!hasEvents || pollAlways) return; // keep polling; socket alone can't keep us fresh
        if (isLive) stopPoll();
        else startPoll();
      },
    });

    return () => {
      teardownRequest();
      stopPoll();
      unsubscribe();
    };
  }, [path, refresh, pollMs, pollAlways, setLoadingOnce]);

  return {
    data,
    loading,
    error,
    live,
    updatedAt,
    stale: error !== null && updatedAt !== null,
    refresh: () => void refresh(),
  };
}
