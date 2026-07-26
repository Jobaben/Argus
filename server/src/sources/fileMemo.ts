/**
 * An mtime-keyed parse memo for a directory of JSON records.
 *
 * Runs and pipeline instances are each a directory of small files that the hot
 * read paths re-scan constantly: `/api/overview`, `/api/insight`, `/api/palette`,
 * `/api/briefing`, `/api/monitors`, `/api/issues`, the Chronicle and the engine's
 * own reconcile pass. An unchanged file — the overwhelming common case — should
 * cost a `stat`, not a read plus `JSON.parse`.
 *
 * **Retention is by scan membership, not recency.** Both memos used to be
 * 500-entry LRUs, which is the pathological policy for this access pattern: a
 * full-directory scan touches every file exactly once, in order, so past the cap
 * each entry is evicted just before the next scan asks for it. Measured over
 * ~4 kB records, a *warm* scan cost 25ms at 400 files and 130ms at 1000 — the
 * mitigation inverted at precisely the scale that needed it, and the LRU
 * bookkeeping became pure overhead. Retaining by membership makes a warm scan
 * 42ms at 1000 files, all of it `readdir` plus `stat`.
 *
 * Memory is bounded by what is on disk, which pruning already bounds. `ceiling`
 * is a runaway guard for a directory pruning has not reached, not a working-set
 * limit — and past it a memo keeps whichever keys it saw first, so with a
 * caller that scans in sorted order the retained subset is stable and the
 * benefit degrades smoothly instead of collapsing.
 */
export interface FileMemo<T> {
  /** The parsed value if the file's mtime still matches, else undefined. */
  get(key: string, mtimeMs: number): T | undefined;
  set(key: string, mtimeMs: number, value: T): void;
  /** Forget one key — call on write and on delete. */
  forget(key: string): void;
  /** Forget every key the latest scan did not see. */
  retain(keys: Set<string>): void;
  /** Test introspection. */
  size(): number;
}

export const DEFAULT_MEMO_CEILING = 10_000;

export function createFileMemo<T>(ceiling = DEFAULT_MEMO_CEILING): FileMemo<T> {
  const entries = new Map<string, { mtime: number; value: T }>();
  return {
    get(key, mtimeMs) {
      const hit = entries.get(key);
      return hit && hit.mtime === mtimeMs ? hit.value : undefined;
    },
    set(key, mtimeMs, value) {
      if (!entries.has(key) && entries.size >= ceiling) return;
      entries.set(key, { mtime: mtimeMs, value });
    },
    forget(key) {
      entries.delete(key);
    },
    retain(keys) {
      if (entries.size <= keys.size) return;
      for (const key of entries.keys()) {
        if (!keys.has(key)) entries.delete(key);
      }
    },
    size() {
      return entries.size;
    },
  };
}
