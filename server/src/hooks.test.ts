import { test } from "node:test";
import assert from "node:assert/strict";
// The reference hook lives at <repo>/hooks/argus-signal.mjs; import its pure
// type-resolution helper. The module guards its side effects behind an
// is-main check, so importing it here is safe.
import { resolveType } from "../../hooks/argus-signal.mjs";

test("explicit CLI arg always wins over the message", () => {
  assert.equal(resolveType("needs-input", { last_assistant_message: "ARGUS_OUTCOME: failed" }), "needs-input");
  assert.equal(resolveType("failed", { last_assistant_message: "all good" }), "failed");
});

test("Stop hook (no arg) derives failed from the sentinel", () => {
  assert.equal(resolveType(undefined, { last_assistant_message: "work done\nARGUS_OUTCOME: failed" }), "failed");
  assert.equal(resolveType(undefined, { last_assistant_message: "ARGUS_OUTCOME: blocked — no Jira" }), "failed");
  assert.equal(resolveType(undefined, { last_assistant_message: "argus_outcome:  FAILED" }), "failed");
});

test("Stop hook defaults to completed without a failure sentinel", () => {
  assert.equal(resolveType(undefined, { last_assistant_message: "Done. ARGUS_OUTCOME: succeeded" }), "completed");
  assert.equal(resolveType(undefined, { last_assistant_message: "finished cleanly" }), "completed");
  assert.equal(resolveType(undefined, {}), "completed");
  assert.equal(resolveType(undefined, "raw non-json text"), "completed");
  assert.equal(resolveType(undefined, null), "completed");
});
