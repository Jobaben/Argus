import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DagValidationError,
  DEFAULT_PLACEHOLDER_BYTES,
  capPlaceholder,
  currentIndex,
  instanceOutcome,
  interpolate,
  isExplicitDag,
  layers,
  livePhases,
  previousPayloadFor,
  readyPhases,
  resolveNeeds,
  topoOrder,
  utf8SlicePrefix,
  utf8SliceSuffix,
  validateDag,
} from "./dag.js";
import type {
  Dependency,
  PhaseDef,
  PhaseStatus,
  PipelineDefinition,
  PipelineInstance,
} from "./pipelineTypes.js";

const phase = (id: string, needs?: Dependency[]): PhaseDef => ({
  id,
  name: id,
  cwd: "/tmp",
  steps: [{ name: "s", prompt: "p" }],
  gated: false,
  ...(needs === undefined ? {} : { needs }),
});

function def(phases: PhaseDef[]): PipelineDefinition {
  return {
    id: "p1",
    name: "Pipeline",
    phases,
    trigger: null,
    enabled: true,
    overlapPolicy: "skip",
    lastStartedAt: null,
    createdAt: "2026-07-20T12:00:00.000Z",
    updatedAt: "2026-07-20T12:00:00.000Z",
  };
}

function instance(phases: PhaseDef[], statuses: Record<string, PhaseStatus>): PipelineInstance {
  return {
    id: "i1",
    pipelineId: "p1",
    pipelineName: "Pipeline",
    status: "running",
    currentPhaseIndex: 0,
    phases: phases.map((p) => ({
      id: p.id,
      name: p.name,
      gated: p.gated,
      status: statuses[p.id] ?? "pending",
      steps: [],
      attempt: 0,
      payload: null,
    })),
    trigger: "manual",
    signalToken: "t",
    createdAt: "2026-07-20T12:00:00.000Z",
    updatedAt: "2026-07-20T12:00:00.000Z",
    endedAt: null,
  };
}

// ── The degenerate case ─────────────────────────────────────────────────────

test("regression: a definition with no `needs` is linear — every pre-Weave pipeline still works", () => {
  const phases = [phase("a"), phase("b"), phase("c")];
  assert.equal(isExplicitDag(phases), false);
  assert.deepEqual(
    [...resolveNeeds(phases)],
    [
      ["a", []],
      ["b", ["a"]],
      ["c", ["b"]],
    ],
  );
});

test("regression: one declared `needs` makes the whole graph explicit, not half-implicit", () => {
  // A mixed reading would make the same definition mean two different things
  // depending on which phase you looked at.
  const phases = [phase("a"), phase("b"), phase("c", ["a"])];
  assert.equal(isExplicitDag(phases), true);
  const needs = resolveNeeds(phases);
  assert.deepEqual(needs.get("b"), [], "b does not silently inherit a");
  assert.deepEqual(needs.get("c"), ["a"]);
});

test("conditional dependency objects retain their source phase in the DAG", () => {
  const phases = [
    phase("evaluate"),
    phase("publish", [
      {
        phase: "evaluate",
        when: { predicate: { path: ["accepted"], operator: "equals", value: true } },
      },
    ]),
  ];

  assert.deepEqual(resolveNeeds(phases).get("publish"), ["evaluate"]);
});

// ── Validation ──────────────────────────────────────────────────────────────

test("a valid graph passes; a cycle names the phases in it", () => {
  validateDag([phase("a"), phase("b", ["a"]), phase("c", ["a"]), phase("d", ["b", "c"])]);
  assert.throws(() => validateDag([phase("a", ["b"]), phase("b", ["a"])]), /cycle: a, b/);
  assert.throws(() => validateDag([phase("a", ["a"])]), /cannot depend on itself/);
});

test("a dependency that does not exist is named, not silently dropped", () => {
  assert.throws(() => validateDag([phase("a"), phase("b", ["nope"])]), /needs "nope"/);
});

test("duplicate ids and duplicate edges are rejected", () => {
  assert.throws(() => validateDag([phase("a"), phase("a")]), /duplicate phase id/);
  assert.throws(() => validateDag([phase("a"), phase("b", ["a", "a"])]), /twice/);
});

test("a graph where nothing can start is rejected up front", () => {
  // Every phase waiting on another is a pipeline that begins and never begins.
  assert.throws(
    () => validateDag([phase("a", ["b"]), phase("b", ["c"]), phase("c", ["a"])]),
    DagValidationError,
  );
});

test("an empty phase list validates — emptiness is the pipeline validator's business", () => {
  validateDag([]);
});

// ── Shape ───────────────────────────────────────────────────────────────────

test("topoOrder respects dependencies and breaks ties by declaration order", () => {
  const phases = [phase("d", ["b", "c"]), phase("b", ["a"]), phase("c", ["a"]), phase("a")];
  assert.deepEqual(
    topoOrder(phases).map((p) => p.id),
    ["a", "b", "c", "d"],
  );
});

test("layers group the phases that can run at the same time", () => {
  const phases = [phase("a"), phase("b", ["a"]), phase("c", ["a"]), phase("d", ["b", "c"])];
  assert.deepEqual(layers(phases), [["a"], ["b", "c"], ["d"]]);
});

test("a linear pipeline is one phase per layer", () => {
  assert.deepEqual(layers([phase("a"), phase("b"), phase("c")]), [["a"], ["b"], ["c"]]);
});

// ── Readiness ───────────────────────────────────────────────────────────────

test("only the roots are ready at the start, and a fan-out starts both branches", () => {
  const phases = [phase("a"), phase("b", ["a"]), phase("c", ["a"]), phase("d", ["b", "c"])];
  assert.deepEqual(readyPhases(def(phases), instance(phases, {})), [0]);
  assert.deepEqual(
    readyPhases(def(phases), instance(phases, { a: "succeeded" })),
    [1, 2],
    "both branches of the fan-out",
  );
});

test("regression: a fan-in waits for every dependency, not just the first", () => {
  // This is the case a cursor cannot express, and the reason readiness is
  // computed from statuses instead of an index.
  const phases = [phase("a"), phase("b", ["a"]), phase("c", ["a"]), phase("d", ["b", "c"])];
  const half = instance(phases, { a: "succeeded", b: "succeeded", c: "running" });
  assert.deepEqual(readyPhases(def(phases), half), [], "d must not start on b alone");

  const both = instance(phases, { a: "succeeded", b: "succeeded", c: "succeeded" });
  assert.deepEqual(readyPhases(def(phases), both), [3]);
});

test("a failed dependency never makes its dependents ready", () => {
  const phases = [phase("a"), phase("b", ["a"])];
  assert.deepEqual(readyPhases(def(phases), instance(phases, { a: "failed" })), []);
  assert.deepEqual(readyPhases(def(phases), instance(phases, { a: "aborted" })), []);
});

test("a phase awaiting approval blocks its dependents until it actually succeeds", () => {
  const phases = [phase("a"), phase("b", ["a"])];
  assert.deepEqual(readyPhases(def(phases), instance(phases, { a: "awaiting-approval" })), []);
});

test("livePhases reports what is executing or waiting on a human", () => {
  const phases = [phase("a"), phase("b", ["a"]), phase("c", ["a"])];
  const inst = instance(phases, { a: "succeeded", b: "running", c: "awaiting-approval" });
  assert.deepEqual(livePhases(inst), [1, 2]);
});

// ── Outcome ─────────────────────────────────────────────────────────────────

test("an instance is done only when every phase succeeded", () => {
  const phases = [phase("a"), phase("b", ["a"])];
  assert.equal(instanceOutcome(def(phases), instance(phases, { a: "succeeded" })), "running");
  assert.equal(
    instanceOutcome(def(phases), instance(phases, { a: "succeeded", b: "succeeded" })),
    "succeeded",
  );
});

test("regression: a pipeline that skipped half its work reports blocked, not succeeded", () => {
  // Nothing running, nothing ready, phases left: a cursor executor would either
  // hang or claim success. Neither is true.
  const phases = [phase("a"), phase("b", ["a"]), phase("c")];
  const stuck = instance(phases, { a: "failed", c: "succeeded" });
  assert.equal(instanceOutcome(def(phases), stuck), "blocked");
});

test("regression: an all-terminal graph containing a failed phase is not succeeded", () => {
  const one = [phase("a")];
  assert.equal(instanceOutcome(def(one), instance(one, { a: "failed" })), "blocked");

  const parallel = [phase("a"), phase("b")];
  assert.equal(
    instanceOutcome(def(parallel), instance(parallel, { a: "failed", b: "succeeded" })),
    "blocked",
  );
});

test("currentPhaseIndex prefers the gate a human has to act on", () => {
  const phases = [phase("a"), phase("b", ["a"]), phase("c", ["a"])];
  assert.equal(
    currentIndex(instance(phases, { a: "succeeded", b: "running", c: "awaiting-approval" })),
    2,
  );
  assert.equal(currentIndex(instance(phases, { a: "succeeded", b: "running" })), 1);
  assert.equal(currentIndex(instance(phases, { a: "failed" })), 0);
  assert.equal(
    currentIndex(instance(phases, { a: "succeeded", b: "succeeded", c: "succeeded" })),
    2,
  );
  assert.equal(currentIndex(instance(phases, {})), 0);
});

// ── Artifacts ───────────────────────────────────────────────────────────────

test("the pre-Weave template still works, and artifacts interpolate by name", () => {
  assert.equal(interpolate("say {{previous.payload}}", "hello").prompt, "say hello");
  assert.equal(
    interpolate("use {{artifacts.plan}} and {{artifacts.review}}", null, {
      plan: "the plan",
      review: { ok: true },
    }).prompt,
    'use the plan and {"ok":true}',
  );
});

test("regression: an unknown artifact becomes empty, never a literal template marker", () => {
  // A `{{artifacts.foo}}` reaching the model is worse than a gap: the model
  // tries to make sense of it.
  assert.equal(interpolate("x {{artifacts.missing}} y", null, {}).prompt, "x  y");
  assert.equal(interpolate("x {{previous.payload}} y", null).prompt, "x  y");
});

test("previousPayloadFor picks a phase's dependency, and is stable with several", () => {
  const phases = [phase("a"), phase("b", ["a"]), phase("c", ["a"]), phase("d", ["b", "c"])];
  const inst = instance(phases, {});
  inst.phases[0].payload = "from a";
  inst.phases[1].payload = "from b";
  inst.phases[2].payload = "from c";

  assert.equal(previousPayloadFor(def(phases), inst, "b"), "from a");
  // With two dependencies there is no single "previous"; the last in
  // declaration order is the only stable answer, which is why such phases
  // should name artifacts instead.
  assert.equal(previousPayloadFor(def(phases), inst, "d"), "from c");
  assert.equal(previousPayloadFor(def(phases), inst, "a"), null, "a root has no previous");
});

// ── Bounded interpolation (context discipline) ───────────────────────────────

test("utf8SlicePrefix/utf8SliceSuffix never split a multi-byte character", () => {
  // "é" is 2 bytes in UTF-8 (0xC3 0xA9); a naive byte slice at an odd offset
  // would cut it in half and produce invalid UTF-8 (or a replacement char).
  const s = "é".repeat(10); // 20 bytes
  for (let n = 0; n <= 21; n++) {
    const prefix = utf8SlicePrefix(s, n);
    const suffix = utf8SliceSuffix(s, n);
    assert.ok(Buffer.byteLength(prefix, "utf8") <= n);
    assert.ok(Buffer.byteLength(suffix, "utf8") <= n);
    // Every character kept is a whole "é", never a stray byte.
    assert.ok([...prefix].every((c) => c === "é"));
    assert.ok([...suffix].every((c) => c === "é"));
  }
  assert.equal(utf8SlicePrefix(s, 1000), s);
  assert.equal(utf8SliceSuffix(s, 1000), s);
  assert.equal(utf8SlicePrefix(s, 0), "");
  assert.equal(utf8SliceSuffix(s, 0), "");
});

test("capPlaceholder leaves a value under the cap untouched", () => {
  const { text, trimmed } = capPlaceholder("previous.payload", "short value", 100, "/tmp/x.txt");
  assert.equal(text, "short value");
  assert.equal(trimmed, false);
});

test("capPlaceholder over the cap keeps head 2/3 + tail 1/3 with a marker naming the full path", () => {
  const value = "H".repeat(200) + "T".repeat(100);
  const { text, trimmed } = capPlaceholder(
    "artifacts.plan",
    value,
    90,
    "/inv/context/artifacts.plan.txt",
  );
  assert.equal(trimmed, true);
  assert.ok(text.startsWith("H".repeat(60)), "keeps roughly the first 2/3 of the budget");
  assert.ok(text.endsWith("T".repeat(30)), "keeps roughly the last 1/3 of the budget");
  assert.match(
    text,
    /\[… Argus trimmed \d+ bytes of \{\{artifacts\.plan\}\} — the full value is at \/inv\/context\/artifacts\.plan\.txt …\]/,
  );
});

test("capPlaceholder is UTF-8 safe: trimming never splits a multi-byte character", () => {
  const value = "é".repeat(50) + "x".repeat(50);
  const { text } = capPlaceholder("memory", value, 40, "/x.txt");
  // The whole trimmed prompt must still be valid UTF-8 text with no stray
  // replacement characters or half-characters.
  assert.ok(!text.includes("�"));
});

test("interpolate caps {{previous.payload}} and {{artifacts.<name>}} by default at 16 KiB", () => {
  const big = "z".repeat(DEFAULT_PLACEHOLDER_BYTES + 1000);
  const { prompt, contextFiles } = interpolate(
    "payload: {{previous.payload}}",
    big,
    {},
    undefined,
    {
      contextDir: "/inv",
    },
  );
  assert.ok(prompt.length < big.length + 200, "the rendered prompt is capped, not the raw value");
  assert.match(prompt, /Argus trimmed \d+ bytes of \{\{previous\.payload\}\}/);
  assert.equal(contextFiles.length, 1);
  assert.equal(contextFiles[0].path, "/inv/context/previous.payload.txt");
  assert.equal(
    contextFiles[0].contents,
    big,
    "the full, untrimmed value is described for the engine to write",
  );
});

test("interpolate respects a pipeline's own placeholderBytes override", () => {
  const value = "a".repeat(500);
  const capped = interpolate("{{artifacts.x}}", null, { x: value }, undefined, {
    maxPlaceholderBytes: 100,
    contextDir: "/inv",
  });
  assert.notEqual(capped.prompt, value);
  const uncapped = interpolate("{{artifacts.x}}", null, { x: value }, undefined, {
    maxPlaceholderBytes: 1000,
  });
  assert.equal(uncapped.prompt, value);
});

test("interpolate: no contextDir means no context files are produced, even when trimming happens", () => {
  const big = "q".repeat(DEFAULT_PLACEHOLDER_BYTES + 10);
  const { prompt, contextFiles } = interpolate("{{previous.payload}}", big);
  assert.equal(contextFiles.length, 0);
  assert.match(prompt, /Argus trimmed/);
});

test("interpolate: {{trigger.payload}} renders the instance's firing payload, JSON-stringified", () => {
  assert.equal(
    interpolate("fired with {{trigger.payload}}", null, {}, undefined, {
      triggerPayload: { a: 1 },
    }).prompt,
    'fired with {"a":1}',
  );
  // Absent trigger payload interpolates to empty, same as any other unknown.
  assert.equal(interpolate("x {{trigger.payload}} y", null).prompt, "x  y");
});

test("interpolate: {{memory}} and {{previous.instance}} render whatever the engine looked up", () => {
  assert.equal(
    interpolate("Notes: {{memory}}", null, {}, undefined, { memory: "remember X" }).prompt,
    "Notes: remember X",
  );
  assert.equal(interpolate("Notes: {{memory}}", null).prompt, "Notes: ");
  assert.equal(
    interpolate("Last time: {{previous.instance}}", null, {}, undefined, {
      previousInstanceSummary: "Previous run failed.",
    }).prompt,
    "Last time: Previous run failed.",
  );
  assert.equal(interpolate("Last time: {{previous.instance}}", null).prompt, "Last time: ");
});

test("interpolate: artifactDir placeholders are never capped, however long the path", () => {
  const longPath = "/very/".repeat(5000) + "artifacts";
  const { prompt, contextFiles } = interpolate(
    "{{artifactDir}} and {{artifactDir.other}}",
    null,
    {},
    { own: longPath, byPhase: { other: longPath } },
  );
  assert.equal(prompt, `${longPath} and ${longPath}`);
  assert.equal(contextFiles.length, 0);
});
