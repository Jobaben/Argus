import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ARTIFACT_LIST_CAP,
  ARTIFACT_LIST_DEPTH,
  ARTIFACT_READ_CAP,
  buildPhaseReview,
  listPhaseArtifacts,
  readPhaseArtifact,
  resolveArtifactPath,
} from "./artifacts.js";
import { writeInstance } from "./instances.js";
import type {
  PhaseChildren,
  PhaseProgress,
  PipelineDefinition,
  PipelineInstance,
} from "./pipelineTypes.js";

async function dir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "argus-artifacts-"));
}

function phase(over: Partial<PhaseProgress> = {}): PhaseProgress {
  return {
    id: "draft",
    name: "Draft",
    gated: true,
    status: "awaiting-approval",
    steps: [{ name: "write", runId: "r1", status: "succeeded" }],
    attempt: 2,
    payload: { summary: "done" },
    artifactDir: null,
    ...over,
  };
}

function instance(phases: PhaseProgress[], definition?: PipelineDefinition): PipelineInstance {
  return {
    id: "i1",
    pipelineId: "p1",
    pipelineName: "Reports",
    status: "awaiting-approval",
    currentPhaseIndex: 0,
    phases,
    trigger: "manual",
    signalToken: "tok",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
    ...(definition ? { definition } : {}),
  };
}

function definition(checks?: { kind: "artifact"; path: string }[]): PipelineDefinition {
  return {
    id: "p1",
    name: "Reports",
    trigger: null,
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    phases: [
      {
        id: "draft",
        name: "Draft",
        cwd: "/tmp",
        steps: [{ name: "write", prompt: "p" }],
        gated: true,
        ...(checks ? { checks } : {}),
      },
    ],
  } as PipelineDefinition;
}

// ── containment ──────────────────────────────────────────────────────────────

test("resolveArtifactPath accepts nested relative paths and rejects escapes", async () => {
  const root = await dir();
  assert.equal(resolveArtifactPath(root, "report.md"), path.join(root, "report.md"));
  assert.equal(resolveArtifactPath(root, "sub/report.md"), path.join(root, "sub", "report.md"));
  assert.equal(resolveArtifactPath(root, "../escape"), null);
  assert.equal(resolveArtifactPath(root, "a/../../b"), null);
  assert.equal(resolveArtifactPath(root, path.join(root, "abs.md")), null);
  assert.equal(resolveArtifactPath(root, "/etc/passwd"), null);
  assert.equal(resolveArtifactPath(root, ""), null);
  assert.equal(resolveArtifactPath(root, "."), null);
  assert.equal(resolveArtifactPath(root, "a\0b"), null);
});

// ── listing ──────────────────────────────────────────────────────────────────

test("listPhaseArtifacts lists regular files sorted, flags required and text", async () => {
  const root = await dir();
  await mkdir(path.join(root, "notes"));
  await writeFile(path.join(root, "report.md"), "# Report\n");
  await writeFile(path.join(root, "notes", "b.txt"), "plain");
  await writeFile(path.join(root, "image.bin"), Buffer.from([0x89, 0x50, 0x00, 0x47]));
  await writeFile(path.join(root, "empty.txt"), "");

  const { artifacts, truncated } = await listPhaseArtifacts(root, ["./report.md"]);
  assert.equal(truncated, false);
  assert.deepEqual(
    artifacts.map((a) => a.path),
    ["empty.txt", "image.bin", "notes/b.txt", "report.md"],
  );
  const byPath = Object.fromEntries(artifacts.map((a) => [a.path, a]));
  assert.equal(byPath["report.md"].required, true);
  assert.equal(byPath["report.md"].text, true);
  assert.equal(byPath["report.md"].bytes, 9);
  assert.equal(byPath["notes/b.txt"].required, false);
  assert.equal(byPath["image.bin"].text, false);
  assert.equal(byPath["empty.txt"].text, true);
  assert.match(byPath["report.md"].modifiedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("listPhaseArtifacts returns empty for a missing or null directory", async () => {
  assert.deepEqual(await listPhaseArtifacts(null, []), { artifacts: [], truncated: false });
  assert.deepEqual(await listPhaseArtifacts(undefined, []), { artifacts: [], truncated: false });
  const gone = path.join(await dir(), "nope");
  assert.deepEqual(await listPhaseArtifacts(gone, []), { artifacts: [], truncated: false });
});

test("listPhaseArtifacts caps the count and marks truncated", async () => {
  const root = await dir();
  for (let i = 0; i < ARTIFACT_LIST_CAP + 5; i++) {
    await writeFile(path.join(root, `f${String(i).padStart(4, "0")}.txt`), "x");
  }
  const { artifacts, truncated } = await listPhaseArtifacts(root, []);
  assert.equal(artifacts.length, ARTIFACT_LIST_CAP);
  assert.equal(truncated, true);
});

test("listPhaseArtifacts stops descending past the depth cap", async () => {
  const root = await dir();
  let sub = root;
  const rel: string[] = [];
  for (let d = 1; d <= ARTIFACT_LIST_DEPTH + 2; d++) {
    sub = path.join(sub, `d${d}`);
    rel.push(`d${d}`);
    await mkdir(sub);
    await writeFile(path.join(sub, "leaf.txt"), "x");
  }
  const { artifacts } = await listPhaseArtifacts(root, []);
  const depths = artifacts.map((a) => a.path.split("/").length - 1);
  assert.equal(Math.max(...depths), ARTIFACT_LIST_DEPTH);
  assert.equal(artifacts.length, ARTIFACT_LIST_DEPTH);
});

test("listPhaseArtifacts skips symlinks", async () => {
  const root = await dir();
  await writeFile(path.join(root, "real.txt"), "x");
  try {
    await symlink(path.join(root, "real.txt"), path.join(root, "link.txt"));
  } catch {
    // Symlink creation needs privileges on some Windows setups; nothing to test then.
    return;
  }
  const { artifacts } = await listPhaseArtifacts(root, []);
  assert.deepEqual(
    artifacts.map((a) => a.path),
    ["real.txt"],
  );
});

test("listPhaseArtifacts treats invalid UTF-8 as not text", async () => {
  const root = await dir();
  await writeFile(path.join(root, "latin1.txt"), Buffer.from([0x68, 0xe9, 0x6c, 0x6c, 0x6f]));
  await writeFile(path.join(root, "utf8.txt"), "héllo — ok");
  const { artifacts } = await listPhaseArtifacts(root, []);
  const byPath = Object.fromEntries(artifacts.map((a) => [a.path, a]));
  assert.equal(byPath["latin1.txt"].text, false);
  assert.equal(byPath["utf8.txt"].text, true);
});

// ── reading ──────────────────────────────────────────────────────────────────

test("readPhaseArtifact returns text content and metadata", async () => {
  const root = await dir();
  await mkdir(path.join(root, "sub"));
  await writeFile(path.join(root, "sub", "report.md"), "# Hi\n\nbody");
  const got = await readPhaseArtifact(root, "sub/report.md");
  assert.ok(got);
  assert.equal(got.path, "sub/report.md");
  assert.equal(got.text, true);
  assert.equal(got.truncated, false);
  assert.equal(got.content, "# Hi\n\nbody");
  assert.equal(got.bytes, 10);
});

test("readPhaseArtifact clips at the read cap and marks truncated", async () => {
  const root = await dir();
  await writeFile(path.join(root, "big.txt"), "a".repeat(ARTIFACT_READ_CAP + 100));
  const got = await readPhaseArtifact(root, "big.txt");
  assert.ok(got);
  assert.equal(got.truncated, true);
  assert.equal(got.content?.length, ARTIFACT_READ_CAP);
  assert.equal(got.bytes, ARTIFACT_READ_CAP + 100);
});

test("readPhaseArtifact omits content for binary and returns null for escapes and misses", async () => {
  const root = await dir();
  await writeFile(path.join(root, "blob"), Buffer.from([0, 1, 2, 3]));
  await mkdir(path.join(root, "folder"));
  const bin = await readPhaseArtifact(root, "blob");
  assert.ok(bin);
  assert.equal(bin.text, false);
  assert.equal(bin.content, undefined);
  assert.equal(await readPhaseArtifact(root, "../blob"), null);
  assert.equal(await readPhaseArtifact(root, "missing.txt"), null);
  assert.equal(await readPhaseArtifact(root, "folder"), null);
  assert.equal(await readPhaseArtifact(null, "blob"), null);
});

// ── review ───────────────────────────────────────────────────────────────────

test("buildPhaseReview describes a gated phase with its artifacts", async () => {
  const root = await dir();
  await writeFile(path.join(root, "report.md"), "# R");
  await writeFile(path.join(root, "scratch.txt"), "s");
  const inst = instance(
    [
      phase({
        artifactDir: root,
        result: { ok: true },
        verification: {
          status: "passed",
          startedAt: "2026-01-01T00:00:00.000Z",
          endedAt: "2026-01-01T00:00:01.000Z",
          checks: [],
        },
      }),
    ],
    definition([{ kind: "artifact", path: "report.md" }]),
  );
  const res = await buildPhaseReview(inst, "draft", inst.definition);
  assert.ok(res.ok);
  const { review } = res;
  assert.equal(review.instanceId, "i1");
  assert.equal(review.phaseId, "draft");
  assert.equal(review.phaseName, "Draft");
  assert.equal(review.pipelineName, "Reports");
  assert.equal(review.status, "awaiting-approval");
  assert.equal(review.canApprove, true);
  assert.equal(review.attempt, 2);
  assert.deepEqual(review.payload, { summary: "done" });
  assert.deepEqual(review.result, { ok: true });
  assert.equal(review.verification?.status, "passed");
  assert.equal(review.artifactDir, root);
  assert.deepEqual(
    review.artifacts.map((a) => [a.path, a.required]),
    [
      ["report.md", true],
      ["scratch.txt", false],
    ],
  );
  assert.equal(review.truncated, undefined);
});

test("buildPhaseReview on a failed phase offers no approve", async () => {
  const inst = instance([
    phase({ status: "failed", payload: { reason: "boom" }, artifactDir: null }),
  ]);
  const res = await buildPhaseReview(inst, "draft", undefined);
  assert.ok(res.ok);
  assert.equal(res.review.status, "failed");
  assert.equal(res.review.canApprove, false);
  assert.deepEqual(res.review.artifacts, []);
  assert.equal(res.review.artifactDir, null);
  assert.equal("result" in res.review, false);
});

test("buildPhaseReview rejects unknown and non-paused phases", async () => {
  const inst = instance([phase({ status: "running" })]);
  const unknown = await buildPhaseReview(inst, "nope", undefined);
  assert.ok(!unknown.ok);
  assert.equal(unknown.code, 404);
  const running = await buildPhaseReview(inst, "draft", undefined);
  assert.ok(!running.ok);
  assert.equal(running.code, 409);
  assert.match(running.error, /running/);
});

test("buildPhaseReview reads required paths from the snapshot, not a live edit", async () => {
  const root = await dir();
  await writeFile(path.join(root, "old.md"), "o");
  await writeFile(path.join(root, "new.md"), "n");
  const snapshot = definition([{ kind: "artifact", path: "old.md" }]);
  const live = definition([{ kind: "artifact", path: "new.md" }]);
  const inst = instance([phase({ artifactDir: root })], snapshot);
  const res = await buildPhaseReview(inst, "draft", inst.definition ?? live);
  assert.ok(res.ok);
  const byPath = Object.fromEntries(res.review.artifacts.map((a) => [a.path, a.required]));
  assert.equal(byPath["old.md"], true);
  assert.equal(byPath["new.md"], false);
});

test("buildPhaseReview of a spawn phase shows each task's child as it is now", async () => {
  // Children are read from the instance store: this file has no per-test home.
  process.env.ARGUS_CLAUDE_HOME = await dir();
  /** A child of `parentId`'s task `key` at `index`, with its own phases. */
  const child = (
    id: string,
    parentId: string,
    index: number,
    key: string,
    phases: PhaseProgress[],
  ) =>
    writeInstance({
      ...instance(phases),
      id,
      pipelineId: "task",
      pipelineName: "Task",
      status: phases.some((p) => p.status === "failed") ? "failed" : "succeeded",
      trigger: "spawned",
      parent: { instanceId: parentId, pipelineId: "p1", phaseId: "tasks", index, key },
    });
  const children: PhaseChildren = {
    pipelineId: "task",
    source: { phaseId: "plan", attempt: 1 },
    maxParallel: 1,
    tasks: [
      { key: "a", title: "First", state: "succeeded", instanceId: "c-a" },
      { key: "b", state: "failed", instanceId: "c-b", reason: "phase build failed" },
      { key: "c", dependsOn: [1], state: "blocked" },
    ],
  };
  const spawnPhase = phase({
    id: "tasks",
    name: "Tasks",
    gated: false,
    steps: [],
    attempt: 1,
    pause: "children",
    payload: null,
    children,
  });
  const parent = {
    ...instance([phase({ id: "plan", status: "succeeded" }), spawnPhase]),
    id: "parent",
  };
  await child("c-a", "parent", 0, "a", [
    phase({ id: "build", name: "Build", status: "succeeded" }),
  ]);
  await child("c-b", "parent", 1, "b", [
    phase({ id: "build", name: "Build", status: "failed", attempt: 1 }),
    phase({ id: "review", name: "Review", status: "pending", attempt: 0 }),
  ]);
  // Another parent's child for a task with the same key: never this parent's.
  await child("c-other", "other", 2, "c", [phase({ id: "build", name: "Build" })]);
  const before = structuredClone(children);

  const res = await buildPhaseReview(parent, "tasks", undefined);
  assert.ok(res.ok, "a spawn phase paused at children has a review");
  const { review } = res;
  assert.equal(review.canApprove, true, "approving accepts the tasks that succeeded");
  assert.deepEqual(review.artifacts, [], "a spawn phase has no artifact folder");
  assert.ok(review.children, "the review carries the children");
  assert.equal(review.children.pipelineId, "task", "with the phase's own record");
  assert.deepEqual(review.children.source, { phaseId: "plan", attempt: 1 }, "source kept");
  assert.deepEqual(
    review.children.tasks[0],
    { ...children.tasks[0], child: { status: "succeeded" } },
    "a child with nothing waiting or failed has no decision phase",
  );
  assert.deepEqual(
    review.children.tasks[1].child,
    {
      status: "failed",
      decisionPhase: { phaseId: "build", phaseName: "Build", attempt: 1, status: "failed" },
    },
    "the failed child names the phase a person would revise",
  );
  assert.equal(review.children.tasks[1].reason, "phase build failed", "the task's own record");
  assert.equal(review.children.tasks[2].child, undefined, "a task with no child has none");
  assert.deepEqual(review.children.notSucceeded, ["b", "c"], "what approving drops");
  assert.deepEqual(children, before, "reading the review changes nothing on the phase");

  // A task that names a record of another parent is not shown that record.
  const stray = {
    ...parent,
    id: "stray",
    phases: [
      parent.phases[0],
      {
        ...spawnPhase,
        children: {
          ...children,
          tasks: [{ key: "c", state: "failed" as const, instanceId: "c-other" }],
        },
      },
    ],
  };
  const strayReview = await buildPhaseReview(stray, "tasks", undefined);
  assert.ok(strayReview.ok, "the stray parent has a review");
  assert.equal(strayReview.review.children?.tasks[0].child, undefined, "not its child");

  // The phase that produced the list is no spawn phase: no `children` key.
  const plan = await buildPhaseReview(
    { ...parent, phases: [phase({ id: "plan" }), spawnPhase] },
    "plan",
    undefined,
  );
  assert.ok(plan.ok, "the plan phase has a review");
  assert.equal("children" in plan.review, false, "an ordinary phase has no children key");
});
