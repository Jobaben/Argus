import { test } from "node:test";
import assert from "node:assert/strict";
import {
  approvalConditionEligibility,
  conditionFailureReason,
  conditionOutcome,
  knowledgeCommitReasons,
  stagedKnowledgeReasons,
} from "./gatePolicy.js";
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

// ── approveWhen (DL-A3) ──────────────────────────────────────────────────────

const WHEN = { kind: "command", run: "node merged.js", everySeconds: 60 };
/** A gated phase with an approval condition and no autoApprove. */
const whenPhase = (extra: Record<string, unknown>) =>
  phase({ rubric: undefined, autoApprove: undefined, approveWhen: WHEN, ...extra });
const pipelineWhen = (extra: Record<string, unknown>) => ({
  name: "p",
  phases: [whenPhase(extra)],
});

test("approveWhen on a knowledge-committing phase is refused when saved", () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    [
      "change intent",
      { changeIntent: { request: { summary: "s", description: "d" } } },
      /change-intent/,
    ],
    ["rule verification", { ruleVerification: {} }, /rule-verification/],
    ["discovery", { discovery: { scope: { paths: ["src"] } } }, /discovery/],
    ["a required delta", { knowledgeDelta: "required" }, /knowledge-delta-required/],
    [
      "implementation",
      { changeContext: { fromPhase: "intent" }, implementation: {} },
      /implementation/,
    ],
  ];
  for (const [label, extra, reason] of cases) {
    assert.throws(
      () => validatePipelineInput(pipelineWhen(extra)),
      (e: unknown) =>
        e instanceof PipelineValidationError &&
        /approveWhen cannot open a gate that commits knowledge \(/.test(e.message) &&
        reason.test(e.message) &&
        /Remove approveWhen from this phase/.test(e.message),
      label,
    );
  }
});

test("approveWhen: the same refusal holds on PATCH", () => {
  assert.throws(
    () => validatePipelinePatch({ phases: [whenPhase({ ruleVerification: {} })] }),
    /approveWhen cannot open a gate that commits knowledge \(rule-verification\)/,
  );
});

test("approveWhen is refused on an ungated phase", () => {
  assert.throws(
    () => validatePipelineInput(pipelineWhen({ gated: false })),
    /approveWhen only means something on a gated phase/,
  );
});

test("approveWhen is accepted on an ordinary gated phase, beside autoApprove, and with an optional delta", () => {
  assert.deepEqual(validatePipelineInput(pipelineWhen({})).phases[0].approveWhen, WHEN);
  const both = validatePipelineInput(pipelineWhen({ rubric: RUBRIC, autoApprove: { verdict: 7 } }))
    .phases[0];
  assert.deepEqual(both.approveWhen, WHEN, "approveWhen beside autoApprove");
  assert.deepEqual(both.autoApprove, { verdict: 7 }, "autoApprove beside approveWhen");
  assert.deepEqual(
    validatePipelineInput(pipelineWhen({ knowledgeDelta: "optional" })).phases[0].approveWhen,
    WHEN,
    "optional delta: checked at runtime",
  );
});

const progress = (extra: Partial<PhaseProgress> = {}) =>
  ({
    id: "p1",
    name: "P1",
    gated: true,
    status: "awaiting-approval",
    pause: "gate",
    attempt: 0,
    payload: null,
    steps: [{ name: "s", runId: "r", status: "succeeded" }],
    ...extra,
  }) as PhaseProgress;
const whenDef = (extra: Partial<PhaseDef> = {}) =>
  ({
    id: "p1",
    name: "P1",
    cwd,
    gated: true,
    steps: [{ name: "s", prompt: "x" }],
    approveWhen: WHEN,
    ...extra,
  }) as PhaseDef;

test("approvalConditionEligibility: only a known gate pause of a phase that declares approveWhen and commits nothing", () => {
  assert.deepEqual(approvalConditionEligibility(progress(), whenDef()), {
    ok: true,
    condition: WHEN,
  });
  assert.deepEqual(
    approvalConditionEligibility(progress({ status: "running" }), whenDef()),
    { ok: false, cause: "pause" },
    "not waiting",
  );
  assert.deepEqual(
    approvalConditionEligibility(progress({ pause: "needs-input" }), whenDef()),
    { ok: false, cause: "pause" },
    "a question for a person",
  );
  assert.deepEqual(
    approvalConditionEligibility(progress({ pause: undefined }), whenDef()),
    { ok: false, cause: "pause" },
    "a pause of unknown cause",
  );
  assert.deepEqual(
    approvalConditionEligibility(progress(), whenDef({ approveWhen: undefined })),
    { ok: false, cause: "not-configured" },
    "no approveWhen",
  );
  assert.deepEqual(
    approvalConditionEligibility(progress(), undefined),
    { ok: false, cause: "not-configured" },
    "no phase definition",
  );
  assert.deepEqual(
    approvalConditionEligibility(progress(), whenDef({ ruleVerification: {} })),
    { ok: false, cause: "knowledge", reasons: ["rule-verification"] },
    "knowledge by configuration",
  );
  assert.deepEqual(
    approvalConditionEligibility(
      progress({
        steps: [
          {
            name: "s",
            runId: "r",
            status: "succeeded",
            knowledgeDelta: { status: "staged" },
          },
        ] as PhaseProgress["steps"],
      }),
      whenDef(),
    ),
    { ok: false, cause: "knowledge", reasons: ["staged-knowledge-delta"] },
    "knowledge the attempt staged",
  );
});

test("conditionOutcome: only a command that exited on its own speaks", () => {
  const cond = { failOnExit: 3 };
  assert.deepEqual(conditionOutcome(cond, { end: "exit", exitCode: 0 }), { kind: "approve" });
  assert.deepEqual(conditionOutcome(cond, { end: "exit", exitCode: 3 }), {
    kind: "fail",
    exitCode: 3,
  });
  assert.deepEqual(conditionOutcome(cond, { end: "exit", exitCode: 1 }), { kind: "wait" });
  assert.deepEqual(
    conditionOutcome({}, { end: "exit", exitCode: 3 }),
    { kind: "wait" },
    "no failOnExit: every non-zero exit waits",
  );
  assert.deepEqual(
    conditionOutcome(cond, { end: "timeout", exitCode: 3 }),
    { kind: "wait" },
    "a timed-out command that trapped SIGTERM and exited 3 never fails the phase",
  );
  for (const end of ["signal", "error", "aborted"] as const) {
    assert.deepEqual(conditionOutcome(cond, { end, exitCode: 0 }), { kind: "wait" }, end);
  }
  assert.deepEqual(conditionOutcome(cond, { end: "exit", exitCode: null }), { kind: "wait" });
});

test("conditionFailureReason: the label, the exit and the last line printed, bounded", () => {
  assert.equal(
    conditionFailureReason("pr merged", 3, "checking\nPR 12 was abandoned\n\n"),
    'approval condition "pr merged" exited 3: PR 12 was abandoned',
  );
  assert.equal(
    conditionFailureReason("pr merged", 3, ""),
    'approval condition "pr merged" exited 3',
  );
  const long = conditionFailureReason("c", 3, `first\r\n${"y".repeat(400)}`);
  assert.equal(long, `approval condition "c" exited 3: …${"y".repeat(299)}`);
});
