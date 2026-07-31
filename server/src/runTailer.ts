/**
 * Tails the NDJSON logs of running pipeline steps and derives compact activity
 * events for the Command Center. Both runtimes write one: `claude -p
 * --output-format stream-json --verbose` and `codex exec --json`. The two use
 * different event vocabularies, so the line-to-event mapping belongs to the
 * runtime; everything here is the byte-offset machinery that is the same for
 * either. The log on disk is the durable source of truth; all of this is
 * in-memory and rebuilt from the log after a restart.
 */

import { open } from "node:fs/promises";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { LOG_CAP_BYTES, runLogPath } from "./sources/runs.js";
import { runtimeFor } from "./runtimes/index.js";
import type { ActivityEvent, AgentRuntimeId } from "@argus/contracts";
import { log } from "./log.js";

export type { ActivityEvent } from "@argus/contracts";

/**
 * Map one NDJSON line to zero or more activity events for the named runtime.
 * Unknown, malformed, and uninteresting lines yield nothing.
 *
 * Defaults to Claude Code when no runtime is named, which is what every caller
 * that predates runtimes means.
 */
export function deriveActivity(
  line: string,
  at: string,
  runtime?: AgentRuntimeId | null,
): ActivityEvent[] {
  return runtimeFor(runtime ?? "claude").deriveActivity(line, at);
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
  /** `runtime` decides how the log's lines are read; omitted means Claude Code. */
  track(runId: string, instanceId: string, runtime?: AgentRuntimeId | null): void;
  untrack(runId: string): void;
  latest(): Map<string, ActivityEvent>;
  poke(runId: string): void;
  stop(): Promise<void>;
}

interface TrackedRun {
  instanceId: string;
  runtime: AgentRuntimeId | null;
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
          .on("error", (e: unknown) => log.error("run tail watcher error", { err: e }));

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
        const events = deriveActivity(line, at, st.runtime);
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
      .catch((e: unknown) => log.error("tail read failed", { runId: id, err: e }))
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

  function track(runId: string, instanceId: string, runtime?: AgentRuntimeId | null): void {
    if (runs.has(runId)) return;
    runs.set(runId, {
      instanceId,
      runtime: runtime ?? null,
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
