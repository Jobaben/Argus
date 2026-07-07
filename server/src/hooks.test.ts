import { test } from "node:test";
import assert from "node:assert/strict";
// The reference hook lives at <repo>/hooks/argus-signal.mjs; import its pure
// type-resolution helper. The module guards its side effects behind an
// is-main check, so importing it here is safe.
import { resolveType, hasPendingBackgroundWork } from "../../hooks/argus-signal.mjs";

test("explicit CLI arg always wins over the message", () => {
  assert.equal(
    resolveType("needs-input", { last_assistant_message: "ARGUS_OUTCOME: failed" }),
    "needs-input",
  );
  assert.equal(resolveType("failed", { last_assistant_message: "all good" }), "failed");
});

test("Stop hook (no arg) derives failed from the sentinel", () => {
  assert.equal(
    resolveType(undefined, { last_assistant_message: "work done\nARGUS_OUTCOME: failed" }),
    "failed",
  );
  assert.equal(
    resolveType(undefined, { last_assistant_message: "ARGUS_OUTCOME: blocked — no Jira" }),
    "failed",
  );
  assert.equal(
    resolveType(undefined, { last_assistant_message: "argus_outcome:  FAILED" }),
    "failed",
  );
});

test("Stop hook defaults to completed without a failure sentinel", () => {
  assert.equal(
    resolveType(undefined, { last_assistant_message: "Done. ARGUS_OUTCOME: succeeded" }),
    "completed",
  );
  assert.equal(resolveType(undefined, { last_assistant_message: "finished cleanly" }), "completed");
  assert.equal(resolveType(undefined, {}), "completed");
  assert.equal(resolveType(undefined, "raw non-json text"), "completed");
  assert.equal(resolveType(undefined, null), "completed");
});

test("Stop hook reports failed when background tasks are still in flight", () => {
  // The premature-stop bug: agent yields expecting re-invocation, but claude -p
  // tears the process down at Stop and the background work never finishes.
  const waiting = {
    last_assistant_message: "I'll wait for the agents to finish before finalizing.",
    background_tasks: [{ id: "a1", type: "subagent", status: "running" }],
  };
  assert.equal(resolveType(undefined, waiting), "failed");
});

test("Stop hook overrides a premature success claim with unfinished background work", () => {
  const claimed = {
    last_assistant_message: "Done. ARGUS_OUTCOME: succeeded",
    background_tasks: [{ status: "queued" }],
  };
  assert.equal(resolveType(undefined, claimed), "failed");
});

test("Stop hook ignores finished background tasks", () => {
  const finished = {
    last_assistant_message: "all good",
    background_tasks: [{ status: "completed" }, { status: "done" }, { status: "failed" }],
  };
  assert.equal(resolveType(undefined, finished), "completed");
});

test("explicit CLI arg still wins over unfinished background work", () => {
  assert.equal(
    resolveType("needs-input", { background_tasks: [{ status: "running" }] }),
    "needs-input",
  );
});

test("hasPendingBackgroundWork detects only non-terminal task statuses", () => {
  assert.equal(hasPendingBackgroundWork({ background_tasks: [{ status: "running" }] }), true);
  assert.equal(hasPendingBackgroundWork({ background_tasks: [{ status: "in_progress" }] }), true);
  assert.equal(hasPendingBackgroundWork({ background_tasks: [{ status: "done" }] }), false);
  assert.equal(hasPendingBackgroundWork({ background_tasks: [] }), false);
  assert.equal(hasPendingBackgroundWork({}), false);
  assert.equal(hasPendingBackgroundWork("raw"), false);
  assert.equal(hasPendingBackgroundWork(null), false);
});
