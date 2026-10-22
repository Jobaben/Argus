import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { paths } from "../claudeHome.js";
import { instanceArtifactDir, phaseArtifactDir } from "../harness/invocation.js";
import { appendGateDecision, gateDecisionFile } from "./gateDecisions.js";
import { writeInstance } from "./instances.js";
import { runInvocationDir, writeRun } from "./runs.js";
import {
  MANIFEST_REASON_MAX_CHARS,
  MANIFEST_RUN_ERROR_MAX_CHARS,
  buildChildrenManifest,
  childrenManifestFile,
  planChildrenManifest,
} from "./childrenManifest.js";
import type { ChildrenManifestSources } from "./childrenManifest.js";
import type { GateDecision } from "@argus/contracts";
import type { Run } from "./scheduleTypes.js";
import type {
  ChildrenManifest,
  PhaseProgress,
  PipelineInstance,
  SpawnTask,
  VerificationReport,
} from "./pipelineTypes.js";

/**
 * The children manifest (DL-A2b): the pure builder over hand-made sources,
 * then the I/O shell over a temp home. The engine end to end is
 * `childrenContextEngine.test.ts`.
 */

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-children-manifest-"));
  process.env.ARGUS_CLAUDE_HOME = home;
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

const T = (minute: number) => new Date(Date.UTC(2026, 9, 22, 9, minute)).toISOString();

function phase(id: string, over: Partial<PhaseProgress> = {}): PhaseProgress {
  return {
    id,
    name: id[0].toUpperCase() + id.slice(1),
    gated: false,
    status: "succeeded",
    steps: [],
    attempt: 0,
    payload: null,
    ...over,
  };
}

function instance(id: string, over: Partial<PipelineInstance> = {}): PipelineInstance {
  return {
    id,
    pipelineId: "child",
    pipelineName: "Task",
    status: "succeeded",
    currentPhaseIndex: 0,
    phases: [],
    trigger: "spawned",
    signalToken: "SIGNAL-SECRET",
    createdAt: T(0),
    updatedAt: T(30),
    endedAt: T(30),
    ...over,
  };
}

function run(id: string, instanceId: string, phaseId: string, over: Partial<Run> = {}): Run {
  return {
    id,
    scheduleId: `pipeline:${instanceId}`,
    scheduleName: `Task · ${phaseId}`,
    prompt: `PROMPT-SECRET of ${id}`,
    cwd: "/repo",
    status: "succeeded",
    trigger: "scheduled",
    queuedAt: T(1),
    startedAt: T(1),
    endedAt: T(2),
    durationMs: 60_000,
    pid: null,
    exitCode: 0,
    sessionId: "sess-1",
    runtime: "claude",
    project: null,
    resultSummary: null,
    error: null,
    instanceId,
    phaseId,
    deadlineAt: null,
    ...over,
  };
}

function decision(id: string, instanceId: string, over: Partial<GateDecision> = {}): GateDecision {
  return {
    id,
    instanceId,
    pipelineId: "child",
    decision: "approve",
    mechanism: "operator",
    channel: "http",
    principal: { kind: "session", username: "operator-name", role: "admin" },
    phases: [{ phaseId: "work", attempt: 0, status: "awaiting-approval", runIds: ["r-a1"] }],
    recordedAt: T(10),
    ...over,
  };
}

const TASKS: SpawnTask[] = [
  { key: "a", title: "First", state: "succeeded", instanceId: "c-a" },
  {
    key: "b",
    state: "failed",
    reason: "the tests broke",
    instanceId: "c-new",
    previousInstanceIds: ["c-old"],
    dependsOn: [0],
  },
  { key: "c", state: "blocked", dependsOn: [1] },
];

/** The parent: `plan` wrote the list, `tasks` spawned it, `learn` reads it. */
function parent(tasks: SpawnTask[] = TASKS, spawnOver: Partial<PhaseProgress> = {}) {
  return instance("p-1", {
    pipelineId: "p1",
    pipelineName: "Loop",
    trigger: "manual",
    status: "running",
    endedAt: null,
    definition: {
      id: "p1",
      name: "Loop",
      phases: [],
      trigger: null,
      enabled: true,
      overlapPolicy: "skip",
      lastStartedAt: null,
      createdAt: T(0),
      updatedAt: T(0),
      hookToken: "HOOK-SECRET",
    },
    gateDecisionIds: ["GD-P1"],
    phases: [
      phase("plan", { gated: true, result: { tasks: [{ id: "a" }, { id: "b" }, { id: "c" }] } }),
      phase("tasks", {
        status: "awaiting-approval",
        pause: "children",
        children: {
          pipelineId: "child",
          source: { phaseId: "plan", attempt: 0 },
          maxParallel: 1,
          tasks,
        },
        ...spawnOver,
      }),
      phase("learn", { status: "running", gated: true }),
    ],
  });
}

const RESULT_A = { pr: 12, url: "https://example.test/pr/12" };
const VERIFICATION_A: VerificationReport = {
  status: "passed",
  startedAt: T(20),
  endedAt: T(21),
  checks: [
    {
      kind: "command",
      label: "npm test",
      status: "passed",
      detail: "exit 0",
      durationMs: 900,
    },
  ],
};

function children(): Map<string, PipelineInstance | null> {
  return new Map<string, PipelineInstance | null>([
    [
      "c-a",
      instance("c-a", {
        triggerPayload: { task: { id: "a", title: "First" }, key: "a" },
        gateDecisionIds: ["GD-1", "GD-2"],
        phases: [
          phase("work", {
            gated: true,
            attempt: 1,
            result: RESULT_A,
            verification: VERIFICATION_A,
            artifactDir: path.join("/artifacts", "c-a", "work"),
            workspace: { path: "/wt/c-a", branch: "argus/c-a", base: "main", baseHead: "abc123" },
          }),
        ],
      }),
    ],
    [
      "c-new",
      instance("c-new", {
        status: "failed",
        triggerPayload: { task: { id: "b" }, key: "b" },
        gateDecisionIds: ["GD-4"],
        pendingGateOperation: {
          decisionId: "GD-4",
          decision: "revise",
          phaseId: "work",
          attempt: 0,
          stopRunIds: [],
          startedAt: T(25),
        },
        phases: [
          phase("work", {
            status: "failed",
            retries: 1,
            payload: { reason: "  verification failed: npm test  ", failureClass: "verification" },
          }),
        ],
      }),
    ],
    ["c-old", instance("c-old", { status: "aborted", abortCause: "parent-aborted" })],
  ]);
}

function decisions(): GateDecision[] {
  return [
    decision("GD-1", "c-a", { decision: "revise", note: "use the helper", recordedAt: T(10) }),
    decision("GD-2", "c-a", {
      phases: [{ phaseId: "work", attempt: 1, status: "awaiting-approval", runIds: ["r-a2"] }],
      recordedAt: T(20),
    }),
    // Recorded, never linked: it did not take effect.
    decision("GD-3", "c-a", { decision: "abort", recordedAt: T(21) }),
    decision("GD-4", "c-new", {
      decision: "revise",
      mechanism: "parent-decision",
      channel: "in-process",
      principal: { kind: "system", component: "spawn" },
      note: "again",
      parentDecisionId: "GD-P1",
      recordedAt: T(25),
    }),
    decision("GD-P1", "p-1", {
      pipelineId: "p1",
      decision: "revise",
      note: "again",
      phases: [{ phaseId: "tasks", attempt: 0, status: "awaiting-approval", runIds: [] }],
      recordedAt: T(24),
    }),
  ];
}

function runs(): Run[] {
  return [
    // Out of order on purpose: the manifest sorts by queuedAt.
    run("r-a2", "c-a", "work", { queuedAt: T(15), costUsd: 0.2, tokens: 500, durationMs: 30_000 }),
    run("r-a1", "c-a", "work", {
      queuedAt: T(5),
      costUsd: 0.1234,
      tokens: 1000,
      outcome: "succeeded",
    }),
    run("r-new1", "c-new", "work", {
      status: "failed",
      costUsd: null,
      tokens: null,
      durationMs: 1000,
      termination: "timed-out",
      error: "x".repeat(MANIFEST_RUN_ERROR_MAX_CHARS + 100),
      runtime: undefined,
    }),
    run("r-old1", "c-old", "work", { costUsd: 0.05, tokens: 100, durationMs: 2000 }),
    run("r-p1", "p-1", "plan", { costUsd: 1, tokens: 10, durationMs: 5000, model: "opus" }),
    run("r-other", "someone-else", "work", { costUsd: 99 }),
  ];
}

function sources(over: Partial<ChildrenManifestSources> = {}): ChildrenManifestSources {
  return {
    parent: parent(),
    fromPhase: "tasks",
    phaseId: "learn",
    attempt: 0,
    generatedAt: T(40),
    children: children(),
    decisions: decisions(),
    runs: runs(),
    artifactDirs: new Map([["c-a", path.join("/artifacts", "c-a")]]),
    warnings: [],
    ...over,
  };
}

function built(over: Partial<ChildrenManifestSources> = {}): ChildrenManifest {
  const out = buildChildrenManifest(sources(over));
  assert.ok(!("error" in out), `the manifest was built: ${JSON.stringify(out)}`);
  return out;
}

// ── The pure builder ─────────────────────────────────────────────────────────

test("every task in list order, each child with its phases, its task and its folder", () => {
  const m = built();
  assert.equal(m.schemaVersion, 1, "versioned");
  assert.deepEqual(m.for, { instanceId: "p-1", phaseId: "learn", attempt: 0 }, "for this attempt");
  assert.equal(m.generatedAt, T(40), "when it was planned");
  assert.deepEqual(
    m.spawnPhase,
    {
      id: "tasks",
      name: "Tasks",
      status: "awaiting-approval",
      attempt: 0,
      childPipelineId: "child",
      counts: { succeeded: 1, failed: 1, blocked: 1 },
    },
    "the spawn phase, with its tasks counted by state",
  );
  assert.deepEqual(
    m.tasks.map((t) => [t.index, t.key, t.state, t.dependsOn]),
    [
      [0, "a", "succeeded", []],
      [1, "b", "failed", ["a"]],
      [2, "c", "blocked", ["b"]],
    ],
    "list order; dependencies by key",
  );
  const [a, b, c] = m.tasks;
  assert.equal(a.title, "First", "the title as the parent keeps it");
  assert.deepEqual(a.task, { id: "a", title: "First" }, "the task as the child received it");
  assert.equal(b.reason, "the tests broke", "why the task failed");
  assert.equal(c.child, undefined, "a task never planned has no child");
  assert.equal(c.task, undefined, "and no task object");

  assert.deepEqual(
    a.child?.phases?.[0],
    {
      id: "work",
      name: "Work",
      status: "succeeded",
      attempt: 1,
      gated: true,
      result: RESULT_A,
      verification: VERIFICATION_A,
      artifactDir: path.join("/artifacts", "c-a", "work"),
      workspace: { branch: "argus/c-a", base: "main", baseHead: "abc123" },
      runs: [
        {
          runId: "r-a1",
          status: "succeeded",
          queuedAt: T(5),
          startedAt: T(1),
          endedAt: T(2),
          durationMs: 60_000,
          costUsd: 0.1234,
          tokens: 1000,
          model: null,
          runtime: "claude",
          outcome: "succeeded",
        },
        {
          runId: "r-a2",
          status: "succeeded",
          queuedAt: T(15),
          startedAt: T(1),
          endedAt: T(2),
          durationMs: 30_000,
          costUsd: 0.2,
          tokens: 500,
          model: null,
          runtime: "claude",
        },
      ],
      cost: { runs: 2, costUsd: 0.3234, tokens: 1500, unpricedRuns: 0, durationMs: 90_000 },
    },
    "the child's phase: result, verification, folder, branch, runs oldest first and cost",
  );
  assert.equal(a.child?.artifactsDir, path.join("/artifacts", "c-a"), "its folder is offered");
  assert.equal(b.child?.artifactsDir, undefined, "a child whose folder is not offered has none");
  assert.equal(b.child?.phases?.[0].artifactDir, undefined, "and its phases name none either");
  assert.deepEqual(
    b.child?.phases?.[0].failure,
    { failureClass: "verification", reason: "verification failed: npm test" },
    "a failed phase says why",
  );
  assert.equal(b.child?.phases?.[0].retries, 1, "and how many retries it used");
});

test("a failed phase's reason may be a bare string, and is clipped", () => {
  const kids = children();
  kids.set(
    "c-new",
    instance("c-new", {
      status: "failed",
      phases: [
        phase("work", { status: "failed", payload: "y".repeat(MANIFEST_REASON_MAX_CHARS + 5) }),
      ],
    }),
  );
  const failure = built({ children: kids }).tasks[1].child?.phases?.[0].failure;
  assert.equal(failure?.failureClass, undefined, "no class in a bare string");
  assert.equal(failure?.reason?.length, MANIFEST_REASON_MAX_CHARS, "clipped");
  assert.ok(failure?.reason?.endsWith("…"), "and marked so");
  // A failed phase with nothing to say carries no failure at all.
  kids.set("c-new", instance("c-new", { phases: [phase("work", { status: "failed" })] }));
  assert.equal(
    built({ children: kids }).tasks[1].child?.phases?.[0].failure,
    undefined,
    "no empty failure object",
  );
});

test("decisions that took effect, oldest first, without who made them", () => {
  const m = built();
  assert.deepEqual(
    m.tasks[0].child?.decisions,
    [
      {
        id: "GD-1",
        decision: "revise",
        mechanism: "operator",
        phases: [{ phaseId: "work", attempt: 0 }],
        note: "use the helper",
        recordedAt: T(10),
        effect: "applied",
      },
      {
        id: "GD-2",
        decision: "approve",
        mechanism: "operator",
        phases: [{ phaseId: "work", attempt: 1 }],
        recordedAt: T(20),
        effect: "applied",
      },
    ],
    "the linked revise and approve; the unlinked abort is left out",
  );
  assert.deepEqual(
    m.tasks[1].child?.decisions,
    [
      {
        id: "GD-4",
        decision: "revise",
        mechanism: "parent-decision",
        phases: [{ phaseId: "work", attempt: 0 }],
        note: "again",
        recordedAt: T(25),
        effect: "incomplete",
        parentDecisionId: "GD-P1",
      },
    ],
    "a decision still being applied is incomplete, and names the parent's",
  );
  assert.deepEqual(
    m.parent.decisions?.map((d) => [d.id, d.decision, d.note]),
    [["GD-P1", "revise", "again"]],
    "the parent's own decisions",
  );
  const text = JSON.stringify(m);
  assert.equal(text.includes('"principal"'), false, "no principal");
  assert.equal(text.includes("operator-name"), false, "no username");
  assert.equal(text.includes('"channel"'), false, "no channel");
});

test("cost is what the runs recorded: per phase, per child, all children, and the parent's own", () => {
  const m = built();
  assert.deepEqual(
    m.tasks[0].child?.cost,
    { runs: 2, costUsd: 0.3234, tokens: 1500, unpricedRuns: 0, durationMs: 90_000 },
    "a child's two priced runs",
  );
  assert.deepEqual(
    m.tasks[1].child?.cost,
    { runs: 1, costUsd: null, tokens: null, unpricedRuns: 1, durationMs: 1000 },
    "no priced run: no cost, and the manifest makes none up",
  );
  const unpriced = m.tasks[1].child?.phases?.[0].runs[0];
  assert.equal(unpriced?.runtime, "claude", "an absent runtime is Claude Code");
  assert.equal(unpriced?.termination, "timed-out", "how it ended");
  assert.equal(unpriced?.error?.length, MANIFEST_RUN_ERROR_MAX_CHARS, "its error, clipped");
  assert.deepEqual(
    m.childrenCost,
    { runs: 4, costUsd: 0.3734, tokens: 1600, unpricedRuns: 1, durationMs: 93_000 },
    "every child's runs, the replaced child's included, nobody else's",
  );
  assert.deepEqual(
    m.parent.cost,
    { runs: 1, costUsd: 1, tokens: 10, unpricedRuns: 0, durationMs: 5000 },
    "the parent's own runs",
  );
  assert.equal(m.parent.phases?.[0].runs[0].model, "opus", "with the model each ran");
});

test("a Codex run's recorded cost, Argus's own list-price estimate, is summed as recorded", () => {
  const m = built({
    runs: [
      run("r-codex", "c-a", "work", {
        runtime: "codex",
        model: "gpt-5.6",
        costUsd: 0.0421,
        tokens: 3000,
        durationMs: 4000,
      }),
    ],
  });
  const recorded = m.tasks[0].child?.phases?.[0].runs[0];
  assert.deepEqual(
    [recorded?.runtime, recorded?.costUsd, recorded?.tokens],
    ["codex", 0.0421, 3000],
    "the run's figures, unchanged",
  );
  assert.deepEqual(
    m.tasks[0].child?.cost,
    { runs: 1, costUsd: 0.0421, tokens: 3000, unpricedRuns: 0, durationMs: 4000 },
    "priced like any other run: neither re-estimated nor left out",
  );
  assert.equal(m.childrenCost.costUsd, 0.0421, "and in the children's total");
});

test("an earlier child is listed beside the one that replaced it", () => {
  const b = built().tasks[1];
  assert.equal(b.child?.instanceId, "c-new", "the current child");
  assert.deepEqual(
    b.earlierChildren?.map((c) => [c.instanceId, c.status, c.abortCause]),
    [["c-old", "aborted", "parent-aborted"]],
    "the child it replaced, with how it ended",
  );
  assert.deepEqual(b.earlierChildren?.[0].cost?.runs, 1, "and what it cost");
  assert.equal(built().tasks[0].earlierChildren, undefined, "none where nothing was replaced");
});

test("a child Argus could not read is listed by id alone", () => {
  const kids = children();
  kids.set("c-a", null);
  const a = built({
    children: kids,
    warnings: ['child c-a of task "a": its record could not be read'],
  }).tasks[0];
  assert.deepEqual(a.child, { instanceId: "c-a", status: null }, "its id, no status");
  assert.equal(a.task, undefined, "no task object");
  assert.equal(a.state, "succeeded", "the task's own state still stands");
});

test("a spawn phase that never built a list describes no children", () => {
  const skipped = parent([], { status: "skipped", pause: undefined, children: undefined });
  const m = built({ parent: skipped, children: new Map(), runs: [], decisions: [] });
  assert.deepEqual(m.tasks, [], "no tasks");
  assert.deepEqual(
    m.spawnPhase,
    {
      id: "tasks",
      name: "Tasks",
      status: "skipped",
      attempt: 0,
      childPipelineId: null,
      counts: {},
    },
    "the phase says it was skipped",
  );
  assert.deepEqual(
    m.childrenCost,
    { runs: 0, costUsd: null, tokens: null, unpricedRuns: 0, durationMs: 0 },
    "and nothing was spent",
  );
});

test("a fromPhase the instance does not have is an error", () => {
  const out = buildChildrenManifest(sources({ fromPhase: "nope" }));
  assert.ok("error" in out, "no manifest");
  assert.match(out.error, /phase "nope" is not a phase of this instance/);
});

test("the parent is listed with its phases and no folder", () => {
  const m = built();
  assert.equal(m.parent.instanceId, "p-1", "this instance");
  assert.equal(m.parent.status, "running", "as it stands");
  assert.equal(m.parent.artifactsDir, undefined, "no folder: its own phase writes beneath it");
  assert.deepEqual(
    m.parent.phases?.map((p) => [p.id, p.status]),
    [
      ["plan", "succeeded"],
      ["tasks", "awaiting-approval"],
      ["learn", "running"],
    ],
    "every phase of the parent",
  );
  assert.deepEqual(
    m.parent.phases?.[0].result,
    { tasks: [{ id: "a" }, { id: "b" }, { id: "c" }] },
    "with its results",
  );
  assert.equal(m.parent.phases?.[1].pause, "children", "and its pauses");
});

test("the manifest never carries a token, a definition or a prompt", () => {
  const text = JSON.stringify(built());
  for (const secret of [
    "SIGNAL-SECRET",
    "HOOK-SECRET",
    "PROMPT-SECRET",
    "definition",
    "signalToken",
  ]) {
    assert.equal(text.includes(secret), false, `${secret} is not in the manifest`);
  }
});

test("the same sources give the same document, key for key", () => {
  assert.equal(JSON.stringify(built()), JSON.stringify(built()), "deterministic");
  const shuffled = built({ runs: [...runs()].reverse() });
  assert.equal(
    JSON.stringify(shuffled),
    JSON.stringify(built()),
    "whatever order the runs came in",
  );
});

// ── The I/O shell ─────────────────────────────────────────────────────────────

const AT = { phaseId: "learn", attempt: 0, generatedAt: T(40) };

/** Everything on disk; `unwritten` children are left for the test to write. */
async function seedOnDisk(unwritten: string[] = []): Promise<PipelineInstance> {
  for (const record of children().values()) {
    if (record && !unwritten.includes(record.id)) await writeInstance(record);
  }
  const p = parent();
  await writeInstance(p);
  for (const d of decisions()) await appendGateDecision(d);
  for (const r of runs()) await writeRun(r);
  return p;
}

test("childrenManifestFile is a folder of its own in the run's invocation directory", () => {
  assert.equal(
    childrenManifestFile("run-1"),
    path.join(runInvocationDir("run-1"), "children", "children-manifest.json"),
  );
});

test("planChildrenManifest reads children, decisions and runs from disk, and offers only folders that exist", async () => {
  const p = await seedOnDisk();
  mkdirSync(phaseArtifactDir(paths.artifactsDir(), "c-a", "work"), { recursive: true });

  const plan = await planChildrenManifest(p, { fromPhase: "tasks" }, AT);
  assert.ok(!("error" in plan), "built");
  const folder = instanceArtifactDir(paths.artifactsDir(), "c-a");
  assert.deepEqual(
    plan.artifactDirs,
    [{ dir: folder, instanceId: "c-a", key: "a" }],
    "only the child whose folder exists is offered one",
  );
  const m = plan.manifest;
  assert.equal(m.tasks[0].child?.artifactsDir, folder, "and the manifest names it");
  assert.equal(m.tasks[1].child?.artifactsDir, undefined, "the others none");
  assert.deepEqual(
    m.tasks[0].child?.decisions?.map((d) => [d.id, d.effect]),
    [
      ["GD-1", "applied"],
      ["GD-2", "applied"],
    ],
    "decisions from the log, the unlinked one left out",
  );
  assert.equal(m.tasks[1].child?.decisions?.[0].effect, "incomplete", "the pending one");
  assert.deepEqual(
    m.childrenCost,
    { runs: 4, costUsd: 0.3734, tokens: 1600, unpricedRuns: 1, durationMs: 93_000 },
    "runs from disk, nobody else's",
  );
  assert.deepEqual(m.warnings, [], "nothing it could not read");
  assert.equal(plan.contents, `${JSON.stringify(m, null, 2)}\n`, "the bytes a run is given");
});

test("a child record that cannot be read is a warning and gets no folder, never a refusal", async () => {
  const p = await seedOnDisk(["c-a"]);
  writeFileSync(path.join(paths.instancesDir(), "c-a.json"), "{");
  mkdirSync(phaseArtifactDir(paths.artifactsDir(), "c-a", "work"), { recursive: true });

  const plan = await planChildrenManifest(p, { fromPhase: "tasks" }, AT);
  assert.ok(!("error" in plan), "still built");
  assert.deepEqual(
    plan.manifest.tasks[0].child,
    { instanceId: "c-a", status: null },
    "by id alone",
  );
  assert.deepEqual(
    plan.manifest.warnings,
    ['child c-a of task "a": its record could not be read'],
    "one warning naming the child and its task",
  );
  assert.deepEqual(plan.artifactDirs, [], "no folder is offered for it");
});

test("a decisions log that cannot be read is a warning: the manifest lists no decisions", async () => {
  const p = parent();
  for (const record of children().values()) if (record) await writeInstance(record);
  // A directory where the log should be: unreadable on every platform,
  // without permission bits.
  mkdirSync(gateDecisionFile(), { recursive: true });
  const plan = await planChildrenManifest(p, { fromPhase: "tasks" }, AT);
  assert.ok(!("error" in plan), "still built");
  assert.deepEqual(plan.manifest.tasks[0].child?.decisions, [], "no decisions");
  assert.equal(plan.manifest.warnings.length, 1, "one warning");
  assert.match(plan.manifest.warnings[0], /^gate decisions could not be read: /, "saying so");
});

test("at most maxFolders child folders are offered; the rest are a warning", async () => {
  const p = await seedOnDisk();
  for (const id of ["c-a", "c-new", "c-old"]) {
    mkdirSync(phaseArtifactDir(paths.artifactsDir(), id, "work"), { recursive: true });
  }
  const plan = await planChildrenManifest(p, { fromPhase: "tasks" }, AT, { maxFolders: 2 });
  assert.ok(!("error" in plan), "built");
  assert.deepEqual(
    plan.artifactDirs.map((c) => [c.instanceId, c.key]),
    [
      ["c-a", "a"],
      ["c-new", "b"],
    ],
    "current children first: the replaced one is past the cap",
  );
  assert.equal(
    plan.manifest.tasks[1].earlierChildren?.[0].artifactsDir,
    undefined,
    "so it has none",
  );
  assert.deepEqual(
    plan.manifest.warnings,
    ["1 child artifact folder was not offered: at most 2 per run"],
    "and the warning says so",
  );
});

test("a fromPhase the instance does not have is an error before anything is read", async () => {
  const plan = await planChildrenManifest(parent(), { fromPhase: "nope" }, AT);
  assert.ok("error" in plan, "no manifest");
  assert.match(plan.error, /children context: phase "nope" is not a phase of this instance/);
});
