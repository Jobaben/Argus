import { chmod } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Peer, PeerInput, PeerStatus } from "@argus/contracts";
import { paths } from "../claudeHome.js";
import { atomicWriteJson } from "../sources/atomicWrite.js";
import { readJson } from "../sources/readJson.js";

/**
 * The peer list, and the secrets that make it a peer list rather than a set of
 * URLs.
 *
 * Stored in its own file — `argus/peers.json`, mode 0600 — for the same reason
 * `auth.json` is: it holds long-lived shared secrets, and mixing them into a
 * config file people paste into issues is how they leak. Nothing in this module
 * returns a secret to an API caller; {@link publicPeers} exists so that is the
 * default rather than a thing each route has to remember.
 */

const FILE = () => path.join(paths.argus(), "peers.json");

/** Peers per machine. A fleet larger than this wants a different product. */
export const MAX_PEERS = 24;

/** How long a verified summary stays current before the peer reads as stale. */
export const STALE_AFTER_MS = 5 * 60_000;

export interface StoredPeer {
  id: string;
  label: string;
  url: string;
  secret: string;
  addedAt: string;
}

interface PeersFile {
  /** This machine's own stable identity, minted once. */
  machineId: string;
  label: string;
  peers: StoredPeer[];
}

export class PeerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeerValidationError";
  }
}

const LABEL_RE = /^[\w .'()-]{1,60}$/;

/**
 * Validate a peer before it is written.
 *
 * The URL check is the load-bearing one: a peer URL is a place this server will
 * make outbound requests to on a timer, so it must be an absolute http(s) URL
 * and nothing more exotic. `file:` and friends are refused by name rather than
 * left to fail confusingly later.
 */
export function validatePeer(raw: unknown): Omit<StoredPeer, "id" | "addedAt"> {
  const r = (raw ?? {}) as Partial<PeerInput>;
  if (typeof r.label !== "string" || !LABEL_RE.test(r.label.trim())) {
    throw new PeerValidationError("label must be 1–60 ordinary characters");
  }
  let url: URL;
  try {
    url = new URL(String(r.url ?? ""));
  } catch {
    throw new PeerValidationError("url must be an absolute http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PeerValidationError(`url must be http or https, not ${url.protocol}`);
  }
  if (typeof r.secret !== "string" || !/^[0-9a-f]{64}$/.test(r.secret)) {
    throw new PeerValidationError("secret must be the 64-character pairing code");
  }
  return {
    label: r.label.trim(),
    // Normalized without a trailing slash so two spellings of one peer do not
    // become two peers.
    url: url.origin + url.pathname.replace(/\/+$/, ""),
    secret: r.secret,
  };
}

async function read(): Promise<PeersFile> {
  const raw = await readJson<Partial<PeersFile> | null>(FILE(), null);
  const peers = Array.isArray(raw?.peers)
    ? raw.peers.filter(
        (p): p is StoredPeer =>
          !!p &&
          typeof p.id === "string" &&
          typeof p.url === "string" &&
          typeof p.secret === "string",
      )
    : [];
  return {
    machineId: typeof raw?.machineId === "string" && raw.machineId ? raw.machineId : "",
    label: typeof raw?.label === "string" && raw.label ? raw.label : "",
    peers,
  };
}

async function write(file: PeersFile): Promise<void> {
  await atomicWriteJson(FILE(), file);
  // Best effort: on a filesystem without POSIX modes this is a no-op, and a
  // peer list that exists is better than one that refused to save.
  await chmod(FILE(), 0o600).catch(() => {});
}

export async function readPeers(): Promise<StoredPeer[]> {
  return (await read()).peers;
}

/** Peers as the API returns them: no secrets, ever. */
export function publicPeers(peers: StoredPeer[], health: Map<string, PeerHealth>): Peer[] {
  return peers
    .map((p) => {
      const h = health.get(p.id);
      return {
        id: p.id,
        label: p.label,
        url: p.url,
        status: h?.status ?? ("pending" as PeerStatus),
        lastSeenAt: h?.lastSeenAt ?? null,
        error: h?.error ?? null,
        addedAt: p.addedAt,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

export interface PeerHealth {
  status: PeerStatus;
  lastSeenAt: string | null;
  error: string | null;
}

/**
 * This machine's identity, minted on first use.
 *
 * A random UUID rather than a hostname or a MAC address: the id travels to
 * every peer, and a monitoring tool should not be the reason a machine name
 * ends up somewhere it was not before.
 */
export async function machineIdentity(defaultLabel: string): Promise<{
  machineId: string;
  label: string;
}> {
  const file = await read();
  if (file.machineId && file.label) return { machineId: file.machineId, label: file.label };
  const next: PeersFile = {
    ...file,
    machineId: file.machineId || randomUUID(),
    label: file.label || defaultLabel,
  };
  await write(next);
  return { machineId: next.machineId, label: next.label };
}

export async function setLabel(label: string): Promise<string> {
  if (!LABEL_RE.test(label.trim())) {
    throw new PeerValidationError("label must be 1–60 ordinary characters");
  }
  const file = await read();
  await write({ ...file, label: label.trim() });
  return label.trim();
}

export async function addPeer(input: unknown, now: Date): Promise<StoredPeer> {
  const valid = validatePeer(input);
  const file = await read();
  if (file.peers.length >= MAX_PEERS) {
    throw new PeerValidationError(`at most ${MAX_PEERS} peers`);
  }
  if (file.peers.some((p) => p.url === valid.url)) {
    throw new PeerValidationError("that machine is already paired");
  }
  const peer: StoredPeer = { ...valid, id: randomUUID(), addedAt: now.toISOString() };
  await write({ ...file, peers: [...file.peers, peer] });
  return peer;
}

export async function removePeer(id: string): Promise<boolean> {
  const file = await read();
  const next = file.peers.filter((p) => p.id !== id);
  if (next.length === file.peers.length) return false;
  await write({ ...file, peers: next });
  return true;
}
