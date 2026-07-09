import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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
