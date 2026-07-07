import { test } from "node:test";
import assert from "node:assert/strict";
import { cached, cacheSize, invalidateCaches } from "./cache.js";

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
