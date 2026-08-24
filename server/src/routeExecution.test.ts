import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEngine } from "./pipelineEngine.js";
import {
  createPipeline,
  updatePipeline,
  validatePipelineInput,
  validatePipelinePatch,
} from "./sources/pipelines.js";
import { readInstance } from "./sources/instances.js";
import { readJournal } from "./sources/journal.js";
import { readRun } from "./sources/runs.js";
import type { EngineDeps } from "./pipelineEngine.js";
import type { PipelineInstance } from "./sources/pipelineTypes.js";

/**
 * Routing through the real engine: what gets persisted, what gets journalled,
 * and what a failure costs.
 *
 * The settle tests prove the decisions; these prove the plumbing around them —
 * that a decision and the statuses it implies land in one atomic write, that a
 * result failure is an ordinary retryable phase failure, and that nothing
 * re-decides a route that has already been decided.
 */

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-route-engine-"));
  process.env.ARGUS_CLAUDE_HOME = home;
});

let counter = 0;
function recordingSpawn() {
  const calls: { runId: string; env: Record<string, string> }[] = [];
  const spawn = (run: { id: string }, _log: string, env: Record<string, string>) => {
    calls.push({ runId: run.id, env });
    return { pid: 1000 + calls.length, done: new Promise<{ code: number | null }>(() => {}) };
  };
  return { spawn, calls };
}

const baseDeps = (over: Partial<EngineDeps> & { spawn: EngineDeps["spawn"] }): EngineDeps => ({
  now: () => new Date(2026, 7, 13, 12, 0),
  newId: () => `id-${++counter}`,
  signalUrlBase: "http://localhost:7777",
  maxConcurrent: 4,
  tickMs: 30000,
  ...over,
});

const acceptedSchema = {
  type: "object",
  required: ["accepted"],
  properties: { accepted: { type: "boolean" } },
};

const accepted = (value: boolean) => ({
  predicate: { path: ["accepted"], operator: "equals", value },
});

const step = (name: string, prompt = "p") => ({ name, prompt });

/** The spec's worked example, as a saved definition. */
const workedPhases = (over: Record<string, unknown> = {}) => [
  {
    id: "evaluate",
    name: "Evaluate",
    cwd: home,
    gated: false,
    steps: [step("decide")],
    result: { artifact: "evaluation", schema: acceptedSchema },
    ...over,
  },
  {
    id: "publish",
    name: "Publish",
    cwd: home,
    gated: false,
    steps: [step("ship", "ship {{artifacts.evaluation}}")],
    needs: [{ phase: "evaluate", when: accepted(true) }],
  },
  {
    id: "repair",
    name: "Repair",
    cwd: home,
    gated: false,
    steps: [step("fix")],
    needs: [{ phase: "evaluate", when: accepted(false) }],
  },
  {
    id: "report",
    name: "Report",
    cwd: home,
    gated: false,
    steps: [step("write")],
    needs: [
      { phase: "publish", allowSkipped: true },
      { phase: "repair", allowSkipped: true },
    ],
  },
];

async function seed(phases: unknown[], over: Record<string, unknown> = {}) {
  return createPipeline(
    validatePipelineInput({ name: "routed", trigger: null, phases, ...over }),
    new Date(2026, 7, 13, 9, 0),
    "p1",
  );
}

/** Complete the run the engine most recently spawned. */
async function complete(
  e: ReturnType<typeof createEngine>,
  inst: PipelineInstance,
  rec: { calls: { runId: string; env: Record<string, string> }[] },
  phaseId: string,
  extra: Record<string, unknown> = {},
) {
  return e.onSignal(inst.id, {
    instanceId: inst.id,
    phaseId,
    runId: rec.calls[rec.calls.length - 1].runId,
    type: "completed",
    token: inst.signalToken,
    ...extra,
  });
}
/** The persisted instance, which these tests always expect to exist. */
async function readInst(id: string): Promise<PipelineInstance> {
  return (await readInstance(id))!;
}

const statusOf = (inst: PipelineInstance, id: string) =>
  inst.phases.find((p) => p.id === id)?.status;

/**
 * Wait for the engine's detached launch of the next wave.
 *
 * A signal handler answers the child before it waits for a concurrency slot, so
 * the phases a decision authorized are spawned just after `onSignal` resolves.
 */
async function waitForCalls(
  rec: { calls: { runId: string }[] },
  count: number,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (rec.calls.length < count) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`expected ${count} spawns, saw ${rec.calls.length}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ── End to end, both ways through the graph ────────────────────────────────

test("the worked example runs its selected branch and succeeds with the other skipped", async () => {
  await seed(workedPhases());
  const rec = recordingSpawn();
  const e = createEngine(baseDeps({ spawn: rec.spawn }));
  const inst = await e.start("p1", "manual");

  await complete(e, inst!, rec, "evaluate", { result: { accepted: true } });
  await waitForCalls(rec, 2);
  let current = await readInst(inst!.id);
  assert.equal(statusOf(current, "publish"), "running");
  assert.equal(statusOf(current, "repair"), "skipped");

  // The published result reaches the branch it selected.
  const shipRun = await readRun(rec.calls[1].runId);
  assert.equal(shipRun!.run.prompt, 'ship {"accepted":true}');

  await complete(e, inst!, rec, "publish");
  await waitForCalls(rec, 3);
  current = await readInst(inst!.id);
  assert.equal(statusOf(current, "report"), "running", "the skip-tolerant join goes ahead");

  await complete(e, inst!, rec, "report");
  current = await readInst(inst!.id);
  assert.equal(current.status, "succeeded");
  assert.deepEqual(
    current.phases.map((p: { status: string }) => p.status),
    ["succeeded", "succeeded", "skipped", "succeeded"],
  );
});

test("the other outcome takes the repair branch, and still succeeds", async () => {
  await seed(workedPhases());
  const rec = recordingSpawn();
  const e = createEngine(baseDeps({ spawn: rec.spawn }));
  const inst = await e.start("p1", "manual");

  await complete(e, inst!, rec, "evaluate", { result: { accepted: false } });
  await waitForCalls(rec, 2);
  await complete(e, inst!, rec, "repair");
  await waitForCalls(rec, 3);
  await complete(e, inst!, rec, "report");
  const current = await readInst(inst!.id);
  assert.equal(current.status, "succeeded");
  assert.deepEqual(
    current.phases.map((p: { status: string }) => p.status),
    ["succeeded", "skipped", "succeeded", "succeeded"],
  );
});

// ── Persistence: one write, and never a second opinion ─────────────────────

test("the decision and the statuses it implies are persisted together", async () => {
  await seed(workedPhases());
  const rec = recordingSpawn();
  const e = createEngine(baseDeps({ spawn: rec.spawn }));
  const inst = await e.start("p1", "manual");
  await complete(e, inst!, rec, "evaluate", { result: { accepted: true } });

  // Read from disk, not from the in-memory object the engine mutated.
  const persisted = await readInst(inst!.id);
  assert.equal(persisted.routeDecisions?.length, 1);
  assert.deepEqual(persisted.routeDecisions![0].selected, ["publish"]);
  assert.equal(statusOf(persisted, "repair"), "skipped", "the skip is in the same record");
  assert.deepEqual(persisted.artifacts?.evaluation, { accepted: true });
  assert.deepEqual(persisted.phases[0].result, { accepted: true });
});

test("a decision already recorded is never taken again, even if the definition changed", async () => {
  await seed(workedPhases());
  const rec = recordingSpawn();
  const e = createEngine(baseDeps({ spawn: rec.spawn }));
  const inst = await e.start("p1", "manual");
  await complete(e, inst!, rec, "evaluate", { result: { accepted: true } });

  // An author flips the conditions while the instance is still running.
  await updatePipeline(
    "p1",
    validatePipelinePatch({
      phases: workedPhases().map((p) =>
        p.id === "publish"
          ? { ...p, needs: [{ phase: "evaluate", when: accepted(false) }] }
          : p.id === "repair"
            ? { ...p, needs: [{ phase: "evaluate", when: accepted(true) }] }
            : p,
      ),
    }),
    new Date(2026, 7, 13, 12, 30),
  );

  await waitForCalls(rec, 2);
  await complete(e, inst!, rec, "publish");
  const current = await readInst(inst!.id);
  assert.equal(current.routeDecisions!.length, 1, "the record stands");
  assert.deepEqual(current.routeDecisions![0].selected, ["publish"]);
  assert.equal(statusOf(current, "repair"), "skipped");
});

// ── The journal explains why a phase never ran ─────────────────────────────

test("the journal records the selection, each skip, and a routing failure", async () => {
  await seed(workedPhases());
  const rec = recordingSpawn();
  const e = createEngine(baseDeps({ spawn: rec.spawn }));
  const inst = await e.start("p1", "manual");
  await complete(e, inst!, rec, "evaluate", { result: { accepted: true } });

  const entries = await readJournal(inst!.id);
  const selection = entries.find((x: { kind: string }) => x.kind === "route.selection");
  assert.ok(selection, "the decision is journalled");
  assert.equal(selection.phaseId, "evaluate");
  assert.match(String(selection.detail), /accepted equals true/);
  const skip = entries.find((x: { kind: string }) => x.kind === "route.skip");
  assert.equal(skip?.phaseId, "repair");
});

test("a phase that delivers no result fails, is journalled, and blocks the instance", async () => {
  await seed(workedPhases());
  const rec = recordingSpawn();
  const e = createEngine(baseDeps({ spawn: rec.spawn }));
  const inst = await e.start("p1", "manual");
  await complete(e, inst!, rec, "evaluate");

  const current = await readInst(inst!.id);
  assert.equal(statusOf(current, "evaluate"), "failed");
  assert.equal(current.status, "failed");
  assert.equal(statusOf(current, "publish"), "pending", "no branch was selected");
  assert.equal(current.routeDecisions ?? undefined, undefined);
  const entries = await readJournal(inst!.id);
  const failure = entries.find((x: { kind: string }) => x.kind === "route.failure");
  assert.match(String(failure?.detail), /did not deliver its declared result/);
});

test("a missing result honours the phase's retry policy", async () => {
  await seed(workedPhases({ retry: { attempts: 2, backoffSeconds: 0, retryOn: ["signal"] } }));
  const rec = recordingSpawn();
  const e = createEngine(baseDeps({ spawn: rec.spawn }));
  const inst = await e.start("p1", "manual");
  await complete(e, inst!, rec, "evaluate");

  let current = await readInst(inst!.id);
  assert.equal(current.status, "running", "a retry is pending, so nothing is terminal");
  assert.ok(current.phases[0].retryAt, "the next attempt is scheduled");

  await e.reconcile();
  current = await readInst(inst!.id);
  assert.equal(statusOf(current, "evaluate"), "running", "the phase is trying again");
  assert.equal(current.phases[0].attempt, 1);

  // Second attempt delivers a result, and routing proceeds as normal.
  await waitForCalls(rec, 2);
  await complete(e, inst!, rec, "evaluate", { result: { accepted: false } });
  await waitForCalls(rec, 3);
  current = await readInst(inst!.id);
  assert.equal(statusOf(current, "repair"), "running");
  assert.equal(statusOf(current, "publish"), "skipped");
});

test("an ambiguous exclusive group fails the deciding phase", async () => {
  const group = { group: "verdict", exclusive: true };
  await seed([
    {
      id: "audit",
      name: "Audit",
      cwd: home,
      gated: false,
      steps: [step("look")],
      result: {
        artifact: "audit",
        schema: {
          type: "object",
          required: ["verdict"],
          properties: { verdict: { type: "string", enum: ["pass", "fail"] } },
        },
      },
    },
    {
      id: "ship",
      name: "Ship",
      cwd: home,
      gated: false,
      steps: [step("go")],
      needs: [
        {
          phase: "audit",
          when: { ...group, predicate: { path: ["verdict"], operator: "equals", value: "pass" } },
        },
      ],
    },
    {
      id: "archive",
      name: "Archive",
      cwd: home,
      gated: false,
      steps: [step("keep")],
      needs: [
        {
          phase: "audit",
          when: {
            ...group,
            predicate: { path: ["verdict"], operator: "one-of", value: ["pass", "fail"] },
          },
        },
      ],
    },
  ]);
  const rec = recordingSpawn();
  const e = createEngine(baseDeps({ spawn: rec.spawn }));
  const inst = await e.start("p1", "manual");
  await complete(e, inst!, rec, "audit", { result: { verdict: "pass" } });

  const current = await readInst(inst!.id);
  assert.equal(statusOf(current, "audit"), "failed");
  assert.equal(current.status, "failed");
  assert.equal(statusOf(current, "ship"), "pending");
  assert.equal(statusOf(current, "archive"), "pending");
  const entries = await readJournal(inst!.id);
  assert.match(
    String(entries.find((x: { kind: string }) => x.kind === "route.failure")?.detail),
    /exclusive route group/,
  );
});

// ── Gates ─────────────────────────────────────────────────────────────────

test("a gated decision phase routes on approval, not on completion", async () => {
  await seed(workedPhases().map((p) => (p.id === "evaluate" ? { ...p, gated: true } : p)));
  const rec = recordingSpawn();
  const e = createEngine(baseDeps({ spawn: rec.spawn }));
  const inst = await e.start("p1", "manual");
  await complete(e, inst!, rec, "evaluate", { result: { accepted: true } });

  let current = await readInst(inst!.id);
  assert.equal(current.status, "awaiting-approval");
  assert.deepEqual(current.phases[0].result, { accepted: true }, "validated before the gate");
  assert.equal(current.routeDecisions ?? undefined, undefined, "but not yet routed");

  assert.equal((await e.approve(inst!.id, { note: "ship it" })).code, 200);
  await waitForCalls(rec, 2);
  current = await readInst(inst!.id);
  assert.deepEqual(current.routeDecisions![0].selected, ["publish"]);
  assert.equal(statusOf(current, "publish"), "running");
  assert.equal(statusOf(current, "repair"), "skipped");
});

// ── Nothing changes for a pipeline that does not route ────────────────────

test("a linear pipeline persists no routing state and journals no route entries", async () => {
  await seed([
    { id: "one", name: "One", cwd: home, gated: false, steps: [step("a")] },
    { id: "two", name: "Two", cwd: home, gated: false, steps: [step("b")] },
  ]);
  const rec = recordingSpawn();
  const e = createEngine(baseDeps({ spawn: rec.spawn }));
  const inst = await e.start("p1", "manual");
  await complete(e, inst!, rec, "one");
  await waitForCalls(rec, 2);
  await complete(e, inst!, rec, "two");

  const current = await readInst(inst!.id);
  assert.equal(current.status, "succeeded");
  assert.equal(current.routeDecisions ?? undefined, undefined);
  const entries = await readJournal(inst!.id);
  assert.equal(entries.filter((x: { kind: string }) => x.kind.startsWith("route.")).length, 0);
});
