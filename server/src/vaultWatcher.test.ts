import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createVaultWatcher } from "./vaultWatcher.js";
import { closeVault } from "./vault/db.js";
import type { Run } from "./sources/scheduleTypes.js";

const NOW = new Date("2026-07-20T12:00:00.000Z");

function deps(over: Partial<Parameters<typeof createVaultWatcher>[0]> = {}) {
  return {
    now: () => NOW,
    readRuns: async (): Promise<Run[]> => [],
    readIncidents: async () => [],
    readAnomalies: async () => [],
    readVerdicts: async () => [],
    readSpend: async () => ({ days: {} }),
    ...over,
  };
}

async function withHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = await mkdtemp(path.join(tmpdir(), "argus-vw-"));
  const previous = process.env.ARGUS_CLAUDE_HOME;
  process.env.ARGUS_CLAUDE_HOME = home;
  closeVault();
  try {
    return await fn();
  } finally {
    closeVault();
    if (previous === undefined) delete process.env.ARGUS_CLAUDE_HOME;
    else process.env.ARGUS_CLAUDE_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
}

test("a pass reports what it ingested", async () => {
  await withHome(async () => {
    const seen: unknown[] = [];
    const watcher = createVaultWatcher(deps({ onIngest: (r) => seen.push(r) }));
    const result = await watcher.check();
    assert.equal(result?.ok, true, result?.error ?? "");
    assert.equal(seen.length, 1);
  });
});

test("the watcher is a no-op while the Vault is off", async () => {
  await withHome(async () => {
    process.env.ARGUS_VAULT = "off";
    closeVault();
    try {
      const watcher = createVaultWatcher(deps());
      assert.equal(await watcher.check(), null);
    } finally {
      delete process.env.ARGUS_VAULT;
    }
  });
});

test("regression: a source that throws skips the pass instead of writing a partial history", async () => {
  await withHome(async () => {
    let reads = 0;
    const watcher = createVaultWatcher(
      deps({
        readRuns: async () => {
          reads++;
          if (reads === 1) throw new Error("disk gone");
          return [];
        },
      }),
    );
    assert.equal(await watcher.check(), null);
    // A half-read pass would look complete in the Vault forever, so it backs
    // off rather than committing what it managed to read.
    assert.equal(await watcher.check(), null);
    assert.equal(await watcher.check(), null);
    assert.equal(reads, 1);
    // …and comes back once the cooldown has drained.
    assert.notEqual(await watcher.check(), null);
  });
});

test("a slow pass sits out exactly one tick", async () => {
  await withHome(async () => {
    const watcher = createVaultWatcher(
      deps({
        // Reporting a slow pass rather than being one: the backoff is about the
        // measured duration, and a test that actually took a second to prove it
        // would be a second slower for nothing.
        ingest: () => ({
          ok: true,
          runs: 0,
          events: 0,
          spendDays: 0,
          scores: 0,
          ms: 5_000,
          error: null,
        }),
      }),
    );
    assert.notEqual(await watcher.check(), null);
    assert.equal(await watcher.check(), null);
    assert.notEqual(await watcher.check(), null);
  });
});

test("regression: a failing pass is retried, and does not log on every tick", async () => {
  await withHome(async () => {
    let passes = 0;
    const watcher = createVaultWatcher(
      deps({
        ingest: () => {
          passes++;
          return {
            ok: false,
            runs: 0,
            events: 0,
            spendDays: 0,
            scores: 0,
            ms: 1,
            error: "disk full",
          };
        },
      }),
    );
    const first = await watcher.check();
    assert.equal(first?.ok, false);
    // Four quiet ticks, then one more attempt — a Vault that cannot open must
    // not write a warning line every thirty seconds, forever.
    for (let i = 0; i < 4; i++) assert.equal(await watcher.check(), null);
    assert.notEqual(await watcher.check(), null);
    assert.equal(passes, 2);
  });
});
