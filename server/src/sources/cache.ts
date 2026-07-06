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
  value: Promise<T>;
}

const entries = new Map<string, Entry<unknown>>();

export function cached<T>(key: string, ttlMs: number, load: () => Promise<T>, now = Date.now): Promise<T> {
  const hit = entries.get(key) as Entry<T> | undefined;
  const t = now();
  if (hit && t - hit.at < ttlMs) return hit.value;
  const value = load();
  entries.set(key, { at: t, value });
  // If the load rejects, drop the entry so the next caller retries instead of
  // caching a rejected promise for the whole TTL.
  void value.catch(() => {
    if (entries.get(key)?.value === value) entries.delete(key);
  });
  return value;
}

export function invalidateCaches(): void {
  entries.clear();
}
