import { test } from "node:test";
import assert from "node:assert/strict";
import { createFileMemo } from "./fileMemo.js";

test("a hit requires the mtime to match", () => {
  const memo = createFileMemo<string>();
  memo.set("a", 100, "v1");
  assert.equal(memo.get("a", 100), "v1");
  assert.equal(memo.get("a", 101), undefined, "the file changed under us");
  assert.equal(memo.get("missing", 100), undefined);
});

test("retain keeps exactly what the scan saw", () => {
  const memo = createFileMemo<string>();
  memo.set("a", 1, "A");
  memo.set("b", 1, "B");
  memo.set("c", 1, "C");
  memo.retain(new Set(["a", "c"]));
  assert.equal(memo.size(), 2);
  assert.equal(memo.get("b", 1), undefined);
  assert.equal(memo.get("a", 1), "A");
});

test("a full scan of a directory larger than the old LRU cap keeps every entry", () => {
  // The bug this replaces: a 500-entry LRU under a sequential full-directory
  // scan evicts each entry just before the next scan asks for it, so past the
  // cap every read is a re-parse and the memo is pure overhead.
  const memo = createFileMemo<number>();
  for (let i = 0; i < 1000; i++) memo.set(`k${i}`, 1, i);
  assert.equal(memo.size(), 1000);
  for (let i = 0; i < 1000; i++) assert.equal(memo.get(`k${i}`, 1), i, `k${i}`);
});

test("the ceiling stops growth but keeps a stable subset", () => {
  const memo = createFileMemo<number>(3);
  for (let i = 0; i < 10; i++) memo.set(`k${i}`, 1, i);
  assert.equal(memo.size(), 3);
  // The first three admitted, not the last three: a caller scanning in sorted
  // order therefore reuses the same subset on every pass instead of rotating.
  assert.equal(memo.get("k0", 1), 0);
  assert.equal(memo.get("k9", 1), undefined);
  // An entry already held is still refreshable past the ceiling.
  memo.set("k0", 2, 100);
  assert.equal(memo.get("k0", 2), 100);
});

test("forget drops one key", () => {
  const memo = createFileMemo<string>();
  memo.set("a", 1, "A");
  memo.forget("a");
  assert.equal(memo.get("a", 1), undefined);
});

test("retain is a no-op when the memo is no larger than the scan", () => {
  const memo = createFileMemo<string>();
  memo.set("a", 1, "A");
  memo.retain(new Set(["a", "b", "c"]));
  assert.equal(memo.get("a", 1), "A");
});
