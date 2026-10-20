/**
 * Transcripts in a pipeline's own Claude config folder (`claudeConfigDir`).
 *
 * The CLI files a folder run's session log under `<folder>/projects/`, not
 * under the operator's home. Every Claude transcript reader — the session
 * list, the session view, the live tail, the raw lines, search, the projects
 * list — finds it there through the folder its run recorded, beside the
 * operator's own sessions.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeRun } from "./runs.js";
import { claudeProjectRoots } from "./transcriptRoots.js";
import { readSession, readSessionLines, readSessionTail, readSessions } from "./sessions.js";
import { searchTranscripts } from "./search.js";
import { readProjects } from "./projects.js";
import type { Run } from "./scheduleTypes.js";

let home: string;
let folder: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-roots-home-"));
  folder = mkdtempSync(path.join(tmpdir(), "argus-roots-folder-"));
  process.env.ARGUS_CLAUDE_HOME = home;
});

const PROJECT = "-srv-app";
const OWN = "aaaaaaaa-0000-4000-8000-000000000001";
const IN_FOLDER = "bbbbbbbb-0000-4000-8000-000000000002";

/** One two-message Claude transcript under `<root>/projects/<project>/`. */
function transcript(root: string, id: string, text: string, at: string): void {
  const dir = path.join(root, "projects", PROJECT);
  mkdirSync(dir, { recursive: true });
  const lines = [
    { type: "user", timestamp: at, message: { role: "user", content: text } },
    {
      type: "assistant",
      timestamp: at,
      message: {
        role: "assistant",
        model: "claude-test",
        content: [{ type: "text", text: "done" }],
      },
    },
  ];
  writeFileSync(
    path.join(dir, `${id}.jsonl`),
    `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
  );
}

function pipelineRun(id: string, over: Partial<Run> = {}): Run {
  return {
    id,
    scheduleId: "pipeline:p1",
    scheduleName: "Loop · Build",
    prompt: "p",
    cwd: "/srv/app",
    status: "succeeded",
    trigger: "scheduled",
    queuedAt: "2026-10-20T10:00:00.000Z",
    startedAt: "2026-10-20T10:00:00.000Z",
    endedAt: "2026-10-20T10:05:00.000Z",
    durationMs: 300_000,
    pid: null,
    exitCode: 0,
    sessionId: IN_FOLDER,
    runtime: "claude",
    project: PROJECT,
    resultSummary: null,
    error: null,
    ...over,
  };
}

/** The operator's own session and a folder run's, in the same repository. */
async function bothSessions(): Promise<void> {
  transcript(home, OWN, "operator question", "2026-10-20T09:00:00.000Z");
  transcript(folder, IN_FOLDER, "pipeline build step", "2026-10-20T10:00:00.000Z");
  await writeRun(pipelineRun("run-folder", { claudeConfigDir: folder }));
}

test("claudeProjectRoots: the operator's projects first, then each recorded folder once", async () => {
  assert.deepEqual(await claudeProjectRoots(), [path.join(home, "projects")]);
  await writeRun(pipelineRun("run-a", { claudeConfigDir: folder }));
  await writeRun(pipelineRun("run-b", { claudeConfigDir: folder }));
  await writeRun(pipelineRun("run-c"));
  assert.deepEqual(await claudeProjectRoots(), [
    path.join(home, "projects"),
    path.join(folder, "projects"),
  ]);
});

test("sessions: a folder run's transcript is listed, opened, tailed and read like the operator's own", async () => {
  await bothSessions();
  const list = await readSessions();
  assert.deepEqual(list.map((s) => s.id).sort(), [OWN, IN_FOLDER].sort(), "both roots are listed");
  assert.ok(
    list.every((s) => s.project === PROJECT),
    "filed under the same project",
  );

  const detail = await readSession(PROJECT, IN_FOLDER);
  assert.equal(detail?.title, "pipeline build step", "the step's transcript link resolves");
  assert.equal(detail?.messages.length, 2);

  const tail = await readSessionTail(PROJECT, IN_FOLDER, -1);
  assert.equal(tail?.messages.length, 2, "the live tail reads it");

  const lines = await readSessionLines(PROJECT, IN_FOLDER);
  assert.equal(lines.length, 2, "the Flight Recorder's raw lines read it");

  assert.equal((await readSession(PROJECT, OWN))?.title, "operator question");
});

test("sessions: a folder no run recorded is not scanned", async () => {
  // Its own session id: readSession caches by (project, id) for a moment,
  // and an earlier test opened IN_FOLDER from another home.
  const unrecorded = "cccccccc-0000-4000-8000-000000000003";
  transcript(folder, unrecorded, "pipeline build step", "2026-10-20T10:00:00.000Z");
  await writeRun(pipelineRun("run-own", { sessionId: unrecorded }));
  assert.deepEqual(await readSessions(), []);
  assert.equal(await readSession(PROJECT, unrecorded), null);
});

test("search: a folder run's transcript is searchable", async () => {
  await bothSessions();
  const hits = await searchTranscripts("build step");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sessionId, IN_FOLDER);
  assert.equal(hits[0].project, PROJECT);
});

test("projects: one card per repository, counting the sessions of every root", async () => {
  await bothSessions();
  const projects = await readProjects();
  assert.equal(projects.length, 1);
  assert.equal(projects[0].id, PROJECT);
  assert.equal(projects[0].sessionCount, 2);
});
