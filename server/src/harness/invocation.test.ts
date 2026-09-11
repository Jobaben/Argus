import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareInvocation, resolveCapabilities, resolveTimeoutSeconds } from "./invocation.js";
import type { InvocationInputs } from "./invocation.js";
import type { Run } from "../sources/scheduleTypes.js";
import type { PhaseDef, PhaseStep, PipelineDefinition } from "../sources/pipelineTypes.js";

function makeRun(over: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    scheduleId: "pipeline:p1",
    scheduleName: "P1 · Only",
    prompt: "do the work",
    cwd: "/repo",
    status: "running",
    trigger: "scheduled",
    queuedAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
    durationMs: null,
    pid: null,
    exitCode: null,
    sessionId: "sess-1",
    runtime: "claude",
    project: null,
    resultSummary: null,
    error: null,
    instanceId: "inst-1",
    phaseId: "only",
    deadlineAt: null,
    ...over,
  };
}

function makeDef(over: Partial<PipelineDefinition> = {}): PipelineDefinition {
  return {
    id: "p1",
    name: "P1",
    phases: [],
    trigger: null,
    enabled: true,
    overlapPolicy: "skip",
    lastStartedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function makePhase(over: Partial<PhaseDef> = {}): PhaseDef {
  return {
    id: "only",
    name: "Only",
    cwd: "/repo",
    steps: [],
    gated: false,
    ...over,
  };
}

function makeStep(over: Partial<PhaseStep> = {}): PhaseStep {
  return { name: "s", prompt: "p", ...over };
}

function baseInputs(over: Partial<InvocationInputs> = {}): InvocationInputs {
  return {
    run: makeRun(),
    def: makeDef(),
    phaseDef: makePhase(),
    stepDef: makeStep(),
    instanceId: "inst-1",
    attempt: 0,
    systemPrompt: "SYSTEM PROMPT",
    argusEnv: { ARGUS_SIGNAL_TOKEN: "tok", ARGUS_ARTIFACT_DIR: "/art" },
    invocationDir: "/inv",
    artifactDir: "/art",
    resultFile: null,
    timeoutSeconds: null,
    gitHead: null,
    parentEnv: { PATH: "/bin", HOME: "/h", ARGUS_TOKEN: "secret", MY_SECRET: "x" },
    now: new Date("2026-01-01T00:00:00.000Z"),
    ...over,
  };
}

// ── resolveCapabilities ──────────────────────────────────────────────────────

test("resolveCapabilities: absent everywhere is undefined", () => {
  assert.equal(resolveCapabilities(makeDef(), makePhase(), makeStep()), undefined);
});

test("resolveCapabilities: a lone pipeline profile is used as-is", () => {
  const def = makeDef({ capabilities: { filesystem: "read-only" } });
  assert.deepEqual(resolveCapabilities(def, makePhase(), makeStep()), { filesystem: "read-only" });
});

test("resolveCapabilities: phase overrides the pipeline on a shared key", () => {
  const def = makeDef({ capabilities: { filesystem: "read-only" } });
  const phase = makePhase({ capabilities: { filesystem: "workspace-write" } });
  assert.deepEqual(resolveCapabilities(def, phase, makeStep()), { filesystem: "workspace-write" });
});

test("resolveCapabilities: distinct keys merge across all three layers, narrowest wins on overlap", () => {
  const def = makeDef({ capabilities: { env: { inherit: "minimal" }, maxTurns: 3 } });
  const phase = makePhase({ capabilities: { filesystem: "read-only" } });
  const step = makeStep({ capabilities: { filesystem: "workspace-write" } });
  assert.deepEqual(resolveCapabilities(def, phase, step), {
    env: { inherit: "minimal" },
    maxTurns: 3,
    filesystem: "workspace-write",
  });
});

test("resolveCapabilities: an empty profile at any layer still counts as declared", () => {
  const def = makeDef({ capabilities: {} });
  assert.deepEqual(resolveCapabilities(def, makePhase(), makeStep()), {});
});

// ── resolveTimeoutSeconds ────────────────────────────────────────────────────

test("resolveTimeoutSeconds: step wins over phase", () => {
  assert.equal(
    resolveTimeoutSeconds(makePhase({ timeoutSeconds: 60 }), makeStep({ timeoutSeconds: 10 })),
    10,
  );
});

test("resolveTimeoutSeconds: falls back to the phase's limit", () => {
  assert.equal(resolveTimeoutSeconds(makePhase({ timeoutSeconds: 60 }), makeStep()), 60);
});

test("resolveTimeoutSeconds: null when neither level sets one", () => {
  assert.equal(resolveTimeoutSeconds(makePhase(), makeStep()), null);
});

// ── prepareInvocation ────────────────────────────────────────────────────────

test("prepareInvocation: envNames are sorted and ARGUS_TOKEN never reaches the child", () => {
  const prepared = prepareInvocation(baseInputs());
  assert.deepEqual(prepared.record.envNames, [...prepared.record.envNames].sort());
  assert.equal(prepared.record.envNames.includes("ARGUS_TOKEN"), false);
  assert.ok(prepared.record.envStripped.includes("ARGUS_TOKEN"));
  assert.equal(prepared.env.ARGUS_TOKEN, undefined);
  assert.equal(prepared.env.PATH, "/bin"); // ordinary vars still pass under the default policy
});

test("prepareInvocation: deadlineAt is now + timeoutSeconds", () => {
  const now = new Date("2026-03-01T10:00:00.000Z");
  const prepared = prepareInvocation(baseInputs({ timeoutSeconds: 30, now }));
  assert.equal(prepared.record.deadlineAt, new Date(now.getTime() + 30_000).toISOString());
});

test("prepareInvocation: deadlineAt is null without a timeout", () => {
  const prepared = prepareInvocation(baseInputs({ timeoutSeconds: null }));
  assert.equal(prepared.record.deadlineAt, null);
});

test("prepareInvocation: blocking carries the limitations only under strict enforcement", () => {
  // OpenCode enforces none of the profile, so any key set produces a limitation.
  const run = makeRun({ runtime: "opencode" });

  const strict = prepareInvocation(
    baseInputs({ run, phaseDef: makePhase({ capabilities: { tools: { allow: ["Read"] } } }) }),
  );
  assert.ok(strict.record.limitations.length > 0);
  assert.deepEqual(strict.blocking, strict.record.limitations);

  const bestEffort = prepareInvocation(
    baseInputs({
      run,
      phaseDef: makePhase({
        capabilities: { tools: { allow: ["Read"] }, enforcement: "best-effort" },
      }),
    }),
  );
  assert.ok(bestEffort.record.limitations.length > 0);
  assert.deepEqual(bestEffort.blocking, []);
});

test("prepareInvocation: a legacy invocation with no capability profile gets none, and no --settings", () => {
  const legacy = prepareInvocation(baseInputs());
  assert.equal(legacy.record.capabilities, null);
  assert.equal(legacy.plan.args.includes("--settings"), false);
});

test("prepareInvocation: capabilities (and hooks) reach the runtime only when a profile is declared", () => {
  const withProfile = prepareInvocation(baseInputs({ phaseDef: makePhase({ capabilities: {} }) }));
  assert.deepEqual(withProfile.record.capabilities, {});
  assert.ok(withProfile.plan.args.includes("--settings"));
});
