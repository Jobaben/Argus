import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  statSync,
  openSync,
  writeSync,
  closeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let home: string;
const PROJECT = "proj-x";
const SESSION = "sess1";

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-tail-"));
  process.env.ARGUS_CLAUDE_HOME = home;
});

async function fresh() {
  return import(`./sessions.js?${Math.random()}`);
}

function writeSession(lines: string[]): void {
  const dir = path.join(home, "projects", PROJECT);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${SESSION}.jsonl`), lines.join("\n"), "utf8");
}

const USER = JSON.stringify({
  type: "user",
  timestamp: "2026-07-09T00:00:00Z",
  message: { role: "user", content: "hi" },
});
const ASSISTANT_TOOL = JSON.stringify({
  type: "assistant",
  timestamp: "2026-07-09T00:00:01Z",
  message: {
    role: "assistant",
    model: "claude-x",
    content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }],
  },
});
const ASSISTANT_TEXT = JSON.stringify({
  type: "assistant",
  timestamp: "2026-07-09T00:00:02Z",
  message: { role: "assistant", content: [{ type: "text", text: "done" }] },
});
const MALFORMED = "{ this is not json";
const SYSTEM = JSON.stringify({ type: "system", subtype: "init" });

test("tail returns all messages after=-1, skipping malformed and non-message lines", async () => {
  writeSession([USER, ASSISTANT_TOOL, MALFORMED, SYSTEM, ASSISTANT_TEXT]);
  const m = await fresh();
  const tail = await m.readSessionTail(PROJECT, SESSION, -1);
  assert.ok(tail);
  // 3 message lines survive; the malformed and system lines are dropped.
  assert.equal(tail.messages.length, 3);
  assert.deepEqual(
    tail.messages.map((x: { index: number }) => x.index),
    [0, 1, 2],
  );
  assert.equal(tail.lastIndex, 2);
  assert.equal(tail.messages[1].toolName, "Bash");
});

test("tail returns only messages strictly after the given index", async () => {
  writeSession([USER, ASSISTANT_TOOL, ASSISTANT_TEXT]);
  const m = await fresh();
  const tail = await m.readSessionTail(PROJECT, SESSION, 0);
  assert.ok(tail);
  assert.deepEqual(
    tail.messages.map((x: { index: number }) => x.index),
    [1, 2],
  );
  assert.equal(tail.lastIndex, 2);
});

test("tail is empty (no new messages) when after is the last index", async () => {
  writeSession([USER, ASSISTANT_TEXT]);
  const m = await fresh();
  const tail = await m.readSessionTail(PROJECT, SESSION, 1);
  assert.ok(tail);
  assert.equal(tail.messages.length, 0);
  assert.equal(tail.lastIndex, 1);
});

test("tail returns null for an unknown session", async () => {
  const m = await fresh();
  const tail = await m.readSessionTail(PROJECT, "nope", -1);
  assert.equal(tail, null);
});

function appendSession(lines: string[]): void {
  const file = path.join(home, "projects", PROJECT, `${SESSION}.jsonl`);
  appendFileSync(file, "\n" + lines.join("\n"), "utf8");
}

test("appended messages arrive on the next tail with continuing indices", async () => {
  writeSession([USER, ASSISTANT_TOOL]);
  const m = await fresh();
  const first = await m.readSessionTail(PROJECT, SESSION, -1);
  assert.equal(first.lastIndex, 1);

  appendSession([SYSTEM, ASSISTANT_TEXT]);
  const second = await m.readSessionTail(PROJECT, SESSION, first.lastIndex);
  assert.deepEqual(
    second.messages.map((x: { index: number }) => x.index),
    [2],
  );
  assert.equal(second.messages[0].text, "done");
  assert.equal(second.lastIndex, 2);
  assert.equal(second.lastActivity, "2026-07-09T00:00:02Z");
});

test("tail reads appended bytes only: an in-place rewrite of earlier bytes at the same size is not observed", async () => {
  // Pins the O(new bytes) property: after the first tail, corrupt the already
  // consumed prefix without changing its length. A full re-parse would drop
  // those messages; an incremental tail never re-reads them.
  writeSession([USER, ASSISTANT_TOOL]);
  const m = await fresh();
  const first = await m.readSessionTail(PROJECT, SESSION, -1);
  assert.equal(first.messages.length, 2);

  const file = path.join(home, "projects", PROJECT, `${SESSION}.jsonl`);
  const originalSize = statSync(file).size;
  const fd = openSync(file, "r+");
  writeSync(fd, Buffer.from("garbage!"), 0, 8, 0);
  closeSync(fd);
  assert.equal(statSync(file).size, originalSize);
  appendSession([ASSISTANT_TEXT]);

  const second = await m.readSessionTail(PROJECT, SESSION, first.lastIndex);
  assert.deepEqual(
    second.messages.map((x: { index: number }) => x.index),
    [2],
  );
  assert.equal(second.lastIndex, 2);
});

test("a truncated (rewritten shorter) file is re-parsed from scratch", async () => {
  writeSession([USER, ASSISTANT_TOOL, ASSISTANT_TEXT]);
  const m = await fresh();
  const first = await m.readSessionTail(PROJECT, SESSION, -1);
  assert.equal(first.lastIndex, 2);

  writeSession([USER]);
  const second = await m.readSessionTail(PROJECT, SESSION, -1);
  assert.deepEqual(
    second.messages.map((x: { index: number }) => x.index),
    [0],
  );
  assert.equal(second.lastIndex, 0);
});

test("a partial trailing line is held back until completed, without duplication", async () => {
  writeSession([USER]);
  const m = await fresh();
  await m.readSessionTail(PROJECT, SESSION, -1);

  // Simulate a writer mid-append: half a JSON line, no trailing newline.
  const file = path.join(home, "projects", PROJECT, `${SESSION}.jsonl`);
  const half = ASSISTANT_TEXT.slice(0, 20);
  appendFileSync(file, "\n" + half, "utf8");
  const during = await m.readSessionTail(PROJECT, SESSION, 0);
  assert.equal(during.messages.length, 0);

  appendFileSync(file, ASSISTANT_TEXT.slice(20), "utf8");
  const after = await m.readSessionTail(PROJECT, SESSION, 0);
  assert.deepEqual(
    after.messages.map((x: { index: number }) => x.index),
    [1],
  );
  assert.equal(after.messages[0].text, "done");
});

test("an unchanged file is served from memory and stays correct", async () => {
  writeSession([USER, ASSISTANT_TOOL, ASSISTANT_TEXT]);
  const m = await fresh();
  const first = await m.readSessionTail(PROJECT, SESSION, -1);
  const again = await m.readSessionTail(PROJECT, SESSION, 1);
  assert.deepEqual(
    again.messages.map((x: { index: number }) => x.index),
    [2],
  );
  assert.equal(again.lastIndex, first.lastIndex);
  assert.equal(again.title, first.title);
});

test("concurrent tails of the same session never double-ingest appended bytes", async () => {
  writeSession([USER]);
  const m = await fresh();
  await m.readSessionTail(PROJECT, SESSION, -1);

  appendSession([ASSISTANT_TOOL, ASSISTANT_TEXT]);
  const [a, b] = await Promise.all([
    m.readSessionTail(PROJECT, SESSION, 0),
    m.readSessionTail(PROJECT, SESSION, 0),
  ]);
  assert.deepEqual(
    a.messages.map((x: { index: number }) => x.index),
    [1, 2],
  );
  assert.deepEqual(
    b.messages.map((x: { index: number }) => x.index),
    [1, 2],
  );
  // A double-ingest would leave 5 messages in the memo; a fresh read sees 3.
  const final = await m.readSessionTail(PROJECT, SESSION, -1);
  assert.equal(final.messages.length, 3);
  assert.equal(final.lastIndex, 2);
});

test("an ai-title appended later upgrades the tail title", async () => {
  writeSession([USER]);
  const m = await fresh();
  const first = await m.readSessionTail(PROJECT, SESSION, -1);
  assert.equal(first.title, "hi");

  appendSession([JSON.stringify({ type: "ai-title", aiTitle: "Better title" })]);
  const second = await m.readSessionTail(PROJECT, SESSION, first.lastIndex);
  assert.equal(second.title, "Better title");
});
