import { test } from "node:test";
import assert from "node:assert/strict";
import { cached, invalidateCaches } from "./cache.js";

test("single-flight: concurrent callers share one load", async () => {
  invalidateCaches();
  let calls = 0;
  const load = async () => { calls++; return 7; };
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
  const load = async () => { calls++; return calls; };
  let now = 1000;
  const clock = () => now;
  assert.equal(await cached("k", 500, load, clock), 1);
  now = 1400; // within TTL
  assert.equal(await cached("k", 500, load, clock), 1);
  now = 1600; // past TTL
  assert.equal(await cached("k", 500, load, clock), 2);
});

test("a rejected load is not cached", async () => {
  invalidateCaches();
  let calls = 0;
  const load = async () => { calls++; if (calls === 1) throw new Error("boom"); return 42; };
  await assert.rejects(cached("k", 1000, load, () => 0));
  assert.equal(await cached("k", 1000, load, () => 0), 42);
  assert.equal(calls, 2);
});
