import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PipelineInstance, Rubric, TrajectorySignals, Verdict } from "@argus/contracts";
import {
  createEngine,
  type AutomatedApproval,
  type Engine,
  type GateEffectPoint,
} from "./pipelineEngine.js";
import { fakeKill } from "./testPlatform.js";
import { createPipeline, validatePipelineInput } from "./sources/pipelines.js";
import { readInstance } from "./sources/instances.js";
import { readGateDecisions } from "./sources/gateDecisions.js";
import { rubricDigest, writeVerdict } from "./sources/verdict.js";
import {
  TRAJECTORY_PROMPT_VERSION,
  TRAJECTORY_SIGNALS_VERSION,
  trajectoryRubricDigest,
} from "./sources/trajectory.js";
import { testRunToken } from "./testSignalToken.js";

/**
 * Hardening Item 5 through the real engine: a rubric that declares a
 * trajectory makes the automated-approval boundary require a current, usable
 * trajectory judgment for every relevant run, validated under the same verdict
 * lock as the output basis and recorded separately from it.
 */

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-trajectory-gates-"));
  process.env.ARGUS_CLAUDE_HOME = home;
  mkdirSync(path.join(home, "argus", "runs"), { recursive: true });
  mkdirSync(path.join(home, "argus", "instances"), { recursive: true });
});

const NOW = new Date("2026-09-29T10:00:00.000Z");
const RUBRIC: Rubric = {
  goal: "Be good.",
  criteria: [{ id: "quality", label: "Quality" }],
  trajectory: {
    criteria: [{ id: "focus", label: "Stayed on task" }],
    check: { holdOn: ["destructive-command"] },
  },
};
const PLAIN: Rubric = { goal: "Be good.", criteria: [{ id: "quality", label: "Quality" }] };

let counter = 0;
function engine(over = {}): { e: Engine; calls: string[] } {
  const calls: string[] = [];
  const e = createEngine({
    now: () => new Date(),
    newId: () => `id-${++counter}`,
    spawn: (run: { id: string }) => {
      calls.push(run.id);
      return { pid: 3000 + calls.length, done: new Promise<{ code: number | null }>(() => {}) };
    },
    kill: fakeKill().kill,
    signalUrlBase: "http://localhost:7777",
    newSignalToken: testRunToken,
    maxConcurrent: 4,
    tickMs: 30000,
    parentEnv: { PATH: process.env.PATH ?? "/bin", HOME: home },
    ...over,
  });
  return { e, calls };
}

function signals(observed: string[] = []): TrajectorySignals {
  const kinds = ["repetition", "errors", "edit-revert", "path", "destructive-command"] as const;
  return {
    version: TRAJECTORY_SIGNALS_VERSION,
    transcript: "present",
    events: 12,
    truncated: false,
    signals: kinds.map((kind) => ({
      kind,
      count: observed.includes(kind) ? 1 : 0,
      observed: observed.includes(kind),
      examples: [],
    })),
  };
}

const base = (runId: string): Verdict => ({
  id: "V-1",
  runId,
  scheduleId: "pipeline:p1",
  scheduleName: "gates",
  phaseId: "build",
  status: "ready",
  at: NOW.toISOString(),
  score: 9,
  criteria: [],
  summary: null,
  regression: false,
  minScore: null,
  costUsd: null,
  tokens: null,
  durationMs: null,
  error: null,
  provenance: { runtime: "claude", requestedModel: "haiku", reportedModel: null, promptVersion: 1 },
  rubricDigest: rubricDigest(RUBRIC),
});

async function storeOutput(runId: string, over: Partial<Verdict> = {}) {
  await writeVerdict({ ...base(runId), ...over });
}

async function storeTrajectory(
  runId: string,
  over: Partial<Verdict> = {},
  observed: string[] = [],
) {
  await writeVerdict({
    ...base(runId),
    id: "VT-1",
    kind: "trajectory",
    score: 8,
    provenance: {
      runtime: "claude",
      requestedModel: "haiku",
      reportedModel: null,
      promptVersion: TRAJECTORY_PROMPT_VERSION,
    },
    rubricDigest: trajectoryRubricDigest(RUBRIC),
    trajectory: { signals: signals(observed), held: [], judged: true },
    ...over,
  });
}

async function waitingAt(
  rubric: Rubric,
  autoApprove: Record<string, number> = { verdict: 7 },
  over = {},
) {
  await createPipeline(
    validatePipelineInput({
      name: "gates",
      trigger: null,
      phases: [
        {
          id: "build",
          name: "build",
          cwd: home,
          gated: true,
          steps: [{ name: "s", prompt: "p" }],
          rubric,
          autoApprove,
        },
      ],
    }),
    NOW,
    "p1",
  );
  const { e, calls } = engine(over);
  const inst = (await e.start("p1", "manual"))!;
  const runId = calls[0];
  await e.onSignal(inst.id, {
    instanceId: inst.id,
    phaseId: "build",
    runId,
    type: "completed",
    token: testRunToken(runId),
    payload: { last_assistant_message: "done\nARGUS_OUTCOME: succeeded" },
  });
  await e.drain();
  const waiting = (await readInstance(inst.id))!;
  assert.equal(waiting.phases[0].status, "awaiting-approval");
  await storeOutput(runId);
  return { e, inst: waiting, runId };
}

const request = (
  inst: PipelineInstance,
  runId: string,
  over: Partial<AutomatedApproval> = {},
): AutomatedApproval => ({
  instanceId: inst.id,
  phaseId: "build",
  attempt: inst.phases[0].attempt,
  runIds: [runId],
  verdicts: [{ runId, verdictId: "V-1" }],
  trajectoryVerdicts: [{ runId, verdictId: "VT-1" }],
  ...over,
});

const statusOf = async (id: string) => (await readInstance(id))!.phases[0].status;

test("a trajectory gate opens on both bases and records them apart, from the stored records", async () => {
  const { e, inst, runId } = await waitingAt(RUBRIC);
  await storeTrajectory(runId);
  const res = await e.approveAutomatically(request(inst, runId));
  assert.equal(res.ok, true, res.error ?? "");
  assert.equal(await statusOf(inst.id), "succeeded");
  const [d] = await readGateDecisions(inst.id);
  assert.equal(d.verdicts?.[0].verdictId, "V-1");
  assert.deepEqual(d.trajectoryVerdicts, [
    {
      runId,
      stepName: "s",
      verdictId: "VT-1",
      at: NOW.toISOString(),
      score: 8,
      bar: 7,
      held: [],
      signalsVersion: TRAJECTORY_SIGNALS_VERSION,
      rubricDigest: trajectoryRubricDigest(RUBRIC),
      runtime: "claude",
      requestedModel: "haiku",
      reportedModel: null,
      promptVersion: TRAJECTORY_PROMPT_VERSION,
    },
  ]);
});

test("a trajectory gate with no trajectory basis, or no stored judgment, waits for a person", async () => {
  const { e, inst, runId } = await waitingAt(RUBRIC);
  const noBasis = await e.approveAutomatically(request(inst, runId, { trajectoryVerdicts: [] }));
  assert.equal(noBasis.ok, false);
  assert.match(noBasis.error ?? "", /no trajectory judgment in the approval request/);
  const noStored = await e.approveAutomatically(request(inst, runId));
  assert.equal(noStored.ok, false);
  assert.match(noStored.error ?? "", /not that run's current one/);
  assert.equal(await statusOf(inst.id), "awaiting-approval");
  assert.equal((await readGateDecisions(inst.id)).length, 0, "a refusal records nothing");
});

test("duplicate or unrelated trajectory references are refused before anything is read", async () => {
  const { e, inst, runId } = await waitingAt(RUBRIC);
  await storeTrajectory(runId);
  const dup = await e.approveAutomatically(
    request(inst, runId, {
      trajectoryVerdicts: [
        { runId, verdictId: "VT-1" },
        { runId, verdictId: "VT-1" },
      ],
    }),
  );
  assert.match(dup.error ?? "", /more than once/);
  const other = await e.approveAutomatically(
    request(inst, runId, {
      trajectoryVerdicts: [
        { runId, verdictId: "VT-1" },
        { runId: "someone-else", verdictId: "VT-9" },
      ],
    }),
  );
  assert.match(other.error ?? "", /not about/);
  // An output verdict named as a trajectory judgment is not one.
  const crossed = await e.approveAutomatically(
    request(inst, runId, { trajectoryVerdicts: [{ runId, verdictId: "V-1" }] }),
  );
  assert.match(crossed.error ?? "", /not that run's current one/);
  assert.equal(await statusOf(inst.id), "awaiting-approval");
});

test("a phase without a trajectory refuses a trajectory basis and records none", async () => {
  const { e, inst, runId } = await waitingAt(PLAIN);
  await storeOutput(runId, { id: "V-1", rubricDigest: rubricDigest(PLAIN) });
  const named = await e.approveAutomatically(request(inst, runId));
  assert.equal(named.ok, false);
  assert.match(named.error ?? "", /declares no trajectory/);
  const res = await e.approveAutomatically(request(inst, runId, { trajectoryVerdicts: undefined }));
  assert.equal(res.ok, true, res.error ?? "");
  const [d] = await readGateDecisions(inst.id);
  assert.equal("trajectoryVerdicts" in d, false, "a plain gate's record is unchanged in shape");
});

for (const [name, over, observed, why] of [
  ["skipped (no transcript)", { status: "skipped", score: null }, [], /trajectory-not-ready/],
  ["failed", { status: "failed", score: null }, [], /trajectory-not-ready/],
  [
    "missing signals",
    { trajectory: { signals: { ...signals(), transcript: "missing" }, held: [], judged: true } },
    [],
    /trajectory-signals-unavailable/,
  ],
  [
    "judged under another rubric",
    { rubricDigest: trajectoryRubricDigest(PLAIN) },
    [],
    /rubric-mismatch/,
  ],
  [
    "from another prompt version",
    {
      provenance: {
        runtime: "claude",
        requestedModel: null,
        reportedModel: null,
        promptVersion: 99,
      },
    },
    [],
    /prompt-mismatch/,
  ],
  ["held by the check", {}, ["destructive-command"], /check held on destructive-command/],
  [
    "over a truncated recording (insufficient input, not an observed violation)",
    { trajectory: { signals: { ...signals(), truncated: true }, held: [], judged: true } },
    [],
    /trajectory-signals-truncated/,
  ],
  ["below the bar", { score: 6 }, [], /below the bar of 7/],
] as const) {
  test(`a trajectory judgment that is ${name} holds the gate`, async () => {
    const { e, inst, runId } = await waitingAt(RUBRIC);
    await storeTrajectory(runId, over as Partial<Verdict>, [...observed]);
    const res = await e.approveAutomatically(request(inst, runId));
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", why);
    assert.equal(await statusOf(inst.id), "awaiting-approval");
  });
}

test("held is recomputed from the stored signals, not taken from the record", async () => {
  const { e, inst, runId } = await waitingAt(RUBRIC);
  await storeTrajectory(
    runId,
    { trajectory: { signals: signals(["destructive-command"]), held: [], judged: true } },
    ["destructive-command"],
  );
  const res = await e.approveAutomatically(request(inst, runId));
  assert.match(res.error ?? "", /check held/);
});

test("autoApprove.trajectory sets its own bar", async () => {
  const { e, inst, runId } = await waitingAt(RUBRIC, { verdict: 7, trajectory: 5 });
  await storeTrajectory(runId, { score: 6 });
  const res = await e.approveAutomatically(request(inst, runId));
  assert.equal(res.ok, true, res.error ?? "");
  assert.equal((await readGateDecisions(inst.id))[0].trajectoryVerdicts?.[0].bar, 5);
});

test("a check-only trajectory needs no score, only a usable judgment that held nothing", async () => {
  const checkOnly: Rubric = { ...PLAIN, trajectory: { check: { holdOn: ["errors"] } } };
  const { e, inst, runId } = await waitingAt(checkOnly);
  await storeOutput(runId, { rubricDigest: rubricDigest(checkOnly) });
  await storeTrajectory(runId, {
    score: null,
    provenance: undefined,
    rubricDigest: trajectoryRubricDigest(checkOnly),
    trajectory: { signals: signals(["destructive-command"]), held: [], judged: false },
  });
  const res = await e.approveAutomatically(request(inst, runId));
  assert.equal(res.ok, true, res.error ?? "");
  const t = (await readGateDecisions(inst.id))[0].trajectoryVerdicts?.[0];
  assert.equal(t?.score, null);
  assert.equal(t?.bar, null);
});

// ── Concurrency: the verdict lock orders trajectory writes too ──────────────

function racing(runId: string, over: Partial<Verdict>) {
  let landed = false;
  let pending: Promise<unknown> | null = null;
  let landedAtLink: boolean | null = null;
  return {
    deps: {
      gateEffectProbe: (point: GateEffectPoint) => {
        if (point === "approve:validated" && !pending) {
          pending = storeTrajectory(runId, over).then(() => (landed = true));
        }
        if (point === "approve:linked") landedAtLink = landed;
      },
    },
    done: () => pending,
    landedAtLink: () => landedAtLink,
  };
}

test("MANDATORY: a newer failed trajectory judgment written during the approval lands after its commit point", async () => {
  // The racing write is armed only for the engine that approves.
  const { inst, runId } = await waitingAt(RUBRIC);
  await storeTrajectory(runId);
  const race = racing(runId, {
    id: "VT-2",
    status: "failed",
    score: null,
    at: new Date(NOW.getTime() + 1000).toISOString(),
  });
  const { e } = engine(race.deps);
  const res = await e.approveAutomatically(request(inst, runId));
  await race.done();
  assert.equal(res.ok, true, res.error ?? "");
  assert.equal(race.landedAtLink(), false, "the write could not land before the link");
  assert.equal((await readGateDecisions(inst.id))[0].trajectoryVerdicts?.[0].verdictId, "VT-1");
});

test("a newer trajectory judgment that lands before the commit point refuses the approval", async () => {
  const { e, inst, runId } = await waitingAt(RUBRIC);
  await storeTrajectory(runId);
  await storeTrajectory(runId, { id: "VT-2", at: new Date(NOW.getTime() + 1000).toISOString() });
  const res = await e.approveAutomatically(request(inst, runId));
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /not that run's current one/);
});

test("a pruned trajectory judgment is absent, which holds the gate", async () => {
  const { e, inst, runId } = await waitingAt(RUBRIC);
  // Nothing stored for the trajectory: what the retention cap leaves behind.
  const res = await e.approveAutomatically(request(inst, runId));
  assert.equal(res.ok, false);
  assert.equal(await statusOf(inst.id), "awaiting-approval");
});
