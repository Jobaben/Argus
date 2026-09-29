import { test } from "node:test";
import assert from "node:assert/strict";
import { knowledgeCommitReasons, stagedKnowledgeReasons } from "./gatePolicy.js";
import {
  PipelineValidationError,
  validatePipelineInput,
  validatePipelinePatch,
} from "./pipelines.js";
import type { PhaseDef, PhaseProgress } from "./pipelineTypes.js";

const RUBRIC = { goal: "g", criteria: [{ id: "q", label: "Quality" }] };
const cwd = process.cwd();

const phase = (extra: Record<string, unknown>) => ({
  id: "p1",
  name: "P1",
  cwd,
  gated: true,
  steps: [{ name: "s", prompt: "x" }],
  rubric: RUBRIC,
  autoApprove: { verdict: 7 },
  ...extra,
});

const pipelineWith = (extra: Record<string, unknown>) => ({ name: "p", phases: [phase(extra)] });

test("MANDATORY REGRESSION: autoApprove on a knowledge-committing phase is refused when saved", () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    [
      "change intent",
      { changeIntent: { request: { summary: "s", description: "d" } } },
      /change-intent/,
    ],
    ["rule verification", { ruleVerification: {} }, /rule-verification/],
    ["discovery", { discovery: { scope: { paths: ["src"] } } }, /discovery/],
    ["a required delta", { knowledgeDelta: "required" }, /knowledge-delta-required/],
  ];
  for (const [label, extra, reason] of cases) {
    assert.throws(
      () => validatePipelineInput(pipelineWith(extra)),
      (e: unknown) =>
        e instanceof PipelineValidationError &&
        reason.test(e.message) &&
        /A person must approve this gate\. Remove autoApprove/.test(e.message),
      label,
    );
  }
});

test("the same refusal holds on PATCH, which re-validates every phase it replaces", () => {
  assert.throws(
    () => validatePipelinePatch({ phases: [phase({ ruleVerification: {} })] }),
    /autoApprove cannot open a gate that commits knowledge \(rule-verification\)/,
  );
});

test("a knowledge phase keeps its rubric; only autoApprove is refused", () => {
  const out = validatePipelineInput(pipelineWith({ ruleVerification: {}, autoApprove: undefined }));
  assert.deepEqual(out.phases[0].rubric?.goal, "g");
  assert.equal(out.phases[0].autoApprove, undefined);
});

test("unchanged: autoApprove on an ordinary gated phase is still accepted", () => {
  const out = validatePipelineInput(pipelineWith({}));
  assert.deepEqual(out.phases[0].autoApprove, { verdict: 7 });
  const optional = validatePipelineInput(pipelineWith({ knowledgeDelta: "optional" }));
  assert.deepEqual(
    optional.phases[0].autoApprove,
    { verdict: 7 },
    "optional delta: checked at runtime",
  );
});

test("knowledgeCommitReasons covers every phase kind whose acceptance writes the ledger", () => {
  const base = { id: "x", name: "x", cwd, steps: [], gated: true } as unknown as PhaseDef;
  const reasons = (extra: Partial<PhaseDef>) =>
    knowledgeCommitReasons({ ...base, ...extra } as PhaseDef);
  assert.deepEqual(reasons({}), []);
  assert.deepEqual(reasons({ knowledgeDelta: "optional" }), []);
  assert.deepEqual(reasons({ discovery: {} as PhaseDef["discovery"] }), ["discovery"]);
  assert.deepEqual(reasons({ ruleVerification: {} }), ["rule-verification"]);
  assert.deepEqual(reasons({ changeIntent: {} }), ["change-intent"]);
  assert.deepEqual(reasons({ acceptanceVerification: {} as PhaseDef["acceptanceVerification"] }), [
    "acceptance-verification",
  ]);
  assert.deepEqual(reasons({ implementation: {} as PhaseDef["implementation"] }), [
    "implementation",
  ]);
  assert.deepEqual(reasons({ knowledgeDelta: "required" }), ["knowledge-delta-required"]);
});

test("stagedKnowledgeReasons reads Argus's staging records, and ignores what can never commit", () => {
  const p = (steps: unknown[], extra: Partial<PhaseProgress> = {}) =>
    ({
      id: "x",
      name: "x",
      gated: true,
      status: "awaiting-approval",
      attempt: 0,
      payload: null,
      steps,
      ...extra,
    }) as PhaseProgress;
  assert.deepEqual(stagedKnowledgeReasons(p([{ name: "s", runId: "r", status: "succeeded" }])), []);
  assert.deepEqual(
    stagedKnowledgeReasons(
      p([
        {
          name: "s",
          runId: "r",
          status: "succeeded",
          knowledgeDelta: { id: "d", status: "staged" },
        },
      ]),
    ),
    ["staged-knowledge-delta"],
  );
  assert.deepEqual(
    stagedKnowledgeReasons(
      p([
        {
          name: "s",
          runId: "r",
          status: "succeeded",
          knowledgeDelta: { id: "d", status: "rejected" },
        },
        {
          name: "t",
          runId: "q",
          status: "succeeded",
          ruleVerification: { id: "v", status: "superseded" },
        },
      ]),
    ),
    [],
    "a rejected or superseded sidecar can never commit",
  );
  assert.deepEqual(
    stagedKnowledgeReasons(
      p([], { realization: { id: "R", proposalId: "CP", attempt: 1 } } as Partial<PhaseProgress>),
    ),
    ["realization-attempt"],
  );
});
