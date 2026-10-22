/**
 * What a command check is told about the work it judges.
 *
 * A check runs with the instance, phase and attempt it judges, the artifact
 * folder and worktree the work happened in, and, when the instance was started
 * with a payload, a JSON copy of that payload as a file. The copy is put back
 * before every verification run, so neither an edit nor a restart leaves the
 * next run reading anything but the payload the instance was started with; it
 * is not put back between the checks of one run.
 */
import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { paths } from "../claudeHome.js";
import { instanceTriggerPayloadPath, phaseArtifactDir } from "../harness/invocation.js";
import { fakeKill } from "../testPlatform.js";
import { createEngine as createEngineUntracked } from "../pipelineEngine.js";
import { createPipeline, validatePipelineInput } from "../sources/pipelines.js";
import { readInstance, writeInstance } from "../sources/instances.js";
import { testRunToken } from "../testSignalToken.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-check-inputs-"));
  process.env.ARGUS_CLAUDE_HOME = home;
});

// Every engine a test builds is drained before the next test repoints the home.
const engines: ReturnType<typeof createEngineUntracked>[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.drain()));
});

const MARKED = { last_assistant_message: "done\nARGUS_OUTCOME: succeeded" };
const PAYLOAD = { task: { id: "T1", files: ["src/a.ts"] }, base: "main" };
let counter = 0;

function gitAvailable(): boolean {
  try {
    return spawnSync("git", ["--version"]).status === 0;
  } catch {
    return false;
  }
}
const git = (cwd: string, args: string[]) =>
  spawnSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=T", ...args], { cwd });
function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "argus-check-inputs-repo-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "core.autocrlf", "false"]);
  writeFileSync(path.join(dir, "README.md"), "base\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

/** Records each launch; the process never exits, so no exit handler runs. */
function recordingSpawn() {
  const runIds: string[] = [];
  const spawn = (run: { id: string }) => {
    runIds.push(run.id);
    return { pid: process.pid, done: new Promise<{ code: number | null }>(() => {}) };
  };
  return { spawn, runIds };
}

/** No `parentEnv`: the checks see this process's environment, so `node` is on
 *  their `PATH`. */
function makeEngine(spawn: ReturnType<typeof recordingSpawn>["spawn"]) {
  const e = createEngineUntracked({
    spawn,
    now: () => new Date(),
    newId: () => `ci-${++counter}`,
    newSignalToken: testRunToken,
    signalUrlBase: "http://localhost:7777",
    maxConcurrent: 8,
    tickMs: 30000,
    kill: fakeKill().kill,
  } as any);
  engines.push(e);
  return e;
}

const complete = (e: any, instanceId: string, runId: string) =>
  e.onSignal(instanceId, {
    instanceId,
    phaseId: "impl",
    runId,
    type: "completed",
    token: testRunToken(runId),
    payload: MARKED,
  });

async function waitFor(cond: () => boolean | Promise<boolean>, label: string, ms = 10_000) {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * A command check that writes down what it was told: every ARGUS_* variable,
 * and the payload file's text when one is named, into
 * `<dir>/<last segment of ARGUS_ARTIFACT_DIR>.json` — `impl.json` for the
 * phase, `c<i>.json` for a candidate. Portable: `node -e` with the folder as an
 * argument, nothing the Windows shell would expand.
 */
const recordInto = (dir: string) =>
  `node -e "var fs=require('fs'),p=require('path');var o={};for(var k in process.env){if(k.indexOf('ARGUS_')===0)o[k]=process.env[k]}var f=process.env.ARGUS_TRIGGER_PAYLOAD_FILE;o.payloadText=f?fs.readFileSync(f,'utf8'):null;fs.writeFileSync(p.join(process.argv[1],p.basename(process.env.ARGUS_ARTIFACT_DIR)+'.json'),JSON.stringify(o))" "${dir}"`;

/** What one recorded check saw: its ARGUS_* variables, and `payloadText`. */
type Seen = Record<string, string | null>;
const recordOf = (dir: string, name: string): Seen =>
  JSON.parse(readFileSync(path.join(dir, `${name}.json`), "utf8")) as Seen;

async function seed(cwd: string, out: string, over: Record<string, unknown> = {}, id = "p1") {
  return createPipeline(
    validatePipelineInput({
      name: "check-inputs",
      trigger: null,
      phases: [
        {
          id: "impl",
          name: "Implement",
          cwd,
          gated: false,
          steps: [{ name: "code", prompt: "implement it" }],
          checks: [{ kind: "command", run: recordInto(out), label: "record" }],
          ...over,
        },
      ],
    }),
    new Date(2026, 9, 21, 9, 0),
    id,
  );
}

const outDir = () => mkdtempSync(path.join(tmpdir(), "argus-check-inputs-out-"));
const verification = async (id: string) => (await readInstance(id))?.phases[0].verification;

test("a webhook-started instance's check reads its identity, its folder and tree, and the payload file", async (t) => {
  if (!gitAvailable()) return t.skip("git not available");
  const out = outDir();
  await seed(makeRepo(), out, { workspace: { scope: "instance" } });
  const rec = recordingSpawn();
  const e = makeEngine(rec.spawn);
  const inst = (await e.start("p1", "webhook", { triggerPayload: PAYLOAD }))!;
  await complete(e, inst.id, rec.runIds[0]);
  await e.drain();
  await waitFor(async () => (await verification(inst.id))?.status === "passed", "the check");

  const saved = (await readInstance(inst.id))!;
  const phase = saved.phases[0];
  const seen = recordOf(out, "impl");
  assert.equal(seen.ARGUS_INSTANCE_ID, inst.id, "the instance");
  assert.equal(seen.ARGUS_PHASE_ID, "impl", "the phase");
  assert.equal(seen.ARGUS_PHASE_ATTEMPT, "0", "the attempt, from 0");
  assert.equal(seen.ARGUS_ARTIFACT_DIR, phase.artifactDir, "the phase's artifact folder");
  assert.equal(
    seen.ARGUS_ARTIFACT_DIR,
    phaseArtifactDir(paths.artifactsDir(), inst.id, "impl"),
    "the folder its agent step was given",
  );
  assert.ok(phase.workspace?.path, "the phase ran in a worktree");
  assert.equal(seen.ARGUS_WORKSPACE, phase.workspace.path, "the worktree the work happened in");
  const file = instanceTriggerPayloadPath(paths.invocationsDir(), inst.id);
  assert.equal(seen.ARGUS_TRIGGER_PAYLOAD_FILE, file, "the payload copy");
  assert.deepEqual(JSON.parse(seen.payloadText!), PAYLOAD, "which holds the payload");
  // Outside what the agent is handed: neither its artifact folder nor its tree.
  assert.ok(!file.startsWith(phase.artifactDir!), "the copy is not in the artifact folder");
  assert.ok(!file.startsWith(phase.workspace.path), "the copy is not in the worktree");
});

test("with no payload, the payload variable is unset and no file is written", async () => {
  for (const firing of [
    { pipelineId: "p-manual", trigger: "manual", payload: undefined },
    { pipelineId: "p-null", trigger: "webhook", payload: null },
  ] as const) {
    const out = outDir();
    await seed(home, out, {}, firing.pipelineId);
    const rec = recordingSpawn();
    const e = makeEngine(rec.spawn);
    const inst = (await e.start(
      firing.pipelineId,
      firing.trigger,
      firing.payload === undefined ? undefined : { triggerPayload: firing.payload },
    ))!;
    await complete(e, inst.id, rec.runIds[0]);
    await e.drain();
    await waitFor(async () => (await verification(inst.id))?.status === "passed", "the check");

    const seen = recordOf(out, "impl");
    const label = `${firing.trigger} start`;
    assert.equal(seen.ARGUS_INSTANCE_ID, inst.id, `${label}: the instance`);
    assert.equal(seen.ARGUS_PHASE_ID, "impl", `${label}: the phase`);
    assert.equal(seen.ARGUS_PHASE_ATTEMPT, "0", `${label}: the attempt`);
    assert.equal(
      seen.ARGUS_ARTIFACT_DIR,
      (await readInstance(inst.id))!.phases[0].artifactDir,
      `${label}: the artifact folder`,
    );
    assert.equal(seen.ARGUS_WORKSPACE, undefined, `${label}: no worktree, no ARGUS_WORKSPACE`);
    assert.equal(seen.ARGUS_TRIGGER_PAYLOAD_FILE, undefined, `${label}: no payload variable`);
    assert.equal(seen.payloadText, null, `${label}: nothing to read`);
    assert.ok(
      !existsSync(instanceTriggerPayloadPath(paths.invocationsDir(), inst.id)),
      `${label}: no payload file`,
    );
    await e.drain();
  }
});

test("a candidate's checks get its own folder and worktree", async (t) => {
  if (!gitAvailable()) return t.skip("git not available");
  const out = outDir();
  await seed(makeRepo(), out, {
    workspace: { scope: "attempt" },
    candidates: { count: 2, select: "cheapest-verified" },
  });
  const rec = recordingSpawn();
  const e = makeEngine(rec.spawn);
  const inst = (await e.start("p1", "webhook", { triggerPayload: PAYLOAD }))!;
  const steps = (await readInstance(inst.id))!.phases[0].steps;
  assert.equal(steps.length, 2, "two candidates");
  for (const runId of rec.runIds) await complete(e, inst.id, runId);
  await e.drain();
  await waitFor(
    () => existsSync(path.join(out, "c0.json")) && existsSync(path.join(out, "c1.json")),
    "both candidates' checks",
  );
  await e.drain();

  const phaseDir = phaseArtifactDir(paths.artifactsDir(), inst.id, "impl");
  const seen = [recordOf(out, "c0"), recordOf(out, "c1")];
  for (const i of [0, 1]) {
    assert.equal(seen[i].ARGUS_PHASE_ID, "impl", `c${i}: the phase`);
    assert.equal(seen[i].ARGUS_PHASE_ATTEMPT, "0", `c${i}: every candidate shares the attempt`);
    assert.equal(
      seen[i].ARGUS_ARTIFACT_DIR,
      path.join(phaseDir, `c${i}`),
      `c${i}: its own artifact folder`,
    );
    assert.ok(steps[i].workspace?.path, `c${i} ran in a worktree`);
    assert.equal(seen[i].ARGUS_WORKSPACE, steps[i].workspace!.path, `c${i}: its own worktree`);
    assert.deepEqual(JSON.parse(seen[i].payloadText!), PAYLOAD, `c${i}: the instance's payload`);
  }
  assert.notEqual(seen[0].ARGUS_ARTIFACT_DIR, seen[1].ARGUS_ARTIFACT_DIR, "two folders");
  assert.notEqual(seen[0].ARGUS_WORKSPACE, seen[1].ARGUS_WORKSPACE, "two worktrees");
});

test("MANUAL STATE: a check run again after a restart puts an edited payload file back", async () => {
  const out = outDir();
  await seed(home, out);
  const rec = recordingSpawn();
  const e1 = makeEngine(rec.spawn);
  const inst = (await e1.start("p1", "webhook", { triggerPayload: PAYLOAD }))!;
  await e1.drain();
  // Commit "verification running" by hand, as a crash mid-check leaves it.
  const mid = structuredClone((await readInstance(inst.id))!);
  mid.phases[0].steps[0].status = "succeeded";
  mid.phases[0].verification = {
    status: "running",
    startedAt: new Date().toISOString(),
    checks: [],
  };
  await writeInstance(mid);
  // Meanwhile somebody edits the copy the check will read.
  const file = instanceTriggerPayloadPath(paths.invocationsDir(), inst.id);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '{"task":{"id":"EDITED"}}');

  const e2 = makeEngine(recordingSpawn().spawn);
  await e2.reconcile();
  await e2.drain();
  await waitFor(async () => (await verification(inst.id))?.status === "passed", "the re-run check");

  const seen = recordOf(out, "impl");
  assert.equal(seen.ARGUS_TRIGGER_PAYLOAD_FILE, file, "the same copy is named");
  assert.deepEqual(JSON.parse(seen.payloadText!), PAYLOAD, "the check read the original payload");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), PAYLOAD, "and the copy on disk is it");
});

test("a retry's check is told the retry's attempt", async () => {
  const out = outDir();
  // Fails on the first attempt, passes on the next: only the attempt differs.
  await seed(home, out, {
    retry: { attempts: 2, backoffSeconds: 0, retryOn: ["verification"] },
    checks: [
      {
        kind: "command",
        run: `node -e "process.exit(process.env.ARGUS_PHASE_ATTEMPT === '0' ? 1 : 0)"`,
        label: "attempt",
      },
      { kind: "command", run: recordInto(out), label: "record" },
    ],
  });
  const rec = recordingSpawn();
  const e = makeEngine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  await complete(e, inst.id, rec.runIds[0]);
  await e.drain();
  await waitFor(
    async () => (await readInstance(inst.id))!.phases[0].retryAt !== undefined,
    "the retry to be scheduled",
  );
  assert.equal(recordOf(out, "impl").ARGUS_PHASE_ATTEMPT, "0", "the first check saw attempt 0");

  await e.reconcile();
  await e.drain();
  await waitFor(() => rec.runIds.length === 2, "the retry's launch");
  await complete(e, inst.id, rec.runIds[1]);
  await e.drain();
  await waitFor(async () => (await readInstance(inst.id))!.status === "succeeded", "the retry");
  const after = (await readInstance(inst.id))!.phases[0];
  assert.equal(after.attempt, 1, "the phase is on its retry");
  assert.equal(recordOf(out, "impl").ARGUS_PHASE_ATTEMPT, "1", "and its check was told so");
});

test("an edited payload copy is put back before the next verification run, not between one run's checks", async () => {
  const out = outDir();
  const EDITED = { task: { id: "EDITED", files: ["*"] } };
  // The first attempt fails after a check edits the copy, as a check running
  // repository code could; the retry's run must read the payload again.
  await seed(home, out, {
    retry: { attempts: 2, backoffSeconds: 0, retryOn: ["verification"] },
    checks: [
      {
        kind: "command",
        run: `node -e "if(process.env.ARGUS_PHASE_ATTEMPT==='0')require('fs').writeFileSync(process.env.ARGUS_TRIGGER_PAYLOAD_FILE,JSON.stringify({task:{id:'EDITED',files:['*']}}))"`,
        label: "edit",
      },
      { kind: "command", run: recordInto(out), label: "record" },
      {
        kind: "command",
        run: `node -e "process.exit(process.env.ARGUS_PHASE_ATTEMPT === '0' ? 1 : 0)"`,
        label: "attempt",
      },
    ],
  });
  const rec = recordingSpawn();
  const e = makeEngine(rec.spawn);
  const inst = (await e.start("p1", "webhook", { triggerPayload: PAYLOAD }))!;
  await complete(e, inst.id, rec.runIds[0]);
  await e.drain();
  await waitFor(
    async () => (await readInstance(inst.id))!.phases[0].retryAt !== undefined,
    "the retry to be scheduled",
  );
  const first = recordOf(out, "impl");
  assert.equal(first.ARGUS_PHASE_ATTEMPT, "0", "the first run");
  assert.deepEqual(
    JSON.parse(first.payloadText!),
    EDITED,
    "a check listed after the edit reads the edited copy: nothing puts it back mid-run",
  );

  await e.reconcile();
  await e.drain();
  await waitFor(() => rec.runIds.length === 2, "the retry's launch");
  await complete(e, inst.id, rec.runIds[1]);
  await e.drain();
  await waitFor(async () => (await readInstance(inst.id))!.status === "succeeded", "the retry");
  const second = recordOf(out, "impl");
  assert.equal(second.ARGUS_PHASE_ATTEMPT, "1", "the retry's run");
  assert.deepEqual(JSON.parse(second.payloadText!), PAYLOAD, "which reads the payload again");
  const file = instanceTriggerPayloadPath(paths.invocationsDir(), inst.id);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), PAYLOAD, "and the copy on disk is it");
});
