/**
 * A single shared WebSocket for the whole app. Previously every data hook
 * opened its own socket, so one tab held 3–4 connections and a single server
 * broadcast fanned out into that many duplicate refetches. Here one connection
 * multiplexes to all subscribers; each subscriber filters for the change types
 * it cares about.
 *
 * The socket is opened lazily on the first subscriber and torn down (with its
 * reconnect timer) when the last one leaves, so there are no dangling
 * connections or timers — which also keeps it well-behaved under test.
 */
import type { LiveFrame } from "@argus/contracts";

export type { LiveFrame };

type MessageListener = (msg: LiveFrame) => void;

/**
 * What the client knows about the connection.
 *
 * `attempt` and `retryAt` exist so the UI can be specific: "Offline — retrying
 * in 8s" is actionable, while "Reconnecting…" forever is indistinguishable from
 * a bug precisely when the server is genuinely down.
 */
export interface LiveStatus {
  live: boolean;
  /** Consecutive failed connection attempts; 0 once connected. */
  attempt: number;
  /** Epoch ms of the next reconnect attempt, if one is scheduled. */
  retryAt: number | null;
}

type StatusListener = (status: LiveStatus) => void;

interface Subscriber {
  onMessage?: MessageListener;
  onStatus?: StatusListener;
}

/**
 * Reconnect backoff.
 *
 * A flat 2s retry hammers a server that is genuinely down — forever, from every
 * open tab. Doubling to a 30s ceiling with jitter matches the fetch layer's
 * policy, and the visibility/online hooks below mean the long tail of the
 * backoff is never what the user waits on: returning to the tab reconnects
 * immediately.
 */
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling * (0.5 + random() * 0.5));
}

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let status: LiveStatus = { live: false, attempt: 0, retryAt: null };
const subscribers = new Set<Subscriber>();
let wakeHooksInstalled = false;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isActivityEvent(v: unknown): boolean {
  return isRecord(v) && typeof v.at === "string" && typeof v.label === "string";
}

/**
 * Validates the payload of the frames that carry one.
 *
 * A `LiveFrame` is a compile-time contract; the socket is an untrusted input,
 * so without this every consumer would have to re-guard fields the type says
 * are present. Validating once here means a narrowed frame can be trusted, and
 * a truncated or half-written payload is dropped instead of rendering as
 * `undefined` somewhere deep in a view.
 */
function hasValidPayload(frame: Record<string, unknown>): boolean {
  switch (frame.type) {
    case "run:activity":
      return (
        typeof frame.runId === "string" &&
        Array.isArray(frame.events) &&
        frame.events.length > 0 &&
        frame.events.every(isActivityEvent)
      );
    case "monitors:alert":
    case "budget:alert":
    case "sentinel:alert":
      return isRecord(frame.alert) && typeof frame.alert.event === "string";
    case "watchtower:anomaly":
      return isRecord(frame.anomaly) && typeof frame.anomaly.id === "string";
    default:
      // Change pings are payload-free, and a frame type from a newer server is
      // forwarded unvalidated: it matches no subscriber arm, so ignoring it
      // costs nothing while dropping it here would need a client release.
      return true;
  }
}

/** Parses and validates one frame off the wire; null means "ignore this". */
function parseFrame(data: string): LiveFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string") return null;
  return hasValidPayload(parsed) ? (parsed as unknown as LiveFrame) : null;
}

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

function publish(next: Partial<LiveStatus>) {
  status = { ...status, ...next };
  for (const s of subscribers) s.onStatus?.(status);
}

function connect() {
  if (socket || subscribers.size === 0) return;
  let ws: WebSocket;
  try {
    ws = new WebSocket(wsUrl());
  } catch {
    scheduleReconnect();
    return;
  }
  socket = ws;
  ws.onopen = () => publish({ live: true, attempt: 0, retryAt: null });
  ws.onmessage = (ev: MessageEvent) => {
    const msg = parseFrame(String(ev.data));
    if (!msg) return;
    for (const s of subscribers) s.onMessage?.(msg);
  };
  ws.onclose = () => {
    if (socket === ws) socket = null;
    publish({ live: false });
    scheduleReconnect();
  };
  ws.onerror = () => {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  };
}

function scheduleReconnect() {
  if (reconnectTimer || subscribers.size === 0) return;
  const attempt = status.attempt + 1;
  const delay = reconnectDelay(attempt);
  publish({ attempt, retryAt: Date.now() + delay });
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

/**
 * Reconnects now, cancelling any pending backoff.
 *
 * Called when the tab becomes visible or the browser reports it is back online,
 * and exposed for a manual retry. Without it, returning to a tab that backed
 * off to 30s means up to half a minute of stale data while the server has been
 * healthy the whole time.
 */
export function reconnectNow(): void {
  if (status.live || subscribers.size === 0) return;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  publish({ retryAt: null });
  connect();
}

function installWakeHooks() {
  if (wakeHooksInstalled || typeof window === "undefined") return;
  wakeHooksInstalled = true;
  // Deliberately never removed: they are cheap, idempotent, and this module
  // lives for the page's lifetime.
  window.addEventListener("online", reconnectNow);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") reconnectNow();
  });
}

function teardownIfIdle() {
  if (subscribers.size > 0) return;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    const s = socket;
    socket = null;
    try {
      s.close();
    } catch {
      /* ignore */
    }
  }
  status = { live: false, attempt: 0, retryAt: null };
}

/** Subscribe to live messages and connection status. Returns an unsubscribe. */
export function subscribeLive(sub: Subscriber): () => void {
  subscribers.add(sub);
  installWakeHooks();
  // Report the current status immediately so a late subscriber isn't stuck
  // "reconnecting" until the next transition.
  sub.onStatus?.(status);
  connect();
  return () => {
    subscribers.delete(sub);
    teardownIfIdle();
  };
}

/** Current connection state — exposed mainly for tests. */
export function isLive(): boolean {
  return status.live;
}

/** The full connection status, including backoff progress. */
export function liveStatus(): LiveStatus {
  return status;
}
