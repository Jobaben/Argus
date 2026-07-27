import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-instances-"));
  process.env.ARGUS_CLAUDE_HOME = home;
});

async function fresh() {
  return import(`./instances.js?${Math.random()}`);
}

const makeInstance = (id: string, pipelineId: string, createdAt: string) => ({
  id,
  pipelineId,
  pipelineName: "feature pipeline",
  status: "running" as const,
  currentPhaseIndex: 0,
  phases: [
    {
      id: "p0",
      name: "P0",
      gated: false,
      status: "running" as const,
      steps: [],
      attempt: 0,
      payload: null,
    },
  ],
  trigger: "manual" as const,
  signalToken: "tok",
  createdAt,
  updatedAt: createdAt,
  endedAt: null,
});

test("writeInstance then readInstance round-trips", async () => {
  const m = await fresh();
  await m.writeInstance(makeInstance("i1", "p1", new Date(2026, 5, 30, 9, 0).toISOString()));
  const got = await m.readInstance("i1");
  assert.equal(got?.id, "i1");
  assert.equal(got?.signalToken, "tok");
});

test("readInstances filters by pipeline, newest first", async () => {
  const m = await fresh();
  await m.writeInstance(makeInstance("a", "p1", new Date(2026, 5, 30, 9, 0).toISOString()));
  await m.writeInstance(makeInstance("b", "p1", new Date(2026, 5, 30, 10, 0).toISOString()));
  await m.writeInstance(makeInstance("c", "p2", new Date(2026, 5, 30, 11, 0).toISOString()));
  const p1 = await m.readInstances({ pipelineId: "p1" });
  assert.deepEqual(
    p1.map((i: { id: string }) => i.id),
    ["b", "a"],
  );
});

test("pruneInstances keeps only newest N of a pipeline", async () => {
  const m = await fresh();
  for (let i = 0; i < 5; i++) {
    await m.writeInstance(makeInstance(`r${i}`, "p1", new Date(2026, 5, 30, 9, i).toISOString()));
  }
  await m.pruneInstances("p1", 2);
  const left = await m.readInstances({ pipelineId: "p1" });
  assert.deepEqual(
    left.map((i: { id: string }) => i.id),
    ["r4", "r3"],
  );
});

test("memo: repeat reads are stable and direct file edits are picked up", async () => {
  const m = await fresh();
  await m.writeInstance(makeInstance("i1", "p1", new Date(2026, 5, 30, 9, 0).toISOString()));
  // Prime the memo, then read again — same object served from memory.
  const first = await m.readInstance("i1");
  const second = await m.readInstance("i1");
  assert.equal(second, first);
  // A direct on-disk edit (new mtime) must invalidate the memo entry.
  const file = path.join(home, "argus", "instances", "i1.json");
  const edited = {
    ...makeInstance("i1", "p1", new Date(2026, 5, 30, 9, 0).toISOString()),
    status: "failed",
  };
  const { writeFileSync, utimesSync } = await import("node:fs");
  writeFileSync(file, JSON.stringify(edited));
  utimesSync(file, new Date(), new Date(Date.now() + 5000));
  const third = await m.readInstance("i1");
  assert.equal(third?.status, "failed");
});

test("readInstance rejects path-traversal ids", async () => {
  const m = await fresh();
  assert.equal(await m.readInstance("../../../etc/passwd"), null);
  assert.equal(await m.readInstance("a/b"), null);
});

test("a write patches the cached scan instead of discarding it", async () => {
  // A running pipeline writes on every step transition. Each write used to drop
  // the directory-scan cache, so the next reader — board, palette, briefing, or
  // the engine's own reconcile pass — re-stat'ed every retained instance.
  const m = await fresh();
  for (let i = 0; i < 6; i++) {
    await m.writeInstance(makeInstance(`r${i}`, "p1", new Date(2026, 5, 30, 9, i).toISOString()));
  }
  const before = await m.readInstances();
  assert.equal(before.length, 6);

  // Rewriting an existing instance must be visible immediately (read-after-write
  // stays exact) without the cache being thrown away.
  const changed = {
    ...makeInstance("r3", "p1", new Date(2026, 5, 30, 9, 3).toISOString()),
    status: "failed" as const,
  };
  await m.writeInstance(changed);
  const after = await m.readInstances();
  assert.equal(after.length, 6, "no duplicate, no loss");
  assert.equal(after.find((i: { id: string }) => i.id === "r3")?.status, "failed");
  assert.deepEqual(
    after.map((i: { id: string }) => i.id),
    ["r5", "r4", "r3", "r2", "r1", "r0"],
    "still newest-first",
  );
});

test("a brand-new instance appears in an already-warm scan", async () => {
  const m = await fresh();
  await m.writeInstance(makeInstance("old", "p1", new Date(2026, 5, 30, 9, 0).toISOString()));
  await m.readInstances(); // warm the scan cache
  await m.writeInstance(makeInstance("new", "p1", new Date(2026, 5, 30, 10, 0).toISOString()));
  const all = await m.readInstances();
  assert.deepEqual(
    all.map((i: { id: string }) => i.id),
    ["new", "old"],
  );
});

test("the cache never hands out an array a caller can mutate", async () => {
  const m = await fresh();
  await m.writeInstance(makeInstance("a", "p1", new Date(2026, 5, 30, 9, 0).toISOString()));
  await m.writeInstance(makeInstance("b", "p1", new Date(2026, 5, 30, 10, 0).toISOString()));
  const first = await m.readInstances();
  first.length = 0;
  assert.equal((await m.readInstances()).length, 2);
});

test("the memo holds the whole directory rather than evicting what the next scan wants", async () => {
  // The memo was a 500-entry LRU, which is the pathological policy for a
  // full-directory scan: past the cap it evicted each entry just before the next
  // scan needed it, so a "warm" scan of 1000 files cost 5x a warm scan of 400.
  const m = await fresh();
  const count = 40;
  for (let i = 0; i < count; i++) {
    await m.writeInstance(
      makeInstance(
        `i${String(i).padStart(3, "0")}`,
        "p1",
        new Date(2026, 5, 30, 9, i).toISOString(),
      ),
    );
  }
  const first = await m.readInstances();
  const second = await m.readInstances();
  // Same parsed objects, not re-parsed copies: identity proves the memo served
  // every one of them, not just the tail.
  for (let i = 0; i < count; i++) assert.equal(second[i], first[i], `entry ${i}`);
});

test("forgetting a deleted instance: a pruned id is not served from the memo", async () => {
  const m = await fresh();
  await m.writeInstance(makeInstance("keep", "p1", new Date(2026, 5, 30, 10, 0).toISOString()));
  await m.writeInstance(makeInstance("drop", "p1", new Date(2026, 5, 30, 9, 0).toISOString()));
  await m.readInstances();
  await m.pruneInstances("p1", 1);
  const left = await m.readInstances();
  assert.deepEqual(
    left.map((i: { id: string }) => i.id),
    ["keep"],
  );
  assert.equal(await m.readInstance("drop"), null);
});
