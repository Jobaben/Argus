import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readResultFile } from "../../hooks/argus-signal.mjs";
import { resultStepName } from "./sources/dag.js";
import type { PhaseDef } from "./sources/pipelineTypes.js";

/**
 * Result transport: how a structured decision gets from the agent to the engine.
 *
 * The route is a file, not prose. The engine names a per-run path in the
 * environment, the agent writes JSON there, and the stop hook puts that parsed
 * JSON into the completion signal — so a phase's business decision never
 * depends on a regex over the model's closing paragraph. `ARGUS_OUTCOME` keeps
 * meaning exactly what it meant: whether the run *worked*.
 */

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-result-"));
  process.env.ARGUS_CLAUDE_HOME = home;
});

async function load() {
  const engine = await import(`./pipelineEngine.js?${Math.random()}`);
  const pipelines = await import(`./sources/pipelines.js?${Math.random()}`);
  const instances = await import(`./sources/instances.js?${Math.random()}`);
  const runs = await import(`./sources/runs.js?${Math.random()}`);
  return { engine, pipelines, instances, runs };
}

let counter = 0;
function deferred() {
  let resolve!: (v: { code: number | null }) => void;
  const promise = new Promise<{ code: number | null }>((r) => (resolve = r));
  return { promise, resolve };
}

function recordingSpawn() {
  const calls: { runId: string; env: Record<string, string> }[] = [];
  const spawn = (run: { id: string }, _log: string, env: Record<string, string>) => {
    calls.push({ runId: run.id, env });
    return { pid: 1000 + calls.length, done: deferred().promise };
  };
  return { spawn, calls };
}

const baseDeps = (over: Record<string, unknown>) => ({
  now: () => new Date(2026, 5, 30, 12, 0),
  newId: () => `id-${++counter}`,
  signalUrlBase: "http://localhost:7777",
  maxConcurrent: 4,
  tickMs: 30000,
  ...over,
});

const decisionSchema = {
  type: "object" as const,
  required: ["accepted"],
  properties: { accepted: { type: "boolean" as const } },
};

/* eslint-disable @typescript-eslint/no-explicit-any */
async function seed(pipelines: any, phases: unknown[], over: Record<string, unknown> = {}) {
  return pipelines.createPipeline(
    pipelines.validatePipelineInput({ name: "feature", trigger: null, phases, ...over }),
    new Date(2026, 5, 30, 9, 0),
    "p1",
  );
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const phaseDef = (id: string, over: Partial<PhaseDef> = {}): PhaseDef => ({
  id,
  name: id,
  cwd: home,
  gated: false,
  steps: [{ name: "s", prompt: "p" }],
  ...over,
});

// ── Which step may publish ──────────────────────────────────────────────────

test("the publishing step is the only step, or the one the phase named", () => {
  assert.equal(resultStepName(phaseDef("a")), null);
  assert.equal(
    resultStepName(phaseDef("a", { result: { artifact: "x", schema: decisionSchema } })),
    "s",
  );
  assert.equal(
    resultStepName(
      phaseDef("a", {
        steps: [
          { name: "one", prompt: "p" },
          { name: "two", prompt: "p" },
        ],
        result: { artifact: "x", resultStep: "two", schema: decisionSchema },
      }),
    ),
    "two",
  );
});

// ── The engine's half: an env var and an instruction, for one step only ──────

test("only the declared result step is given a result file and told to write it", async () => {
  const { engine, pipelines, runs } = await load();
  await seed(pipelines, [
    {
      id: "evaluate",
      name: "Evaluate",
      cwd: home,
      gated: false,
      steps: [
        { name: "gather", prompt: "gather" },
        { name: "decide", prompt: "decide" },
      ],
      result: { artifact: "evaluation", resultStep: "decide", schema: decisionSchema },
    },
  ]);
  const rec = recordingSpawn();
  const e = engine.createEngine(baseDeps({ spawn: rec.spawn }));
  await e.start("p1", "manual");

  assert.equal(rec.calls.length, 2);
  const byStep = new Map<string, { runId: string; env: Record<string, string> }>();
  for (const call of rec.calls) {
    const got = await runs.readRun(call.runId);
    byStep.set(got!.run.scheduleName, call);
  }
  const decide = rec.calls[1];
  const gather = rec.calls[0];
  assert.ok(decide.env.ARGUS_RESULT_FILE, "the publishing step gets a result file path");
  assert.equal(gather.env.ARGUS_RESULT_FILE, undefined, "a sibling step gets no result file");

  const decideRun = await runs.readRun(decide.runId);
  const gatherRun = await runs.readRun(gather.runId);
  assert.match(decideRun!.run.prompt, /ARGUS_RESULT_FILE/);
  assert.match(decideRun!.run.prompt, /"accepted"/, "the schema travels with the instruction");
  assert.doesNotMatch(gatherRun!.run.prompt, /ARGUS_RESULT_FILE/);
});

test("a phase with no declared result is spawned exactly as before", async () => {
  const { engine, pipelines, runs } = await load();
  await seed(pipelines, [
    { id: "only", name: "Only", cwd: home, gated: false, steps: [{ name: "s", prompt: "p" }] },
  ]);
  const rec = recordingSpawn();
  const e = engine.createEngine(baseDeps({ spawn: rec.spawn }));
  await e.start("p1", "manual");
  assert.equal(rec.calls[0].env.ARGUS_RESULT_FILE, undefined);
  assert.equal((await runs.readRun(rec.calls[0].runId))!.run.prompt, "p");
});

// ── The hook's half: read the file, never the prose ──────────────────────────

test("readResultFile parses the file, reports malformed JSON, and stays quiet otherwise", () => {
  const good = path.join(home, "good.json");
  writeFileSync(good, JSON.stringify({ accepted: true }));
  assert.deepEqual(readResultFile(good), { result: { accepted: true } });

  const bad = path.join(home, "bad.json");
  writeFileSync(bad, "{accepted: yes");
  const malformed = readResultFile(bad);
  assert.equal(malformed.result, undefined);
  assert.match(String(malformed.resultError), /could not be parsed/);

  // Not written at all: the engine reports the missing result, not the hook.
  assert.deepEqual(readResultFile(path.join(home, "absent.json")), {});
  assert.deepEqual(readResultFile(undefined), {});
  assert.deepEqual(readResultFile(""), {});
});

/** Run the reference hook against a throwaway server and return the body it posts. */
async function hookPost(
  env: Record<string, string>,
  stdin: unknown,
): Promise<Record<string, unknown>> {
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push(raw);
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const hook = fileURLToPath(new URL("../../hooks/argus-signal.mjs", import.meta.url));
  try {
    const child = spawn(process.execPath, [hook], {
      env: {
        ...process.env,
        ARGUS_SIGNAL_URL: `http://127.0.0.1:${port}/signal`,
        ARGUS_INSTANCE_ID: "i1",
        ARGUS_PHASE_ID: "evaluate",
        ARGUS_RUN_ID: "r1",
        ARGUS_SIGNAL_TOKEN: "t1",
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end(JSON.stringify(stdin));
    await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
  assert.equal(bodies.length, 1, "the hook delivered exactly one signal");
  return JSON.parse(bodies[0]) as Record<string, unknown>;
}

test("the stop hook carries the parsed result file into the completion signal", async () => {
  const file = path.join(home, "result.json");
  writeFileSync(file, JSON.stringify({ accepted: false, notes: ["retry"] }));
  const body = await hookPost(
    { ARGUS_RESULT_FILE: file },
    { last_assistant_message: "done\nARGUS_OUTCOME: succeeded" },
  );
  assert.equal(body.type, "completed");
  assert.deepEqual(body.result, { accepted: false, notes: ["retry"] });
  assert.equal(body.resultError, undefined);
});

test("the stop hook reports a malformed result file instead of guessing", async () => {
  const file = path.join(home, "torn.json");
  writeFileSync(file, '{"accepted": tru');
  const body = await hookPost({ ARGUS_RESULT_FILE: file }, { last_assistant_message: "done" });
  assert.equal(body.result, undefined);
  assert.match(String(body.resultError), /could not be parsed/);
});

test("a run with no result file posts the same body it always did", async () => {
  const body = await hookPost({}, { last_assistant_message: "done" });
  assert.deepEqual(Object.keys(body).sort(), [
    "instanceId",
    "payload",
    "phaseId",
    "runId",
    "token",
    "type",
  ]);
});

test("the stop hook never reads a decision out of the assistant's prose", async () => {
  const body = await hookPost(
    {},
    { last_assistant_message: 'The decision is {"accepted": true}. ARGUS_OUTCOME: succeeded' },
  );
  assert.equal(body.result, undefined);
});

// ── The receiving end: the signal's result lands on its step ─────────────────

test("a completion signal's result is recorded against the step that sent it", async () => {
  const { engine, pipelines, instances } = await load();
  await seed(pipelines, [
    {
      id: "evaluate",
      name: "Evaluate",
      cwd: home,
      gated: false,
      steps: [{ name: "s", prompt: "p" }],
      result: { artifact: "evaluation", schema: decisionSchema },
    },
  ]);
  const rec = recordingSpawn();
  const e = engine.createEngine(baseDeps({ spawn: rec.spawn }));
  const inst = await e.start("p1", "manual");
  await e.onSignal(inst!.id, {
    instanceId: inst!.id,
    phaseId: "evaluate",
    runId: rec.calls[0].runId,
    type: "completed",
    token: inst!.signalToken,
    result: { accepted: true },
  });
  const after = await instances.readInstance(inst!.id);
  assert.deepEqual(after!.phases[0].steps[0].result, { accepted: true });
});

// ── The hookless runtimes: the file is read on the reconcile tick ────────────

test("a hookless runtime's result file is read when its run is reconciled", async () => {
  const { engine, pipelines, instances, runs } = await load();
  await seed(
    pipelines,
    [
      {
        id: "evaluate",
        name: "Evaluate",
        cwd: home,
        gated: false,
        steps: [{ name: "s", prompt: "p" }],
        result: { artifact: "evaluation", schema: decisionSchema },
      },
    ],
    { runtime: "opencode" },
  );
  const rec = recordingSpawn();
  const e = engine.createEngine(baseDeps({ spawn: rec.spawn }));
  const inst = await e.start("p1", "manual");
  const runId = rec.calls[0].runId;

  // OpenCode has no command hook: the agent wrote the file and exited, and the
  // conclusion is read off the record on the next tick.
  const file = rec.calls[0].env.ARGUS_RESULT_FILE;
  assert.ok(file, "a result-producing step is given a file even without a hook");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ accepted: true }));
  const got = await runs.readRun(runId);
  await runs.writeRun({
    ...got!.run,
    status: "succeeded",
    exitCode: 0,
    endedAt: new Date().toISOString(),
    resultSummary: "Evaluated.\nARGUS_OUTCOME: succeeded",
  });

  await e.reconcile();

  const after = await instances.readInstance(inst!.id);
  assert.deepEqual(after!.phases[0].steps[0].result, { accepted: true });
});

test("a hookless runtime's malformed result file is reported, not parsed from prose", async () => {
  const { engine, pipelines, instances, runs } = await load();
  await seed(
    pipelines,
    [
      {
        id: "evaluate",
        name: "Evaluate",
        cwd: home,
        gated: false,
        steps: [{ name: "s", prompt: "p" }],
        result: { artifact: "evaluation", schema: decisionSchema },
      },
    ],
    { runtime: "opencode" },
  );
  const rec = recordingSpawn();
  const e = engine.createEngine(baseDeps({ spawn: rec.spawn }));
  const inst = await e.start("p1", "manual");
  const file = rec.calls[0].env.ARGUS_RESULT_FILE;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "not json at all");
  const got = await runs.readRun(rec.calls[0].runId);
  await runs.writeRun({
    ...got!.run,
    status: "succeeded",
    exitCode: 0,
    endedAt: new Date().toISOString(),
    resultSummary: '{"accepted": true}\nARGUS_OUTCOME: succeeded',
  });

  await e.reconcile();

  const after = await instances.readInstance(inst!.id);
  assert.equal(after!.phases[0].steps[0].result, undefined);
  assert.match(String(after!.phases[0].steps[0].resultError), /could not be parsed/);
});

test("the result file lives beside the run it belongs to", async () => {
  const { runs } = await load();
  const file = runs.runResultPath("run-9");
  assert.equal(path.basename(file), "run-9.json");
  assert.equal(path.basename(path.dirname(file)), "results");
  // And it is readable back through the same helper the engine uses.
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ accepted: true }));
  assert.deepEqual(await runs.readRunResult("run-9"), { result: { accepted: true } });
  assert.equal(readFileSync(file, "utf8"), '{"accepted":true}');
});
