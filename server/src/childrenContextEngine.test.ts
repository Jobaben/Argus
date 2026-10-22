import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEngine as createEngineUntracked, type EngineDeps } from "./pipelineEngine.js";
import { createPipeline, validatePipelineInput } from "./sources/pipelines.js";
import { readInstance } from "./sources/instances.js";
import { readInvocation } from "./sources/runs.js";
import { childrenManifestFile } from "./sources/childrenManifest.js";
import { instanceArtifactDir, phaseArtifactDir } from "./harness/invocation.js";
import { toClaudeRulePath } from "./runtimes/claude.js";
import { paths } from "./claudeHome.js";
import { fakeKill } from "./testPlatform.js";
import { testRunToken } from "./testSignalToken.js";
import type { GateEffectPoint, OperatorSource } from "./engine/types.js";
import type { PreparedInvocation } from "./harness/invocation.js";
import type { Run } from "./sources/scheduleTypes.js";
import type {
  ChildrenManifest,
  PhaseFailurePayload,
  PhaseProgress,
  SignalType,
} from "./sources/pipelineTypes.js";

/**
 * A phase that declares `childrenContext` (DL-A2b) through the real engine:
 * a parent plans two tasks, a spawn phase runs one child per task (each child
 * revised and approved at its own gate), and a later phase `learn` reads them.
 * The builder itself is proved in `sources/childrenManifest.test.ts`; these
 * prove what reaches the run: the file, its hash, its channels, its prompt.
 */

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-children-context-"));
  process.env.ARGUS_CLAUDE_HOME = home;
});

// Every engine a test creates is drained before the next test repoints the
// home: its detached work resolves its paths when it writes.
const engines: ReturnType<typeof createEngineUntracked>[] = [];
function createEngine(deps: EngineDeps): ReturnType<typeof createEngineUntracked> {
  const e = createEngineUntracked(deps);
  engines.push(e);
  return e;
}
afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.drain()));
});

let counter = 0;
interface Call {
  run: Run;
  env: Record<string, string>;
  prepared: PreparedInvocation | undefined;
}
/** Records each launch in full; the process never exits, so no exit handler
 *  runs and every run keeps its slot. */
function recordingSpawn() {
  const calls: Call[] = [];
  const spawn: EngineDeps["spawn"] = (run, _log, env, prepared) => {
    calls.push({ run, env, prepared });
    return { pid: 1000 + calls.length, done: new Promise<{ code: number | null }>(() => {}) };
  };
  return { spawn, calls };
}
type Recorder = ReturnType<typeof recordingSpawn>;

const baseDeps = (over: Partial<EngineDeps> & Pick<EngineDeps, "spawn">): EngineDeps => ({
  now: () => new Date(2026, 9, 22, 12, 0),
  newId: () => `id-${++counter}`,
  signalUrlBase: "http://localhost:7777",
  newSignalToken: testRunToken,
  maxConcurrent: 32,
  tickMs: 30_000,
  kill: fakeKill().kill,
  ...over,
});

/** A probe that fails exactly once, at `at`: the process dying there. */
function failAt(at: GateEffectPoint): Pick<EngineDeps, "gateEffectProbe"> {
  let fired = false;
  return {
    gateEffectProbe: (point: GateEffectPoint) => {
      if (point === at && !fired) {
        fired = true;
        throw new Error(`injected failure at ${point}`);
      }
    },
  };
}

async function waitFor(cond: () => boolean | Promise<boolean>, label: string, ms = 5000) {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const MARKED = { last_assistant_message: "done\nARGUS_OUTCOME: succeeded" };
/** A person, so the decisions read `operator` and the manifest can be checked
 *  for the name it must not carry. */
const OPERATOR: OperatorSource = {
  channel: "http",
  principal: { kind: "session", username: "op-person", role: "admin" },
};

/** `child`: one gated phase `work`. `p1`: `plan` → spawn phase `tasks` →
 *  `learn`, which reads the children, under a profile, in two steps. */
async function seed(): Promise<void> {
  await createPipeline(
    validatePipelineInput({
      name: "task",
      trigger: null,
      overlapPolicy: "allow",
      phases: [
        {
          id: "work",
          name: "Work",
          cwd: home,
          gated: true,
          steps: [{ name: "s", prompt: "do the task" }],
        },
      ],
    }),
    new Date(2026, 9, 22, 9, 0),
    "child",
  );
  await createPipeline(
    validatePipelineInput({
      name: "loop",
      trigger: null,
      phases: [
        {
          id: "plan",
          name: "Plan",
          cwd: home,
          gated: false,
          steps: [{ name: "s", prompt: "plan" }],
          result: {
            artifact: "plan",
            schema: {
              type: "object",
              required: ["tasks"],
              properties: {
                tasks: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["id"],
                    properties: { id: { type: "string" } },
                  },
                },
              },
            },
          },
        },
        {
          id: "tasks",
          name: "Tasks",
          cwd: home,
          needs: ["plan"],
          spawn: { pipelineId: "child", items: { phase: "plan", path: ["tasks"] }, key: "id" },
        },
        {
          id: "learn",
          name: "Learn",
          cwd: home,
          gated: true,
          needs: ["tasks"],
          childrenContext: { fromPhase: "tasks" },
          capabilities: { filesystem: "workspace-write" },
          steps: [
            { name: "l1", prompt: "learn from the children" },
            { name: "l2", prompt: "and again" },
          ],
        },
      ],
    }),
    new Date(2026, 9, 22, 9, 0),
    "p1",
  );
}

const launchesOf = (rec: Recorder, instanceId: string, phaseId: string): Call[] =>
  rec.calls.filter(
    (c) => c.env.ARGUS_INSTANCE_ID === instanceId && c.env.ARGUS_PHASE_ID === phaseId,
  );

/** Signal a run, then drain. */
async function signal(
  e: ReturnType<typeof createEngine>,
  call: Call,
  type: SignalType,
  extra: { result?: unknown } = {},
) {
  const instanceId = call.env.ARGUS_INSTANCE_ID;
  const res = await e.onSignal(instanceId, {
    instanceId,
    phaseId: call.env.ARGUS_PHASE_ID,
    runId: call.run.id,
    type,
    token: testRunToken(call.run.id),
    payload: MARKED,
    ...extra,
  });
  assert.equal(res.ok, true, `the ${type} signal for ${call.run.id} was taken`);
  await e.drain();
}

async function phaseOf(instanceId: string, phaseId: string): Promise<PhaseProgress> {
  const phase = (await readInstance(instanceId))?.phases.find((p) => p.id === phaseId);
  assert.ok(phase, `${instanceId} has phase ${phaseId}`);
  return phase;
}

async function waitForPhase(instanceId: string, phaseId: string, status: string) {
  await waitFor(
    async () =>
      (await readInstance(instanceId))?.phases.find((p) => p.id === phaseId)?.status === status,
    `${instanceId}/${phaseId} ${status}`,
  );
}

/** Run one child's `work` to its gate and approve it; `revise` first sends it
 *  back once with that note. */
async function runChild(
  e: ReturnType<typeof createEngine>,
  rec: Recorder,
  childId: string,
  revise?: string,
) {
  await waitFor(() => launchesOf(rec, childId, "work").length > 0, `${childId} launched`);
  await signal(e, launchesOf(rec, childId, "work")[0], "completed");
  await waitForPhase(childId, "work", "awaiting-approval");
  if (revise) {
    const revised = await e.revise(childId, revise, { phaseId: "work", source: OPERATOR });
    assert.equal(revised.ok, true, `${childId} was revised`);
    await e.drain();
    await waitFor(() => launchesOf(rec, childId, "work").length === 2, `${childId} again`);
    await signal(e, launchesOf(rec, childId, "work")[1], "completed");
    await waitForPhase(childId, "work", "awaiting-approval");
  }
  const approved = await e.approve(childId, undefined, { phaseId: "work", source: OPERATOR });
  assert.equal(approved.ok, true, `${childId} was approved`);
  await e.drain();
  await waitFor(
    async () => (await readInstance(childId))?.status === "succeeded",
    `${childId} succeeded`,
  );
}

/** Start the parent, plan `a` and `b`, run both children (`a` revised once
 *  when asked), and wait for `learn`'s two runs. */
async function toLearn(
  e: ReturnType<typeof createEngine>,
  rec: Recorder,
  opts: { reviseA?: string } = {},
): Promise<{ parentId: string; childA: string; childB: string; learn: Call[] }> {
  const parent = await e.start("p1", "manual");
  assert.ok(parent, "the parent started");
  await waitFor(() => launchesOf(rec, parent.id, "plan").length === 1, "plan launched");
  await signal(e, launchesOf(rec, parent.id, "plan")[0], "completed", {
    result: { tasks: [{ id: "a" }, { id: "b" }] },
  });
  const taskId = async (i: number) =>
    (await phaseOf(parent.id, "tasks")).children?.tasks[i]?.instanceId;
  await waitFor(async () => !!(await taskId(0)), "a planned");
  const childA = (await taskId(0))!;
  await runChild(e, rec, childA, opts.reviseA);
  await waitFor(async () => !!(await taskId(1)), "b planned");
  const childB = (await taskId(1))!;
  await runChild(e, rec, childB);
  await waitForPhase(parent.id, "tasks", "succeeded");
  await waitFor(() => launchesOf(rec, parent.id, "learn").length === 2, "learn's two runs");
  return { parentId: parent.id, childA, childB, learn: launchesOf(rec, parent.id, "learn") };
}

const manifestOf = (call: Call): ChildrenManifest =>
  JSON.parse(readFileSync(call.env.ARGUS_CHILDREN_FILE, "utf8")) as ChildrenManifest;

// ── What reaches the run ─────────────────────────────────────────────────────

test("every run of the attempt gets the same manifest, in its own folder", async () => {
  await seed();
  const rec = recordingSpawn();
  const e = createEngine(baseDeps({ spawn: rec.spawn }));
  const { parentId, childA, childB, learn } = await toLearn(e, rec, {
    reviseA: "use the helper",
  });

  const files = learn.map((c) => c.env.ARGUS_CHILDREN_FILE);
  assert.ok(files.every(Boolean), "both runs are told where it is");
  assert.notEqual(files[0], files[1], "each run has its own copy");
  for (const call of learn) {
    assert.equal(
      call.env.ARGUS_CHILDREN_FILE,
      childrenManifestFile(call.run.id),
      "in the run's own invocation folder",
    );
  }
  const text = readFileSync(files[0], "utf8");
  assert.equal(readFileSync(files[1], "utf8"), text, "the same bytes: built once per attempt");

  const m = manifestOf(learn[0]);
  assert.equal(m.schemaVersion, 1, "versioned");
  assert.deepEqual(m.for, { instanceId: parentId, phaseId: "learn", attempt: 0 }, "for learn");
  assert.deepEqual(
    m.spawnPhase,
    {
      id: "tasks",
      name: "Tasks",
      status: "succeeded",
      attempt: 0,
      childPipelineId: "child",
      counts: { succeeded: 2 },
    },
    "the spawn phase joined",
  );
  assert.deepEqual(
    m.tasks.map((t) => [t.key, t.state, t.child?.instanceId]),
    [
      ["a", "succeeded", childA],
      ["b", "succeeded", childB],
    ],
    "both tasks, with their children",
  );
  const a = m.tasks[0];
  assert.deepEqual(a.task, { id: "a" }, "the task as the child received it");
  const work = a.child?.phases?.[0];
  assert.deepEqual(
    [work?.id, work?.status, work?.attempt, work?.runs.length],
    ["work", "succeeded", 1, 2],
    "the child's phase, revised once: two runs",
  );
  assert.deepEqual(
    a.child?.decisions?.map((d) => [d.decision, d.mechanism, d.note ?? null, d.effect]),
    [
      ["revise", "operator", "use the helper", "applied"],
      ["approve", "operator", null, "applied"],
    ],
    "the gate decisions with their notes",
  );
  assert.equal(
    a.child?.artifactsDir,
    instanceArtifactDir(paths.artifactsDir(), childA),
    "the child's folder",
  );
  assert.equal(
    work?.artifactDir,
    phaseArtifactDir(paths.artifactsDir(), childA, "work"),
    "and its phase's",
  );
  assert.deepEqual(
    m.parent.phases?.map((p) => p.id),
    ["plan", "tasks", "learn"],
    "the parent's own phases",
  );
  assert.deepEqual(
    m.parent.phases?.[0].result,
    { tasks: [{ id: "a" }, { id: "b" }] },
    "with the plan's result",
  );
  assert.equal(m.childrenCost.runs, 3, "every child run counted");
  assert.deepEqual(m.warnings, [], "nothing it could not read");
  assert.equal(text.includes('"principal"'), false, "no principal");
  assert.equal(text.includes("op-person"), false, "no username");
  const child = (await readInstance(childA))!;
  assert.equal(text.includes(child.signalToken), false, "no signal token");
});

test("the manifest is hashed into the run's supplied inputs, recorded, and granted with each child's folder", async () => {
  await seed();
  const rec = recordingSpawn();
  const e = createEngine(baseDeps({ spawn: rec.spawn }));
  const { childA, childB, learn } = await toLearn(e, rec);
  const folders = [childA, childB].map((id) => instanceArtifactDir(paths.artifactsDir(), id));

  for (const call of learn) {
    const file = call.env.ARGUS_CHILDREN_FILE;
    const record = await readInvocation(call.run.id);
    assert.ok(record, "the invocation is recorded");
    assert.equal(record.childrenFile, file, "it names the manifest");
    assert.deepEqual(
      record.suppliedInputs?.find((i) => i.kind === "children-manifest"),
      {
        kind: "children-manifest",
        path: file,
        sha256: createHash("sha256").update(readFileSync(file, "utf8")).digest("hex"),
      },
      "the hash of the bytes as written",
    );
    assert.deepEqual(
      record.channels
        ?.filter((c) => c.kind === "children-manifest" || c.kind === "child-artifacts")
        .map((c) => [c.kind, c.path, c.access, c.required, c.status]),
      [
        ["children-manifest", file, "read", true, "granted"],
        ["child-artifacts", folders[0], "read", false, "granted"],
        ["child-artifacts", folders[1], "read", false, "granted"],
      ],
      "a required manifest and an optional folder per child",
    );
    const args = call.prepared?.plan.args ?? [];
    const added = args.filter((_, i) => args[i - 1] === "--add-dir");
    const denied = args[args.indexOf("--disallowedTools") + 1]?.split(",") ?? [];
    for (const folder of folders) {
      assert.ok(added.includes(folder), `${folder} is admitted`);
      assert.ok(
        denied.includes(`Edit(/${toClaudeRulePath(folder)}/**)`),
        `${folder} is denied for edits (${denied.join(",")})`,
      );
    }
  }
});

test("the run's prompt says where the children are", async () => {
  await seed();
  const rec = recordingSpawn();
  const e = createEngine(baseDeps({ spawn: rec.spawn }));
  const { childA, childB, learn } = await toLearn(e, rec);
  for (const call of learn) {
    const prompt = call.run.prompt;
    const file = call.env.ARGUS_CHILDREN_FILE;
    const at = prompt.indexOf(
      'Children of this instance. The spawn phase "tasks" ran 2 tasks as child instances (2 succeeded).',
    );
    assert.ok(at > -1, `the instruction: ${prompt}`);
    assert.ok(prompt.includes(`manifest of them to ${file}`), "it names the file");
    assert.ok(prompt.includes(`- ARGUS_CHILDREN_FILE: ${file}`), "among the run's paths");
    assert.ok(at < prompt.indexOf("Argus paths for this run."), "before the paths");
    for (const id of [childA, childB]) {
      assert.equal(
        prompt.includes(instanceArtifactDir(paths.artifactsDir(), id)),
        false,
        "a child's folder is named in the manifest, not in the prompt",
      );
    }
  }
});

test("a manifest changed while the run reads it fails the completion", async () => {
  await seed();
  const rec = recordingSpawn();
  const e = createEngine(baseDeps({ spawn: rec.spawn }));
  const { parentId, learn } = await toLearn(e, rec);
  const file = learn[0].env.ARGUS_CHILDREN_FILE;
  // Argus publishes the file read-only; tampering takes the step an outside
  // hand would. Windows has no POSIX permission bits to check.
  if (process.platform !== "win32") {
    assert.equal(statSync(file).mode & 0o777, 0o444, "written read-only");
  }
  chmodSync(file, 0o644);
  writeFileSync(file, `${readFileSync(file, "utf8")}\n`);
  await signal(e, learn[0], "completed");
  await waitForPhase(parentId, "learn", "failed");
  const failure = (await phaseOf(parentId, "learn")).payload as PhaseFailurePayload;
  assert.equal(failure.failureClass, "change-context-integrity", "the integrity class");
  assert.match(String(failure.reason), /children-manifest file changed/, "naming the input");
});

test("a revise reads the children again, with the revise on the parent's own record", async () => {
  await seed();
  const rec = recordingSpawn();
  const e = createEngine(baseDeps({ spawn: rec.spawn }));
  const { parentId, learn } = await toLearn(e, rec);
  for (const call of learn) await signal(e, call, "completed");
  await waitForPhase(parentId, "learn", "awaiting-approval");

  const revised = await e.revise(parentId, "compare costs", {
    phaseId: "learn",
    source: OPERATOR,
  });
  assert.equal(revised.ok, true, "the revise is taken");
  await e.drain();
  await waitFor(() => launchesOf(rec, parentId, "learn").length === 4, "learn's next attempt");
  const next = launchesOf(rec, parentId, "learn").slice(2);
  const m = manifestOf(next[0]);
  assert.equal(m.for.attempt, 1, "built for the new attempt");
  assert.equal(
    readFileSync(next[1].env.ARGUS_CHILDREN_FILE, "utf8"),
    readFileSync(next[0].env.ARGUS_CHILDREN_FILE, "utf8"),
    "the same bytes for both of its runs",
  );
  const last = m.parent.decisions?.at(-1);
  assert.deepEqual(
    [last?.decision, last?.note, last?.phases],
    ["revise", "compare costs", [{ phaseId: "learn", attempt: 0 }]],
    "the parent's revise, with its note",
  );
  assert.equal(
    m.parent.phases?.find((p) => p.id === "learn")?.runs.length,
    2,
    "and the attempt it revised, as runs",
  );
});

test("FAULT SEAM: a launch owed after a restart still gets the manifest", async () => {
  await seed();
  const rec = recordingSpawn();
  const make = (over: Partial<EngineDeps> = {}) =>
    createEngine(baseDeps({ spawn: rec.spawn, ...over }));
  const e = make();
  const { parentId, learn } = await toLearn(e, rec);
  for (const call of learn) await signal(e, call, "completed");
  await waitForPhase(parentId, "learn", "awaiting-approval");

  await make(failAt("revise:saved"))
    .revise(parentId, "after the crash", { phaseId: "learn" })
    .catch(() => undefined);
  assert.equal(launchesOf(rec, parentId, "learn").length, 2, "nothing launched before the crash");

  const restarted = make();
  await restarted.reconcile();
  await restarted.drain();
  await waitFor(() => launchesOf(rec, parentId, "learn").length === 4, "launched on restart");
  const owed = launchesOf(rec, parentId, "learn")[2];
  assert.equal(
    owed.env.ARGUS_CHILDREN_FILE,
    childrenManifestFile(owed.run.id),
    "the owed launch is told where its manifest is",
  );
  assert.equal(manifestOf(owed).for.attempt, 1, "built for the attempt it launches");
});
