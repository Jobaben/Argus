/**
 * A keyed async mutex. Argus persists each pipeline instance and each JSON
 * store as a whole-file read-modify-write, so two concurrent mutations of the
 * same key (e.g. two sibling steps signalling completion at once, or the
 * reconcile pass racing a live signal) would read the same snapshot and the
 * second write would clobber the first — a classic lost update.
 *
 * Wrapping every mutation of a given key in `withLock(key, fn)` serializes
 * them: operations on different keys still run concurrently, operations on the
 * same key queue behind one another in call order.
 */
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();

  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    // Chain onto the current tail, swallowing its outcome so one failed
    // critical section doesn't poison the queue for the next caller.
    const run = prev.then(
      () => fn(),
      () => fn(),
    );
    // The stored tail must never reject — it exists only to order callers.
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    try {
      return await run;
    } finally {
      // Once the queue for this key has fully drained, drop it so the map
      // doesn't grow unbounded over the process lifetime.
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
