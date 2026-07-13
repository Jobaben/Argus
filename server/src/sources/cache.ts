/**
 * A tiny single-flight + short-TTL cache for expensive read sources (e.g.
 * /api/sessions reads dozens of transcript files per call). Under the live
 * dashboard, a single server broadcast can trigger several near-simultaneous
 * refetches; this collapses them:
 *
 *  - single-flight: concurrent callers within one in-flight read share the
 *    same promise instead of each hitting the filesystem,
 *  - TTL: a result is reused for `ttlMs` so a burst of refetches costs one scan.
 *
 * The TTL is deliberately short (well under the watcher debounce plus network
 * latency) so freshness is effectively unchanged while the stampede is gone.
 * `invalidateCaches()` clears everything (used by tests).
 */
interface Entry<T> {
  at: number;
  ttlMs: number;
  value: Promise<T>;
}

// Hard bound on distinct keys. Keys are a small fixed vocabulary
// (`sessions:50`, `stats`, …), so overflow means a caller is interpolating
// unbounded input into keys — sweep expired entries first, then evict oldest.
const MAX_ENTRIES = 256;

const entries = new Map<string, Entry<unknown>>();

function enforceBound(t: number): void {
  if (entries.size <= MAX_ENTRIES) return;
  for (const [key, entry] of entries) {
    if (t - entry.at >= entry.ttlMs) entries.delete(key);
  }
  while (entries.size > MAX_ENTRIES) {
    entries.delete(entries.keys().next().value as string);
  }
}

export function cached<T>(
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
  now = Date.now,
): Promise<T> {
  const hit = entries.get(key) as Entry<T> | undefined;
  const t = now();
  if (hit && t - hit.at < ttlMs) return hit.value;
  const value = load();
  entries.set(key, { at: t, ttlMs, value });
  enforceBound(t);
  // If the load rejects, drop the entry so the next caller retries instead of
  // caching a rejected promise for the whole TTL.
  void value.catch(() => {
    if (entries.get(key)?.value === value) entries.delete(key);
  });
  return value;
}

/** Drop one key immediately. For sources whose writes happen in-process (runs,
 *  instances), eager invalidation on write keeps read-after-write exact while
 *  the TTL still collapses the broadcast-driven refetch stampede. */
export function invalidate(key: string): void {
  entries.delete(key);
}

export function invalidateCaches(): void {
  entries.clear();
}

/** Current number of cached keys (test introspection). */
export function cacheSize(): number {
  return entries.size;
}
