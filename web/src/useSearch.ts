import { useEffect, useRef, useState } from "react";

export interface SearchResult {
  project: string;
  projectLabel: string;
  sessionId: string;
  snippet: string;
  type: string;
}

interface SearchState {
  results: SearchResult[];
  loading: boolean;
  error: string | null;
}

const DEBOUNCE_MS = 300;

/**
 * Debounced transcript search. Stale responses are discarded so the results
 * always reflect the latest committed query, even under fast typing.
 */
export function useSearch(query: string): SearchState {
  const [results, setResults] = useState<SearchResult[]>([]);
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
        const data = (await res.json()) as { results: SearchResult[] };
        if (id !== requestId.current) return;
        setResults(data.results);
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

  return { results, loading, error };
}
