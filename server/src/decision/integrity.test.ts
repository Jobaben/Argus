import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
import path from "node:path";
import type { DecisionAssessment, StoredSnapshot } from "@argus/contracts";
import { canonicalJson, sha256Hex } from "./canonical.js";
import { DecisionJournal, JournalError } from "./journal.js";
import { createMockProvider } from "./providers/mock.js";
import { replay } from "./replay.js";
import { layout, ShortWriteError, writeAll, type WriteFn } from "./storage.js";
import {
  failedRun,
  harness,
  memorySources,
  RESIDUAL_P,
  tempRoot,
  transcript,
} from "./testSupport.js";

/**
 * Two persistence concerns, each reproduced against the pre-fix code first:
 *
 * 1. A sealed segment is judged against its manifest seal (sha256 and
 *    size) everywhere it matters: readers, replay, reference scanning before
 *    deletion, and interrupted-deletion recovery. Per-line digests alone
 *    cannot show that a whole line is gone.
 * 2. Every journal write goes through `writeAll`, so a short write is
 *    continued, zero progress or an error fails, and nothing is acknowledged
 *    before all of its bytes are written.
 *
 * "Crash" is an injected fault and "restart" a fresh journal over the same
 * files: logical recovery, not power-loss durability.
 */

const answering = () => createMockProvider({ script: () => ({ distribution: RESIDUAL_P }) });
const fresh = (root: string) =>
  new DecisionJournal({ root, now: () => new Date("2026-09-01T12:00:00.000Z") });

function assess(h: ReturnType<typeof harness>, runId = "run-1", sample = 0) {
  return h.service.assess({
    question: "run.failure-cause.residual",
    subject: { kind: "run", runId },
    provider: "mock",
    sample,
  });
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
}

/** Remove one whole line (1-based) from a file, keeping every other byte. */
function dropLine(file: string, line: number): string {
  const lines = readFileSync(file, "utf8").split("\n");
  const [gone] = lines.splice(line - 1, 1);
  writeFileSync(file, lines.join("\n"));
  return gone;
}

// ── 1. Sealed-segment integrity ────────────────────────────────────────────

test("losing a complete line from a sole archived segment is reported as a seal mismatch, never as a complete history", async () => {
  const h = harness({ providers: { mock: answering() } });
  for (let i = 0; i < 3; i++) assert.ok((await assess(h, "run-1", i)).ok);
  await h.journal.archive();
  const intact = await fresh(h.root).read();
  assert.deepEqual(
    intact.segments.map((s) => [s.store, s.integrity, s.records]),
    [["archive", "intact", 3]],
  );

  const seg = intact.segments[0].segment;
  const gone = dropLine(layout(h.root).segmentPath("archive", seg), 3);
  assert.ok(gone.includes('"kind":"assessment"'));

  const view = await fresh(h.root).read();
  // The intact records are salvaged, every one still passing its line digest...
  assert.equal(view.entries.length, 2);
  // ...but the segment is not presented as whole.
  assert.equal(view.segments[0].integrity, "seal-mismatch");
  const finding = view.notices.find((n) => n.kind === "seal-mismatch");
  assert.equal(finding?.segment, seg);
  assert.match(finding!.detail, /sealed with 3 records .* found 2 readable records/);
});

test("replay reports the seal mismatch and an incomplete history; a healthy journal stays complete and byte-identical across archival", async () => {
  const h = harness({ providers: { mock: answering() } });
  for (let i = 0; i < 3; i++) await assess(h, "run-1", i);
  const before = await replay(fresh(h.root), h.registry);
  assert.equal(JSON.parse(before).totals.history, "complete");
  await h.journal.archive();
  const archived = await replay(fresh(h.root), h.registry);
  assert.equal(archived, before, "successful archival leaves the report byte-identical");

  const seg = (await fresh(h.root).read()).segments[0].segment;
  dropLine(layout(h.root).segmentPath("archive", seg), 2);
  const report = JSON.parse(await replay(fresh(h.root), h.registry));
  assert.equal(report.totals.history, "incomplete");
  assert.equal(report.totals.assessments, 2);
  assert.deepEqual(
    report.integrity.map((n: { kind: string; segment: string }) => [n.kind, n.segment]),
    [["seal-mismatch", seg]],
  );
});

test("replay no longer drops manifest damage or differing copies with physical placement", async () => {
  const h = harness({ providers: { mock: answering() } });
  await assess(h);
  await h.journal.archive();
  const seg = (await fresh(h.root).read()).segments[0].segment;
  // A second copy that differs from the archived one.
  const copy = readFileSync(layout(h.root).segmentPath("archive", seg), "utf8");
  writeFileSync(
    layout(h.root).segmentPath("active", seg),
    copy.split("\n").slice(0, 1).join("\n") + "\n",
  );
  appendFileSync(path.join(h.root, "manifest.jsonl"), "garbage in the manifest\n");
  const report = JSON.parse(await replay(fresh(h.root), h.registry));
  const kinds = report.integrity.map((n: { kind: string }) => n.kind).sort();
  assert.deepEqual(kinds, ["copy-mismatch", "manifest-damage"]);
  assert.equal(report.totals.history, "incomplete");
  // The whole (archive) copy is the one read.
  assert.equal(report.totals.assessments, 1);
});

test("a sealed segment with no surviving seal reads as missing-seal, and recovery does not re-bless it", async () => {
  const h = harness({ providers: { mock: answering() }, limits: { segmentMaxBytes: 5000 } });
  for (let i = 0; i < 8; i++) await assess(h, "run-1", i);
  const segments = (await fresh(h.root).read()).segments;
  assert.ok(segments.length >= 2 && segments[0].integrity === "intact");
  // Lose the first segment's seal line from the middle of the manifest, and
  // leave interior damage there: a seal lost this way could be of any age.
  const manifest = path.join(h.root, "manifest.jsonl");
  const lines = readFileSync(manifest, "utf8").split("\n");
  const at = lines.findIndex((l) => l.includes('"kind":"seal"') && l.includes(segments[0].segment));
  lines[at] = "damaged seal line";
  writeFileSync(manifest, lines.join("\n"));

  await fresh(h.root).usage(); // recovery runs
  const view = await fresh(h.root).read();
  assert.equal(view.segments[0].integrity, "missing-seal");
  assert.ok(
    view.notices.some((n) => n.kind === "missing-seal" && n.segment === segments[0].segment),
  );
  assert.ok(
    !readFileSync(manifest, "utf8").includes('"reason":"recovered"'),
    "nothing was resealed",
  );
  // Archival will not move a segment it cannot show whole.
  const res = await fresh(h.root).archive();
  assert.ok(!res.segments.includes(segments[0].segment));
});

test("a second seal line cannot re-bless changed bytes: the first seal governs", async () => {
  const h = harness({ providers: { mock: answering() } });
  for (let i = 0; i < 3; i++) await assess(h, "run-1", i);
  await h.journal.archive();
  const seg = (await fresh(h.root).read()).segments[0].segment;
  const file = layout(h.root).segmentPath("archive", seg);
  dropLine(file, 2);
  const bytes = readFileSync(file);
  const body = {
    segment: seg,
    records: 2,
    bytes: bytes.length,
    sha256: sha256Hex(bytes),
    firstAt: null,
    lastAt: null,
    reason: "size",
    at: "x",
  };
  const digest = sha256Hex(canonicalJson({ body, kind: "seal" }));
  appendFileSync(
    path.join(h.root, "manifest.jsonl"),
    `${canonicalJson({ body, kind: "seal", sha256: digest })}\n`,
  );
  const view = await fresh(h.root).read();
  assert.equal(view.segments[0].integrity, "seal-mismatch");
  assert.ok(view.notices.some((n) => n.kind === "manifest-damage" && /second seal/.test(n.detail)));
});

async function sharedAcrossArchivedSegments() {
  const mem = memorySources({
    runs: [failedRun({ id: "run-a" }), failedRun({ id: "run-b", scheduleName: "B" })],
    transcripts: { "run-a": transcript(), "run-b": transcript() },
  });
  const h = harness({ providers: { mock: answering() }, sources: mem.sources });
  const a1 = await assess(h, "run-a"); // segment 1: run-a
  await h.journal.archive();
  const b = await assess(h, "run-b"); // segment 2: run-b, then run-a again
  const a2 = await assess(h, "run-a");
  await h.journal.archive();
  assert.ok(a1.ok && b.ok && a2.ok);
  const [seg1, seg2] = (await fresh(h.root).read()).segments.map((s) => s.segment);
  // Segment 2 loses the only surviving line that references run-a's snapshot.
  const file2 = layout(h.root).segmentPath("archive", seg2);
  const idx = readFileSync(file2, "utf8")
    .split("\n")
    .findIndex((l) => l.includes(a2.assessment.id));
  dropLine(file2, idx + 1);
  return { h, seg1, seg2, shared: a1.assessment.snapshot.sha256 };
}

test("fresh deletion refuses while a surviving sealed segment has lost lines that may reference a snapshot", async () => {
  const { h, seg1, shared } = await sharedAcrossArchivedSegments();
  await assert.rejects(
    fresh(h.root).deleteArchivedSegment({ segment: seg1, operator: "ops", reason: "retention" }),
    (e: unknown) =>
      e instanceof JournalError &&
      e.code === "unreadable-references" &&
      /seg-00000002/.test(e.message),
  );
  assert.ok(existsSync(layout(h.root).segmentPath("archive", seg1)), "nothing deleted");
  assert.equal((await fresh(h.root).loadSnapshot(shared)).status, "retained");
});

test("recovery of an interrupted deletion keeps snapshots while a surviving sealed segment has lost lines", async () => {
  const mem = memorySources({
    runs: [failedRun({ id: "run-a" }), failedRun({ id: "run-b", scheduleName: "B" })],
    transcripts: { "run-a": transcript(), "run-b": transcript() },
  });
  const h = harness({ providers: { mock: answering() }, sources: mem.sources });
  const a = await assess(h, "run-a"); // segment 1: only run-a
  await h.journal.archive();
  for (let i = 0; i < 3; i++) await assess(h, "run-b", i); // segment 2: only run-b
  await h.journal.archive();
  assert.ok(a.ok);
  const [seg1, seg2] = (await fresh(h.root).read()).segments.map((s) => s.segment);

  // The deletion is decided while everything is whole: run-a's snapshot is
  // segment 1's alone, so the tombstone names it for deletion. Then the
  // process fails before removing anything.
  const crashing = new DecisionJournal({
    root: h.root,
    now: h.clock.now,
    fault: (p) => {
      if (p === "delete:tombstoned") throw new Error("crash");
    },
  });
  await assert.rejects(
    crashing.deleteArchivedSegment({ segment: seg1, operator: "ops", reason: "r" }),
  );
  const manifest = readFileSync(path.join(h.root, "manifest.jsonl"), "utf8");
  assert.ok(manifest.includes(a.assessment.snapshot.sha256), "the tombstone names the snapshot");

  // Before recovery, the surviving sealed segment loses a whole line. What
  // that line referenced is now unknown, so nothing may be reclaimed.
  dropLine(layout(h.root).segmentPath("archive", seg2), 3);

  await fresh(h.root).usage(); // recovery completes the deletion
  assert.ok(
    !existsSync(layout(h.root).segmentPath("archive", seg1)),
    "the tombstoned segment goes",
  );
  assert.equal(
    (await fresh(h.root).loadSnapshot(a.assessment.snapshot.sha256)).status,
    "retained",
    "kept while a damaged survivor might reference it",
  );
  const view = await fresh(h.root).read();
  assert.ok(view.gaps.some((g) => g.segment === seg1 && g.reason === "deleted"));
  assert.ok(view.notices.some((n) => n.kind === "seal-mismatch" && n.segment === seg2));
});

test("archival will not move a sealed active segment whose bytes no longer match its seal", async () => {
  const h = harness({ providers: { mock: answering() }, limits: { segmentMaxBytes: 5000 } });
  for (let i = 0; i < 6; i++) await assess(h, "run-1", i);
  const first = (await fresh(h.root).read()).segments[0];
  assert.equal(first.integrity, "intact");
  dropLine(layout(h.root).segmentPath("active", first.segment), 2);
  const res = await fresh(h.root).archive();
  assert.ok(res.skipped.some((s) => s.segment === first.segment));
  const view = await fresh(h.root).read();
  const again = view.segments.find((s) => s.segment === first.segment)!;
  assert.deepEqual([again.store, again.integrity], ["active", "seal-mismatch"]);
});

// ── 2. Short writes ────────────────────────────────────────────────────────

/** A write seam that hands the OS at most `chunk` bytes per call. */
const chunked =
  (chunk: number, log?: number[]): WriteFn =>
  (fh, data, offset, length) => {
    const n = Math.min(chunk, length);
    log?.push(n);
    return fh.write(data, offset, n, null);
  };

test("writeAll continues over short writes, and fails on zero progress or an error after partial progress", async () => {
  const file = path.join(tempRoot(), "w.bin");
  const data = Buffer.from("0123456789abcdefghij".repeat(5));
  const calls: number[] = [];
  let fh = await open(file, "w");
  await writeAll(fh, data, chunked(7, calls));
  await fh.close();
  assert.deepEqual(await readFile(file), data);
  assert.ok(calls.length > 10 && calls.every((n) => n <= 7));

  fh = await open(file, "w");
  let first = true;
  const stall: WriteFn = async (h, d, o, l) => {
    if (first) {
      first = false;
      return h.write(d, o, Math.min(10, l), null);
    }
    return { bytesWritten: 0 };
  };
  await assert.rejects(
    writeAll(fh, data, stall),
    (e: unknown) => e instanceof ShortWriteError && e.written === 10 && e.intended === 100,
  );
  await fh.close();
  assert.equal((await readFile(file)).length, 10, "the prefix stays for torn-write recovery");

  fh = await open(file, "w");
  let n = 0;
  const failing: WriteFn = async (h, d, o, l) => {
    if (n++ === 0) return h.write(d, o, Math.min(30, l), null);
    throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
  };
  await assert.rejects(writeAll(fh, data, failing), /EIO/);
  await fh.close();
  assert.equal((await readFile(file)).length, 30);

  fh = await open(file, "w");
  await assert.rejects(
    writeAll(fh, data, async () => ({ bytesWritten: 500 })),
    ShortWriteError,
  );
  await fh.close();
});

test("every journal write completes through short writes: records, snapshots, headers, manifest and archive copies", async () => {
  const calls: number[] = [];
  const h = harness({
    providers: { mock: answering() },
    limits: { segmentMaxBytes: 5000 },
    write: chunked(97, calls),
  });
  for (let i = 0; i < 6; i++) assert.ok((await assess(h, "run-1", i)).ok);
  await h.journal.archive();
  assert.ok(calls.length > 100, "writes really were split");
  const view = await fresh(h.root).read();
  assert.equal(view.entries.length, 6);
  assert.deepEqual(view.notices, []);
  assert.ok(view.segments.every((s) => s.integrity === "intact"));
  for (const e of view.entries) {
    assert.equal(
      (await fresh(h.root).loadSnapshot(e.assessment.snapshot.sha256)).status,
      "retained",
    );
  }
});

/** A write seam that fails on the first call matching `when`, after writing `keep(length)` bytes of it. */
function failOnce(
  when: (data: Buffer) => boolean,
  keep: (length: number) => number,
  how: "error" | "stall",
): WriteFn {
  let armed = true;
  return async (fh, data, offset, length) => {
    if (armed && offset === 0 && when(data)) {
      armed = false;
      const n = keep(length);
      if (n > 0) await fh.write(data, 0, n, null);
      if (how === "stall") return { bytesWritten: 0 };
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    }
    return fh.write(data, offset, length, null);
  };
}

const isAssessmentLine = (d: Buffer) => d.toString("utf8").includes('"kind":"assessment"');

for (const [label, keep, how] of [
  ["an error after half the line", (n: number) => Math.floor(n / 2), "error"],
  ["zero progress after half the line", (n: number) => Math.floor(n / 2), "stall"],
  ["an error with only the newline missing", (n: number) => n - 1, "error"],
] as const) {
  test(`a record write that fails with ${label} is not acknowledged; a retry lands exactly once`, async () => {
    const seen: Array<{ a: DecisionAssessment; s: StoredSnapshot }> = [];
    const h = harness({
      providers: { mock: answering() },
      write: failOnce(isAssessmentLine, keep, how),
    });
    const append = h.journal.append.bind(h.journal);
    h.journal.append = (a, s) => {
      seen.push({ a, s });
      return append(a, s);
    };
    await assert.rejects(assess(h), how === "stall" ? ShortWriteError : /ENOSPC/);
    assert.equal(seen.length, 1);

    // No acknowledged record, and the fragment is an unacknowledged torn tail.
    const torn = await fresh(h.root).read();
    assert.equal(torn.entries.length, 0);
    assert.deepEqual(
      torn.notices.map((n) => n.kind),
      ["torn-tail"],
    );

    // A retry of the same assessment on a fresh journal lands once; the
    // fragment is fenced, and never reads as a second copy of the record.
    const retry = await fresh(h.root).append(seen[0].a, seen[0].s);
    assert.equal(retry.status, "appended");
    const after = await fresh(h.root).read();
    assert.deepEqual(
      after.entries.map((e) => e.assessment.id),
      [seen[0].a.id],
    );
    assert.deepEqual(
      after.notices.map((n) => n.kind),
      ["recovered-torn-write"],
    );
    assert.equal((await fresh(h.root).append(seen[0].a, seen[0].s)).status, "duplicate");
    assert.equal((await fresh(h.root).read()).entries.length, 1);
    assert.equal(JSON.parse(await replay(fresh(h.root), h.registry)).totals.history, "complete");
  });
}

test("a snapshot publication that stalls calls no provider and publishes nothing", async () => {
  const mock = answering();
  const h = harness({
    providers: { mock },
    write: failOnce(
      (d) => d.toString("utf8").startsWith('{"body"'),
      (n) => Math.floor(n / 3),
      "stall",
    ),
  });
  await assert.rejects(assess(h), ShortWriteError);
  assert.equal(mock.calls.length, 0);
  const snapshots = () => walk(path.join(h.root, "snapshots"));
  // Only an unpublished temp file exists, and recovery removes it.
  assert.ok(snapshots().length === 1 && snapshots()[0].endsWith(".tmp"));
  assert.equal((await fresh(h.root).read()).entries.length, 0);
  await fresh(h.root).usage();
  assert.deepEqual(snapshots(), []);
  const r = await assess(harness({ root: h.root, providers: { mock } }));
  assert.ok(r.ok);
  assert.equal(mock.calls.length, 1);
});

test("a segment header write that fails leaves no segment file with a torn header", async () => {
  const h = harness({
    providers: { mock: answering() },
    write: failOnce(
      (d) => d.toString("utf8").includes('"kind":"segment-open"'),
      () => 20,
      "error",
    ),
  });
  await assert.rejects(assess(h), /ENOSPC/);
  assert.ok(!existsSync(layout(h.root).segmentPath("active", "seg-00000001")));
  const r = await assess(harness({ root: h.root, providers: { mock: answering() } }));
  assert.ok(r.ok);
  const view = await fresh(h.root).read();
  assert.equal(view.entries.length, 1);
  assert.deepEqual(view.notices, []);
});
