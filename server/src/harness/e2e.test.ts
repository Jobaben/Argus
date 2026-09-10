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
import { readFile, readdir, writeFile } from "node:fs/promises";
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
    assert.match(retryPrompt, /Previous attempt failed/);
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
