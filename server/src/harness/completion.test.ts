import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyOutcomeMarker,
  completionMessageOf,
  decideCompletion,
  parseHookMeta,
  resolveCompletionPolicy,
  summarizePhaseCompletion,
} from "./completion.js";
import { classifyMarker as hookClassify, HOOK_VERSION } from "../../../hooks/argus-signal.mjs";

const AT = "2026-10-04T12:00:00.000Z";

// ── The classifier ───────────────────────────────────────────────────────────

/** One corpus, read by both classifiers — the server's and the hook's copy,
 *  which must stay a dependency-free script and so cannot import it. */
const CORPUS: Array<[string, string]> = [
  ["", "missing"],
  ["Done.", "missing"],
  ["ARGUS_OUTCOME: succeeded", "succeeded"],
  ["All green.\nARGUS_OUTCOME: succeeded", "succeeded"],
  ["argus_outcome: SUCCEEDED", "succeeded"],
  ["ARGUS_OUTCOME:succeeded", "succeeded"],
  ["Result — ARGUS_OUTCOME: succeeded (mid-line)", "succeeded"],
  ["**ARGUS_OUTCOME: succeeded**", "succeeded"],
  ["`ARGUS_OUTCOME: succeeded`", "succeeded"],
  ["ARGUS_OUTCOME: succeeded\nrecap\nARGUS_OUTCOME: succeeded", "succeeded"],
  ["ARGUS_OUTCOME: failed — tests red", "failed"],
  ["ARGUS_OUTCOME: blocked: no credentials", "blocked"],
  ["ARGUS_OUTCOME: succeeded\nARGUS_OUTCOME: failed — contradictory", "conflicting"],
  ["ARGUS_OUTCOME: blocked\nARGUS_OUTCOME: failed", "conflicting"],
  // The instruction echoed back is two different conclusions, not a success.
  [
    "Write `ARGUS_OUTCOME: succeeded` if you met the criteria, or `ARGUS_OUTCOME: failed`",
    "conflicting",
  ],
  ["ARGUS_OUTCOME: succeededly", "missing"],
  ["MY_ARGUS_OUTCOME: succeeded", "missing"],
  ["ARGUS_OUTCOME: done", "missing"],
];

test("the classifier reads every corpus message as expected", () => {
  for (const [message, kind] of CORPUS) {
    assert.equal(classifyOutcomeMarker(message).kind, kind, JSON.stringify(message));
  }
});

test("the stop hook's copy of the classifier agrees with the server's on the whole corpus", () => {
  for (const [message] of CORPUS) {
    assert.equal(
      hookClassify(message),
      classifyOutcomeMarker(message).kind,
      JSON.stringify(message),
    );
  }
  assert.equal(hookClassify(undefined), "missing");
  assert.equal(HOOK_VERSION, 2);
});

test("a failed/blocked marker carries its own line's reason; success carries none", () => {
  assert.equal(
    classifyOutcomeMarker("x\nARGUS_OUTCOME: failed — tests red").reason,
    "failed: tests red",
  );
  assert.equal(classifyOutcomeMarker("ARGUS_OUTCOME: blocked").reason, "blocked");
  assert.equal(classifyOutcomeMarker("ARGUS_OUTCOME: succeeded").reason, null);
  assert.deepEqual(classifyOutcomeMarker("ARGUS_OUTCOME: succeeded\nARGUS_OUTCOME: failed").found, [
    "succeeded",
    "failed",
  ]);
});

test("the final message is read from the keys the hook reads, and nothing else", () => {
  assert.equal(completionMessageOf({ last_assistant_message: "a" }), "a");
  assert.equal(completionMessageOf({ last_agent_message: "b" }), "b");
  assert.equal(completionMessageOf({ last_message: "c" }), "c");
  assert.equal(completionMessageOf({ last_assistant_message: "a", last_message: "c" }), "a");
  // Absent is not empty: Argus was not told what the agent said.
  assert.equal(completionMessageOf(undefined), null);
  assert.equal(completionMessageOf("raw text"), null);
  assert.equal(completionMessageOf(["ARGUS_OUTCOME: succeeded"]), null);
  assert.equal(completionMessageOf({ reason: "ARGUS_OUTCOME: succeeded" }), null);
});

test("policy resolution: phase, else pipeline, else required", () => {
  assert.equal(resolveCompletionPolicy({}, undefined), "required");
  assert.equal(resolveCompletionPolicy({}, {}), "required");
  assert.equal(resolveCompletionPolicy({ completion: { marker: "lenient" } }, {}), "lenient");
  assert.equal(
    resolveCompletionPolicy(
      { completion: { marker: "lenient" } },
      { completion: { marker: "required" } },
    ),
    "required",
  );
  assert.equal(resolveCompletionPolicy({}, { completion: { marker: "lenient" } }), "lenient");
});

test("hook metadata is validated, and malformed metadata is said so rather than trusted", () => {
  assert.equal(parseHookMeta(undefined), null);
  assert.equal(parseHookMeta(null), null);
  assert.deepEqual(parseHookMeta({ hookVersion: 2, marker: "succeeded" }), {
    hookVersion: 2,
    marker: "succeeded",
  });
  for (const bad of [
    "v2",
    [],
    { hookVersion: "2", marker: "succeeded" },
    { hookVersion: 0, marker: "succeeded" },
    { hookVersion: 2.5, marker: "succeeded" },
    { hookVersion: 2, marker: "great" },
    { hookVersion: 2 },
  ]) {
    assert.equal(parseHookMeta(bad), "malformed", JSON.stringify(bad));
  }
});

// ── The decision ─────────────────────────────────────────────────────────────

const MESSAGES = {
  succeeded: "done\nARGUS_OUTCOME: succeeded",
  missing: "done",
  conflicting: "ARGUS_OUTCOME: succeeded\nARGUS_OUTCOME: failed",
  failed: "ARGUS_OUTCOME: failed — red",
  blocked: "ARGUS_OUTCOME: blocked — no creds",
} as const;

test("strict and lenient, across every marker, on a completed signal", () => {
  const expected: Record<string, Record<"required" | "lenient", [boolean, string | undefined]>> = {
    succeeded: { required: [true, undefined], lenient: [true, undefined] },
    missing: { required: [false, "unverified"], lenient: [true, undefined] },
    conflicting: { required: [false, "unverified"], lenient: [false, "unverified"] },
    failed: { required: [false, "signal"], lenient: [false, "signal"] },
    blocked: { required: [false, "signal"], lenient: [false, "signal"] },
  };
  for (const [marker, message] of Object.entries(MESSAGES)) {
    for (const policy of ["required", "lenient"] as const) {
      const d = decideCompletion({
        signal: "completed",
        source: "signal",
        policy,
        message,
        at: AT,
      });
      const [accept, cls] = expected[marker][policy];
      assert.equal(d.accept, accept, `${marker}/${policy}`);
      assert.equal(d.record.marker, marker);
      assert.equal(d.record.policy, policy);
      assert.equal(d.record.verdict, accept ? "accepted" : "refused");
      if (!d.accept) {
        assert.equal(d.failureClass, cls, `${marker}/${policy}`);
        assert.ok(d.reason.length > 0);
        assert.equal(d.record.reason, d.reason);
      }
    }
  }
});

test("a markerless refusal tells the retry exactly what was required, and how to opt out", () => {
  const d = decideCompletion({
    signal: "completed",
    source: "signal",
    policy: "required",
    message: "done",
    at: AT,
  });
  assert.equal(d.accept, false);
  if (d.accept) return;
  assert.match(d.reason, /ARGUS_OUTCOME: succeeded/);
  assert.match(d.reason, /lenient/);
});

test("a completion carrying no message at all is refused as unverified, not read as empty", () => {
  const d = decideCompletion({
    signal: "completed",
    source: "signal",
    policy: "required",
    message: null,
    at: AT,
  });
  assert.equal(d.accept, false);
  if (d.accept) return;
  assert.equal(d.failureClass, "unverified");
  assert.match(d.reason, /carried no final message/);
});

test("the hook's metadata never overrules the message Argus read", () => {
  // The hook claims success; the message it delivered has none.
  const strict = decideCompletion({
    signal: "completed",
    source: "signal",
    policy: "required",
    message: "done",
    hookMeta: { hookVersion: 2, marker: "succeeded" },
    at: AT,
  });
  assert.equal(strict.accept, false);
  assert.deepEqual(strict.record.hook, { version: 2, marker: "succeeded", agrees: false });
  // And the other way round: a success in the message with a hook that says
  // otherwise is two readings of one message that differ — refused under
  // `required`, decided on the message alone under `lenient`.
  const disagree = {
    signal: "completed" as const,
    source: "signal" as const,
    message: MESSAGES.succeeded,
    hookMeta: { hookVersion: 2, marker: "missing" },
    at: AT,
  };
  const r = decideCompletion({ ...disagree, policy: "required" });
  assert.equal(r.accept, false);
  if (!r.accept) {
    assert.equal(r.failureClass, "unverified");
    assert.match(r.reason, /hook reported marker "missing"/);
  }
  const l = decideCompletion({ ...disagree, policy: "lenient" });
  assert.equal(l.accept, true);
  assert.deepEqual(l.record.hook, { version: 2, marker: "missing", agrees: false });
  // Lenient with a markerless message is still accepted on the message alone.
  const lm = decideCompletion({
    signal: "completed",
    source: "signal",
    policy: "lenient",
    message: "done",
    hookMeta: { hookVersion: 2, marker: "succeeded" },
    at: AT,
  });
  assert.equal(lm.accept, true);
  assert.equal(lm.record.marker, "missing");
});

test("an agreeing hook, an old hook and malformed metadata are each recorded as what they are", () => {
  const agree = decideCompletion({
    signal: "completed",
    source: "signal",
    policy: "required",
    message: MESSAGES.succeeded,
    hookMeta: { hookVersion: 2, marker: "succeeded" },
    at: AT,
  });
  assert.equal(agree.accept, true);
  assert.deepEqual(agree.record.hook, { version: 2, marker: "succeeded", agrees: true });

  const legacy = decideCompletion({
    signal: "completed",
    source: "signal",
    policy: "required",
    message: MESSAGES.succeeded,
    at: AT,
  });
  assert.equal(legacy.accept, true);
  assert.equal(legacy.record.hook, undefined);

  const garbage = decideCompletion({
    signal: "completed",
    source: "signal",
    policy: "required",
    message: MESSAGES.succeeded,
    hookMeta: { hookVersion: "two" },
    at: AT,
  });
  assert.equal(garbage.accept, false);
  assert.deepEqual(garbage.record.hook, { version: null, marker: null, agrees: false });

  // The run-record path has no hook; metadata there is ignored entirely.
  const record = decideCompletion({
    signal: "completed",
    source: "run-record",
    policy: "required",
    message: MESSAGES.succeeded,
    hookMeta: { hookVersion: 2, marker: "missing" },
    at: AT,
  });
  assert.equal(record.accept, true);
  assert.equal(record.record.hook, undefined);
});

test("a failed signal is recorded as the agent's own report, never turned into a success", () => {
  for (const message of Object.values(MESSAGES)) {
    const d = decideCompletion({
      signal: "failed",
      source: "signal",
      policy: "lenient",
      message,
      at: AT,
    });
    assert.equal(d.accept, false);
    assert.equal(d.record.verdict, "reported-failure");
    if (!d.accept) assert.equal(d.failureClass, undefined);
  }
});

// ── Per-run summary ──────────────────────────────────────────────────────────

test("a phase's completion is derived from every step, never stamped from the last signal", () => {
  const rec = (marker: "succeeded" | "missing") =>
    decideCompletion({
      signal: "completed",
      source: "signal",
      policy: "lenient",
      message: marker === "succeeded" ? MESSAGES.succeeded : MESSAGES.missing,
      at: AT,
    }).record;
  const mixed = summarizePhaseCompletion([
    { completion: rec("missing") },
    { completion: rec("succeeded") },
  ]);
  assert.equal(mixed.allSucceededMarkers, false);
  assert.deepEqual(mixed.markers, { missing: 1, succeeded: 1 });
  // A step that has not reported (or predates provenance) is unknown, not a success.
  const partial = summarizePhaseCompletion([{ completion: rec("succeeded") }, {}]);
  assert.equal(partial.allSucceededMarkers, false);
  assert.deepEqual(partial.markers, { succeeded: 1, unknown: 1 });
  assert.equal(summarizePhaseCompletion([]).allSucceededMarkers, false);
  assert.equal(
    summarizePhaseCompletion([{ completion: rec("succeeded") }, { completion: rec("succeeded") }])
      .allSucceededMarkers,
    true,
  );
});
