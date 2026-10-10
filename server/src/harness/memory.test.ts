import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_MEMORY_BYTES,
  ensureMemoryDir,
  isSettled,
  memoryDirFor,
  memoryNotesPath,
  readMemoryNotes,
  summarizeInstance,
  trimMemoryIfNeeded,
} from "./memory.js";
import type { PipelineInstance } from "../sources/pipelineTypes.js";
import { argusWorkRoot } from "../claudeHome.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-memory-"));
  process.env.ARGUS_CLAUDE_HOME = home;
});

function baseInstance(over: Partial<PipelineInstance> = {}): PipelineInstance {
  return {
    id: "inst-1",
    pipelineId: "pipe-1",
    pipelineName: "Pipe",
    status: "succeeded",
    currentPhaseIndex: 0,
    phases: [],
    trigger: "manual",
    signalToken: "t",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:10:00.000Z",
    endedAt: "2026-01-01T00:10:00.000Z",
    ...over,
  };
}

// ── Paths ─────────────────────────────────────────────────────────────────

test("memoryDirFor/memoryNotesPath are sandboxed under the work root's memory dir", () => {
  const dir = memoryDirFor("my-pipeline");
  assert.ok(dir.startsWith(path.join(argusWorkRoot(), "memory")));
  assert.equal(memoryNotesPath("my-pipeline"), path.join(dir, "NOTES.md"));
});

test("memoryDirFor sanitizes a hostile pipeline id the same as safeSegment does elsewhere", () => {
  // safeSegment (shared with artifact/worktree paths) turns every path
  // separator into "_", so a "../../etc" id becomes one oddly-named segment —
  // never an actual escape: the result is always a *direct* child of the
  // memory root, whatever characters survive in the segment's own name.
  const root = path.join(argusWorkRoot(), "memory");
  const dir = memoryDirFor("../../etc");
  assert.equal(path.dirname(dir), root);
});

// ── readMemoryNotes / ensureMemoryDir ────────────────────────────────────────

test("readMemoryNotes is empty when NOTES.md does not exist yet — never an error", async () => {
  assert.equal(await readMemoryNotes("never-run", DEFAULT_MEMORY_BYTES), "");
});

test("ensureMemoryDir creates the directory idempotently, and a child could write into it", async () => {
  const dir = await ensureMemoryDir("p1");
  await writeFile(path.join(dir, "NOTES.md"), "hello", "utf8");
  await ensureMemoryDir("p1"); // second call: no throw
  assert.equal(await readMemoryNotes("p1", DEFAULT_MEMORY_BYTES), "hello");
});

test("readMemoryNotes returns the tail of NOTES.md, capped, UTF-8 safe", async () => {
  const dir = await ensureMemoryDir("p2");
  const body = "line-1\n".repeat(2000); // well over any small cap
  await writeFile(path.join(dir, "NOTES.md"), body, "utf8");
  const tail = await readMemoryNotes("p2", 100);
  assert.ok(Buffer.byteLength(tail, "utf8") <= 100);
  assert.ok(body.endsWith(tail.slice(-20)));
});

// ── trimMemoryIfNeeded ────────────────────────────────────────────────────

test("trimMemoryIfNeeded is a no-op when the file is missing or already within cap", async () => {
  assert.equal(await trimMemoryIfNeeded("nope", DEFAULT_MEMORY_BYTES), false);
  const dir = await ensureMemoryDir("p3");
  await writeFile(path.join(dir, "NOTES.md"), "short", "utf8");
  assert.equal(await trimMemoryIfNeeded("p3", DEFAULT_MEMORY_BYTES), false);
  assert.equal(await readFile(path.join(dir, "NOTES.md"), "utf8"), "short");
});

test("trimMemoryIfNeeded trims the head on a line boundary, keeping the newest content", async () => {
  const dir = await ensureMemoryDir("p4");
  const lines = Array.from({ length: 50 }, (_, i) => `entry ${i}: ${"x".repeat(20)}`);
  const body = lines.join("\n");
  await writeFile(path.join(dir, "NOTES.md"), body, "utf8");
  const cap = 200;
  assert.equal(await trimMemoryIfNeeded("p4", cap), true);
  const after = await readFile(path.join(dir, "NOTES.md"), "utf8");
  assert.ok(Buffer.byteLength(after, "utf8") <= cap);
  // Never starts mid-line: either the exact start of a kept "entry N: ..."
  // line, or (only if the cap is smaller than one line) a partial tail.
  assert.ok(after.startsWith("entry ") || after.length < 21);
  // The newest content survived; the oldest did not.
  assert.ok(after.includes(lines[lines.length - 1]));
  assert.ok(!after.includes(lines[0]));
  // Idempotent: trimming an already-trimmed file is a no-op.
  assert.equal(await trimMemoryIfNeeded("p4", cap), false);
});

// ── isSettled / summarizeInstance ─────────────────────────────────────────

test("isSettled: only succeeded/failed/aborted count; running/awaiting-approval don't", () => {
  assert.equal(isSettled({ status: "succeeded" }), true);
  assert.equal(isSettled({ status: "failed" }), true);
  assert.equal(isSettled({ status: "aborted" }), true);
  assert.equal(isSettled({ status: "running" }), false);
  assert.equal(isSettled({ status: "awaiting-approval" }), false);
});

test("summarizeInstance is empty for an instance that has not settled", () => {
  assert.equal(summarizeInstance(baseInstance({ status: "running" })), "");
});

test("summarizeInstance: a plain success names the status and when it ended", () => {
  const summary = summarizeInstance(baseInstance());
  assert.equal(summary, "Previous run succeeded (ended 2026-01-01T00:10:00.000Z).");
});

test("summarizeInstance: a failure names which phase and why, in one line", () => {
  const inst = baseInstance({
    status: "failed",
    phases: [
      {
        id: "build",
        name: "Build",
        gated: false,
        status: "failed",
        steps: [],
        attempt: 0,
        payload: { reason: "typecheck failed", failureClass: "verification" },
      },
    ],
  });
  assert.equal(
    summarizeInstance(inst),
    'Previous run failed (ended 2026-01-01T00:10:00.000Z); phase "Build" failed: typecheck failed.',
  );
});

test("summarizeInstance: a failed phase with no reason still names it, without a dangling colon", () => {
  const inst = baseInstance({
    status: "failed",
    phases: [
      {
        id: "build",
        name: "Build",
        gated: false,
        status: "failed",
        steps: [],
        attempt: 0,
        payload: null,
      },
    ],
  });
  assert.equal(
    summarizeInstance(inst),
    'Previous run failed (ended 2026-01-01T00:10:00.000Z); phase "Build" failed.',
  );
});

test("summarizeInstance: names the winning candidate when a phase selected one", () => {
  const inst = baseInstance({
    phases: [
      {
        id: "impl",
        name: "Implement",
        gated: false,
        status: "succeeded",
        steps: [],
        attempt: 0,
        payload: null,
        selectedCandidate: 1,
      },
    ],
  });
  assert.equal(
    summarizeInstance(inst),
    'Previous run succeeded (ended 2026-01-01T00:10:00.000Z); phase "Implement" selected candidate 1.',
  );
});

test("summarizeInstance: falls back to updatedAt when endedAt is absent", () => {
  const inst = baseInstance({ endedAt: null });
  assert.equal(summarizeInstance(inst), "Previous run succeeded (ended 2026-01-01T00:10:00.000Z).");
});
