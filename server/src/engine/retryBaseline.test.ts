/**
 * Which baseline a retried attempt's `changed-files` check is measured from.
 *
 * A retry that reuses the tree an earlier attempt already changed is judged on
 * what the phase changed, so the work the first attempt committed still counts
 * when the retry only re-runs the tests. A retry in a tree of its own, and a
 * revise (a request for new work), are judged on their own baseline.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fakeKill } from "../testPlatform.js";
import { createEngine } from "../pipelineEngine.js";
import { createPipeline, validatePipelineInput } from "../sources/pipelines.js";
import { readInstance } from "../sources/instances.js";
import { testRunToken } from "../testSignalToken.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-retry-baseline-"));
  process.env.ARGUS_CLAUDE_HOME = home;
});

const MARKED = { last_assistant_message: "done\nARGUS_OUTCOME: succeeded" };
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
  const dir = mkdtempSync(path.join(tmpdir(), "argus-retry-baseline-repo-"));
  git(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(dir, "README.md"), "base\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}
function commitChange(cwd: string): void {
  writeFileSync(path.join(cwd, "feature.txt"), "the work\n");
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-q", "-m", "the work"]);
}

function recordingSpawn() {
  const calls: { run: any }[] = [];
  const spawn = (run: any) => {
    calls.push({ run });
    return { pid: 4000 + calls.length, done: new Promise<{ code: number | null }>(() => {}) };
  };
  return { spawn, calls };
}
async function waitFor(cond: () => boolean | Promise<boolean>, ms = 10_000) {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
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

/**
 * An implementation phase whose build check fails until `marker` exists — an
 * environmental failure outside the tree, like a container daemon that is down.
 */
async function seedImplement(repo: string, marker: string, over: Record<string, unknown>) {
  const exists = `node -e "process.exit(require('fs').existsSync('${marker.replace(/\\/g, "/")}') ? 0 : 1)"`;
  return createPipeline(
    validatePipelineInput({
      name: "retry-baseline",
      trigger: null,
      phases: [
        {
          id: "impl",
          name: "Implement",
          cwd: repo,
          gated: false,
          steps: [{ name: "code", prompt: "implement it" }],
          checks: [
            { kind: "changed-files", requireChanges: true, label: "has-changes" },
            { kind: "command", run: exists, label: "build" },
          ],
          ...over,
        },
      ],
    }),
    new Date(2026, 9, 4, 9, 0),
    "p1",
  );
}

/** Start the phase; its first attempt commits the work and fails `build`. */
async function firstAttemptCommitsAndFailsBuild(over: Record<string, unknown>) {
  let now = new Date(2026, 9, 4, 12, 0);
  const repo = makeRepo();
  const marker = path.join(mkdtempSync(path.join(tmpdir(), "argus-retry-env-")), "docker-up");
  await seedImplement(repo, marker, over);
  const rec = recordingSpawn();
  const e = createEngine({
    spawn: rec.spawn,
    now: () => now,
    newId: () => `rb-${++counter}`,
    newSignalToken: testRunToken,
    signalUrlBase: "http://localhost:7777",
    maxConcurrent: 8,
    tickMs: 30000,
    kill: fakeKill().kill,
  } as any);
  const inst = (await e.start("p1", "manual"))!;

  commitChange(rec.calls[0].run.cwd);
  await complete(e, inst.id, rec.calls[0].run.id);
  await e.drain();
  await waitFor(async () => (await readInstance(inst.id))!.phases[0].status === "failed");
  const first = (await readInstance(inst.id))!.phases[0];
  assert.equal(first.verification?.checks.find((c) => c.label === "has-changes")?.status, "passed");
  assert.equal(first.verification?.checks.find((c) => c.label === "build")?.status, "failed");
  return {
    e,
    repo,
    instanceId: inst.id,
    cwds: () => rec.calls.map((c) => c.run.cwd as string),
    /** The environment is fixed: `build` passes from now on. */
    fixBuild: () => {
      writeFileSync(marker, "");
      assert.ok(existsSync(marker));
    },
    /** Start the next attempt with `begin`, let it change nothing, and return
     *  the phase once that attempt is verified. */
    async nextAttemptChangesNothing(begin: () => Promise<unknown>) {
      const before = rec.calls.length;
      now = new Date(now.getTime() + 1000);
      await begin();
      await e.drain();
      await waitFor(() => rec.calls.length === before + 1);
      await complete(e, inst.id, rec.calls[before].run.id);
      await e.drain();
      await waitFor(async () => {
        const s = (await readInstance(inst.id))!.phases[0].status;
        return s === "succeeded" || s === "failed";
      });
      return (await readInstance(inst.id))!.phases[0];
    },
  };
}

const retryOnVerification = {
  retry: { attempts: 2, backoffSeconds: 0, retryOn: ["verification"] },
};
const hasChanges = (phase: any) =>
  phase.verification?.checks.find((c: any) => c.label === "has-changes");

test("a retry in the tree the first attempt changed is judged on what the phase changed", async (t) => {
  if (!gitAvailable()) return t.skip("git not available");
  const h = await firstAttemptCommitsAndFailsBuild({
    workspace: { scope: "instance" },
    ...retryOnVerification,
  });
  h.fixBuild();
  const phase = await h.nextAttemptChangesNothing(() => h.e.reconcile());
  const [first, retry] = h.cwds();
  assert.equal(first, retry, "the instance-scoped tree carries over");
  assert.equal(phase.attempt, 1);
  assert.equal(phase.baselineAttempt, 0);
  assert.equal(phase.status, "succeeded", JSON.stringify(phase.verification));
  assert.equal(hasChanges(phase)?.status, "passed");
  assert.match(hasChanges(phase)?.output ?? "", /feature\.txt/);
});

test("a retry with no workspace runs in the phase's own cwd and is judged the same way", async (t) => {
  if (!gitAvailable()) return t.skip("git not available");
  const h = await firstAttemptCommitsAndFailsBuild(retryOnVerification);
  h.fixBuild();
  const phase = await h.nextAttemptChangesNothing(() => h.e.reconcile());
  assert.equal(phase.status, "succeeded", JSON.stringify(phase.verification));
  assert.equal(hasChanges(phase)?.status, "passed");
});

test("a retry in a fresh attempt-scoped tree is judged on its own baseline", async (t) => {
  if (!gitAvailable()) return t.skip("git not available");
  const h = await firstAttemptCommitsAndFailsBuild({
    workspace: { scope: "attempt" },
    ...retryOnVerification,
  });
  h.fixBuild();
  // The base moves on before the retry's tree is cut from it: measured from
  // the first attempt's baseline, that unrelated commit would count as work.
  commitChange(h.repo);
  const phase = await h.nextAttemptChangesNothing(() => h.e.reconcile());
  const [first, retry] = h.cwds();
  assert.notEqual(first, retry, "each attempt has a tree of its own");
  assert.equal(phase.status, "failed");
  assert.equal(hasChanges(phase)?.status, "failed");
  assert.equal(hasChanges(phase)?.detail, "no files changed");
});

test("a revise asks for new work, so it is judged on its own baseline", async (t) => {
  if (!gitAvailable()) return t.skip("git not available");
  const h = await firstAttemptCommitsAndFailsBuild({
    workspace: { scope: "instance" },
    ...retryOnVerification,
  });
  // The retry still finds `build` broken and exhausts the retry budget.
  const retried = await h.nextAttemptChangesNothing(() => h.e.reconcile());
  assert.equal(retried.attempt, 1);
  assert.equal(retried.baselineAttempt, 0);
  assert.equal(retried.status, "failed");
  assert.ok(!retried.retryAt);
  assert.equal(hasChanges(retried)?.status, "passed");

  h.fixBuild();
  const revised = await h.nextAttemptChangesNothing(async () => {
    assert.equal((await h.e.revise(h.instanceId, "again", { phaseId: "impl" })).code, 200);
  });
  assert.equal(revised.attempt, 2);
  assert.equal(revised.baselineAttempt, undefined);
  assert.equal(revised.status, "failed");
  assert.equal(hasChanges(revised)?.detail, "no files changed");
});
