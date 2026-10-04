import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import path from "node:path";
import { symlinkSkip } from "../testPlatform.js";
import type { DecisionAssessment, StoredSnapshot } from "@argus/contracts";
import { canonicalJson, sha256Hex } from "./canonical.js";
import { DecisionJournal, JournalError } from "./journal.js";
import { replay } from "./replay.js";
import { createMockProvider } from "./providers/mock.js";
import {
  failedRun,
  harness,
  ids,
  memorySources,
  RESIDUAL_P,
  tempRoot,
  transcript,
} from "./testSupport.js";
import { layout } from "./storage.js";

/**
 * Persistence and recovery of the Decision Journal (RFC §O.3).
 *
 * "Crash" here means a fault hook throwing at a named step boundary, and
 * "restart" means a fresh `DecisionJournal` over the same files. That is
 * what these tests demonstrate — logical recovery at every boundary — and
 * not power-loss durability.
 */

const answering = () => createMockProvider({ script: () => ({ distribution: RESIDUAL_P }) });

function walkBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    n += e.isDirectory() ? walkBytes(full) : statSync(full).size;
  }
  return n;
}
/** Active bytes, measured on disk: active segments + active snapshots. */
const activeOnDisk = (root: string) =>
  walkBytes(path.join(root, "active")) + walkBytes(path.join(root, "snapshots"));

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...files(full));
    else out.push(full);
  }
  return out.sort();
}

async function assessOnce(h: ReturnType<typeof harness>, sample = 0) {
  const r = await h.service.assess({
    question: "run.failure-cause.residual",
    subject: { kind: "run", runId: "run-1" },
    provider: "mock",
    sample,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r as Extract<typeof r, { ok: true }>;
}

function fresh(root: string, now = () => new Date("2026-09-01T12:00:00.000Z")) {
  return new DecisionJournal({ root, now });
}

// ── Round trip and digests ─────────────────────────────────────────────────

test("an assessment and its snapshot round-trip; the snapshot file is exactly the hashed canonical bytes", async () => {
  const h = harness({ providers: { mock: answering() } });
  const { assessment } = await assessOnce(h);

  const view = await fresh(h.root).read();
  assert.equal(view.entries.length, 1);
  assert.deepEqual(view.entries[0].assessment, assessment);
  assert.deepEqual(view.notices, []);

  const got = await fresh(h.root).loadSnapshot(assessment.snapshot.sha256);
  assert.equal(got.status, "retained");
  const snap = (got as { snapshot: StoredSnapshot }).snapshot;
  const onDisk = readFileSync(layout(h.root).snapshotPath("active", snap.sha256));
  // The file is the canonical content itself: digest and size are over these
  // bytes and are not inside them.
  assert.equal(onDisk.toString("utf8"), canonicalJson(snap.content));
  assert.equal(sha256Hex(onDisk), assessment.snapshot.sha256);
  assert.equal(onDisk.length, assessment.snapshot.bytes);
  assert.ok(!onDisk.toString("utf8").includes(assessment.snapshot.sha256));
  assert.ok(!("sha256" in snap.content) && !("bytes" in snap.content));
});

test("a damaged snapshot or record is reported, never used", async () => {
  const h = harness({ providers: { mock: answering() } });
  const { assessment } = await assessOnce(h);
  await assessOnce(h, 1);

  const snapFile = layout(h.root).snapshotPath("active", assessment.snapshot.sha256);
  writeFileSync(snapFile, readFileSync(snapFile, "utf8").replace("Nightly", "Daily"));
  const got = await fresh(h.root).loadSnapshot(assessment.snapshot.sha256);
  assert.equal(got.status, "corrupt");

  // Edit a value inside a valid JSON line: the envelope digest no longer matches.
  const seg = layout(h.root).segmentPath("active", "seg-00000001");
  const lines = readFileSync(seg, "utf8").split("\n");
  lines[1] = lines[1].replace('"sample":0', '"sample":7');
  writeFileSync(seg, lines.join("\n"));
  const view = await fresh(h.root).read();
  assert.deepEqual(
    view.entries.map((e) => e.assessment.sample),
    [1],
  );
  const bad = view.notices.find((n) => n.kind === "corrupt-line");
  assert.deepEqual([bad?.segment, bad?.line, bad?.detail], ["seg-00000001", 2, "digest-mismatch"]);
});

// ── Torn tails and interior damage ─────────────────────────────────────────

test("a torn tail is an unacknowledged write: reported, then fenced off by a marker on the next append", async () => {
  const h = harness({ providers: { mock: answering() } });
  await assessOnce(h);
  const seg = layout(h.root).segmentPath("active", "seg-00000001");
  appendFileSync(seg, '{"body":{"id":"DA-torn","ques');

  const torn = await fresh(h.root).read();
  assert.equal(torn.entries.length, 1);
  assert.deepEqual(
    torn.notices.map((n) => n.kind),
    ["torn-tail"],
  );

  await assessOnce(h, 1);
  const after = await fresh(h.root).read();
  assert.deepEqual(
    after.entries.map((e) => e.assessment.sample),
    [0, 1],
  );
  // The fragment is now an interior line, recognised as a recovered torn
  // write rather than reported as corruption.
  assert.deepEqual(
    after.notices.map((n) => [n.kind, n.line]),
    [["recovered-torn-write", 3]],
  );
  assert.ok(readFileSync(seg, "utf8").endsWith("\n"));
});

test("a malformed interior line is corruption, named by segment and line; its neighbours still read", async () => {
  const h = harness({ providers: { mock: answering() } });
  await assessOnce(h);
  const seg = layout(h.root).segmentPath("active", "seg-00000001");
  appendFileSync(seg, "not json at all\n");
  await assessOnce(h, 1);
  const view = await fresh(h.root).read();
  assert.deepEqual(
    view.entries.map((e) => e.assessment.sample),
    [0, 1],
  );
  assert.deepEqual(
    view.notices.map((n) => [n.kind, n.segment, n.line]),
    [["corrupt-line", "seg-00000001", 3]],
  );
});

// ── Duplicates and conflicts ───────────────────────────────────────────────

test("a retried append is idempotent by id; the same id with other content is refused", async () => {
  const h = harness({ providers: { mock: answering() } });
  const { assessment } = await assessOnce(h);
  const snap = (await h.journal.loadSnapshot(assessment.snapshot.sha256)) as {
    snapshot: StoredSnapshot;
  };

  const again = await fresh(h.root).append(assessment, snap.snapshot);
  assert.equal(again.status, "duplicate");
  await assert.rejects(
    fresh(h.root).append({ ...assessment, sample: 9 }, snap.snapshot),
    (e: unknown) => e instanceof JournalError && e.code === "conflict",
  );
  assert.equal((await fresh(h.root).read()).entries.length, 1);
});

test("an append whose acknowledgement was lost is not written twice on retry", async () => {
  let crash = true;
  const h = harness({
    providers: { mock: answering() },
    fault: (p) => {
      if (crash && p === "append:after-line") throw new Error("crash after the line reached disk");
    },
  });
  const r = await h.service
    .assess({
      question: "run.failure-cause.residual",
      subject: { kind: "run", runId: "run-1" },
      provider: "mock",
    })
    .catch((e: Error) => e);
  assert.ok(r instanceof Error);
  crash = false;
  const view = await fresh(h.root).read();
  assert.equal(view.entries.length, 1);
  const a = view.entries[0].assessment;
  const snap = (await h.journal.loadSnapshot(a.snapshot.sha256)) as { snapshot: StoredSnapshot };
  assert.equal((await fresh(h.root).append(a, snap.snapshot)).status, "duplicate");
  assert.equal((await fresh(h.root).read()).entries.length, 1);
});

test("identical duplicates and conflicting records anywhere in the journal are reported by the reader", async () => {
  const h = harness({ providers: { mock: answering() } });
  const { assessment } = await assessOnce(h);
  const seg = layout(h.root).segmentPath("active", "seg-00000001");
  const line = readFileSync(seg, "utf8").split("\n")[1];
  appendFileSync(seg, `${line}\n`);
  const view = await fresh(h.root).read();
  assert.equal(view.entries.length, 1);
  assert.deepEqual(
    view.notices.map((n) => n.kind),
    ["duplicate"],
  );
  assert.equal(view.entries[0].assessment.id, assessment.id);
});

// ── Concurrency ────────────────────────────────────────────────────────────

test("concurrent appends from several journal objects serialise: every record lands whole, once, across rotations", async () => {
  const root = tempRoot();
  const mem = memorySources({ runs: [failedRun()], transcripts: { "run-1": transcript() } });
  const mint = ids("DA-conc");
  const limits = { segmentMaxBytes: 6000 };
  const a = harness({
    root,
    providers: { mock: answering() },
    sources: mem.sources,
    limits,
    newId: mint,
  });
  const b = harness({
    root,
    providers: { mock: answering() },
    sources: mem.sources,
    limits,
    newId: mint,
  });
  const calls = Array.from({ length: 30 }, (_, i) =>
    (i % 2 ? a : b).service.assess({
      question: "run.failure-cause.residual",
      subject: { kind: "run", runId: "run-1" },
      provider: "mock",
      sample: i,
    }),
  );
  const results = await Promise.all(calls);
  assert.ok(results.every((r) => r.ok));
  const view = await fresh(root).read();
  assert.equal(view.entries.length, 30);
  assert.equal(new Set(view.entries.map((e) => e.assessment.id)).size, 30);
  assert.deepEqual(
    view.entries.map((e) => e.assessment.sample).sort((x, y) => x - y),
    Array.from({ length: 30 }, (_, i) => i),
  );
  assert.deepEqual(view.notices, []);
  assert.ok(view.segments.length > 1, "rotation happened under concurrency");
  // Every segment but the newest is sealed, and none is over its cap.
  assert.ok(view.segments.slice(0, -1).every((s) => s.sealed));
  for (const s of view.segments) {
    assert.ok(
      statSync(layout(root).segmentPath("active", s.segment)).size <= limits.segmentMaxBytes,
    );
  }
});

// ── Publication ordering and interrupted writes ────────────────────────────

test("a crash before the line leaves an orphan snapshot, never a record without its snapshot", async () => {
  let crash = true;
  const mock = answering();
  const h = harness({
    providers: { mock },
    fault: (p) => {
      if (crash && p === "append:before-line") throw new Error("crash");
    },
  });
  await assert.rejects(assessOnce(h));
  crash = false;
  const j = fresh(h.root);
  assert.equal((await j.read()).entries.length, 0);
  const snaps = files(path.join(h.root, "snapshots"));
  assert.equal(snaps.length, 1);
  // Counted against the active bound, and moved (not deleted) by archival.
  assert.equal((await j.usage()).activeBytes, activeOnDisk(h.root));
  const moved = await j.archive();
  assert.equal(moved.snapshots.length, 1);
  assert.equal(files(path.join(h.root, "snapshots")).length, 0);
  assert.equal(files(path.join(h.root, "archive", "snapshots")).length, 1);
});

test("an interrupted snapshot publication calls no provider, leaves no published file, and is cleaned up", async () => {
  let crash = true;
  const mock = answering();
  const h = harness({
    providers: { mock },
    fault: (p) => {
      if (crash && p === "snapshot:temp-written") throw new Error("crash");
    },
  });
  await assert.rejects(
    h.service.assess({
      question: "run.failure-cause.residual",
      subject: { kind: "run", runId: "run-1" },
      provider: "mock",
    }),
  );
  assert.equal(mock.calls.length, 0);
  const left = files(path.join(h.root, "snapshots"));
  assert.equal(left.length, 1);
  assert.ok(left[0].endsWith(".tmp"));
  crash = false;
  await assessOnce(h);
  assert.ok(files(path.join(h.root, "snapshots")).every((f) => f.endsWith(".json")));
  assert.equal((await fresh(h.root).read()).entries.length, 1);
});

test("an append re-publishes a snapshot that went missing after its pre-call publication", async () => {
  const mock = createMockProvider({
    script: () => {
      // Between "hash before send" and the append, the file disappears.
      for (const f of files(path.join(h.root, "snapshots"))) writeFileSync(f, "damaged");
      return { distribution: RESIDUAL_P };
    },
  });
  const h = harness({ providers: { mock } });
  const { assessment } = await assessOnce(h);
  const got = await fresh(h.root).loadSnapshot(assessment.snapshot.sha256);
  assert.equal(got.status, "retained");
});

// ── Rotation ───────────────────────────────────────────────────────────────

test("segments rotate by size and by age, and each closed segment is sealed in the manifest", async () => {
  const h = harness({ providers: { mock: answering() }, limits: { segmentMaxBytes: 5000 } });
  for (let i = 0; i < 6; i++) await assessOnce(h, i);
  const bySize = (await fresh(h.root).read()).segments.length;
  assert.ok(bySize >= 2);

  h.clock.advance(8 * 24 * 60 * 60 * 1000);
  await assessOnce(h, 6);
  const view = await fresh(h.root).read();
  assert.equal(
    view.segments.length,
    bySize + 1,
    "an aged segment is sealed before the next append",
  );
  const manifest = readFileSync(path.join(h.root, "manifest.jsonl"), "utf8");
  assert.ok(manifest.includes('"reason":"age"'));
  assert.ok(manifest.includes('"reason":"size"'));
});

for (const point of ["rotate:sealed", "rotate:opened"]) {
  test(`a rotation interrupted at ${point} recovers: one open segment, older ones sealed, no record lost`, async () => {
    let crash = false;
    const h = harness({
      providers: { mock: answering() },
      limits: { segmentMaxBytes: 5000 },
      fault: (p) => {
        if (crash && p === point) throw new Error("crash");
      },
    });
    await assessOnce(h, 0);
    await assessOnce(h, 1);
    crash = true;
    let failed = 0;
    for (let i = 2; i < 6 && failed === 0; i++) {
      await assessOnce(h, i).catch(() => failed++);
    }
    assert.equal(failed, 1);
    crash = false;
    const survivor = harness({
      root: h.root,
      providers: { mock: answering() },
      newId: ids("DA-after"),
    });
    await assessOnce(survivor, 99);
    const view = await fresh(h.root).read();
    assert.deepEqual(view.notices, []);
    assert.ok(view.segments.slice(0, -1).every((s) => s.sealed));
    assert.ok(!view.segments.at(-1)!.sealed);
    assert.ok(view.entries.some((e) => e.assessment.sample === 99));
  });
}

test("a torn manifest seal is re-done: an unsealed segment below the newest is sealed on recovery", async () => {
  const h = harness({ providers: { mock: answering() }, limits: { segmentMaxBytes: 5000 } });
  for (let i = 0; i < 8; i++) await assessOnce(h, i);
  const manifestFile = path.join(h.root, "manifest.jsonl");
  const text = readFileSync(manifestFile, "utf8");
  // Tear the last seal line in half.
  writeFileSync(manifestFile, text.slice(0, text.length - 40));
  const torn = await fresh(h.root).read();
  assert.ok(torn.notices.some((n) => n.kind === "manifest-damage"));
  await fresh(h.root).usage(); // any mutation-path operation recovers
  const view = await fresh(h.root).read();
  assert.ok(view.segments.slice(0, -1).every((s) => s.sealed));
  assert.ok(readFileSync(manifestFile, "utf8").includes('"reason":"recovered"'));
});

// ── The active bound ───────────────────────────────────────────────────────

test("total active storage never exceeds its bound: appends are refused at the cap, nothing is deleted, archival frees space", async () => {
  const limits = { segmentMaxBytes: 4000, activeMaxBytes: 40_000, snapshotMaxBytes: 8000 };
  const mem = memorySources({
    runs: Array.from({ length: 40 }, (_, i) => failedRun({ id: `run-${i}` })),
    transcripts: Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`run-${i}`, transcript()]),
    ),
  });
  const mock = answering();
  const h = harness({ providers: { mock }, sources: mem.sources, limits });
  let refused = null as null | { detail: string; providerCalled: boolean };
  let accepted = 0;
  for (let i = 0; i < 40 && !refused; i++) {
    const before = files(h.root).map((f) => [f, statSync(f).size]);
    const r = await h.service.assess({
      question: "run.failure-cause.residual",
      subject: { kind: "run", runId: `run-${i}` },
      provider: "mock",
    });
    assert.ok(activeOnDisk(h.root) <= limits.activeMaxBytes, `over the bound after ${i}`);
    if (r.ok) accepted++;
    else {
      refused = r;
      // The refusal wrote nothing at all.
      assert.deepEqual(
        files(h.root).map((f) => [f, statSync(f).size]),
        before,
      );
    }
  }
  assert.ok(refused, "the cap was reached");
  assert.match(refused!.detail, /active-storage-full/);
  assert.equal(refused!.providerCalled, false, "refused before the paid call");
  assert.equal(mock.calls.length, accepted);
  assert.equal(
    (await fresh(h.root).read()).entries.length,
    accepted,
    "nothing was deleted at the cap",
  );

  const moved = await h.journal.archive();
  assert.ok(moved.segments.length > 0);
  assert.ok(activeOnDisk(h.root) < limits.activeMaxBytes / 2);
  const r = await h.service.assess({
    question: "run.failure-cause.residual",
    subject: { kind: "run", runId: "run-39" },
    provider: "mock",
  });
  assert.equal(r.ok, true);
  assert.equal((await fresh(h.root).read()).entries.length, accepted + 1);
});

test("a snapshot over the snapshot limit is refused before any call", async () => {
  const mock = answering();
  const h = harness({ providers: { mock }, limits: { snapshotMaxBytes: 500 } });
  const r = await h.service.assess({
    question: "run.failure-cause.residual",
    subject: { kind: "run", runId: "run-1" },
    provider: "mock",
  });
  assert.equal(r.ok, false);
  assert.match((r as { detail: string }).detail, /snapshot-too-large/);
  assert.equal(mock.calls.length, 0);
});

// ── Archival ───────────────────────────────────────────────────────────────

test("archival moves sealed segments and their snapshots, logs each move, and leaves replay byte-identical", async () => {
  const h = harness({ providers: { mock: answering() }, limits: { segmentMaxBytes: 5000 } });
  for (let i = 0; i < 6; i++) await assessOnce(h, i);
  const before = await replay(fresh(h.root), h.registry);
  const res = await h.journal.archive();
  assert.ok(res.segments.length >= 1);
  const view = await fresh(h.root).read();
  assert.equal(view.entries.length, 6);
  assert.deepEqual(view.notices, []);
  assert.ok(view.segments.filter((s) => s.store === "archive").length === res.segments.length);
  assert.equal(await replay(fresh(h.root), h.registry), before);
  const manifest = readFileSync(path.join(h.root, "manifest.jsonl"), "utf8");
  for (const id of res.segments)
    assert.ok(manifest.includes(`"kind":"archive"`) && manifest.includes(id));
});

for (const point of [
  "archive-segment:temp-written",
  "archive-segment:renamed",
  "archive:copied",
  "archive:recorded",
  "archive-snapshot:renamed",
  "archive:snapshots-copied",
]) {
  test(`archival interrupted at ${point}: readers see every record once, and recovery finishes the move`, async () => {
    let crash = false;
    const h = harness({
      providers: { mock: answering() },
      limits: { segmentMaxBytes: 5000 },
      fault: (p) => {
        if (crash && p === point) throw new Error("crash");
      },
    });
    for (let i = 0; i < 6; i++) await assessOnce(h, i);
    h.clock.advance(8 * 24 * 60 * 60 * 1000); // so archival also seals the open segment
    const before = await replay(fresh(h.root), h.registry);
    crash = true;
    await assert.rejects(h.journal.archive());
    crash = false;

    // A fresh reader, without recovery, sees the same records and report.
    const mid = await fresh(h.root).read();
    assert.equal(mid.entries.length, 6);
    assert.equal(await replay(fresh(h.root), h.registry), before);

    // A fresh writer recovers, and a second archival completes the move.
    const j = fresh(h.root);
    await j.archive();
    const view = await j.read();
    assert.equal(view.entries.length, 6);
    assert.deepEqual(
      view.notices.filter((n) => n.kind !== "manifest-damage"),
      [],
    );
    const active = new Set(readdirSync(path.join(h.root, "active")));
    const archived = new Set(readdirSync(path.join(h.root, "archive", "segments")));
    assert.ok(
      [...active].every((f) => !archived.has(f)),
      "no segment left in both stores",
    );
    assert.equal(await replay(fresh(h.root), h.registry), before);
    for (const e of view.entries) {
      assert.equal((await j.loadSnapshot(e.assessment.snapshot.sha256)).status, "retained");
    }
  });
}

test("a snapshot shared by an archived and an active segment stays reachable, and moves only with its last active referrer", async () => {
  const h = harness({ providers: { mock: answering() }, limits: { segmentMaxBytes: 5000 } });
  for (let i = 0; i < 6; i++) await assessOnce(h, i);
  const view0 = await fresh(h.root).read();
  const shared = view0.entries[0].assessment.snapshot.sha256;
  assert.ok(
    view0.entries.every((e) => e.assessment.snapshot.sha256 === shared),
    "same run, same snapshot",
  );

  const partial = await h.journal.archive({ sealOpen: false });
  assert.ok(partial.segments.length >= 1);
  // The open segment still references the snapshot: it stays active.
  assert.equal(partial.snapshots.length, 0);
  assert.equal((await fresh(h.root).loadSnapshot(shared)).status, "retained");

  h.clock.advance(8 * 24 * 60 * 60 * 1000);
  const all = await h.journal.archive();
  assert.deepEqual(all.snapshots, [shared]);
  const got = await fresh(h.root).loadSnapshot(shared);
  assert.equal(got.status, "retained");
  assert.equal((got as { store: string }).store, "archive");
});

// ── Explicit deletion ──────────────────────────────────────────────────────

async function twoArchivedSegments(runs: [string, string]) {
  const mem = memorySources({
    runs: [failedRun({ id: runs[0] }), failedRun({ id: runs[1], scheduleName: "Other" })],
    transcripts: { [runs[0]]: transcript(), [runs[1]]: transcript() },
  });
  const h = harness({
    providers: { mock: answering() },
    sources: mem.sources,
    limits: { segmentMaxBytes: 3000 },
  });
  const one = async (runId: string) =>
    h.service.assess({
      question: "run.failure-cause.residual",
      subject: { kind: "run", runId },
      provider: "mock",
    });
  // seg 1: runs[0]; seg 2: runs[1] and a second runs[0] (shared).
  const a = await one(runs[0]);
  h.clock.advance(8 * 24 * 60 * 60 * 1000);
  const b = await one(runs[1]);
  const c = await one(runs[0]);
  h.clock.advance(8 * 24 * 60 * 60 * 1000);
  await h.journal.archive();
  return { h, a, b, c };
}

test("explicit deletion tombstones first, removes only unshared snapshots, and replay reports a gap", async () => {
  const { h, a, c } = await twoArchivedSegments(["run-a", "run-b"]);
  assert.ok(a.ok && c.ok);
  const segA = (await fresh(h.root).read()).entries.find(
    (e) => e.assessment.id === a.assessment.id,
  )!.segment;
  const res = await h.journal.deleteArchivedSegment({
    segment: segA,
    operator: "ops@example",
    reason: "retention",
  });
  // run-a's snapshot is also referenced from the surviving segment: kept.
  assert.deepEqual(res.deletedSnapshots, []);
  assert.deepEqual(res.retainedSnapshots, [a.assessment.snapshot.sha256]);
  assert.equal((await fresh(h.root).loadSnapshot(a.assessment.snapshot.sha256)).status, "retained");

  const report = JSON.parse(await replay(fresh(h.root), h.registry));
  assert.deepEqual(
    report.gaps.map((g: { segment: string; reason: string; records: number }) => [
      g.segment,
      g.reason,
      g.records,
    ]),
    [[segA, "deleted", 1]],
  );
  assert.ok(!report.assessments.some((x: { id: string }) => x.id === a.assessment.id));
  const tomb = readFileSync(path.join(h.root, "manifest.jsonl"), "utf8");
  assert.ok(tomb.includes('"kind":"tombstone"') && tomb.includes("ops@example"));

  // Deleting the second segment removes its now-unshared snapshots.
  const segB = (await fresh(h.root).read()).entries[0].segment;
  const res2 = await h.journal.deleteArchivedSegment({
    segment: segB,
    operator: "ops@example",
    reason: "retention",
  });
  assert.equal(res2.deletedSnapshots.length, 2);
  for (const sha of res2.deletedSnapshots) {
    assert.equal((await fresh(h.root).loadSnapshot(sha)).status, "unavailable");
  }
});

test("deletion is refused for active segments, twice-deleted segments, bad ids, and while any survivor has unreadable lines", async () => {
  const { h } = await twoArchivedSegments(["run-a", "run-b"]);
  await assessOnce(
    harness({ root: h.root, providers: { mock: answering() }, newId: ids("DA-new") }),
  );
  const view = await fresh(h.root).read();
  const active = view.segments.find((s) => s.store === "active")!.segment;
  const archived = view.segments.filter((s) => s.store === "archive").map((s) => s.segment);
  const code = (p: Promise<unknown>) =>
    p.then(
      () => "ok",
      (e: JournalError) => e.code,
    );
  const del = (segment: string) =>
    fresh(h.root).deleteArchivedSegment({ segment, operator: "ops", reason: "r" });
  assert.equal(await code(del(active)), "not-archived");
  assert.equal(await code(del("../../etc/passwd")), "unknown-segment");
  assert.equal(await code(del("seg-00000077")), "not-archived");
  assert.equal(
    await code(
      fresh(h.root).deleteArchivedSegment({ segment: archived[0], operator: " ", reason: "r" }),
    ),
    "invalid",
  );

  appendFileSync(layout(h.root).segmentPath("active", active), "garbage\n");
  await assessOnce(
    harness({ root: h.root, providers: { mock: answering() }, newId: ids("DA-new2") }),
  );
  assert.equal(await code(del(archived[0])), "unreadable-references");
  assert.ok(existsSync(layout(h.root).segmentPath("archive", archived[0])));

  // With the damage gone, deletion works, and cannot be repeated.
  const lines = readFileSync(layout(h.root).segmentPath("active", active), "utf8").split("\n");
  writeFileSync(
    layout(h.root).segmentPath("active", active),
    lines.filter((l) => l !== "garbage").join("\n"),
  );
  assert.equal(await code(del(archived[0])), "ok");
  assert.equal(await code(del(archived[0])), "unknown-segment");
});

for (const point of ["delete:tombstoned", "delete:snapshots-removed"]) {
  test(`a deletion interrupted at ${point} reads as a gap and is completed by recovery`, async () => {
    const { h, b } = await twoArchivedSegments(["run-a", "run-b"]);
    assert.ok(b.ok);
    const segB = (await fresh(h.root).read()).entries.find(
      (e) => e.assessment.id === b.assessment.id,
    )!.segment;
    let crash = true;
    const j = new DecisionJournal({
      root: h.root,
      now: h.clock.now,
      fault: (p) => {
        if (crash && p === point) throw new Error("crash");
      },
    });
    await assert.rejects(j.deleteArchivedSegment({ segment: segB, operator: "ops", reason: "r" }));
    crash = false;
    const mid = await fresh(h.root).read();
    assert.ok(mid.gaps.some((g) => g.segment === segB && g.reason === "deleted"));
    assert.ok(mid.notices.some((n) => n.kind === "deletion-incomplete" && n.segment === segB));
    assert.ok(
      !mid.entries.some((e) => e.segment === segB),
      "a tombstone governs even before the files go",
    );

    await fresh(h.root).usage(); // recovery
    const done = await fresh(h.root).read();
    assert.ok(!done.notices.some((n) => n.kind === "deletion-incomplete"));
    assert.ok(!existsSync(layout(h.root).segmentPath("archive", segB)));
    assert.equal(
      (await fresh(h.root).loadSnapshot(b.assessment.snapshot.sha256)).status,
      "unavailable",
    );
  });
}

test("recovery of an interrupted deletion keeps a snapshot that a newer assessment references", async () => {
  const { h, b } = await twoArchivedSegments(["run-a", "run-b"]);
  assert.ok(b.ok);
  const segB = (await fresh(h.root).read()).entries.find(
    (e) => e.assessment.id === b.assessment.id,
  )!.segment;
  const j = new DecisionJournal({
    root: h.root,
    now: h.clock.now,
    fault: (p) => {
      if (p === "delete:tombstoned") throw new Error("crash");
    },
  });
  await assert.rejects(j.deleteArchivedSegment({ segment: segB, operator: "ops", reason: "r" }));
  // Before anyone recovers, a new assessment of run-b produces the same snapshot.
  const again = harness({
    root: h.root,
    providers: { mock: answering() },
    sources: h.sources,
    newId: ids("DA-late"),
  });
  const r = await again.service.assess({
    question: "run.failure-cause.residual",
    subject: { kind: "run", runId: "run-b" },
    provider: "mock",
  });
  assert.ok(r.ok);
  assert.equal(r.assessment.snapshot.sha256, b.assessment.snapshot.sha256);
  await fresh(h.root).usage();
  assert.equal((await fresh(h.root).loadSnapshot(b.assessment.snapshot.sha256)).status, "retained");
});

// ── Path safety ────────────────────────────────────────────────────────────

test(
  "paths are rebuilt from validated ids: stray files, symlinks and traversal attempts are ignored and reported",
  { skip: symlinkSkip },
  async () => {
    const h = harness({ providers: { mock: answering() } });
    await assessOnce(h);
    const l = layout(h.root);
    assert.throws(() => l.segmentPath("active", "../seg-00000001"));
    assert.throws(() => l.snapshotPath("active", "../../etc/passwd"));
    assert.equal((await fresh(h.root).loadSnapshot("../../../etc/passwd")).status, "unavailable");

    writeFileSync(path.join(h.root, "active", "seg-1.jsonl"), "x\n");
    const outside = path.join(tempRoot(), "outside.jsonl");
    writeFileSync(outside, readFileSync(l.segmentPath("active", "seg-00000001")));
    symlinkSync(outside, path.join(h.root, "active", "seg-00000009.jsonl"));
    mkdirSync(path.join(h.root, "snapshots", "zz"), { recursive: true });
    // A manifest line naming a path outside the root is not a segment.
    const evil = { segment: "../../outside", sha256: "0".repeat(64), at: "x" };
    appendFileSync(path.join(h.root, "manifest.jsonl"), canonicalLine("archive", evil));

    const view = await fresh(h.root).read();
    assert.equal(view.entries.length, 1);
    const kinds = view.notices.map((n) => n.kind).sort();
    assert.deepEqual(kinds, [
      "manifest-damage",
      "unexpected-file",
      "unexpected-file",
      "unexpected-file",
    ]);
    assert.ok(view.segments.every((s) => s.segment === "seg-00000001"));
  },
);

function canonicalLine(kind: string, body: unknown): string {
  const digest = sha256Hex(canonicalJson({ body, kind }));
  return `${canonicalJson({ body, kind, sha256: digest })}\n`;
}

test("journal refuses malformed input without writing", async () => {
  const root = tempRoot();
  const j = new DecisionJournal({ root });
  const snapshot = { sha256: "a".repeat(64), bytes: 2, content: {} } as unknown as StoredSnapshot;
  await assert.rejects(
    j.append({ id: "nope" } as unknown as DecisionAssessment, snapshot),
    JournalError,
  );
  await assert.rejects(j.publishSnapshot(snapshot), (e: JournalError) => e.code === "invalid");
  assert.deepEqual(files(root), []);
  assert.throws(() => new DecisionJournal({ root, limits: { activeMaxBytes: 0 } }));
  assert.throws(
    () => new DecisionJournal({ root, limits: { activeMaxBytes: 10, snapshotMaxBytes: 20 } }),
  );
});

test("completing an interrupted deletion keeps snapshots while a survivor has unreadable lines", async () => {
  const { h, b } = await twoArchivedSegments(["run-a", "run-b"]);
  assert.ok(b.ok);
  const segB = (await fresh(h.root).read()).entries.find(
    (e) => e.assessment.id === b.assessment.id,
  )!.segment;
  const j = new DecisionJournal({
    root: h.root,
    now: h.clock.now,
    fault: (p) => {
      if (p === "delete:tombstoned") throw new Error("crash");
    },
  });
  await assert.rejects(j.deleteArchivedSegment({ segment: segB, operator: "ops", reason: "r" }));
  const other = (await fresh(h.root).read()).segments.find((s) => s.segment !== segB)!;
  appendFileSync(layout(h.root).segmentPath(other.store, other.segment), "garbage\n");
  await fresh(h.root).usage(); // recovery
  assert.ok(!existsSync(layout(h.root).segmentPath("archive", segB)), "the segment itself goes");
  assert.equal((await fresh(h.root).loadSnapshot(b.assessment.snapshot.sha256)).status, "retained");
});
