import { test } from "node:test";
import assert from "node:assert/strict";
import { builtinRegistry, TERMINATION_PROBE_V2 } from "./definitions.js";
import { canonicalJson } from "./canonical.js";
import { buildSnapshot } from "./projection.js";
import { RUN_FAILURE_BLIND_V2, runFailureBlindV2Builder } from "./projections/runFailure.js";
import { renderDecisionPrompt } from "./providers/claudeCli.js";
import { observeTermination, terminationObservations } from "./observations.js";
import { H2_QUESTIONS } from "./h2/sampling.js";
import { assistant, failedRun, memorySources, toolResult } from "./testSupport.js";
import type { Run } from "@argus/contracts";

const trace = () => [
  assistant(1000, [
    { type: "tool_use", id: "t1", name: "Bash", input: { command: "cat input.txt" } },
  ]),
  toolResult(2000, "t1", "Permission denied", true),
  assistant(3000, [{ type: "text", text: "The requested operation was unavailable." }]),
];
async function snapshot(run: Run, lines = trace()) {
  const registry = builtinRegistry();
  const projection = registry.projection("run-failure.blind", 2)!;
  const sources = memorySources({ runs: [run], transcripts: { [run.id]: lines } }).sources;
  const built = await buildSnapshot(
    runFailureBlindV2Builder,
    projection.ref,
    projection.def,
    { kind: "run", runId: run.id },
    sources,
  );
  assert.ok(built.ok, JSON.stringify(built));
  return built.snapshot;
}

test("V2 separates observed process endings from tool denial and preserves immutable V1/default collection", () => {
  const registry = builtinRegistry();
  assert.deepEqual(
    TERMINATION_PROBE_V2.answers.shape === "choice" &&
      TERMINATION_PROBE_V2.answers.options.map((o) => o.id),
    ["deadline", "never-ran", "ended-normally"],
  );
  assert.deepEqual(TERMINATION_PROBE_V2.consumers, []);
  assert.deepEqual(TERMINATION_PROBE_V2.projection, { id: "run-failure.blind", version: 2 });
  assert.equal(
    registry.question("run.termination-probe", 1)!.ref.digest,
    "4e22c0439828b768eca5543c17527c26981bc4993774b2b7906c20bca7f5f5f9",
  );
  assert.equal(
    registry.projection("run-failure.blind", 1)!.ref.digest,
    "cd6292c099f7162632dc43cc2d2caee31b117f3750369172cffb0e9109eaab80",
  );
  assert.equal(H2_QUESTIONS.probe.version, 1);
  assert.equal(RUN_FAILURE_BLIND_V2.version, 2);
});

test("denied tool and failed task do not replace a normally completed process observation", async () => {
  const run = failedRun({
    status: "succeeded",
    outcome: "blocked",
    termination: "exited",
    exitCode: 0,
  });
  const before = structuredClone(run);
  const retained = await snapshot(run);
  assert.deepEqual(observeTermination(run), { ok: true, value: "ended-normally" });
  assert.equal(terminationObservations([run])[0].value, "ended-normally");
  assert.ok(canonicalJson(retained.content.body).includes("Permission denied"));
  assert.deepEqual(run, before);
});

test("V2 exact rendered input omits fixture hints and stays identical across withheld outcome and metadata", async () => {
  const hints = {
    id: "case-D1-deadline",
    scheduleId: "deadline-case-D1",
    scheduleName: "D1 expected deadline",
    prompt: "CASE_D1_EXPECTED_DEADLINE",
    resultSummary: "EXPECTED_CLASS_deadline",
    model: "model-label-hint",
    runtime: "claude" as const,
    trigger: "scheduled" as const,
    durationMs: 73000,
    error: "EXPECTED_ERROR_deadline",
    termination: "timed-out" as const,
  };
  const first = await snapshot(failedRun(hints));
  const second = await snapshot(
    failedRun({
      ...hints,
      id: "case-N1-normal",
      scheduleName: "N1 normal",
      prompt: "CASE_N1_EXPECTED_NORMAL",
      resultSummary: "normal",
      model: "different-model",
      durationMs: 1000,
      status: "succeeded",
      outcome: "succeeded",
      error: null,
      exitCode: 0,
      termination: "exited",
    }),
  );
  const rendered = renderDecisionPrompt(TERMINATION_PROBE_V2, first);
  assert.equal(rendered, renderDecisionPrompt(TERMINATION_PROBE_V2, second));
  for (const hint of [
    hints.id,
    hints.scheduleId,
    hints.scheduleName,
    hints.prompt,
    hints.resultSummary,
    hints.model,
    hints.error,
    "73000",
  ])
    assert.ok(!rendered.includes(hint), `leaked ${hint}`);
  const body = first.content.body as Record<string, unknown>;
  assert.deepEqual(Object.keys(body), ["timeline"]);
  assert.deepEqual(first.content.subjectAuthored, ["/timeline/events"]);
  assert.notEqual(
    first.sha256,
    second.sha256,
    "retained source identities stay distinct outside elicitation",
  );
  assert.equal(first.sha256, (await snapshot(failedRun(hints))).sha256);
});

test("V2 retains transcript-authored label hints as auditable evidence instead of claiming automatic blinding", async () => {
  const retained = await snapshot(failedRun(), [
    assistant(1000, [{ type: "text", text: "CASE_D1_EXPECTED_DEADLINE" }]),
  ]);
  assert.ok(
    renderDecisionPrompt(TERMINATION_PROBE_V2, retained).includes("CASE_D1_EXPECTED_DEADLINE"),
  );
  assert.deepEqual(retained.content.subjectAuthored, ["/timeline/events"]);
});
