import type { MachineSummary, PeerStatus } from "@argus/contracts";
import { createNonceCache, open, pairingId, EnvelopeError } from "./envelope.js";
import { STALE_AFTER_MS, type PeerHealth, type StoredPeer } from "./peers.js";
import { parseSummary } from "./summary.js";
import { log } from "../log.js";

/**
 * Pulling peer summaries, on the scheduler tick.
 *
 * Pull rather than push, and that is the whole reason this feature does not
 * need a server. A machine that is asleep, behind NAT, or simply off is not a
 * failed delivery to retry — it is a peer that did not answer this time, which
 * is a state the fleet view already has to render.
 *
 * Everything is bounded: one request per peer per tick, a short timeout, a
 * response size cap, and no retries. A monitoring tool must not be the reason a
 * flaky network gets busier.
 */

/** Per-request timeout. A peer that cannot answer in this is down enough. */
export const PEER_TIMEOUT_MS = 4000;

/** Response cap. A summary is under a kilobyte; anything larger is not one. */
export const MAX_RESPONSE_BYTES = 64 * 1024;

export interface PollDeps {
  now: () => Date;
  readPeers: () => Promise<StoredPeer[]>;
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
}

export interface PollState {
  summaries: Map<string, MachineSummary>;
  health: Map<string, PeerHealth>;
}

function statusFor(lastSeenAt: string | null, now: Date): PeerStatus {
  if (!lastSeenAt) return "pending";
  return now.getTime() - Date.parse(lastSeenAt) > STALE_AFTER_MS ? "stale" : "paired";
}

export function createPoller(deps: PollDeps) {
  const summaries = new Map<string, MachineSummary>();
  const health = new Map<string, PeerHealth>();
  const nonces = createNonceCache();
  const doFetch = deps.fetch ?? globalThis.fetch;

  async function pollOne(peer: StoredPeer, now: Date): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PEER_TIMEOUT_MS);
    try {
      const res = await doFetch(`${peer.url}/api/federation/summary`, {
        headers: { "x-argus-pairing": pairingId(peer.secret) },
        signal: controller.signal,
      });
      if (res.status === 401 || res.status === 403) {
        // Reachable but not paired: almost always a secret typed into one
        // machine and not the other, and worth saying so rather than reporting
        // the peer as merely down.
        setUnhealthy(peer.id, "unauthorized", "the peer did not accept this pairing");
        return;
      }
      if (!res.ok) {
        setUnhealthy(peer.id, "unreachable", `HTTP ${res.status}`);
        return;
      }
      const text = await res.text();
      if (text.length > MAX_RESPONSE_BYTES) {
        setUnhealthy(peer.id, "unauthorized", "the peer sent more than a summary");
        return;
      }
      const payload = open(JSON.parse(text), peer.secret, {
        now,
        seen: (nonce) => nonces.check(nonce, now),
      });
      const summary = parseSummary(payload);
      if (!summary) {
        setUnhealthy(peer.id, "unauthorized", "the peer sent something that is not a summary");
        return;
      }
      summaries.set(peer.id, summary);
      health.set(peer.id, { status: "paired", lastSeenAt: now.toISOString(), error: null });
    } catch (e) {
      const previous = health.get(peer.id)?.lastSeenAt ?? null;
      if (e instanceof EnvelopeError) {
        setUnhealthy(peer.id, "unauthorized", e.message, previous);
        return;
      }
      const message = e instanceof Error ? e.message : String(e);
      // A peer that answered before keeps its last summary and reads as stale
      // once the window passes: "last known, ten minutes ago" is information,
      // and blanking the card on one dropped packet is not.
      setUnhealthy(peer.id, previous ? statusFor(previous, now) : "unreachable", message, previous);
    } finally {
      clearTimeout(timer);
    }
  }

  function setUnhealthy(
    id: string,
    status: PeerStatus,
    error: string,
    lastSeenAt: string | null = null,
  ): void {
    health.set(id, { status, lastSeenAt: lastSeenAt ?? health.get(id)?.lastSeenAt ?? null, error });
  }

  return {
    /** One round. Never throws; a peer's failure is that peer's state. */
    async check(): Promise<void> {
      const now = deps.now();
      let peers: StoredPeer[];
      try {
        peers = await deps.readPeers();
      } catch (e) {
        log.warn("could not read the peer list", { err: e });
        return;
      }
      // Drop state for peers that have been removed *before* the early return:
      // unpairing the last peer is exactly the case where returning early would
      // leave a machine on the fleet view that is no longer paired.
      const live = new Set(peers.map((p) => p.id));
      for (const id of [...summaries.keys()]) if (!live.has(id)) summaries.delete(id);
      for (const id of [...health.keys()]) if (!live.has(id)) health.delete(id);

      if (peers.length === 0) return;

      // Concurrent, because the slowest peer should not delay the others, and
      // bounded by MAX_PEERS which is small enough not to need a pool.
      await Promise.all(peers.map((p) => pollOne(p, now)));

      // Re-age everything: a peer that answered once and has been quiet since
      // has to decay to `stale` without another successful round to do it.
      for (const [id, h] of health) {
        if (h.status === "paired") health.set(id, { ...h, status: statusFor(h.lastSeenAt, now) });
      }
    },
    state: (): PollState => ({ summaries, health }),
  };
}
