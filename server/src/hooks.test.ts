import { test } from "node:test";
import assert from "node:assert/strict";
// The reference hook lives at <repo>/hooks/argus-signal.mjs; import its pure
// type-resolution helper. The module guards its side effects behind an
// is-main check, so importing it here is safe.
import {
  resolveType,
  hasPendingBackgroundWork,
  buildReason,
  lastMessage,
} from "../../hooks/argus-signal.mjs";

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

test("Stop hook defers when background tasks are still in flight", () => {
  // The process is not torn down at Stop: Claude keeps it alive and fires Stop
  // again once the background work finishes, and that later Stop drives the real
  // outcome. Deferring (no signal) avoids failing a run that is still working.
  const waiting = {
    last_assistant_message: "I'll wait for the agents to finish before finalizing.",
    background_tasks: [{ id: "a1", type: "subagent", status: "running" }],
  };
  assert.equal(resolveType(undefined, waiting), "deferred");
});

test("Stop hook defers a premature success claim with unfinished background work", () => {
  // No sentinel failure line, so the success claim doesn't force failed; the
  // in-flight work defers the decision to the later terminal Stop.
  const claimed = {
    last_assistant_message: "Done. ARGUS_OUTCOME: succeeded",
    background_tasks: [{ status: "queued" }],
  };
  assert.equal(resolveType(undefined, claimed), "deferred");
});

test("Stop hook: an explicit failure sentinel wins over in-flight background work", () => {
  const failed = {
    last_assistant_message: "ARGUS_OUTCOME: failed — Jira never flipped",
    background_tasks: [{ status: "running" }],
  };
  assert.equal(resolveType(undefined, failed), "failed");
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

test("buildReason: uses the text after the ARGUS_OUTCOME sentinel", () => {
  assert.equal(
    buildReason({
      last_assistant_message: "work done\nARGUS_OUTCOME: failed — Jira never flipped",
    }),
    "failed: Jira never flipped",
  );
  assert.equal(buildReason({ last_assistant_message: "ARGUS_OUTCOME: blocked" }), "blocked");
});

test("buildReason: summarizes pending background work when no sentinel", () => {
  assert.equal(
    buildReason({
      last_assistant_message: "I'll wait for the agents to finish before finalizing.",
      background_tasks: [{ id: "a1", type: "subagent", status: "running" }],
    }),
    "stopped with 1 background task(s) still in flight (subagent: running)",
  );
});

test("buildReason: falls back to the last message tail, then a generic reason", () => {
  assert.equal(
    buildReason({ last_assistant_message: "first line\nStuck on the migration." }),
    "Stuck on the migration.",
  );
  assert.equal(buildReason({}), "run stopped without reporting an outcome");
});

// ── Runtime-agnostic payload reading ────────────────────────────────────────
// One hook file is registered with both CLIs — as a `Stop` hook in Claude
// Code's settings.json and as `[[hooks.stop]]` in Codex's config.toml — so the
// outcome logic has to read either payload.

test("the closing message is read under whichever name the runtime used", () => {
  assert.equal(lastMessage({ last_assistant_message: "a" }), "a");
  assert.equal(lastMessage({ last_agent_message: "b" }), "b");
  assert.equal(lastMessage({ last_message: "c" }), "c");
  assert.equal(lastMessage({}), "");
  assert.equal(lastMessage(null), "");
  assert.equal(lastMessage("not an object"), "");
});

test("a Codex stop payload resolves an outcome the same way a Claude one does", () => {
  // Codex reports no background_tasks; a run that stops is simply finished, so
  // the sentinel in the final message is the whole decision.
  const codexStop = {
    hook_event_name: "Stop",
    session_id: "019c7149",
    cwd: "/srv/app",
    stop_hook_active: false,
    last_assistant_message: "shipped it\nARGUS_OUTCOME: succeeded",
  };
  assert.equal(resolveType(undefined, codexStop), "completed");
  assert.equal(
    resolveType(undefined, {
      ...codexStop,
      last_assistant_message: "ARGUS_OUTCOME: blocked no creds",
    }),
    "failed",
  );
  assert.equal(
    buildReason({ ...codexStop, last_assistant_message: "ARGUS_OUTCOME: blocked no creds" }),
    "blocked: no creds",
  );
});

test("deferral needs background tasks, which Codex never reports", () => {
  assert.equal(hasPendingBackgroundWork({ last_assistant_message: "done" }), false);
  assert.equal(resolveType(undefined, { last_assistant_message: "done" }), "completed");
});
