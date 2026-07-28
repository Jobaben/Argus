import { useCallback, useState } from "react";
import { useLiveResource } from "./live/useLiveResource";
import type { FleetView, PairingCode } from "./types";

const EMPTY: FleetView = {
  machines: [],
  totals: {
    machines: 0,
    reporting: 0,
    monitorsDown: 0,
    monitorsFailing: 0,
    openIssues: 0,
    liveInstances: 0,
    gatedInstances: 0,
    runsToday: 0,
    failuresToday: 0,
    spendTodayUsd: 0,
    spendMonthUsd: 0,
  },
  soloMode: true,
  generatedAt: "",
};

async function post<T>(path: string, body?: unknown, method = "POST"): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(
      json.error ?? (res.status === 401 ? "sign in to change pairings" : `HTTP ${res.status}`),
    );
  }
  return json;
}

/**
 * The fleet, and the three things you can do to it.
 *
 * The pairing secret is held in component state only, never persisted and never
 * read back from the server — it exists for exactly as long as it takes to
 * carry it to the other machine.
 */
export function useFleet() {
  const { data, loading, error, refresh } = useLiveResource<FleetView>("/api/fleet", {
    events: ["fleet:changed", "schedules:changed", "issues:changed"],
    // Peers are polled on the scheduler tick, and nothing broadcasts when a
    // peer's *health* changes — so this is one of the few resources that has to
    // keep polling even with a live socket.
    pollAlways: true,
    select: (j) => (j && typeof j === "object" ? { ...EMPTY, ...(j as FleetView) } : EMPTY),
    initial: EMPTY,
  });

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pairing, setPairing] = useState<PairingCode | null>(null);

  const wrap = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const mintPairing = useCallback(
    () =>
      wrap(async () => {
        setPairing(await post<PairingCode>("/api/peers/pair"));
      }),
    [wrap],
  );

  const addPeer = useCallback(
    (input: { label: string; url: string; secret: string }) =>
      wrap(async () => {
        await post("/api/peers", input);
        await refresh();
      }),
    [wrap, refresh],
  );

  const unpair = useCallback(
    (id: string) =>
      wrap(async () => {
        await post(`/api/peers/${encodeURIComponent(id)}`, undefined, "DELETE");
        await refresh();
      }),
    [wrap, refresh],
  );

  const rename = useCallback(
    (label: string) =>
      wrap(async () => {
        await post("/api/fleet/label", { label }, "PUT");
        await refresh();
      }),
    [wrap, refresh],
  );

  return {
    fleet: data,
    loading,
    error,
    refresh,
    busy,
    actionError,
    pairing,
    clearPairing: () => setPairing(null),
    mintPairing,
    addPeer,
    unpair,
    rename,
  };
}
