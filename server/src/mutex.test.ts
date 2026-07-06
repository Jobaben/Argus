import { test } from "node:test";
import assert from "node:assert/strict";
import { KeyedMutex } from "./mutex.js";

test("same-key critical sections never interleave", async () => {
  const m = new KeyedMutex();
  const log: string[] = [];
  let active = 0;
  const crit = (tag: string) => async () => {
    active++;
    assert.equal(active, 1, `overlap detected at ${tag}`);
    log.push(`${tag}:start`);
    await new Promise((r) => setTimeout(r, 5));
    log.push(`${tag}:end`);
    active--;
  };
  await Promise.all([
    m.withLock("k", crit("a")),
    m.withLock("k", crit("b")),
    m.withLock("k", crit("c")),
  ]);
  // FIFO order preserved, and each section runs start→end before the next.
  assert.deepEqual(log, ["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
});

test("different keys run concurrently", async () => {
  const m = new KeyedMutex();
  let peak = 0;
  let active = 0;
  const crit = async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
  };
  await Promise.all([m.withLock("a", crit), m.withLock("b", crit), m.withLock("c", crit)]);
  assert.equal(peak, 3);
});

test("a throwing section does not poison the queue", async () => {
  const m = new KeyedMutex();
  await assert.rejects(m.withLock("k", async () => { throw new Error("boom"); }));
  const result = await m.withLock("k", async () => 42);
  assert.equal(result, 42);
});
