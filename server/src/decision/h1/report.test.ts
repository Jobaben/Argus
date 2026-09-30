import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import path from "node:path";
import { tempRoot } from "../testSupport.js";
import { h1Registry } from "./definitions.js";
import { H1Ledger, type H1Record, type NewH1Record } from "./ledger.js";
import { renderH1Report, replayH1 } from "./report.js";
import { H1SnapshotStore } from "./snapshots.js";
import { gateInstance, h1Harness } from "./testSupport.js";

/**
 * Integrity findings in `decision-h1-report` v1 (RFC §Q.11): what was retained
 * is what is scored, and anything that no longer matches is reported, not
 * scored.
 */

async function settledRecords() {
  const h = h1Harness({ answer: () => JSON.stringify({ p: 0.2 }) });
  h.world.put(gateInstance());
  await h.tick();
  await h.tick();
  h.world.act("inst-1", "approve");
  await h.tick();
  return { h, records: await h.records() };
}

/** Re-append records into a fresh ledger, with one of them changed. */
async function rewrite(
  h: Awaited<ReturnType<typeof settledRecords>>["h"],
  records: H1Record[],
  change: (r: H1Record) => H1Record,
) {
  const root = tempRoot("argus-h1-report-");
  const ledger = new H1Ledger({ root });
  await ledger.append(
    records.map((r) => {
      const { seq: _seq, ...rest } = change(structuredClone(r));
      return rest as NewH1Record;
    }),
  );
  return replayH1(
    ledger,
    new H1SnapshotStore({ root: path.join(h.root, "h1") }),
    h.boot().journal,
    h1Registry(),
  );
}

test("the same records replay to the same bytes", async () => {
  const { h } = await settledRecords();
  const inputs = async () => ({
    ledger: await h.boot().ledger.read(),
    snapshots: new Map(
      await Promise.all(
        (await h.records())
          .filter((r): r is Extract<H1Record, { kind: "capture" }> => r.kind === "capture")
          .map(
            async (c) => [c.snapshot.sha256, await h.snapshots.load(c.snapshot.sha256)] as const,
          ),
      ),
    ),
    journal: await h.boot().journal.read(),
    registry: h1Registry(),
  });
  assert.equal(renderH1Report(await inputs()), renderH1Report(await inputs()));
  const r = await replayH1(h.ledger, h.snapshots, h.journal, h1Registry());
  assert.equal(r.integrity.history, "complete");
  assert.match(r.statement, /No figure in this report can justify skipping review\./);
});

test("a retained reference that no longer matches its digest is a finding, not a label", async () => {
  const { h, records } = await settledRecords();
  const r = await rewrite(h, records, (rec) => {
    if (rec.kind === "settle" && rec.reference) rec.reference.value = "revise";
    return rec;
  });
  assert.ok(r.integrity.findings.some((f) => f.kind === "reference-corrupt"));
  assert.equal(r.integrity.history, "incomplete");
  assert.deepEqual(r.census[0].unlabeled, { "reference-corrupt": 1 });
  assert.equal(r.deterministic[0].scored, 0);
  assert.equal(r.models[0].agreement.scored, 0);
});

test("a recorded rule result that the rules do not give on the snapshot is reported and not scored", async () => {
  const { h, records } = await settledRecords();
  const r = await rewrite(h, records, (rec) => {
    if (rec.kind === "capture")
      rec.deterministic = {
        ...rec.deterministic,
        classification: "flag",
        fired: ["later-attempt"],
      };
    return rec;
  });
  assert.ok(r.integrity.findings.some((f) => f.kind === "baseline-mismatch"));
  assert.equal(r.deterministic[0].scored, 0);
  assert.equal(r.verdict[0].scored, 1, "the Verdict row does not depend on the recomputed rules");
});

test("a missing snapshot makes the history incomplete", async () => {
  const { h } = await settledRecords();
  rmSync(path.join(h.root, "h1", "snapshots"), { recursive: true, force: true });
  const r = await replayH1(h.ledger, h.snapshots, h.journal, h1Registry());
  assert.ok(r.integrity.findings.some((f) => f.kind === "snapshot-missing"));
  assert.equal(r.integrity.history, "incomplete");
});

test("an assessment missing from the journal is a finding, and the item is not scored for the model", async () => {
  const { h } = await settledRecords();
  rmSync(path.join(h.root, "decisions"), { recursive: true, force: true });
  const r = await replayH1(h.ledger, h.snapshots, h.journal, h1Registry());
  assert.ok(r.integrity.findings.some((f) => f.kind === "assessment-missing"));
  assert.equal(r.models[0].assessed, 0);
  assert.equal(r.deterministic[0].scored, 1, "the baselines are retained in the ledger");
});
