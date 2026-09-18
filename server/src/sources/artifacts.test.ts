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
import type { PhaseProgress, PipelineDefinition, PipelineInstance } from "./pipelineTypes.js";

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
