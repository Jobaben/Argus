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
type StatusListener = (live: boolean) => void;

interface Subscriber {
  onMessage?: MessageListener;
  onStatus?: StatusListener;
}

const RECONNECT_MS = 2000;

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let connected = false;
const subscribers = new Set<Subscriber>();

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
      return isRecord(frame.alert) && typeof frame.alert.event === "string";
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

function setStatus(live: boolean) {
  connected = live;
  for (const s of subscribers) s.onStatus?.(live);
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
  ws.onopen = () => setStatus(true);
  ws.onmessage = (ev: MessageEvent) => {
    const msg = parseFrame(String(ev.data));
    if (!msg) return;
    for (const s of subscribers) s.onMessage?.(msg);
  };
  ws.onclose = () => {
    if (socket === ws) socket = null;
    setStatus(false);
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
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_MS);
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
  connected = false;
}

/** Subscribe to live messages and connection status. Returns an unsubscribe. */
export function subscribeLive(sub: Subscriber): () => void {
  subscribers.add(sub);
  // Report the current status immediately so a late subscriber isn't stuck
  // "reconnecting" until the next transition.
  sub.onStatus?.(connected);
  connect();
  return () => {
    subscribers.delete(sub);
    teardownIfIdle();
  };
}

/** Current connection state — exposed mainly for tests. */
export function isLive(): boolean {
  return connected;
}
