import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { argusWorkRoot, paths } from "./claudeHome.js";

const saved = { home: process.env.ARGUS_CLAUDE_HOME, work: process.env.ARGUS_WORK_DIR };
afterEach(() => {
  for (const [key, value] of [
    ["ARGUS_CLAUDE_HOME", saved.home],
    ["ARGUS_WORK_DIR", saved.work],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("the work root is a sibling of the Claude home, never inside it", () => {
  const home = path.resolve("some", "where", ".claude");
  process.env.ARGUS_CLAUDE_HOME = home;
  delete process.env.ARGUS_WORK_DIR;
  assert.equal(argusWorkRoot(), path.resolve("some", "where", ".claude-argus"));
  const relative = path.relative(home, argusWorkRoot());
  assert.ok(relative.startsWith(".."), `work root must be outside ${home}`);
});

test("ARGUS_WORK_DIR overrides the work root", () => {
  process.env.ARGUS_CLAUDE_HOME = path.resolve("h", ".claude");
  process.env.ARGUS_WORK_DIR = path.resolve("elsewhere", "argus-work");
  assert.equal(argusWorkRoot(), path.resolve("elsewhere", "argus-work"));
});

test("every agent-writable directory lives under the work root; Argus state stays in the Claude home", () => {
  process.env.ARGUS_CLAUDE_HOME = path.resolve("h", ".claude");
  delete process.env.ARGUS_WORK_DIR;
  const root = argusWorkRoot();
  for (const dir of [
    paths.resultsDir(),
    paths.artifactsDir(),
    paths.worktreesDir(),
    paths.memoryDir(),
    paths.knowledgeDeltasDir(),
    paths.ruleVerificationsDir(),
    paths.changeProposalsDir(),
    paths.acceptanceVerificationsDir(),
  ]) {
    assert.equal(path.dirname(dir), root);
  }
  assert.equal(path.dirname(paths.pipelinesFile()), paths.argus());
  assert.equal(path.dirname(paths.knowledgeFile()), paths.argus());
});
