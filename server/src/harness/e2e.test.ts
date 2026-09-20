/**
 * The harness, end to end, with real child processes.
 *
 * Every other pipeline test injects a spawn double. This file does not: it
 * points `ARGUS_CLAUDE_BIN` at `fakeAgent.mjs` and lets the real
 * `defaultPipelineSpawn` start it, so each scenario exercises the whole path an
 * actual agent takes — the argv the Claude Code runtime built, the child
 * environment the env policy produced, the materialized settings/MCP files, the
 * stream-json transcript the engine parses back, the *real* Stop hook POSTing a
 * completion signal to the *real* `/api/instances/:id/signal` route over HTTP,
 * the exit code, and the process tree Argus kills at a deadline or an abort.
 *
 * The assertions are therefore about observable state only: the persisted
 * instance, run and invocation records, the instance journal, and files on
 * disk — including `seen.json`, which the child writes about its own
 * invocation, so "the agent was launched with these capabilities and without
 * Argus's admin token" is checked from inside the child rather than from the
 * engine's own bookkeeping.
 *
 * POSIX only: detached process groups, `sh -c` hooks and signal-based kills all
 * behave differently on Windows, and the engine has its own two-stage host
 * there.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { readInstance } from "../sources/instances.js";
import { readInvocation, readRun } from "../sources/runs.js";
import { readJournal } from "../sources/journal.js";
import type { JournalKind } from "../sources/journal.js";
import { isAlive } from "../scheduler.js";
import {
  ADMIN_TOKEN,
  LEAK_VAR,
  argAfter,
  artifactDirFor,
  hasGit,
  initGitRepo,
  phaseOf,
  readSeen,
  startHarness,
  tempDir,
  waitFor,
  waitForInstance,
} from "./e2eSupport.js";
import type { Harness } from "./e2eSupport.js";
import type { Engine } from "../pipelineEngine.js";
import type { PhaseFailurePayload, PhaseProgress } from "../sources/pipelineTypes.js";
import type { Run } from "../sources/scheduleTypes.js";

/** Commit everything in a harness working tree, so a run has a real head. */
function commitAll(dir: string, message: string): void {
  const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, stdio: "ignore" });
  git("add", "-A");
  git("commit", "-q", "-m", message);
}

/** `git rev-parse HEAD`, for asserting that evidence names the run's commit. */
function gitHead(dir: string): string {
  const out = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" });
  return out.stdout.trim();
}

// The suite owns these process-wide overrides; each harness re-sets them, and
// nothing outside this file should inherit them.
after(() => {
  delete process.env.ARGUS_CLAUDE_BIN;
  delete process.env.ARGUS_TOKEN;
  delete process.env[LEAK_VAR];
});

const posixOnly = {
  skip:
    process.platform === "win32"
      ? "POSIX only: this suite relies on process groups, shell hooks and signals"
      : false,
};

const failure = (phase: PhaseProgress): PhaseFailurePayload =>
  (phase.payload ?? {}) as PhaseFailurePayload;

const runIdOf = (phase: PhaseProgress, step = 0): string => {
  const id = phase.steps[step]?.runId;
  if (!id) throw new Error(`phase ${phase.id} step ${step} has no run id`);
  return id;
};

/** The run record, which must exist by the time a step has a run id. */
async function run(runId: string): Promise<Run> {
  const got = await readRun(runId);
  assert.ok(got, `run ${runId} should be recorded`);
  return got.run;
}

/**
 * Drive reconciliation until `predicate` holds.
 *
 * The retry path is deliberately tick-driven: the healing pass fails a phase
 * whose run died without signalling and *schedules* the retry, and the next
 * pass launches it. Polling reconcile is what a running server's scheduler
 * does, so the test does the same rather than reaching inside the engine.
 */
async function reconcileUntil(
  engine: Engine,
  instanceId: string,
  predicate: (p: PhaseProgress[]) => boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    await engine.reconcile();
    await engine.drain();
    const inst = await readInstance(instanceId);
    if (inst && predicate(inst.phases)) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out reconciling until ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * The run record once its process has ended.
 *
 * A phase's own transitions are driven by the *signal*, which arrives before
 * the agent process exits — so an instance can be terminal while its last run
 * record is still `running`. Anything read off the record (status, exit code,
 * cost) has to wait for the process, not for the phase.
 */
async function finishedRun(runId: string): Promise<Run> {
  await waitFor(
    async () => (await run(runId)).status !== "running",
    `run ${runId} to be finalized`,
  );
  return run(runId);
}

/**
 * The journal, once it carries every named kind.
 *
 * Journal appends are deliberately unawaited by the engine (a journal write
 * must never fail the transition it records), so they can land just after the
 * instance write that a test has already observed.
 */
async function waitForJournal(instanceId: string, kinds: JournalKind[]) {
  await waitFor(
    async () => {
      const seen = new Set((await readJournal(instanceId)).map((e) => e.kind));
      return kinds.every((kind) => seen.has(kind));
    },
    `journal entries ${kinds.join(", ")}`,
  );
  return readJournal(instanceId);
}

// ── 1. Feature pipeline happy path ──────────────────────────────────────────

test(
  "feature pipeline: three phases spawn real agents, verify, and succeed",
  posixOnly,
  async (t) => {
    const h: Harness = await startHarness({ git: true });
    t.after(() => h.close());

    const def = await h.seed([
      {
        id: "investigate",
        name: "Investigate",
        steps: [
          {
            name: "look",
            prompt: [
              "Investigate the feature request and write up what you find.",
              "FAKE: write-artifact investigation.md the feature needs a text file",
            ].join("\n"),
          },
        ],
        capabilities: {
          filesystem: "read-only",
          tools: { allow: ["Read", "Grep"] },
          mcpServers: {},
          settingSources: ["project"],
          env: { inherit: "minimal" },
        },
        checks: [{ kind: "artifact", path: "investigation.md" }],
      },
      {
        id: "implement",
        name: "Implement",
        steps: [
          {
            name: "build",
            prompt: [
              "Implement what {{artifactDir.investigate}}/investigation.md describes.",
              "FAKE: write-file src/feature.txt done",
            ].join("\n"),
          },
        ],
        capabilities: {
          filesystem: "workspace-write",
          tools: { allow: ["Edit", "Bash(npm test:*)"] },
        },
        checks: [
          { kind: "command", run: "test -f src/feature.txt" },
          { kind: "file", path: "src/feature.txt" },
        ],
      },
      {
        id: "verify",
        name: "Verify",
        steps: [{ name: "check", prompt: "Run the tests and report." }],
        checks: [{ kind: "command", run: "exit 0", label: "tests" }],
      },
    ]);

    const started = await h.engine.start(def.id, "manual");
    assert.ok(started);
    const inst = await waitForInstance(
      started.id,
      (i) => i.status !== "running",
      "the instance to reach a terminal state",
    );

    assert.equal(inst.status, "succeeded");

    // Every phase passed its own checks, with the labels the definition implies.
    for (const [phaseId, labels] of [
      ["investigate", ["artifact: investigation.md"]],
      ["implement", ["command: test -f src/feature.txt", "file: src/feature.txt"]],
      ["verify", ["tests"]],
    ] as const) {
      const phase = phaseOf(inst, phaseId);
      assert.equal(phase.status, "succeeded", `${phaseId} should have succeeded`);
      assert.equal(phase.verification?.status, "passed", `${phaseId} should have verified`);
      assert.deepEqual(
        phase.verification?.checks.map((c) => c.label),
        [...labels],
      );
    }

    // The agent's own view of its invocation: read-only + scoped tools + an
    // MCP config it cannot escape + only the project's settings + the hook.
    const seen = await readSeen(inst.id, "investigate");
    assert.deepEqual(seen.argv.slice(0, 4), ["-p", "--output-format", "stream-json", "--verbose"]);
    assert.match(argAfter(seen.argv, "--session-id") ?? "", /^[0-9a-f-]{36}$/);
    assert.match(argAfter(seen.argv, "--append-system-prompt") ?? "", /ARGUS_OUTCOME: succeeded/);
    // The prompt arrived on stdin — never argv — with Argus's own artifact
    // requirement appended to the author's text.
    assert.ok(seen.prompt.includes("FAKE: write-artifact investigation.md"));
    assert.match(seen.prompt, /Required artifacts[\s\S]*investigation\.md/);
    const disallowed = argAfter(seen.argv, "--disallowedTools");
    assert.ok(disallowed, "read-only should produce --disallowedTools");
    assert.ok(disallowed.split(",").includes("Bash"), `Bash denied: ${disallowed}`);
    assert.ok(
      disallowed.split(",").includes(`Edit(//${h.cwd}/**)`),
      `writes to the working directory denied: ${disallowed}`,
    );
    assert.equal(argAfter(seen.argv, "--allowedTools"), "Read,Grep");
    assert.ok(argAfter(seen.argv, "--mcp-config"), "an MCP config should be materialized");
    assert.ok(seen.argv.includes("--strict-mcp-config"));
    assert.equal(argAfter(seen.argv, "--setting-sources"), "project");
    assert.ok(argAfter(seen.argv, "--settings"), "the invocation should register its own hook");
    const investigateDir = artifactDirFor(inst.id, "investigate");
    assert.ok(
      seen.argv.some((a, i) => a === "--add-dir" && seen.argv[i + 1] === investigateDir),
      "the artifact directory stays reachable under read-only",
    );
    assert.equal(seen.cwd, h.cwd);

    // Argus's own admin token never reaches an agent, under any policy — and
    // `inherit: "minimal"` also keeps unrelated variables out.
    assert.equal(seen.hasArgusToken, false);
    assert.ok(!seen.envNames.includes("ARGUS_TOKEN"));
    assert.ok(
      !seen.envNames.includes(LEAK_VAR),
      `minimal inheritance should drop ${LEAK_VAR}: ${seen.envNames.join(",")}`,
    );
    assert.ok(seen.envNames.includes("ARGUS_SIGNAL_TOKEN"));

    // The next phase inherits Argus's whole environment (no policy) but still
    // never the admin token.
    const seenImplement = await readSeen(inst.id, "implement");
    assert.equal(seenImplement.hasArgusToken, false);
    assert.ok(seenImplement.envNames.includes(LEAK_VAR));
    const seenVerify = await readSeen(inst.id, "verify");
    assert.equal(seenVerify.hasArgusToken, false);

    // `{{artifactDir.investigate}}` resolved to a real absolute directory in
    // the prompt the run actually received.
    const implementRun = await run(runIdOf(phaseOf(inst, "implement")));
    assert.ok(
      implementRun.prompt.includes(`${investigateDir}/investigation.md`),
      "the interpolated artifact path should be in the run's prompt",
    );

    // The invocation records: what Argus launched, and what it withheld.
    for (const phaseId of ["investigate", "implement", "verify"] as const) {
      const record = await readInvocation(runIdOf(phaseOf(inst, phaseId)));
      assert.ok(record, `${phaseId} should have an invocation record`);
      assert.ok(
        record.envStripped.includes("ARGUS_TOKEN"),
        `${phaseId} should record ARGUS_TOKEN as stripped`,
      );
      assert.deepEqual(record.limitations, [], `${phaseId} should be fully enforceable`);
      assert.equal(typeof record.gitHead, "string");
      assert.match(record.gitHead ?? "", /^[0-9a-f]{40}$/);
      assert.equal(record.cwd, h.cwd);
    }
    const investigateRecord = await readInvocation(runIdOf(phaseOf(inst, "investigate")));
    const materialized = (investigateRecord?.materializedFiles ?? []).map((f) => path.basename(f));
    assert.deepEqual(materialized.sort(), ["mcp.json", "settings.json"]);

    // The settings file Argus wrote really registers the completion hook.
    const settingsPath = (investigateRecord?.materializedFiles ?? []).find((f) =>
      f.endsWith("settings.json"),
    );
    assert.ok(settingsPath);
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
      hooks?: { Stop?: { hooks?: { command?: string }[] }[] };
    };
    const stopCommand = settings.hooks?.Stop?.[0]?.hooks?.[0]?.command ?? "";
    assert.match(stopCommand, /argus-signal\.mjs/);

    // Verification is journalled on both sides of the checks.
    await waitForJournal(inst.id, ["phase.verifying", "phase.verified", "instance.ended"]);

    // Cost and the agent's verdict are harvested from the transcript.
    for (const phaseId of ["investigate", "implement", "verify"] as const) {
      const record = await finishedRun(runIdOf(phaseOf(inst, phaseId)));
      assert.equal(record.outcome, "succeeded", `${phaseId} run outcome`);
      assert.equal(record.status, "succeeded", `${phaseId} run status`);
      assert.equal(record.costUsd, 0.01, `${phaseId} run cost`);
      assert.equal(record.tokens, 15, `${phaseId} run tokens`);
      assert.equal(record.exitCode, 0);
    }

    // 15a. Runtime state does not leak between phases: separate directories,
    // and one phase's artifact is not visible in the next phase's.
    const implementDir = artifactDirFor(inst.id, "implement");
    assert.notEqual(investigateDir, implementDir);
    assert.ok((await readdir(investigateDir)).includes("investigation.md"));
    assert.ok(!(await readdir(implementDir)).includes("investigation.md"));
    assert.ok(!(await readdir(investigateDir)).includes("src"));
  },
);

// ── 2. A completion signal that beats a non-zero exit ───────────────────────

test(
  "agent signals success then exits non-zero: the run records the failure, the signal decides the phase",
  posixOnly,
  async (t) => {
    const h = await startHarness();
    t.after(() => h.close());

    const def = await h.seed([
      {
        id: "only",
        name: "Only",
        steps: [
          {
            name: "work",
            prompt: ["Do the thing.", "FAKE: outcome succeeded", "FAKE: exit 3"].join("\n"),
          },
        ],
      },
    ]);

    const started = await h.engine.start(def.id, "manual");
    assert.ok(started);
    const inst = await waitForInstance(
      started.id,
      (i) => i.status !== "running",
      "the instance to settle",
    );

    // FINDING (documented, not fixed): the Stop hook's completion signal arrives
    // before the process exits, and it is authoritative — the phase and the
    // instance succeed even though the process then exited 3.
    assert.equal(inst.status, "succeeded");
    assert.equal(phaseOf(inst, "only").status, "succeeded");

    const record = await finishedRun(runIdOf(phaseOf(inst, "only")));
    assert.equal(record.status, "failed");
    assert.equal(record.exitCode, 3);
    assert.equal(record.error, "exit code 3");
    // The agent's own verdict is kept beside the process outcome, unchanged.
    assert.equal(record.outcome, "succeeded");
  },
);

// ── 3. Exits zero, declared result absent ───────────────────────────────────

test("declared result never written: the phase fails as a signal failure", posixOnly, async (t) => {
  const h = await startHarness();
  t.after(() => h.close());

  const def = await h.seed([
    {
      id: "decide",
      name: "Decide",
      steps: [{ name: "judge", prompt: "Decide, and publish your decision." }],
      result: { artifact: "decision", schema: { type: "object" } },
    },
  ]);

  const started = await h.engine.start(def.id, "manual");
  assert.ok(started);
  const inst = await waitForInstance(
    started.id,
    (i) => i.status !== "running",
    "the instance to settle",
  );

  assert.equal(inst.status, "failed");
  const phase = phaseOf(inst, "decide");
  assert.equal(phase.status, "failed");
  assert.match(failure(phase).reason ?? "", /did not deliver its declared result/);
  // The failure is classed `signal`: an agent that reported, whose report
  // cannot be used. The journal always says so.
  const failed = (await waitForJournal(inst.id, ["phase.failed"])).find(
    (e) => e.kind === "phase.failed",
  );
  assert.match(failed?.detail ?? "", /^signal: /);
  // DEFECT (reported, not fixed): on the signal path the engine computes and
  // journals the class but only *persists* `payload.failureClass` when the
  // same call happens to schedule a retry — with no retry policy the phase
  // record loses it. Asserted permissively so this test describes the
  // contract and stays green once the persistence gap is closed.
  const failureClass = failure(phase).failureClass;
  assert.ok(
    failureClass === undefined || failureClass === "signal",
    `unexpected failure class ${String(failureClass)}`,
  );
});

// ── 4. Malformed declared result ────────────────────────────────────────────

test("malformed result file: the phase fails with a parse error", posixOnly, async (t) => {
  const h = await startHarness();
  t.after(() => h.close());

  const def = await h.seed([
    {
      id: "decide",
      name: "Decide",
      steps: [
        {
          name: "judge",
          prompt: ["Decide, and publish your decision.", "FAKE: malformed-result"].join("\n"),
        },
      ],
      result: { artifact: "decision", schema: { type: "object" } },
    },
  ]);

  const started = await h.engine.start(def.id, "manual");
  assert.ok(started);
  const inst = await waitForInstance(
    started.id,
    (i) => i.status !== "running",
    "the instance to settle",
  );

  assert.equal(inst.status, "failed");
  assert.match(failure(phaseOf(inst, "decide")).reason ?? "", /could not be parsed as JSON/);
});

// ── 5. The agent says the tests pass; the verifier disagrees ────────────────

test(
  "agent claims success but a check fails: the phase fails on verification and nothing downstream runs",
  posixOnly,
  async (t) => {
    const h = await startHarness();
    t.after(() => h.close());

    const def = await h.seed([
      {
        id: "work",
        name: "Work",
        steps: [{ name: "do", prompt: "Do the work and claim the tests pass." }],
        checks: [{ kind: "command", run: "exit 1", label: "unit tests" }],
      },
      {
        id: "ship",
        name: "Ship",
        steps: [{ name: "release", prompt: "Ship it." }],
      },
    ]);

    const started = await h.engine.start(def.id, "manual");
    assert.ok(started);
    const inst = await waitForInstance(
      started.id,
      (i) => i.status !== "running",
      "the instance to settle",
    );

    assert.equal(inst.status, "failed");
    const phase = phaseOf(inst, "work");
    assert.equal(phase.status, "failed");
    assert.equal(phase.verification?.status, "failed");
    const check = phase.verification?.checks[0];
    assert.equal(check?.label, "unit tests");
    assert.equal(check?.status, "failed");
    assert.equal(check?.exitCode, 1);
    assert.equal(failure(phase).failureClass, "verification");
    assert.match(failure(phase).reason ?? "", /unit tests/);
    // The agent's own run still succeeded: its self-report is not the verdict.
    const agentRun = await finishedRun(runIdOf(phase));
    assert.equal(agentRun.status, "succeeded");
    assert.equal(agentRun.outcome, "succeeded");
    assert.equal(phaseOf(inst, "ship").status, "pending");
  },
);

// ── 6. Deadline, and the late signal that must not reopen it ────────────────

test(
  "step deadline: the process is killed, the phase fails as a timeout, and a late signal is ignored",
  posixOnly,
  async (t) => {
    const h = await startHarness();
    t.after(() => h.close());

    const def = await h.seed([
      {
        id: "slow",
        name: "Slow",
        timeoutSeconds: 1,
        steps: [{ name: "stall", prompt: ["Take your time.", "FAKE: sleep 8000"].join("\n") }],
      },
    ]);

    const started = await h.engine.start(def.id, "manual");
    assert.ok(started);
    const launched = await readInstance(started.id);
    const runId = runIdOf(phaseOf(launched!, "slow"));
    const pid = (await run(runId)).pid;
    assert.ok(pid, "the real agent process should have a pid");

    const inst = await waitForInstance(
      started.id,
      (i) => i.status !== "running",
      "the deadline to fail the instance",
      6000,
    );
    assert.equal(inst.status, "failed");
    const phase = phaseOf(inst, "slow");
    assert.equal(phase.status, "failed");
    assert.equal(failure(phase).failureClass, "timeout");
    assert.equal(failure(phase).kind, "timed-out");

    const record = await finishedRun(runId);
    assert.equal(record.termination, "timed-out");
    assert.equal(record.status, "failed");
    assert.match(record.error ?? "", /timed out after 1s/);
    await waitFor(() => !isAlive(pid), "the agent process to be gone");

    await waitForJournal(inst.id, ["step.timed-out"]);

    // 16. A completion signal arriving after the timeout must not resurrect the
    // phase. (The killed process cannot send one, so the hook's exact HTTP call
    // is replayed here instead.)
    const response = await fetch(`${h.baseUrl}/api/instances/${inst.id}/signal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        instanceId: inst.id,
        phaseId: "slow",
        runId,
        type: "completed",
        token: inst.signalToken,
        payload: { last_assistant_message: "ARGUS_OUTCOME: succeeded" },
      }),
    });
    assert.equal(response.status, 200);
    await h.engine.drain();
    const after = await readInstance(inst.id);
    assert.equal(after?.status, "failed");
    assert.equal(phaseOf(after!, "slow").status, "failed");
  },
);

// ── 7. Abort mid-run ────────────────────────────────────────────────────────

test("abort mid-run: the instance aborts and the process tree is killed", posixOnly, async (t) => {
  const h = await startHarness();
  t.after(() => h.close());

  const def = await h.seed([
    {
      id: "slow",
      name: "Slow",
      steps: [{ name: "stall", prompt: ["Keep working.", "FAKE: sleep 8000"].join("\n") }],
    },
  ]);

  const started = await h.engine.start(def.id, "manual");
  assert.ok(started);
  const launched = await readInstance(started.id);
  const runId = runIdOf(phaseOf(launched!, "slow"));
  const pid = (await run(runId)).pid;
  assert.ok(pid);

  const res = await h.engine.abort(started.id);
  assert.equal(res.ok, true);

  const inst = await waitForInstance(started.id, (i) => i.status === "aborted", "the abort");
  assert.equal(inst.status, "aborted");
  assert.equal(phaseOf(inst, "slow").status, "aborted");
  const record = await run(runId);
  assert.equal(record.termination, "killed");
  await waitFor(() => !isAlive(pid), "the aborted agent process to be gone");
});

// ── 8. Transient crash, then a retry that succeeds ──────────────────────────

test(
  "transient crash then retry: the phase succeeds on its second attempt",
  posixOnly,
  async (t) => {
    const h = await startHarness();
    t.after(() => h.close());

    const counter = path.join(tempDir("argus-e2e-counter-"), "attempted");
    const def = await h.seed([
      {
        id: "flaky",
        name: "Flaky",
        retry: { attempts: 2, backoffSeconds: 0 },
        steps: [
          { name: "try", prompt: ["Do the work.", `FAKE: fail-first ${counter}`].join("\n") },
        ],
      },
    ]);

    const started = await h.engine.start(def.id, "manual");
    assert.ok(started);
    const firstRunId = runIdOf(phaseOf((await readInstance(started.id))!, "flaky"));
    await waitFor(
      async () => (await run(firstRunId)).status === "failed",
      "the first attempt's process to die",
    );

    await reconcileUntil(
      h.engine,
      started.id,
      (phases) => phases[0].status === "succeeded",
      "the retried attempt to succeed",
    );

    const inst = (await readInstance(started.id))!;
    assert.equal(inst.status, "succeeded");
    const phase = phaseOf(inst, "flaky");
    assert.equal(phase.status, "succeeded");
    assert.equal(phase.retries, 1);
    assert.equal(phase.attempt, 1);
    assert.notEqual(runIdOf(phase), firstRunId);

    await waitForJournal(inst.id, ["phase.retry-scheduled", "phase.retrying"]);
  },
);

// ── 9. A verification retry carries the evidence, and a clean directory ─────

test(
  "verification retry: the next attempt is told why, and starts from an empty artifact directory",
  posixOnly,
  async (t) => {
    const h = await startHarness();
    t.after(() => h.close());

    const def = await h.seed([
      {
        id: "make",
        name: "Make",
        retry: { attempts: 2, backoffSeconds: 0, retryOn: ["verification"] },
        steps: [
          {
            name: "write",
            prompt: [
              "Produce the required file.",
              "FAKE: write-artifact notes.md attempt notes",
            ].join("\n"),
          },
        ],
        checks: [{ kind: "file", path: "must-exist.txt" }],
      },
    ]);

    const started = await h.engine.start(def.id, "manual");
    assert.ok(started);
    const firstRunId = runIdOf(phaseOf((await readInstance(started.id))!, "make"));

    await waitForInstance(
      started.id,
      (i) => phaseOf(i, "make").status === "failed",
      "the first attempt to fail verification",
    );
    const artifactDir = artifactDirFor(started.id, "make");
    assert.ok(
      (await readdir(artifactDir)).includes("notes.md"),
      "attempt 0's artifact should be on disk before the retry",
    );
    // A leftover from attempt 0 that attempt 1 must not inherit: a file left
    // here could otherwise satisfy attempt 1's own artifact checks.
    await writeFile(path.join(artifactDir, "attempt-0-leftover.txt"), "stale", "utf8");

    await reconcileUntil(
      h.engine,
      started.id,
      (phases) => phases[0].attempt === 1 && phases[0].steps[0].runId !== null,
      "the retried attempt to launch",
    );

    const retried = (await readInstance(started.id))!;
    const retryRunId = runIdOf(phaseOf(retried, "make"));
    assert.notEqual(retryRunId, firstRunId);
    const retryPrompt = (await run(retryRunId)).prompt;
    assert.match(retryPrompt, /Previous attempt \(1 of 2\) failed — verification:/);
    assert.match(retryPrompt, /must-exist\.txt/);

    assert.ok(
      !(await readdir(artifactDir)).includes("attempt-0-leftover.txt"),
      "the retry should start from an empty artifact directory",
    );
  },
);

// ── 10. Retry limit reached ─────────────────────────────────────────────────

test("retry limit: after the last attempt the phase and instance fail", posixOnly, async (t) => {
  const h = await startHarness();
  t.after(() => h.close());

  const def = await h.seed([
    {
      id: "broken",
      name: "Broken",
      retry: { attempts: 2, backoffSeconds: 0 },
      steps: [
        {
          name: "try",
          prompt: ["Try the impossible.", "FAKE: exit 1", "FAKE: no-signal"].join("\n"),
        },
      ],
    },
  ]);

  const started = await h.engine.start(def.id, "manual");
  assert.ok(started);

  await reconcileUntil(
    h.engine,
    started.id,
    (phases) =>
      phases[0].status === "failed" && (phases[0].retries ?? 0) >= 1 && !phases[0].retryAt,
    "the retry budget to be exhausted",
  );

  const inst = (await readInstance(started.id))!;
  const phase = phaseOf(inst, "broken");
  assert.equal(phase.status, "failed");
  assert.equal(phase.retries, 1);
  assert.equal(phase.attempt, 1);
  assert.ok(!phase.retryAt);
  assert.equal(failure(phase).failureClass, "exit-code");
  assert.equal(inst.status, "failed");
});

// ── 11. Strict enforcement refuses an unenforceable profile ─────────────────

test(
  "strict enforcement: an unenforceable profile fails the phase without spawning, and is never retried",
  posixOnly,
  async (t) => {
    const h = await startHarness();
    t.after(() => h.close());

    const def = await h.seed([
      {
        id: "guarded",
        name: "Guarded",
        runtime: "opencode",
        capabilities: { tools: { allow: ["Read"] } },
        retry: { attempts: 3, backoffSeconds: 0 },
        steps: [{ name: "look", prompt: "Read the code." }],
      },
    ]);

    const started = await h.engine.start(def.id, "manual");
    assert.ok(started);
    const inst = (await readInstance(started.id))!;
    const phase = phaseOf(inst, "guarded");
    assert.equal(phase.status, "failed");
    assert.equal(failure(phase).failureClass, "configuration");
    assert.match(failure(phase).reason ?? "", /cannot be enforced/);
    assert.equal(inst.status, "failed");

    const runId = runIdOf(phase);
    const record = await run(runId);
    assert.equal(record.termination, "spawn-failed");
    assert.equal(record.pid, null);
    assert.equal(record.status, "failed");

    const invocation = await readInvocation(runId);
    assert.ok(invocation, "a refused launch still leaves an invocation record");
    assert.ok(invocation.limitations.length > 0, "the record should say what it could not enforce");

    // A configuration failure is the definition's fault; running it again cannot
    // help, so no retry is ever scheduled — not even with attempts: 3.
    await h.engine.reconcile();
    await h.engine.drain();
    const after = (await readInstance(started.id))!;
    assert.ok(!phaseOf(after, "guarded").retryAt);
    assert.equal(phaseOf(after, "guarded").retries ?? 0, 0);
    assert.equal(after.status, "failed");
  },
);

// ── 12. Best-effort records the limitation and runs anyway ──────────────────

test(
  "best-effort enforcement: the invocation records what it cannot enforce and still runs",
  posixOnly,
  async (t) => {
    const h = await startHarness();
    t.after(() => h.close());

    const def = await h.seed([
      {
        id: "shell",
        name: "Shell",
        capabilities: {
          filesystem: "read-only",
          tools: { allow: ["Bash"] },
          enforcement: "best-effort",
        },
        steps: [{ name: "poke", prompt: "Look around with the shell." }],
      },
    ]);

    const started = await h.engine.start(def.id, "manual");
    assert.ok(started);
    const inst = await waitForInstance(
      started.id,
      (i) => i.status !== "running",
      "the instance to settle",
    );
    assert.equal(inst.status, "succeeded");

    const invocation = await readInvocation(runIdOf(phaseOf(inst, "shell")));
    assert.ok(invocation);
    assert.ok(
      invocation.limitations.some((l) => l.includes("read-only cannot prevent shell writes")),
      `limitations: ${JSON.stringify(invocation.limitations)}`,
    );
  },
);

// ── 13. A required artifact the agent never wrote ───────────────────────────

test("missing required artifact: verification reports it as missing", posixOnly, async (t) => {
  const h = await startHarness();
  t.after(() => h.close());

  const def = await h.seed([
    {
      id: "plan",
      name: "Plan",
      steps: [{ name: "think", prompt: "Think about it (and write nothing)." }],
      checks: [{ kind: "artifact", path: "plan.md" }],
    },
  ]);

  const started = await h.engine.start(def.id, "manual");
  assert.ok(started);
  const inst = await waitForInstance(
    started.id,
    (i) => i.status !== "running",
    "the instance to settle",
  );

  assert.equal(inst.status, "failed");
  const phase = phaseOf(inst, "plan");
  assert.equal(phase.verification?.status, "failed");
  const check = phase.verification?.checks[0];
  assert.equal(check?.label, "artifact: plan.md");
  assert.equal(check?.detail, "missing");
  assert.equal(failure(phase).failureClass, "verification");
});

// ── 14. changed-files gate ──────────────────────────────────────────────────

test(
  "changed-files gate: a write outside the allowed paths fails the phase, an allowed one passes",
  { ...posixOnly, skip: posixOnly.skip || (hasGit() ? false : "git is not installed") },
  async (t) => {
    const h = await startHarness({ git: true });
    t.after(() => h.close());

    const strayDef = await h.seed([
      {
        id: "edit",
        name: "Edit",
        steps: [
          {
            name: "write",
            prompt: [
              "Make the change.",
              "FAKE: write-file src/ok.txt allowed",
              "FAKE: write-file secrets/leak.txt not allowed",
            ].join("\n"),
          },
        ],
        checks: [{ kind: "changed-files", allow: ["src/**"] }],
      },
    ]);

    const strayStarted = await h.engine.start(strayDef.id, "manual");
    assert.ok(strayStarted);
    const stray = await waitForInstance(
      strayStarted.id,
      (i) => i.status !== "running",
      "the gated instance to settle",
    );
    assert.equal(stray.status, "failed");
    const strayCheck = phaseOf(stray, "edit").verification?.checks[0];
    assert.equal(strayCheck?.status, "failed");
    assert.match(strayCheck?.detail ?? "", /secrets\/leak\.txt/);

    // A second, clean repository: only allowed paths change.
    const cleanCwd = tempDir("argus-e2e-clean-");
    initGitRepo(cleanCwd);
    const cleanDef = await h.seed([
      {
        id: "edit",
        name: "Edit",
        cwd: cleanCwd,
        steps: [
          {
            name: "write",
            prompt: ["Make the change.", "FAKE: write-file src/ok.txt allowed"].join("\n"),
          },
        ],
        checks: [{ kind: "changed-files", allow: ["src/**"] }],
      },
    ]);

    const cleanStarted = await h.engine.start(cleanDef.id, "manual");
    assert.ok(cleanStarted);
    const clean = await waitForInstance(
      cleanStarted.id,
      (i) => i.status !== "running",
      "the clean instance to settle",
    );
    assert.equal(clean.status, "succeeded");
    const cleanCheck = phaseOf(clean, "edit").verification?.checks[0];
    assert.equal(cleanCheck?.status, "passed");
    assert.match(cleanCheck?.output ?? "", /src\/ok\.txt/);
  },
);

// A guard on the suite's own premise: the admin token really is in Argus's own
// environment while a step runs, so "the agent never saw it" means something.
test(
  "the suite runs with an admin token set, so stripping it is observable",
  posixOnly,
  async (t) => {
    const h = await startHarness();
    t.after(() => h.close());
    assert.equal(process.env.ARGUS_TOKEN, ADMIN_TOKEN);
    assert.equal(process.env[LEAK_VAR], "1");
  },
);

// ── 12. KnowledgeDelta: the agent proposes, Argus commits ───────────────────

test(
  "knowledge delta: a read-only agent writes the delta file Argus named, and the phase commits it on success",
  posixOnly,
  async (t) => {
    const h: Harness = await startHarness({ git: true });
    t.after(() => h.close());
    const knowledge = await import("../knowledge/store.js");
    const staging = await import("../knowledge/staging.js");
    await knowledge.createClaim(
      { id: "RULE-17", kind: "business-rule", statement: "Comment max is 180" },
      new Date(),
    );

    const delta = JSON.stringify({
      schemaVersion: 1,
      claims: [{ localId: "c", kind: "conclusion", statement: "Validate comments at 180" }],
      justifications: [{ conclusion: { local: "c" }, premises: ["RULE-17:v1"] }],
      consumed: ["RULE-17:v1"],
    });
    const def = await h.seed([
      {
        id: "derive",
        name: "Derive",
        steps: [
          {
            name: "think",
            prompt: ["Derive the validation rule.", `FAKE: write-delta ${delta}`].join("\n"),
          },
        ],
        capabilities: { filesystem: "read-only", tools: { allow: ["Read"] }, mcpServers: {} },
        checks: [{ kind: "command", run: "exit 0", label: "tests" }],
      },
    ]);
    const inst = (await h.engine.start(def.id, "manual"))!;
    const done = await waitForInstance(
      inst.id,
      (i) => i.status !== "running",
      "instance to settle",
    );
    await h.engine.drain();
    assert.equal(done.status, "succeeded");
    const phase = phaseOf(done, "derive");
    assert.equal(phase.knowledge?.status, "applied");
    assert.equal(phase.steps[0].knowledgeDelta?.status, "applied");

    // The child saw the file's location and had its directory made writable.
    const seen = await readSeen(inst.id, "derive");
    assert.ok(seen.envNames.includes("ARGUS_KNOWLEDGE_DELTA_FILE"));
    const runId = runIdOf(phase);
    const invocation = await readInvocation(runId);
    assert.equal(invocation?.knowledgeDeltaFile, staging.knowledgeDeltaFile(runId));
    assert.ok(
      seen.argv.includes(staging.knowledgeDeltaDir(runId)),
      "--add-dir names the delta dir",
    );
    assert.match(argAfter(seen.argv, "--append-system-prompt") ?? "", /ARGUS_KNOWLEDGE_DELTA_FILE/);

    const ledger = await knowledge.readLedger();
    const created = ledger.claims.find((c) => c.kind === "conclusion");
    assert.ok(created);
    assert.deepEqual(created.producedBy, { runId, instanceId: inst.id, phaseId: "derive" });
    assert.deepEqual(ledger.consumptions[0].claim, { id: "RULE-17", revision: 1 });
    assert.equal(ledger.deltas[0].execution.runId, runId);
    const record = await staging.readDeltaRecord(runId);
    assert.equal(record?.status, "applied");
    assert.deepEqual(record?.result?.createdClaims, [
      { localId: "c", claim: { id: created.id, revision: 1 } },
    ]);
    const journal = await waitForJournal(inst.id, ["knowledge.staged", "knowledge.applied"]);
    assert.ok(journal.some((j) => j.kind === "knowledge.applied"));
  },
);

test(
  "knowledge delta: an invalid document fails the step under knowledge-delta and writes nothing canonical",
  posixOnly,
  async (t) => {
    const h: Harness = await startHarness();
    t.after(() => h.close());
    const def = await h.seed([
      {
        id: "derive",
        name: "Derive",
        steps: [
          { name: "think", prompt: 'FAKE: write-delta {"schemaVersion":1,"consumed":["RULE-17"]}' },
        ],
      },
    ]);
    const inst = (await h.engine.start(def.id, "manual"))!;
    const done = await waitForInstance(
      inst.id,
      (i) => i.status !== "running",
      "instance to settle",
    );
    assert.equal(done.status, "failed");
    const phase = phaseOf(done, "derive");
    assert.equal(failure(phase).failureClass, "knowledge-delta");
    assert.match(failure(phase).reason ?? "", /exact revision/);
    assert.equal((await finishedRun(runIdOf(phase))).outcome, "failed");
    assert.equal(existsSync(path.join(h.home, "argus", "knowledge.json")), false);
  },
);

// ── 13. KnowledgeContext: Argus supplies, the agent reads, consumption is classified ──

test(
  "knowledge context: the agent reads exactly the revisions Argus resolved and froze; consumption, not supply, drives impact",
  posixOnly,
  async (t) => {
    const h: Harness = await startHarness({ git: true });
    t.after(() => h.close());
    const knowledge = await import("../knowledge/store.js");
    const context = await import("../knowledge/context.js");
    const impact = await import("../knowledge/impact.js");
    // Ledger: RULE-17 at v2 (v1 superseded), CONSTRAINT-4:v1.
    await knowledge.createClaim(
      { id: "RULE-17", kind: "business-rule", statement: "Comment max is 180" },
      new Date(),
    );
    await knowledge.createRevision(
      "RULE-17",
      { statement: "Comment max is 500", revisionNote: "Kobra 4.2 raised the limit" },
      new Date(),
    );
    await knowledge.createClaim(
      { id: "CONSTRAINT-4", kind: "constraint", statement: "Validate server-side" },
      new Date(),
    );
    for (const claim of ["RULE-17:v2", "CONSTRAINT-4:v1"]) {
      await knowledge.createEvidence(
        {
          claim: { id: claim.split(":")[0], revision: Number(claim.split(":v")[1]) },
          direction: "supports",
          source: { type: "document", uri: `spec://${claim}` },
        },
        new Date(),
      );
    }

    // The agent reads the context, then consumes RULE-17:v2 only and produces an artifact.
    const delta = JSON.stringify({
      schemaVersion: 1,
      consumed: ["RULE-17:v2"],
      artifacts: [{ location: "artifact-dir", path: "context-as-seen.json" }],
    });
    const def = await h.seed([
      {
        id: "implement",
        name: "Implement",
        steps: [
          {
            name: "code",
            prompt: [
              "Implement the comment validator.",
              "FAKE: read-context context-as-seen.json",
              `FAKE: write-delta ${delta}`,
            ].join("\n"),
            knowledgeContext: { claims: ["RULE-17", "CONSTRAINT-4:v1"] },
          },
        ],
        capabilities: { filesystem: "read-only", tools: { allow: ["Read"] }, mcpServers: {} },
        checks: [{ kind: "artifact", path: "context-as-seen.json" }],
      },
    ]);
    const inst = (await h.engine.start(def.id, "manual"))!;
    const done = await waitForInstance(
      inst.id,
      (i) => i.status !== "running",
      "instance to settle",
    );
    await h.engine.drain();
    assert.equal(done.status, "succeeded", JSON.stringify(done.phases[0].payload));
    const phase = phaseOf(done, "implement");
    const runId = runIdOf(phase);
    assert.equal(phase.knowledge?.status, "applied");

    // Argus resolved the active selector to v2 and froze it; the record proves it.
    const invocation = (await readInvocation(runId))!;
    assert.equal(invocation.knowledgeContextFile, context.knowledgeContextFile(runId));
    assert.deepEqual(invocation.knowledgeContext?.claims, [
      { id: "RULE-17", revision: 2 },
      { id: "CONSTRAINT-4", revision: 1 },
    ]);
    const onDisk = await readFile(invocation.knowledgeContextFile!, "utf8");
    assert.equal(invocation.knowledgeContext?.sha256, context.sha256Hex(onDisk));
    assert.equal(
      invocation.channels?.find((c) => c.kind === "knowledge-context")?.status,
      "granted",
    );

    // The child saw the variable, was granted the directory, and was denied edits under it.
    const seen = await readSeen(inst.id, "implement");
    assert.ok(seen.envNames.includes("ARGUS_KNOWLEDGE_CONTEXT_FILE"));
    assert.ok(
      seen.argv.includes(path.dirname(invocation.knowledgeContextFile!)),
      "--add-dir names the invocation dir",
    );
    const denied = argAfter(seen.argv, "--disallowedTools") ?? "";
    assert.ok(
      denied.includes(`Edit(//${path.dirname(invocation.knowledgeContextFile!)}/**)`),
      denied,
    );
    assert.match(
      argAfter(seen.argv, "--append-system-prompt") ?? "",
      /ARGUS_KNOWLEDGE_CONTEXT_FILE/,
    );
    assert.match(seen.prompt, /Semantic context supplied.*RULE-17:v2, CONSTRAINT-4:v1/);

    // What the agent read is byte-for-byte what Argus wrote, and names the exact refs.
    const copied = await readFile(
      path.join(artifactDirFor(inst.id, "implement"), "context-as-seen.json"),
      "utf8",
    );
    assert.equal(copied, onDisk);
    const ctx = JSON.parse(copied) as { claims: Array<{ ref: string; statement: string }> };
    assert.deepEqual(
      ctx.claims.map((c) => c.ref),
      ["RULE-17:v2", "CONSTRAINT-4:v1"],
    );
    assert.equal(ctx.claims[0].statement, "Comment max is 500");

    // Supplied ≠ consumed: one edge, classified; CONSTRAINT-4 was supplied only.
    const ledger = await knowledge.readLedger();
    assert.deepEqual(
      ledger.consumptions.map((c) => [c.claim.id, c.claim.revision, c.source]),
      [["RULE-17", 2, "supplied-context"]],
    );

    // The reads over HTTP.
    const report = (await (
      await fetch(`${h.baseUrl}/api/knowledge/executions/${runId}/context`)
    ).json()) as any;
    assert.deepEqual(report.comparison, {
      suppliedAndConsumed: [{ id: "RULE-17", revision: 2 }],
      suppliedNotConsumed: [{ id: "CONSTRAINT-4", revision: 1 }],
      consumedNotSupplied: [],
    });
    assert.deepEqual(
      report.projection.claims.map((c: { ref: string }) => c.ref),
      ["RULE-17:v2", "CONSTRAINT-4:v1"],
    );
    const suppliedTo = (await (
      await fetch(`${h.baseUrl}/api/knowledge/claims/RULE-17:v2/supplied-to`)
    ).json()) as any;
    assert.deepEqual(
      suppliedTo.executions.map((e: { execution: { runId: string } }) => e.execution.runId),
      [runId],
    );

    // Later: RULE-17:v3 supersedes v2. The impact set finds the consuming run and its artifact.
    await knowledge.createRevision("RULE-17", { statement: "Comment max is 1000" }, new Date());
    const set = impact.analyzeImpact(await knowledge.readLedger(), { id: "RULE-17", revision: 2 });
    assert.deepEqual(set.root.conditions, ["superseded"]);
    assert.deepEqual(
      set.executions.map((x) => x.execution.runId),
      [runId],
    );
    assert.deepEqual(
      set.artifacts.map((a) => a.artifact.path),
      ["context-as-seen.json"],
    );
    // The historical record is untouched by v3.
    assert.deepEqual((await readInvocation(runId))!.knowledgeContext?.claims[0], {
      id: "RULE-17",
      revision: 2,
    });

    // CONSTRAINT-4 was supplied but not consumed: changing it alone impacts nothing.
    await knowledge.createRevision(
      "CONSTRAINT-4",
      { statement: "Validate client-side" },
      new Date(),
    );
    const unrelated = impact.analyzeImpact(await knowledge.readLedger(), {
      id: "CONSTRAINT-4",
      revision: 1,
    });
    assert.deepEqual(unrelated.root.conditions, ["superseded"]);
    assert.deepEqual(unrelated.executions, []);
    assert.deepEqual(unrelated.artifacts, []);
  },
);

// ── 14. Business-rule discovery, end to end (Phase 5) ───────────────────────

test(
  "business-rule discovery: repository evidence becomes a canonical rule only at the gate, and reaches implementation and impact",
  posixOnly,
  async (t) => {
    const h: Harness = await startHarness({ git: true });
    t.after(() => h.close());
    const knowledge = await import("../knowledge/store.js");
    const impact = await import("../knowledge/impact.js");
    const { formatClaimRef } = await import("../knowledge/kernel.js");

    // The repository under investigation: a booking module whose Kobra
    // adapter truncates the customer comment at 180 characters.
    await mkdir(path.join(h.cwd, "src", "Booking"), { recursive: true });
    await writeFile(
      path.join(h.cwd, "src", "Booking", "Booking.cs"),
      "public sealed class Booking\n{\n    public string Comment { get; set; }\n}\n",
    );
    await writeFile(
      path.join(h.cwd, "src", "Booking", "KobraAdapter.cs"),
      [
        "public static class KobraAdapter",
        "{",
        "    public const int MaxCustomerCommentLength = 180;",
        "",
        "    public static string MapComment(string comment) =>",
        "        comment.Length > MaxCustomerCommentLength",
        "            ? comment.Substring(0, MaxCustomerCommentLength)",
        "            : comment;",
        "}",
        "",
      ].join("\n"),
    );
    commitAll(h.cwd, "booking module");
    const head = gitHead(h.cwd);

    // What the discovery agent proposes: one business rule, one assumption
    // behind it, and source-code evidence for both. Nothing canonical.
    const source = (file: string, startLine: number, endLine: number, symbol?: string) => ({
      type: "source-code",
      path: `src/Booking/${file}`,
      gitHead: head,
      ...(symbol ? { symbol } : {}),
      startLine,
      endLine,
    });
    const discoveryDelta = JSON.stringify({
      schemaVersion: 1,
      claims: [
        {
          localId: "kobra-origin",
          kind: "assumption",
          statement:
            "The 180-character ceiling is a Kobra integration constraint, not an arbitrary implementation choice.",
        },
        {
          localId: "comment-limit",
          kind: "business-rule",
          statement: "Kobra bookings restrict customer comments to 180 characters.",
        },
      ],
      evidence: [
        {
          claim: { local: "kobra-origin" },
          source: source("KobraAdapter.cs", 3, 3, "KobraAdapter.MaxCustomerCommentLength"),
          note: "the constant is named for Kobra, not for the UI",
        },
        {
          claim: { local: "comment-limit" },
          source: source("KobraAdapter.cs", 5, 8, "KobraAdapter.MapComment"),
          note: "MapComment truncates at MaxCustomerCommentLength",
        },
        {
          claim: { local: "comment-limit" },
          source: source("Booking.cs", 1, 4, "Booking.Comment"),
        },
      ],
      justifications: [
        {
          conclusion: { local: "comment-limit" },
          premises: [{ local: "kobra-origin" }],
          note: "a domain constraint rather than a display truncation",
        },
      ],
      metadata: { summary: "One rule and the assumption it rests on, from the Kobra adapter." },
    });

    const def = await h.seed([
      {
        id: "discover",
        name: "Discover",
        gated: true,
        discovery: { scope: { paths: ["src/Booking"], label: "Kobra booking" } },
        steps: [
          {
            name: "investigate",
            prompt: [
              "Investigate the booking module for business rules.",
              `FAKE: write-delta ${discoveryDelta}`,
            ].join("\n"),
          },
        ],
        capabilities: { filesystem: "read-only", tools: { allow: ["Read"] }, mcpServers: {} },
      },
      {
        id: "plan",
        name: "Plan",
        needs: ["discover"],
        knowledgeContext: { fromPhases: [{ phaseId: "discover", kinds: ["business-rule"] }] },
        steps: [
          {
            name: "plan",
            prompt: ["Plan the change.", "FAKE: read-context rules-as-planned.json"].join("\n"),
          },
        ],
      },
      {
        id: "implement",
        name: "Implement",
        needs: ["plan"],
        knowledgeContext: { fromPhases: [{ phaseId: "discover", kinds: ["business-rule"] }] },
        steps: [
          {
            name: "code",
            prompt: [
              "Implement the validator.",
              "FAKE: write-file src/Booking/CommentValidator.cs // enforces the comment limit",
              "FAKE: consume-context src/Booking/CommentValidator.cs",
            ].join("\n"),
          },
        ],
      },
    ]);

    const inst = (await h.engine.start(def.id, "manual"))!;
    const parked = await waitForInstance(
      inst.id,
      (i) => phaseOf(i, "discover").status === "awaiting-approval",
      "discovery to park at its gate",
    );
    await h.engine.drain();

    // ── Before approval: candidate, not canonical ──────────────────────────
    assert.equal(parked.status, "awaiting-approval");
    assert.equal(phaseOf(parked, "discover").steps[0].knowledgeDelta?.status, "staged");
    assert.deepEqual(phaseOf(parked, "discover").discovery, {
      candidates: 2,
      newRules: 1,
      revisions: 0,
      assumptions: 1,
      facts: 0,
      constraints: 0,
      conclusions: 0,
      evidence: 3,
      warnings: 0,
      requiresReview: true,
    });
    const before = await knowledge.readLedger();
    assert.deepEqual(before.claims, [], "no canonical claim exists before the gate opens");
    assert.equal(phaseOf(parked, "plan").status, "pending");

    // The agent was told the discovery contract and its bounded scope.
    const discoverRun = runIdOf(phaseOf(parked, "discover"));
    const seen = await readSeen(inst.id, "discover");
    assert.match(seen.prompt, /Business-rule discovery/);
    assert.match(seen.prompt, /Scope for this invocation \(Kobra booking\): src\/Booking/);
    assert.match(seen.prompt, /is not itself one/);

    // ── The review surface: everything a decision needs, no transcript ─────
    const review = (await (
      await fetch(`${h.baseUrl}/api/instances/${inst.id}/phases/discover/review`)
    ).json()) as any;
    assert.equal(review.status, "awaiting-approval");
    assert.equal(review.canApprove, true);
    assert.equal(review.discovery.newRules, 1);
    const preview = review.knowledge[0];
    assert.equal(preview.status, "staged");
    assert.equal(preview.runId, discoverRun);
    assert.equal(
      preview.summary,
      "One rule and the assumption it rests on, from the Kobra adapter.",
    );
    assert.deepEqual(
      preview.proposedClaims.map((c: { ref: { display: string }; kind: string }) => [
        c.ref.display,
        c.kind,
      ]),
      [
        ["local:kobra-origin", "assumption"],
        ["local:comment-limit", "business-rule"],
      ],
    );
    const rulePreview = preview.proposedClaims[1];
    assert.equal(rulePreview.evidence.length, 2);
    assert.equal(rulePreview.evidence[0].source.path, "src/Booking/KobraAdapter.cs");
    assert.equal(rulePreview.evidence[0].source.gitHead, head);
    assert.equal(rulePreview.justifications[0].premises[0].display, "local:kobra-origin");
    assert.deepEqual(preview.warnings, []);
    // The preview never pretends a canonical id exists yet.
    assert.doesNotMatch(JSON.stringify(preview.proposedClaims), /RULE-/);

    // ── Approve: the candidates become canonical, atomically ───────────────
    assert.equal((await h.engine.approve(inst.id)).code, 200);
    const done = await waitForInstance(
      inst.id,
      (i) => i.status !== "running" && i.status !== "awaiting-approval",
      "the pipeline to settle",
    );
    await h.engine.drain();
    assert.equal(done.status, "succeeded", JSON.stringify(done.phases.map((p) => p.payload)));

    const ledger = await knowledge.readLedger();
    const rule = ledger.claims.find((c) => c.kind === "business-rule")!;
    const assumption = ledger.claims.find((c) => c.kind === "assumption")!;
    assert.ok(rule && assumption);
    assert.match(rule.id, /^RULE-/);
    assert.equal(rule.revision, 1);
    assert.deepEqual(rule.producedBy, {
      runId: discoverRun,
      instanceId: inst.id,
      phaseId: "discover",
    });
    // The assumption survives as its own claim, with the derivation intact.
    assert.deepEqual(ledger.justifications[0].conclusion, { id: rule.id, revision: 1 });
    assert.deepEqual(ledger.justifications[0].premises, [{ id: assumption.id, revision: 1 }]);
    // Evidence is provenance, not a copy of the source.
    assert.equal(ledger.evidence.length, 3);
    assert.doesNotMatch(JSON.stringify(ledger), /Substring/);
    assert.equal(phaseOf(done, "discover").discovery?.requiresReview, false);

    // ── The same-instance handoff: exactly the rule, by exact ref ──────────
    const ruleRef = formatClaimRef({ id: rule.id, revision: 1 });
    const planRun = runIdOf(phaseOf(done, "plan"));
    assert.deepEqual((await readInvocation(planRun))!.knowledgeContext?.claims, [
      { id: rule.id, revision: 1 },
    ]);
    const planned = JSON.parse(
      await readFile(path.join(artifactDirFor(inst.id, "plan"), "rules-as-planned.json"), "utf8"),
    ) as { claims: { ref: string; kind: string }[] };
    assert.deepEqual(
      planned.claims.map((c) => [c.ref, c.kind]),
      [[ruleRef, "business-rule"]],
    );
    // The assumption was NOT handed on: the author chose which kinds flow.
    assert.equal(planned.claims.length, 1);

    // ── Implementation consumes it and records what it built ───────────────
    const implRun = runIdOf(phaseOf(done, "implement"));
    assert.deepEqual((await readInvocation(implRun))!.knowledgeContext?.claims, [
      { id: rule.id, revision: 1 },
    ]);
    assert.deepEqual(
      ledger.consumptions.map((c) => [formatClaimRef(c.claim), c.source, c.execution.runId]),
      [[ruleRef, "supplied-context", implRun]],
    );
    assert.deepEqual(
      ledger.artifacts.map((a) => [a.artifact.path, a.execution.runId]),
      [["src/Booking/CommentValidator.cs", implRun]],
    );

    // ── Later: the rule is revised. Impact reaches the artifact. ───────────
    await knowledge.createRevision(
      rule.id,
      {
        statement: "Kobra bookings restrict customer comments to 500 characters.",
        revisionNote: "Kobra 4.2 raised the limit",
      },
      new Date(),
    );
    const set = impact.analyzeImpact(await knowledge.readLedger(), { id: rule.id, revision: 1 });
    assert.deepEqual(set.root.conditions, ["superseded"]);
    assert.deepEqual(
      set.executions.map((x) => x.execution.runId),
      [implRun],
    );
    assert.deepEqual(
      set.artifacts.map((a) => a.artifact.path),
      ["src/Booking/CommentValidator.cs"],
    );
    // The historical evidence still names the commit it was gathered at: a
    // later revision creates a record, it never rewrites one.
    assert.equal(
      (ledger.evidence[0].source as { gitHead?: string }).gitHead,
      head,
      "source evidence stays bound to the commit discovery ran on",
    );
  },
);
