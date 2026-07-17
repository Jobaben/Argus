/**
 * Tails the NDJSON logs of running pipeline steps (written by `claude -p
 * --output-format stream-json --verbose`) and derives compact activity events
 * for the Command Center. The log on disk is the durable source of truth;
 * everything here is in-memory and rebuilt from the log after a restart.
 */

import { open } from "node:fs/promises";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { LOG_CAP_BYTES, runLogPath } from "./sources/runs.js";

export interface ActivityEvent {
  /** Arrival timestamp, stamped when Argus read the line (events carry none). */
  at: string;
  kind: "init" | "tool" | "text" | "done";
  label: string;
}

const LABEL_MAX = 80;

/** One-line, length-capped label text. */
function clip(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > LABEL_MAX ? `${t.slice(0, LABEL_MAX - 1)}…` : t;
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/** "Bash: npm test" / "Edit: foo.ts" / bare tool name for everything else. */
function summarizeToolUse(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Bash":
      return clip(`${name}: ${String(input.command ?? "")}`);
    case "Read":
    case "Edit":
    case "Write":
      return clip(
        `${name}: ${typeof input.file_path === "string" ? basename(input.file_path) : ""}`,
      );
    case "Task":
      return clip(`${name}: ${String(input.description ?? "")}`);
    default:
      return name;
  }
}

/**
 * Map one NDJSON line to zero or more activity events. Unknown, malformed,
 * and uninteresting lines (user/tool_result echoes) yield nothing.
 */
export function deriveActivity(line: string, at: string): ActivityEvent[] {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }
  if (!obj || typeof obj !== "object") return [];
  if (obj.type === "system" && obj.subtype === "init") {
    return [{ at, kind: "init", label: "session started" }];
  }
  if (obj.type === "result") return [{ at, kind: "done", label: "finished" }];
  if (obj.type !== "assistant") return [];
  const message = obj.message as Record<string, unknown> | undefined;
  const content = Array.isArray(message?.content) ? (message.content as unknown[]) : [];
  // Subagent messages (forwarded when CLAUDE_CODE_FORWARD_SUBAGENT_TEXT is set
  // at spawn) carry the spawning Task tool_use id; mark their labels so the
  // Command Center distinguishes them from the main agent's output.
  const prefix = typeof obj.parent_tool_use_id === "string" ? "Subagent: " : "";
  const events: ActivityEvent[] = [];
  for (const raw of content) {
    const block = raw as Record<string, unknown>;
    if (block?.type === "tool_use" && typeof block.name === "string") {
      events.push({
        at,
        kind: "tool",
        label: clip(
          prefix + summarizeToolUse(block.name, (block.input ?? {}) as Record<string, unknown>),
        ),
      });
    } else if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
      events.push({ at, kind: "text", label: clip(prefix + block.text) });
    }
  }
  return events;
}

const RING_CAP = 200;
const NL = 0x0a;

export interface TailerDeps {
  broadcast: (msg: unknown) => void;
  now: () => Date;
  /** Flush throttle; default 1000ms. Tests pass a small value. */
  flushMs?: number;
  /** false disables the chokidar watcher (tests drive reads via poke()). */
  watch?: boolean;
}

export interface RunTailer {
  track(runId: string, instanceId: string): void;
  untrack(runId: string): void;
  latest(): Map<string, ActivityEvent>;
  poke(runId: string): void;
  stop(): Promise<void>;
}

interface TrackedRun {
  instanceId: string;
  offset: number;
  leftover: Buffer;
  events: ActivityEvent[];
  pending: ActivityEvent[];
  flushTimer: NodeJS.Timeout | null;
  reading: boolean;
  dirty: boolean;
  /** First read decides the start offset (capped rebuild for big logs). */
  primed: boolean;
  /** After a capped rebuild, drop bytes up to the first newline. */
  skipPartial: boolean;
}

export function createRunTailer(deps: TailerDeps): RunTailer {
  const flushMs = deps.flushMs ?? 1000;
  const runs = new Map<string, TrackedRun>();
  const pathToRun = new Map<string, string>();

  const onFsEvent = (p: string) => {
    const id = pathToRun.get(p) ?? pathToRun.get(path.resolve(p));
    if (id) poke(id);
  };
  const watcher: FSWatcher | null =
    deps.watch === false
      ? null
      : chokidar
          .watch([], { ignoreInitial: false })
          .on("add", onFsEvent)
          .on("change", onFsEvent)
          .on("error", (e) => console.error("[argus] run tail watcher error:", e));

  function scheduleFlush(id: string, st: TrackedRun): void {
    if (st.pending.length === 0 || st.flushTimer) return;
    st.flushTimer = setTimeout(() => {
      st.flushTimer = null;
      const events = st.pending.splice(0);
      if (events.length > 0) {
        deps.broadcast({ type: "run:activity", runId: id, instanceId: st.instanceId, events });
      }
    }, flushMs);
  }

  async function readOnce(id: string): Promise<void> {
    const st = runs.get(id);
    if (!st) return;
    let handle;
    try {
      handle = await open(runLogPath(id), "r");
    } catch {
      return; // log not created yet; the watcher's add event retries
    }
    try {
      // untrack()/re-track() may have replaced st in the map while we
      // awaited open(); bail rather than mutate an orphaned state object.
      if (runs.get(id) !== st) return;
      const size = (await handle.stat()).size;
      if (runs.get(id) !== st) return; // re-check: stale after stat()'s await
      if (!st.primed) {
        st.primed = true;
        if (size > LOG_CAP_BYTES) {
          st.offset = size - LOG_CAP_BYTES;
          st.skipPartial = true;
        }
      }
      if (size < st.offset) {
        // Truncated/replaced file: resync to the new end.
        st.offset = size;
        st.leftover = Buffer.alloc(0);
        return;
      }
      if (size === st.offset) return;
      const buf = Buffer.alloc(size - st.offset);
      await handle.read({ buffer: buf, position: st.offset });
      if (runs.get(id) !== st) return; // re-check: stale after read()'s await
      st.offset = size;
      // Keep the partial tail as BYTES (not a decoded string) so a UTF-8
      // code point split across reads can't be garbled.
      let data = Buffer.concat([st.leftover, buf]);
      if (st.skipPartial) {
        const nl = data.indexOf(NL);
        if (nl === -1) {
          st.leftover = data;
          return;
        }
        data = data.subarray(nl + 1);
        st.skipPartial = false;
      }
      const lastNl = data.lastIndexOf(NL);
      if (lastNl === -1) {
        st.leftover = data;
        return;
      }
      st.leftover = Buffer.from(data.subarray(lastNl + 1));
      const at = deps.now().toISOString();
      for (const line of data.subarray(0, lastNl).toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        const events = deriveActivity(line, at);
        if (events.length === 0) continue;
        st.events.push(...events);
        if (st.events.length > RING_CAP) st.events.splice(0, st.events.length - RING_CAP);
        st.pending.push(...events);
        if (st.pending.length > RING_CAP) st.pending.splice(0, st.pending.length - RING_CAP);
      }
      scheduleFlush(id, st);
    } finally {
      await handle.close();
    }
  }

  /** Serialize reads per run: a poke during a read marks it dirty and re-runs. */
  function poke(id: string): void {
    const st = runs.get(id);
    if (!st) return;
    if (st.reading) {
      st.dirty = true;
      return;
    }
    st.reading = true;
    void readOnce(id)
      .catch((e) => console.error(`[argus] tail read for run ${id} failed:`, e))
      .finally(() => {
        // Compare by identity, not just presence: untrack+re-track during the
        // read may have put a *different* state object under the same id.
        const cur = runs.get(id);
        if (cur !== st) return;
        cur.reading = false;
        if (cur.dirty) {
          cur.dirty = false;
          poke(id);
        }
      });
  }

  function track(runId: string, instanceId: string): void {
    if (runs.has(runId)) return;
    runs.set(runId, {
      instanceId,
      offset: 0,
      leftover: Buffer.alloc(0),
      events: [],
      pending: [],
      flushTimer: null,
      reading: false,
      dirty: false,
      primed: false,
      skipPartial: false,
    });
    const logPath = runLogPath(runId);
    pathToRun.set(logPath, runId);
    watcher?.add(logPath);
    poke(runId);
  }

  function untrack(runId: string): void {
    const st = runs.get(runId);
    if (!st) return;
    if (st.flushTimer) clearTimeout(st.flushTimer);
    const logPath = runLogPath(runId);
    watcher?.unwatch(logPath);
    pathToRun.delete(logPath);
    runs.delete(runId);
  }

  function latest(): Map<string, ActivityEvent> {
    const out = new Map<string, ActivityEvent>();
    for (const [id, st] of runs) {
      const last = st.events[st.events.length - 1];
      if (last) out.set(id, last);
    }
    return out;
  }

  async function stop(): Promise<void> {
    for (const st of runs.values()) {
      if (st.flushTimer) clearTimeout(st.flushTimer);
    }
    runs.clear();
    pathToRun.clear();
    await watcher?.close();
  }

  return { track, untrack, latest, poke, stop };
}
