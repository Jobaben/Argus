import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RAW_LINES_CAP_BYTES, readSessionLines } from "./sessions.js";

let home: string;
const PROJECT = "proj-x";
const SESSION = "sess1";

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-lines-"));
  process.env.ARGUS_CLAUDE_HOME = home;
});

function writeSession(text: string, project = PROJECT, session = SESSION): void {
  const dir = path.join(home, "projects", project);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${session}.jsonl`), text);
}

test("returns every line of a small transcript, in file order", async () => {
  writeSession(
    [
      JSON.stringify({ type: "user", n: 1 }),
      JSON.stringify({ type: "assistant", n: 2 }),
      "",
      JSON.stringify({ type: "assistant", n: 3 }),
    ].join("\n"),
  );
  const lines = (await readSessionLines(PROJECT, SESSION)) as { n: number }[];
  assert.deepEqual(
    lines.map((l) => l.n),
    [1, 2, 3],
  );
});

test("skips malformed lines rather than failing the whole read", async () => {
  writeSession([JSON.stringify({ n: 1 }), "{not json", JSON.stringify({ n: 2 })].join("\n"));
  const lines = (await readSessionLines(PROJECT, SESSION)) as { n: number }[];
  assert.deepEqual(
    lines.map((l) => l.n),
    [1, 2],
  );
});

test("a missing transcript is an empty list, not a throw", async () => {
  assert.deepEqual(await readSessionLines(PROJECT, "nope"), []);
});

test("rejects a path-traversing project or session segment", async () => {
  writeSession(JSON.stringify({ n: 1 }));
  assert.deepEqual(await readSessionLines("../..", SESSION), []);
  assert.deepEqual(await readSessionLines(PROJECT, "../sess1"), []);
});

test("regression: an oversized transcript is read from the tail, not wholly into memory", async () => {
  // One padded line per record so the byte offsets are predictable. The first
  // records are pushed past the cap and must not come back.
  const pad = "x".repeat(1000);
  const perLine = JSON.stringify({ n: 0, pad }).length + 1;
  const total = Math.ceil((RAW_LINES_CAP_BYTES * 1.2) / perLine);
  const text = Array.from({ length: total }, (_, i) => JSON.stringify({ n: i, pad })).join("\n");
  writeSession(text);

  const lines = (await readSessionLines(PROJECT, SESSION)) as { n: number }[];
  assert.ok(lines.length > 0, "some tail was read");
  assert.ok(lines.length < total, "the head was dropped");
  // The last record survives — the tail is what matters — and the first does not.
  assert.equal(lines[lines.length - 1].n, total - 1);
  assert.ok(lines[0].n > 0, "reading starts partway in");
  // Every surviving record parsed: the partial first line was dropped cleanly
  // rather than becoming a malformed entry.
  assert.ok(
    lines.every((l) => typeof l.n === "number"),
    "no half-parsed record survived the boundary cut",
  );
});
