import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson } from "./canonical.js";
import { builtinRegistry } from "./definitions.js";
import { buildSnapshot, sealSnapshot } from "./projection.js";
import {
  RUN_FAILURE_BLIND_V1,
  RUN_FAILURE_CAPS,
  RUN_FAILURE_V1,
  runFailureBlindBuilder,
  runFailureBuilder,
} from "./projections/runFailure.js";
import { BodyShaper, REDACTION_RULES_V1 } from "./redaction.js";
import { assistant, failedRun, memorySources, toolResult, transcript } from "./testSupport.js";
import type { Run, StoredSnapshot } from "@argus/contracts";

const registry = builtinRegistry();
const ref = (blind: boolean) => {
  const def = blind ? RUN_FAILURE_BLIND_V1 : RUN_FAILURE_V1;
  return registry.projection(def.id, def.version)!;
};

async function build(run: Run, lines: unknown[] | null = transcript(), blind = false) {
  const mem = memorySources({ runs: [run], transcripts: { [run.id]: lines } });
  const p = ref(blind);
  return buildSnapshot(
    blind ? runFailureBlindBuilder : runFailureBuilder,
    p.ref,
    p.def,
    { kind: "run", runId: run.id },
    mem.sources,
  );
}

async function snap(
  run: Run,
  lines: unknown[] | null = transcript(),
  blind = false,
): Promise<StoredSnapshot> {
  const r = await build(run, lines, blind);
  assert.equal(r.ok, true, JSON.stringify(r));
  return (r as { snapshot: StoredSnapshot }).snapshot;
}

type Body = {
  run: Record<string, unknown>;
  prompt: string;
  resultSummary: string | null;
  timeline: {
    events: Array<{ kind: string; label: string; detail?: string; errored: boolean }>;
    omittedEarlier: number;
  };
};

test("the residual projection carries the observed termination and run outcome; the blind one withholds them", async () => {
  const run = failedRun({
    termination: "timed-out",
    error: "killed at its deadline",
    exitCode: 143,
  });
  const open = (await snap(run)).content.body as Body;
  assert.deepEqual(open.run.observedTermination, { class: "deadline" });
  assert.equal(open.run.status, "failed");
  assert.equal(open.run.exitCode, 143);
  assert.equal(open.run.error, "killed at its deadline");

  const blind = await snap(run, transcript(), true);
  const body = blind.content.body as Body;
  for (const k of [
    "status",
    "outcome",
    "exitCode",
    "error",
    "observedTermination",
    "termination",
  ]) {
    assert.ok(!(k in body.run), `blind body has ${k}`);
  }
  const text = canonicalJson(blind.content);
  assert.ok(!text.includes("killed at its deadline"), "the error string leaks through no field");
  assert.ok(!text.includes('deadline"'), "no termination label anywhere");
  // No terminal event derived from the run record reaches the timeline.
  assert.ok(body.timeline.events.every((e) => !e.label.startsWith("Failed")));
  assert.ok(
    body.timeline.events.every((e) =>
      ["thinking", "text", "tool", "file", "error"].includes(e.kind),
    ),
  );
  assert.equal(blind.content.projection.id, "run-failure.blind");
});

test("snapshots record subject-authored fields and their refs", async () => {
  const s = await snap(failedRun());
  assert.deepEqual(s.content.subjectAuthored, ["/resultSummary", "/timeline/events"]);
  assert.deepEqual(s.content.refs, {
    runs: ["run-1"],
    claims: [],
    verifications: [],
    artifacts: [],
  });
  assert.deepEqual(s.content.subject, { kind: "run", runId: "run-1" });
});

test("projection is deterministic: the same sources give the same bytes and digest", async () => {
  const a = await snap(failedRun());
  const b = await snap(failedRun());
  assert.equal(a.sha256, b.sha256);
  assert.equal(canonicalJson(a.content), canonicalJson(b.content));
  const c = await snap(failedRun({ resultSummary: "something else" }));
  assert.notEqual(a.sha256, c.sha256);
});

test("fields are truncated deterministically at code-point caps, and every cut is recorded", async () => {
  const emoji = "😀";
  const prompt = emoji.repeat(RUN_FAILURE_CAPS.prompt + 500);
  const s = await snap(failedRun({ prompt }));
  const body = s.content.body as Body;
  assert.equal(Array.from(body.prompt).length, RUN_FAILURE_CAPS.prompt);
  assert.ok(!/[\ud800-\udbff]$/.test(body.prompt), "no split surrogate pair");
  assert.deepEqual(
    s.content.truncations.find((t) => t.pointer === "/prompt"),
    {
      pointer: "/prompt",
      originalCodePoints: RUN_FAILURE_CAPS.prompt + 500,
      keptCodePoints: RUN_FAILURE_CAPS.prompt,
    },
  );
});

test("the timeline keeps the last 60 transcript events and says how many earlier ones it dropped", async () => {
  const lines = Array.from({ length: 150 }, (_, i) =>
    assistant(1000 + i * 100, [{ type: "text", text: `step ${i}` }]),
  );
  const body = (await snap(failedRun(), lines)).content.body as Body;
  assert.equal(body.timeline.events.length, RUN_FAILURE_CAPS.events);
  assert.equal(body.timeline.omittedEarlier, 90);
  assert.equal(body.timeline.events.at(-1)!.label, "step 149");
});

test("a worst-case body stays within the projection's byte ceiling", async () => {
  // Control characters expand six-fold in JSON; four-byte characters are
  // four UTF-8 bytes each. Fill every capped field with both.
  const nasty = "\u0001😀".repeat(5000);
  const lines = Array.from({ length: 200 }, (_, i) => [
    assistant(i * 10, [{ type: "tool_use", id: `t${i}`, name: "Bash", input: { command: nasty } }]),
    toolResult(i * 10 + 5, `t${i}`, nasty, true),
  ]).flat();
  const s = await snap(
    failedRun({ prompt: nasty, resultSummary: nasty, error: nasty, scheduleName: nasty }),
    lines,
  );
  assert.ok(s.bytes <= RUN_FAILURE_V1.maxBytes, `${s.bytes} bytes`);
  assert.ok(s.content.truncations.length > 0);
});

test("secrets are redacted before truncation, by versioned rules, and counted", async () => {
  const secretPrompt = [
    "use sk-ant-api03-abcdefghijklmnopqrstuvwx to call",
    "and ghp_abcdefghijklmnopqrstuvwxyz0123",
    "with DB_PASSWORD=hunter22 and Authorization: Bearer abcdefghijklmnopqrstuvwx.yz",
    "clone https://alice:s3cret@example.com/repo.git",
    "AKIAABCDEFGHIJKLMNOP",
  ].join("\n");
  const s = await snap(
    failedRun({ prompt: secretPrompt, resultSummary: "token: xoxb-1234567890-abcdef" }),
  );
  const text = canonicalJson(s.content);
  for (const leaked of [
    "abcdefghijklmnopqrstuvwx",
    "hunter22",
    "s3cret",
    "AKIAABCDEFGHIJKLMNOP",
    "xoxb-1234567890",
  ]) {
    assert.ok(!text.includes(leaked), `leaked ${leaked}`);
  }
  assert.ok(
    text.includes("DB_PASSWORD=[REDACTED:secret.assignment@1]"),
    "the name is kept, the value is not",
  );
  const rules = s.content.redactions.map((r) => r.rule);
  assert.deepEqual(rules, [...rules].sort(), "redactions are listed in a stable order");
  for (const r of [
    "secret.anthropic-key@1",
    "secret.github-token@1",
    "secret.url-credentials@1",
    "secret.aws-access-key@1",
    "secret.bearer@1",
  ]) {
    assert.ok(rules.includes(r), `${r} applied`);
  }
  assert.deepEqual(
    RUN_FAILURE_V1.redactionRules,
    REDACTION_RULES_V1.map((r) => r.id),
  );

  // A secret straddling a cap is redacted whole before the cut, never half-kept.
  const shaper = new BodyShaper(REDACTION_RULES_V1);
  const cut = shaper.text("/x", `${"a".repeat(10)} sk-ant-abcdefghijklmnop`, 20);
  assert.ok(!cut.includes("sk-ant-abc"));
});

test("an unavailable source is a refusal, never an empty body that hashes like a real one", async () => {
  const mem = memorySources({ runs: [] });
  const p = ref(false);
  const missing = await buildSnapshot(
    runFailureBuilder,
    p.ref,
    p.def,
    { kind: "run", runId: "nope" },
    mem.sources,
  );
  assert.deepEqual([missing.ok, !missing.ok && missing.reason], [false, "source-unavailable"]);
  const noTranscript = await build(failedRun(), null);
  assert.deepEqual(
    [noTranscript.ok, !noTranscript.ok && noTranscript.reason],
    [false, "source-unavailable"],
  );
  const running = await build(failedRun({ status: "running", endedAt: null }));
  assert.equal(running.ok, false);
  const wrong = await buildSnapshot(
    runFailureBuilder,
    p.ref,
    p.def,
    { kind: "phase-attempt", instanceId: "i", phaseId: "p", attempt: 0 },
    mem.sources,
  );
  assert.deepEqual([wrong.ok, !wrong.ok && wrong.reason], [false, "subject-mismatch"]);
});

test("sealing refuses non-canonical content and content over the ceiling instead of coercing it", () => {
  const p = ref(false);
  const base = {
    subject: { kind: "run" as const, runId: "r" },
    refs: { runs: [], claims: [], verifications: [], artifacts: [] },
    subjectAuthored: [],
    redactions: [],
    truncations: [],
  };
  const nan = sealSnapshot(p.ref, p.def, { ...base, body: { x: Number.NaN } });
  assert.deepEqual([nan.ok, !nan.ok && nan.reason], [false, "not-canonical"]);
  const undef = sealSnapshot(p.ref, p.def, { ...base, body: { x: undefined } });
  assert.deepEqual([undef.ok, !undef.ok && undef.reason], [false, "not-canonical"]);
  const big = sealSnapshot(p.ref, { ...p.def, maxBytes: 100 }, { ...base, body: "x".repeat(200) });
  assert.deepEqual([big.ok, !big.ok && big.reason], [false, "too-large"]);
  const ok = sealSnapshot(p.ref, p.def, { ...base, body: { x: 1 } });
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.equal(ok.snapshot.bytes, Buffer.byteLength(canonicalJson(ok.snapshot.content)));
    assert.deepEqual(ok.snapshot.content.projection, p.ref);
  }
});
