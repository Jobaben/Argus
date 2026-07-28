import { useEffect, useRef, useState } from "react";
import { useLiveResource } from "./live/useLiveResource";
import type { VaultQuartersReport, VaultSearchResponse, VaultStatus } from "./types";

const EMPTY_STATUS: VaultStatus = {
  available: false,
  reason: null,
  detail: "",
  rows: { runs: 0, events: 0, spendDays: 0, scores: 0 },
  sizeBytes: null,
  oldestRunAt: null,
  newestRunAt: null,
  lastIngestAt: null,
  beyondRetention: 0,
};

const EMPTY_QUARTERS: VaultQuartersReport = { available: false, detail: "", quarters: [] };

/** What the Vault holds. Refreshed on the same pings that move the run history. */
export function useVaultStatus() {
  return useLiveResource<VaultStatus>("/api/vault", {
    events: ["schedules:changed", "totals:changed"],
    select: (j) => (j && typeof j === "object" ? (j as VaultStatus) : EMPTY_STATUS),
    initial: EMPTY_STATUS,
  });
}

/** Quarterly aggregates — the long view Stats cannot build from JSON alone. */
export function useVaultQuarters() {
  return useLiveResource<VaultQuartersReport>("/api/vault/quarters", {
    events: ["schedules:changed", "totals:changed"],
    select: (j) => (j && typeof j === "object" ? (j as VaultQuartersReport) : EMPTY_QUARTERS),
    initial: EMPTY_QUARTERS,
  });
}

const DEBOUNCE_MS = 300;

const EMPTY_SEARCH: VaultSearchResponse = {
  available: false,
  detail: "",
  query: "",
  hits: [],
  relatedTerms: [],
  limit: 0,
  truncated: false,
};

/**
 * Indexed search over the Vault.
 *
 * Debounced and last-write-wins like the transcript search, for the same
 * reason: under fast typing the results must reflect the query that is on
 * screen, not whichever response happened to land last.
 */
export function useVaultSearch(query: string) {
  const [response, setResponse] = useState<VaultSearchResponse>(EMPTY_SEARCH);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      // Clearing view state in response to an external input, not a cascade.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResponse(EMPTY_SEARCH);
      setLoading(false);
      setError(null);
      return;
    }
    const id = ++requestId.current;
    setLoading(true);
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/vault/search?q=${encodeURIComponent(q)}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as VaultSearchResponse;
        if (id !== requestId.current) return;
        setResponse(data);
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

  return { response, loading, error };
}
