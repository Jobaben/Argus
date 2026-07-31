import { test } from "node:test";
import assert from "node:assert/strict";
import { appendStopHook, hasArgusStopHook, hasConflictingStopKey } from "./codexConfig.js";

test("an appended block is found on the next check", () => {
  const before = 'model = "gpt-5.3-codex"\n\n[hooks]\n';
  assert.equal(hasArgusStopHook(before), false);
  const after = appendStopHook(before, ["node", "/home/u/.codex/hooks/argus-signal.mjs"]);
  assert.equal(hasArgusStopHook(after), true);
});

test("appending preserves the operator's file byte for byte", () => {
  const before = '# my notes\nmodel = "gpt-5.3-codex"\n\n[tui]\nnotifications = true\n';
  const after = appendStopHook(before, ["node", "/x/argus-signal.mjs"]);
  assert.ok(after.startsWith(before), "the original text must be untouched");
  assert.ok(after.includes("[[hooks.stop]]"));
  assert.ok(after.includes('command = ["node", "/x/argus-signal.mjs"]'));
});

test("an empty config still produces a well-formed block", () => {
  const out = appendStopHook("", ["node", "/x/argus-signal.mjs"]);
  assert.ok(out.trimStart().startsWith("#"));
  assert.ok(out.includes("[[hooks.stop]]"));
  assert.equal(hasArgusStopHook(out), true);
});

test("a file with no trailing newline gets one before the block", () => {
  const out = appendStopHook('model = "x"', ["node", "/x/argus-signal.mjs"]);
  assert.ok(out.includes('model = "x"\n\n#'));
});

test("backslashes and quotes in a path are escaped", () => {
  const out = appendStopHook("", ["node", 'C:\\Users\\a"b\\argus-signal.mjs']);
  assert.ok(out.includes('"C:\\\\Users\\\\a\\"b\\\\argus-signal.mjs"'));
});

test("another project's stop hook is not mistaken for Argus's", () => {
  const toml = '[[hooks.stop]]\ncommand = ["python3", "/x/other.py"]\n';
  assert.equal(hasArgusStopHook(toml), false);
});

test("a session_start hook using the same script is not a stop registration", () => {
  const toml = '[[hooks.session_start]]\ncommand = ["node", "/x/argus-signal.mjs"]\n';
  assert.equal(hasArgusStopHook(toml), false);
});

test("a matcher sub-table stays part of its block", () => {
  const toml = [
    "[[hooks.stop]]",
    'command = ["node", "/x/argus-signal.mjs"]',
    "",
    "[hooks.stop.matcher]",
    'matcher = "*"',
    "",
    "[[hooks.pre_tool_use]]",
    'command = ["python3", "/x/other.py"]',
  ].join("\n");
  assert.equal(hasArgusStopHook(toml), true);
});

test("a hook registered after an unrelated table is still found", () => {
  const toml = [
    "[tui]",
    "notifications = true",
    "",
    "[[hooks.stop]]",
    'command = ["node", "/home/u/.codex/hooks/argus-signal.mjs"]',
  ].join("\n");
  assert.equal(hasArgusStopHook(toml), true);
});

test("a scalar `stop` under [hooks] is a conflict, not something to append beside", () => {
  // TOML forbids the same name being both a value and an array of tables, so
  // appending would make the whole config unparseable and take Codex with it.
  assert.equal(hasConflictingStopKey('[hooks]\nstop = "echo hi"\n'), true);
  assert.equal(hasConflictingStopKey('[hooks]\n  stop="echo hi"\n'), true);
});

test("a `stop` key in another table is not a conflict", () => {
  assert.equal(hasConflictingStopKey('[tui]\nstop = "x"\n'), false);
  assert.equal(hasConflictingStopKey('[[hooks.stop]]\ncommand = ["node","x"]\n'), false);
  assert.equal(hasConflictingStopKey(""), false);
});
