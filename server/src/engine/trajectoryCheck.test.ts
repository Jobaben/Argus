import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEngine } from "../pipelineEngine.js";
import {
  createPipeline,
  PipelineValidationError,
  validatePipelineInput,
} from "../sources/pipelines.js";
import { readInstance } from "../sources/instances.js";
import { readRun } from "../sources/runs.js";
import { readJournal } from "../sources/journal.js";
import { paths } from "../claudeHome.js";
import { testRunToken } from "../testSignalToken.js";
import type { PipelineInstance } from "@argus/contracts";

/**
 * The deterministic trajectory PhaseCheck (Hardening Item 5), through the real
 * engine's verification lifecycle: the transcript is a real file the Recorder
 * reads, the check runs among the phase's checks, and its result decides the
 * phase as any check does. No model is involved anywhere here.
 */

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-trajectory-check-"));
  process.env.ARGUS_CLAUDE_HOME = home;
});

const MARKED = { last_assistant_message: "done\nARGUS_OUTCOME: succeeded" };
let counter = 0;

function engine() {
  const spawned: string[] = [];
  const e = createEngine({
    now: () => new Date(),
    newId: () => `t-${++counter}`,
    newSignalToken: testRunToken,
    signalUrlBase: "http://localhost:7777",
    maxConcurrent: 8,
    tickMs: 30000,
    killGraceMs: 600_000,
    kill: () => true,
    spawn: (run: { id: string }) => {
      spawned.push(run.id);
      return { pid: 999_999, done: new Promise<{ code: number | null }>(() => {}) };
    },
  } as any);
  return { e, spawned };
}

async function seed(phase: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return createPipeline(
    validatePipelineInput({ name: "tc", trigger: null, phases: [phase], ...over }),
    new Date(),
    "p1",
  );
}

/** Write the run's transcript where the Recorder reads it. */
async function transcript(runId: string, commands: string[]) {
  const run = (await readRun(runId))!.run;
  assert.ok(run.project && run.sessionId, "a Claude step run records its project and session");
  const dir = path.join(paths.projects(), run.project);
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  writeFileSync(
    path.join(dir, `${run.sessionId}.jsonl`),
    commands
      .map((command, i) =>
        JSON.stringify({
          type: "assistant",
          timestamp: new Date(t0 + i * 1000).toISOString(),
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: `u${i}`, name: "Bash", input: { command } }],
          },
        }),
      )
      .join("\n") + "\n",
  );
}

const complete = (e: any, inst: PipelineInstance, phaseId: string, runId: string) =>
  e.onSignal(inst.id, {
    instanceId: inst.id,
    phaseId,
    runId,
    type: "completed",
    token: testRunToken(runId),
    payload: MARKED,
  });

async function settle(e: any) {
  await e.drain();
  await new Promise((r) => setTimeout(r, 20));
  await e.drain();
}

const DESTRUCTIVE = { kind: "trajectory", thresholds: { "destructive-command": 0 } };
const phase = (checks: unknown[]) => ({
  id: "build",
  name: "build",
  cwd: home,
  gated: false,
  steps: [{ name: "s", prompt: "p" }],
  checks,
});

async function runOnce(checks: unknown[], commands: string[] | null) {
  await seed(phase(checks));
  const { e } = engine();
  const inst = (await e.start("p1", "manual"))!;
  const runId = (await readInstance(inst.id))!.phases[0].steps[0].runId!;
  if (commands) await transcript(runId, commands);
  await complete(e, inst, "build", runId);
  await settle(e);
  const after = (await readInstance(inst.id))!;
  return { after, report: after.phases[0].verification, inst };
}

test("a clean recorded trajectory passes the check and the phase succeeds", async () => {
  const { after, report } = await runOnce([DESTRUCTIVE], ["ls", "npm test"]);
  assert.equal(report?.status, "passed");
  assert.equal(report?.checks[0].kind, "trajectory");
  assert.equal(report?.checks[0].status, "passed");
  assert.match(report?.checks[0].detail ?? "", /within thresholds over 1 run/);
  assert.equal(after.status, "succeeded");
});

test("an observed violation fails the check, and the phase fails under `verification`", async () => {
  const { after, report } = await runOnce([DESTRUCTIVE], ["ls", "rm -rf build"]);
  assert.equal(report?.status, "failed");
  assert.equal(report?.checks[0].status, "failed");
  assert.match(report?.checks[0].detail ?? "", /observed: .*destructive-command 1 > 0/);
  assert.equal(after.phases[0].status, "failed");
  const payload = after.phases[0].payload as { failureClass?: string; reason?: string } | null;
  assert.equal(payload?.failureClass, "verification");
});

test("missing input is reported not-evaluated — never passed — and an optional check does not fail the phase", async () => {
  const { after, report, inst } = await runOnce([DESTRUCTIVE], null);
  assert.equal(report?.checks[0].status, "not-evaluated");
  assert.match(report?.checks[0].detail ?? "", /insufficient input: .*no readable/);
  assert.equal(report?.status, "passed", "only a failed check fails the report");
  assert.equal(after.status, "succeeded");
  const verified = (await readJournal(inst.id)).find((j: any) => j.kind === "phase.verified");
  assert.match(verified?.detail ?? "", /1 not evaluated/);
});

test("with requireTranscript, missing input fails the check as insufficient input", async () => {
  const { after, report } = await runOnce([{ ...DESTRUCTIVE, requireTranscript: true }], null);
  assert.equal(report?.checks[0].status, "failed");
  assert.match(report?.checks[0].detail ?? "", /^insufficient input/);
  assert.equal(after.phases[0].status, "failed");
});

test("a definition without the check is stored and verified exactly as before", async () => {
  const legacy = validatePipelineInput({
    name: "l",
    trigger: null,
    phases: [phase([{ kind: "command", run: "exit 0" }])],
  });
  assert.deepEqual(legacy.phases[0].checks, [{ kind: "command", run: "exit 0" }]);
  const { report, after } = await runOnce([{ kind: "command", run: "exit 0" }], ["rm -rf build"]);
  assert.deepEqual(
    report?.checks.map((c) => [c.kind, c.status]),
    [["command", "passed"]],
  );
  assert.equal(
    after.status,
    "succeeded",
    "no trajectory check, no trajectory verdict on the phase",
  );
});

test("authoring validation: thresholds are required, named and whole; requireTranscript is a boolean", () => {
  const bad: unknown[] = [
    { kind: "trajectory" },
    { kind: "trajectory", thresholds: {} },
    { kind: "trajectory", thresholds: { vibes: 0 } },
    { kind: "trajectory", thresholds: { errors: -1 } },
    { kind: "trajectory", thresholds: { errors: 1.5 } },
    { kind: "trajectory", thresholds: { errors: 10_001 } },
    { kind: "trajectory", thresholds: { errors: 1 }, requireTranscript: "yes" },
    { kind: "trajectory", thresholds: { errors: 1 }, model: "haiku" },
  ];
  for (const check of bad) {
    assert.throws(
      () => validatePipelineInput({ name: "x", trigger: null, phases: [phase([check])] }),
      PipelineValidationError,
      JSON.stringify(check),
    );
  }
  const ok = validatePipelineInput({
    name: "x",
    trigger: null,
    phases: [phase([{ kind: "trajectory", label: "no damage", thresholds: { errors: 3 } }])],
  });
  assert.deepEqual(ok.phases[0].checks, [
    { kind: "trajectory", thresholds: { errors: 3 }, label: "no damage" },
  ]);
});

const gitOk = (() => {
  try {
    return spawnSync("git", ["--version"]).status === 0;
  } catch {
    return false;
  }
})();

test("candidates: each candidate is checked on its own run, and a violating draft is never selected", async (t) => {
  if (!gitOk) return t.skip("git not available");
  const repo = mkdtempSync(path.join(tmpdir(), "argus-tc-repo-"));
  const git = (args: string[]) =>
    spawnSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=T", ...args], { cwd: repo });
  git(["init", "-q", "-b", "main"]);
  writeFileSync(path.join(repo, "README.md"), "x\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);
  await seed({
    id: "impl",
    name: "impl",
    cwd: repo,
    gated: false,
    workspace: { scope: "attempt" },
    candidates: { count: 2, select: "first-verified" },
    steps: [{ name: "code", prompt: "do it" }],
    checks: [DESTRUCTIVE],
  });
  const { e } = engine();
  const inst = (await e.start("p1", "manual"))!;
  const steps = (await readInstance(inst.id))!.phases[0].steps;
  const [c0, c1] = [steps[0].runId!, steps[1].runId!];
  await transcript(c1, ["git reset --hard HEAD"]);
  await transcript(c0, ["ls"]);
  await complete(e, inst, "impl", c1);
  await settle(e);
  const mid = (await readInstance(inst.id))!.phases[0];
  const v1 = mid.steps.find((s) => s.runId === c1)!.verification;
  assert.equal(v1?.status, "failed", "candidate 1 failed on its own trajectory");
  assert.match(v1?.checks[0].detail ?? "", new RegExp(`${c1}: destructive-command 1 > 0`));
  assert.equal(mid.selectedCandidate ?? null, null, "a failed draft is not selected");

  await complete(e, inst, "impl", c0);
  await settle(e);
  const after = (await readInstance(inst.id))!;
  assert.equal(after.phases[0].selectedCandidate, 0, "the clean draft is selected");
  const v0 = after.phases[0].steps.find((s) => s.runId === c0)!.verification;
  assert.equal(v0?.checks[0].status, "passed");
  assert.match(v0?.checks[0].detail ?? "", /over 1 run/, "judged on its own run only");
  assert.equal(after.status, "succeeded");
});
