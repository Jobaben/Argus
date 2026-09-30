import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { h1Registry } from "./definitions.js";
import type { H1Record } from "./ledger.js";
import { replayH1 } from "./report.js";
import { gateInstance, h1Harness, H1_ON, MIN } from "./testSupport.js";

/**
 * Restarts, interrupted calls, archival, damage, caps, the call limits and
 * model arms (RFC §Q.7–§Q.9).
 */

const of = <K extends H1Record["kind"]>(rs: H1Record[], k: K) =>
  rs.filter((r): r is Extract<H1Record, { kind: K }> => r.kind === k);

class Stop extends Error {}

test("a crash after the intent line is an unknown outcome: counted as spent, never re-sent", async () => {
  const h = h1Harness({
    fault: (p) => {
      if (p === "attempt-written") throw new Stop("process stopped");
    },
  });
  h.world.put(gateInstance());
  await h.tick();
  await h.tick(); // attempt written, then the "process" stops before the call
  assert.equal(h.spawns.length, 0);
  // A restarted process over the same files.
  const again = h.boot();
  for (let i = 0; i < 4; i++) {
    h.clock.advance(20 * MIN);
    await again.watcher.check();
  }
  assert.equal(h.spawns.length, 0, "never re-sent");
  const recs = await h.records();
  const result = of(recs, "result")[0];
  assert.equal(result.class, "unknown-outcome");
  assert.equal(result.reconciled, true);
  const r = await replayH1(again.ledger, again.snapshots, again.journal, h1Registry());
  assert.equal(r.spend.spent, 1);
});

test("a crash after the call is reconciled from the journal and post-checked on restart", async () => {
  const h = h1Harness({
    fault: (p) => {
      if (p === "assessed") throw new Stop("process stopped");
    },
  });
  h.world.put(gateInstance());
  await h.tick();
  await h.tick(); // the call happens and is journaled; the result line is not written
  assert.equal(h.spawns.length, 1);
  const again = h.boot();
  h.clock.advance(MIN);
  await again.watcher.check();
  const recs = await h.records();
  const result = of(recs, "result")[0];
  assert.equal(result.class, "answered");
  assert.equal(result.reconciled, true);
  const post = of(recs, "post-check")[0];
  assert.equal(post.eligible, true, "still eligible now, so the prediction preceded any action");
  assert.equal(h.spawns.length, 1);
});

test("restarts and journal archival never reopen an item", async () => {
  const h = h1Harness();
  h.world.put(gateInstance());
  await h.tick();
  await h.tick();
  assert.equal(h.spawns.length, 1);
  await h.journal.archive();
  for (let i = 0; i < 3; i++) {
    const b = h.boot();
    h.clock.advance(30 * MIN);
    await b.watcher.check();
    await b.watcher.check();
  }
  assert.equal(h.spawns.length, 1);
  assert.equal(of(await h.records(), "capture").length, 1);
});

test("a refused call is retried at most three times, 30 minutes apart, and spends nothing", async () => {
  const h = h1Harness();
  h.state.enabled = false; // the runner's disabled switch: a pre-call refusal
  h.world.put(gateInstance());
  await h.tick();
  for (let i = 0; i < 12; i++) await h.tick(10 * MIN);
  const recs = await h.records();
  const results = of(recs, "result");
  assert.equal(results.length, 3);
  assert.ok(results.every((r) => r.class === "refused" && r.code === "disabled"));
  const times = of(recs, "attempt").map((a) => Date.parse(a.at));
  assert.ok(times[1] - times[0] >= 30 * MIN && times[2] - times[1] >= 30 * MIN);
  assert.equal(h.spawns.length, 0);
});

test("a missing retained snapshot is missing input: no call", async () => {
  const h = h1Harness();
  h.world.put(gateInstance());
  await h.tick();
  const c = of(await h.records(), "capture")[0];
  writeFileSync(
    path.join(
      h.root,
      "h1",
      "snapshots",
      c.snapshot.sha256.slice(0, 2),
      `${c.snapshot.sha256}.json`,
    ),
    "{}",
  );
  await h.tick();
  assert.equal(h.spawns.length, 0);
  const res = of(await h.records(), "result")[0];
  assert.equal(res.class, "missing-input");
  assert.equal(res.code, "snapshot-corrupt");
});

test("a damaged ledger halts captures and calls, and says why", async () => {
  const h = h1Harness();
  h.world.put(gateInstance());
  await h.tick();
  const file = path.join(h.root, "h1", "collection.jsonl");
  const lines = readFileSync(file, "utf8").split("\n");
  lines.splice(1, 1); // lose a line: a seq gap
  writeFileSync(file, lines.join("\n"));
  const b = h.boot();
  h.clock.advance(MIN);
  const out = await b.watcher.check();
  assert.equal(out.action, "halted");
  assert.match(b.watcher.status().detail ?? "", /damaged/);
  assert.equal(h.spawns.length, 0);
});

test("a torn tail is fenced and collection continues", async () => {
  const h = h1Harness();
  h.world.put(gateInstance());
  await h.tick();
  appendFileSync(path.join(h.root, "h1", "collection.jsonl"), '{"kind":"capt');
  const b = h.boot();
  h.clock.advance(MIN);
  assert.equal((await b.watcher.check()).action, "done"); // a restart's first check defers
  h.clock.advance(MIN);
  assert.equal((await b.watcher.check()).action, "done");
  assert.equal(h.spawns.length, 1);
  assert.ok(
    readFileSync(path.join(h.root, "h1", "collection.jsonl"), "utf8").includes("torn-marker"),
  );
});

test("the ledger and the snapshot store stop honestly at their caps", async () => {
  const small = h1Harness({ maxSnapshotBytes: 100 });
  small.world.put(gateInstance());
  await small.tick();
  const recs = await small.records();
  assert.equal(of(recs, "capture").length, 0);
  assert.deepEqual(
    of(recs, "gate").map((g) => g.reason),
    ["store-full"],
  );

  // Room for the start and config lines, and not for a capture.
  const probe = h1Harness();
  await probe.tick();
  const header = readFileSync(path.join(probe.root, "h1", "collection.jsonl")).length;
  const tiny = h1Harness({ maxLedgerBytes: header + 200 });
  tiny.world.put(gateInstance());
  const out = await tiny.tick();
  assert.equal(out.action, "error");
  assert.match(tiny.watcher.status().detail ?? "", /ledger-full/);
  const before = readFileSync(path.join(tiny.root, "h1", "collection.jsonl"), "utf8");
  await tiny.tick();
  assert.equal(
    readFileSync(path.join(tiny.root, "h1", "collection.jsonl"), "utf8"),
    before,
    "nothing more written",
  );
  assert.equal(tiny.spawns.length, 0);
});

test("existing analysis goes first: another pass since the last check, or one in flight, defers the call", async () => {
  const h = h1Harness();
  h.world.put(gateInstance());
  await h.tick(); // first check defers
  // Another feature's pass runs between checks.
  await h.runner.run({ kind: "autopsy", prompt: "x", cwd: h.root }, () => ({}));
  const out = await h.tick();
  assert.equal(out.action === "done" && out.call.kind, "deferred");
  assert.equal(h.spawns.length, 1, "only the other pass spawned");
  h.state.spendBlocked = true;
  const paused = await h.tick();
  assert.equal(paused.action === "done" && paused.call.kind, "paused");
  assert.equal(h.spawns.length, 1);
});

test("limits: own share, the combined daily cap, the combined interval and dollars", async () => {
  // Own share: 1 call a day for H1.
  const own = h1Harness({ env: { ...H1_ON, ARGUS_DECISIONS_H1_MAX_OWN_CALLS_PER_DAY: "1" } });
  own.world.put(gateInstance({ id: "i1" }));
  own.world.put(gateInstance({ id: "i2", runIds: ["run-b"] }));
  await own.tick();
  await own.tick();
  for (let i = 0; i < 4; i++) await own.tick(20 * MIN);
  assert.equal(own.spawns.length, 1);

  // Combined: H2 already spent 20 today, so H1 makes none.
  const now = Date.parse("2026-09-01T12:00:00.000Z");
  const full = h1Harness({
    otherSpend: async () =>
      Array.from({ length: 20 }, (_, i) => ({ atMs: now - i * MIN, costUsd: 0.001 })),
  });
  full.world.put(gateInstance());
  await full.tick();
  const out = await full.tick();
  assert.equal(out.action === "done" && out.call.kind, "limited");
  assert.match(
    out.action === "done" && out.call.kind === "limited" ? out.call.detail : "",
    /shadow invocations/,
  );
  assert.equal(full.spawns.length, 0);

  // Interval: an H2 call 5 minutes ago holds H1 back.
  let otherAt = 0;
  const gap = h1Harness({ otherSpend: async () => [{ atMs: otherAt, costUsd: 0 }] });
  gap.world.put(gateInstance());
  await gap.tick();
  otherAt = gap.clock.now().getTime() - 5 * MIN + MIN;
  const held = await gap.tick();
  assert.equal(held.action === "done" && held.call.kind, "limited");
  await gap.tick(15 * MIN);
  assert.equal(gap.spawns.length, 1);

  // Dollars: a combined US$1 recorded.
  const usd = h1Harness({ otherSpend: async () => [{ atMs: now - 3 * 60 * MIN, costUsd: 1.2 }] });
  usd.world.put(gateInstance());
  await usd.tick();
  const capped = await usd.tick();
  assert.equal(capped.action === "done" && capped.call.kind, "limited");
  assert.equal(usd.spawns.length, 0);
});

test("model arms: each item gets one arm, never two calls, and populations stay apart by requested model", async () => {
  const h = h1Harness({ env: { ...H1_ON, ARGUS_DECISIONS_H1_MODELS: "haiku,sonnet" } });
  const n = 12;
  for (let i = 0; i < n; i++) h.world.put(gateInstance({ id: `inst-${i}`, runIds: [`run-${i}`] }));
  await h.tick();
  for (let i = 0; i < 3 * n; i++) await h.tick(16 * MIN);
  const recs = await h.records();
  const captures = of(recs, "capture");
  assert.equal(captures.length, n);
  const attempts = of(recs, "attempt");
  assert.equal(new Set(attempts.map((a) => a.itemKey)).size, attempts.length, "one call per item");
  assert.ok(attempts.length <= 10, "within H1's share");
  const byItem = new Map(captures.map((c) => [c.itemKey, c.sample.arm]));
  for (const a of attempts) {
    assert.equal(a.arm, byItem.get(a.itemKey));
    assert.equal(a.provider.requestedModel, a.arm === 0 ? "haiku" : "sonnet");
  }
  assert.deepEqual(
    h.spawns.map((s) => s.model),
    attempts.map((a) => (a.arm === 0 ? "haiku" : "sonnet")),
  );
  assert.equal(
    new Set(captures.map((c) => c.sample.arm)).size,
    2,
    "both arms drawn over twelve items",
  );
  for (const id of [...h.world.instances.keys()]) h.world.act(id, "approve");
  await h.tick();
  const r = await replayH1(h.ledger, h.snapshots, h.journal, h1Registry());
  const requested = r.models.map((m) => m.provider.requestedModel).sort();
  assert.deepEqual([...new Set(requested)], requested, "one population per requested model");
});
