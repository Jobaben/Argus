import { test } from "node:test";
import assert from "node:assert/strict";
import { EVENT_CAP, buildRecording, diffShape, toolLabel } from "./recorder.js";
import type { Run } from "./scheduleTypes.js";

const T0 = Date.parse("2026-07-01T10:00:00.000Z");
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
const NOW = new Date(T0 + 600_000);

function run(over: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    scheduleId: "s1",
    scheduleName: "Nightly triage",
    prompt: "Triage the overnight failures",
    cwd: "/repo",
    status: "succeeded",
    trigger: "scheduled",
    queuedAt: iso(0),
    startedAt: iso(0),
    endedAt: iso(60_000),
    durationMs: 60_000,
    pid: 100,
    exitCode: 0,
    sessionId: "sess-1",
    project: "-repo",
    resultSummary: "done",
    error: null,
    ...over,
  };
}

const assistant = (offsetMs: number, content: unknown[], usage?: Record<string, number>) => ({
  type: "assistant",
  timestamp: iso(offsetMs),
  message: { role: "assistant", content, ...(usage ? { usage } : {}) },
});

const userResult = (offsetMs: number, toolUseId: string, over: Record<string, unknown> = {}) => ({
  type: "user",
  timestamp: iso(offsetMs),
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok", ...over }],
  },
});

test("places every event on one clock rooted at the run's start", () => {
  const rec = buildRecording(
    run(),
    [
      assistant(5_000, [{ type: "text", text: "starting" }]),
      assistant(12_000, [
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } },
      ]),
      userResult(20_000, "t1"),
    ],
    NOW,
  );

  const offsets = rec.events.map((e) => e.atMs);
  assert.deepEqual(offsets, [0, 5_000, 12_000, 60_000]);
  assert.equal(rec.events[0].kind, "start");
  assert.equal(rec.durationMs, 60_000);
});

test("joins a tool call to its result, giving the call a duration", () => {
  const rec = buildRecording(
    run(),
    [
      assistant(1_000, [
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } },
      ]),
      userResult(9_000, "t1"),
    ],
    NOW,
  );
  const call = rec.events.find((e) => e.kind === "tool");
  assert.ok(call);
  assert.equal(call.label, "Bash: npm test");
  assert.equal(call.durationMs, 8_000);
  assert.equal(call.errored, undefined);
});

test("an errored tool result marks the call and anchors jump-to-failure", () => {
  const rec = buildRecording(
    run({ status: "failed", exitCode: 1, error: "exit code 1" }),
    [
      assistant(1_000, [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "a" } }]),
      userResult(2_000, "t1"),
      assistant(3_000, [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "b" } }]),
      userResult(4_000, "t2", { is_error: true, content: "command not found: b" }),
    ],
    NOW,
  );

  assert.equal(rec.totals.errors, 1);
  assert.ok(rec.failureIndex !== null);
  const failure = rec.events[rec.failureIndex];
  assert.equal(failure.errored, true);
  assert.equal(failure.label, "Bash: b");
  assert.equal(failure.detail, "command not found: b");
  // Not the terminal marker — the moment it actually went wrong.
  assert.ok(rec.failureIndex < rec.events.length - 1);
});

test("a failed run with no errored tool falls back to the terminal marker", () => {
  const rec = buildRecording(
    run({ status: "failed", exitCode: 2, error: "spawn ENOENT" }),
    [assistant(1_000, [{ type: "text", text: "hello" }])],
    NOW,
  );
  assert.equal(rec.failureIndex, rec.events.length - 1);
  assert.equal(rec.events[rec.events.length - 1].kind, "error");
  assert.match(rec.events[rec.events.length - 1].label, /spawn ENOENT/);
});

test("file-shaped tools land in the file lane with a diff shape", () => {
  const rec = buildRecording(
    run(),
    [
      assistant(1_000, [
        {
          type: "tool_use",
          id: "t1",
          name: "Edit",
          input: { file_path: "/repo/src/app.ts", old_string: "a\nb", new_string: "a\nb\nc\nd" },
        },
      ]),
    ],
    NOW,
  );
  const edit = rec.events.find((e) => e.lane === "file");
  assert.ok(edit);
  assert.equal(edit.path, "/repo/src/app.ts");
  assert.equal(edit.added, 4);
  assert.equal(edit.removed, 2);
  assert.equal(edit.label, "Edit: app.ts");
  assert.equal(rec.totals.files, 1);
  assert.equal(rec.totals.tools, 0);
});

test("token bursts accumulate and cost is apportioned by share, flagged estimated", () => {
  const rec = buildRecording(
    run({ costUsd: 1 }),
    [
      assistant(1_000, [{ type: "text", text: "one" }], { input_tokens: 100, output_tokens: 100 }),
      assistant(2_000, [{ type: "text", text: "two" }], { input_tokens: 500, output_tokens: 300 }),
    ],
    NOW,
  );

  const spend = rec.events.filter((e) => e.lane === "spend");
  assert.equal(spend.length, 2);
  assert.equal(spend[0].tokens, 200);
  assert.equal(spend[1].tokens, 800);
  assert.equal(spend[1].tokensTotal, 1000);
  assert.equal(spend[0].costUsd, 0.2);
  assert.equal(spend[1].costUsd, 0.8);
  assert.equal(spend[1].costTotalUsd, 1);
  assert.equal(rec.costEstimated, true);
  assert.equal(rec.totals.tokens, 1000);
});

test("no reported cost means no invented per-event dollars", () => {
  const rec = buildRecording(
    run({ costUsd: null }),
    [assistant(1_000, [{ type: "text", text: "x" }], { input_tokens: 10, output_tokens: 10 })],
    NOW,
  );
  const spend = rec.events.find((e) => e.lane === "spend");
  assert.ok(spend);
  assert.equal(spend.costUsd, undefined);
  assert.equal(rec.costEstimated, false);
});

test("regression: out-of-order transcript timestamps never move the scrubber backwards", () => {
  const rec = buildRecording(
    run(),
    [
      assistant(10_000, [{ type: "text", text: "later" }]),
      assistant(2_000, [{ type: "text", text: "earlier, from a resumed session" }]),
      assistant(11_000, [{ type: "text", text: "later still" }]),
    ],
    NOW,
  );
  const offsets = rec.events.map((e) => e.atMs);
  for (let i = 1; i < offsets.length; i++) {
    assert.ok(offsets[i] >= offsets[i - 1], `event ${i} went backwards`);
  }
});

test("regression: malformed and unknown lines are skipped, not thrown on", () => {
  const rec = buildRecording(
    run(),
    [
      null,
      "a bare string",
      42,
      { type: "system", subtype: "init" },
      { type: "assistant" },
      { type: "assistant", message: { content: "not an array" } },
      assistant(1_000, [{ type: "text", text: "ok" }]),
    ],
    NOW,
  );
  assert.ok(rec.events.some((e) => e.label === "ok"));
});

test("regression: a tool_result with no matching call still records the error", () => {
  const rec = buildRecording(
    run({ status: "failed" }),
    [userResult(1_000, "orphan", { is_error: true, content: "boom" })],
    NOW,
  );
  assert.equal(rec.totals.errors, 1);
  const err = rec.events.find((e) => e.errored);
  assert.ok(err);
  assert.equal(err.label, "boom");
});

test("past the event cap the earliest events go and the origin stays fixed", () => {
  const lines = Array.from({ length: EVENT_CAP + 50 }, (_, i) =>
    assistant(i * 10, [{ type: "text", text: `line ${i}` }]),
  );
  const rec = buildRecording(run(), lines, NOW);
  assert.equal(rec.truncated, true);
  assert.equal(rec.events.length, EVENT_CAP);
  // Absolute offsets survive the trim: the first kept event is not at zero.
  assert.ok(rec.events[0].atMs > 0);
  assert.equal(rec.events[rec.events.length - 1].kind, "end");
});

test("a run with no transcript says why rather than showing an empty track", () => {
  const noSession = buildRecording(run({ sessionId: null, startedAt: iso(0) }), [], NOW);
  assert.equal(noSession.events.length > 0, true); // the start marker still exists
  const neverStarted = buildRecording(
    run({ startedAt: null, endedAt: null, status: "skipped" }),
    [],
    NOW,
  );
  assert.equal(neverStarted.events.length, 0);
  assert.equal(neverStarted.unavailable, "not-started");
});

test("a running run's scrubber extends to now", () => {
  const rec = buildRecording(
    run({ status: "running", endedAt: null, durationMs: null }),
    [assistant(1_000, [{ type: "text", text: "working" }])],
    NOW,
  );
  assert.equal(rec.durationMs, 600_000);
  assert.equal(
    rec.events.some((e) => e.kind === "end"),
    false,
  );
});

test("lanes summarize only what is present", () => {
  const rec = buildRecording(run(), [assistant(1_000, [{ type: "text", text: "x" }])], NOW);
  assert.deepEqual(
    rec.lanes.map((l) => l.lane),
    ["agent"],
  );
});

test("diffShape handles every edit-shaped tool", () => {
  assert.deepEqual(diffShape("Edit", { old_string: "a", new_string: "a\nb" }), {
    added: 2,
    removed: 1,
  });
  assert.deepEqual(
    diffShape("MultiEdit", {
      edits: [
        { old_string: "a", new_string: "a\nb" },
        { old_string: "", new_string: "c" },
      ],
    }),
    { added: 3, removed: 1 },
  );
  assert.deepEqual(diffShape("Write", { content: "1\n2\n3" }), { added: 3, removed: 0 });
  assert.deepEqual(diffShape("Read", {}), { added: 0, removed: 0 });
});

test("toolLabel stays one line and clipped", () => {
  assert.equal(toolLabel("Bash", { command: "echo  hi\nthere" }), "Bash: echo hi there");
  assert.equal(toolLabel("Grep", { pattern: "foo" }), "Grep: foo");
  assert.equal(toolLabel("WebFetch", {}), "WebFetch");
});
