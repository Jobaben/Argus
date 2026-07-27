import { useEffect, useRef, useState } from "react";

import type { SearchResponse, SearchResult } from "@argus/contracts";

export type { SearchResult };

interface SearchState {
  results: SearchResult[];
  loading: boolean;
  error: string | null;
  /** True when the server stopped at its cap, so more matches may exist. */
  truncated: boolean;
}

const DEBOUNCE_MS = 300;

/**
 * Debounced transcript search. Stale responses are discarded so the results
 * always reflect the latest committed query, even under fast typing.
 */
export function useSearch(query: string): SearchState {
  const [results, setResults] = useState<SearchResult[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      // Intentional: clear results when the query is emptied — syncing view
      // state to the (external) debounced query input, not a cascading render.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResults([]);
      setTruncated(false);
      setLoading(false);
      setError(null);
      return;
    }

    const id = ++requestId.current;
    setLoading(true);
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as SearchResponse;
        if (id !== requestId.current) return;
        setResults(data.results ?? []);
        setTruncated(data.truncated === true);
        setError(null);
      } catch (e) {
        if (controller.signal.aborted || id !== requestId.current) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  return { results, loading, error, truncated };
}
