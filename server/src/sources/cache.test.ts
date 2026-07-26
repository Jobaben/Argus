import { test } from "node:test";
import assert from "node:assert/strict";
import { cached, cacheSize, invalidateCaches, patchCached } from "./cache.js";

test("single-flight: concurrent callers share one load", async () => {
  invalidateCaches();
  let calls = 0;
  const load = async () => {
    calls++;
    return 7;
  };
  const [a, b] = await Promise.all([
    cached("k", 1000, load, () => 0),
    cached("k", 1000, load, () => 0),
  ]);
  assert.equal(a, 7);
  assert.equal(b, 7);
  assert.equal(calls, 1);
});

test("TTL: reuses within window, reloads after it", async () => {
  invalidateCaches();
  let calls = 0;
  const load = async () => {
    calls++;
    return calls;
  };
  let now = 1000;
  const clock = () => now;
  assert.equal(await cached("k", 500, load, clock), 1);
  now = 1400; // within TTL
  assert.equal(await cached("k", 500, load, clock), 1);
  now = 1600; // past TTL
  assert.equal(await cached("k", 500, load, clock), 2);
});

test("size bound: expired entries are swept, live ones survive", async () => {
  invalidateCaches();
  let now = 0;
  const clock = () => now;
  // Fill past the bound with entries that expire immediately.
  for (let i = 0; i < 300; i++) {
    await cached(`stale:${i}`, 1, async () => i, clock);
  }
  now = 10; // everything above is now expired
  await cached("live", 10_000, async () => "x", clock);
  assert.ok(cacheSize() <= 256, `size ${cacheSize()} exceeds bound`);
  // The live entry survived the sweep.
  let reloaded = false;
  const v = await cached(
    "live",
    10_000,
    async () => {
      reloaded = true;
      return "y";
    },
    clock,
  );
  assert.equal(v, "x");
  assert.equal(reloaded, false);
});

test("size bound: unexpired overflow evicts oldest first", async () => {
  invalidateCaches();
  const clock = () => 0;
  for (let i = 0; i < 300; i++) {
    await cached(`k:${i}`, 60_000, async () => i, clock);
  }
  assert.ok(cacheSize() <= 256, `size ${cacheSize()} exceeds bound`);
  // Newest entries are retained.
  let calls = 0;
  const v = await cached(
    "k:299",
    60_000,
    async () => {
      calls++;
      return -1;
    },
    clock,
  );
  assert.equal(v, 299);
  assert.equal(calls, 0);
});

test("a rejected load is not cached", async () => {
  invalidateCaches();
  let calls = 0;
  const load = async () => {
    calls++;
    if (calls === 1) throw new Error("boom");
    return 42;
  };
  await assert.rejects(cached("k", 1000, load, () => 0));
  assert.equal(await cached("k", 1000, load, () => 0), 42);
  assert.equal(calls, 2);
});

test("patchCached rewrites a cached value without reloading it", async () => {
  invalidateCaches();
  let calls = 0;
  const load = async () => {
    calls++;
    return [1, 2, 3];
  };
  assert.deepEqual(await cached("k", 1000, load, () => 0), [1, 2, 3]);
  assert.equal(
    patchCached<number[]>("k", (v) => [...v, 4]),
    true,
  );
  assert.deepEqual(await cached("k", 1000, load, () => 0), [1, 2, 3, 4]);
  assert.equal(calls, 1, "the patch derived the new value instead of reloading");
});

test("patchCached reports a miss so the caller can fall back to a reload", () => {
  invalidateCaches();
  assert.equal(
    patchCached<number[]>("never-cached", (v) => v),
    false,
  );
});

test("patchCached does not extend the TTL", async () => {
  // Otherwise a stream of in-process writes could keep an entry alive
  // indefinitely, and a change Argus did not make would never be seen.
  invalidateCaches();
  let calls = 0;
  const load = async () => {
    calls++;
    return calls;
  };
  let now = 0;
  assert.equal(await cached("k", 100, load, () => now), 1);
  now = 50;
  patchCached<number>("k", (v) => v + 100);
  assert.equal(await cached("k", 100, load, () => now), 101, "patched, still inside the window");
  now = 150;
  assert.equal(await cached("k", 100, load, () => now), 2, "expired on the original schedule");
});

test("a patch that throws drops the entry instead of caching a rejection", async () => {
  invalidateCaches();
  let calls = 0;
  const load = async () => {
    calls++;
    return calls;
  };
  assert.equal(await cached("k", 1000, load, () => 0), 1);
  patchCached<number>("k", () => {
    throw new Error("bad patch");
  });
  await assert.rejects(() => cached("k", 1000, load, () => 0));
  // The entry is gone, so the next caller reloads rather than seeing the failure
  // again for the rest of the TTL.
  assert.equal(await cached("k", 1000, load, () => 0), 2);
});
