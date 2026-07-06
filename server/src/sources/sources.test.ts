import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-sources-"));
  process.env.ARGUS_CLAUDE_HOME = home;
});

// Fresh module per test so claudeHome() re-resolves the temp dir and the
// short-TTL read cache doesn't bleed between cases.
async function load(mod: string) {
  return import(`./${mod}.js?${Math.random()}`);
}

test("readProjects counts sessions per encoded project dir", async () => {
  mkdirSync(path.join(home, "projects", "-home-user-alpha"), { recursive: true });
  writeFileSync(path.join(home, "projects", "-home-user-alpha", "a.jsonl"), "{}\n");
  writeFileSync(path.join(home, "projects", "-home-user-alpha", "b.jsonl"), "{}\n");
  const { readProjects } = await load("projects");
  const projects = await readProjects();
  assert.equal(projects.length, 1);
  assert.equal(projects[0].sessionCount, 2);
});

test("readActivity normalizes history.jsonl newest-first", async () => {
  const lines = [
    { display: "first", timestamp: 1000, project: "/home/u/proj" },
    { display: "second", timestamp: 2000, project: "/home/u/proj" },
    { display: "", timestamp: 3000, project: "/home/u/proj" }, // empty text dropped
  ];
  writeFileSync(path.join(home, "history.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n"));
  const { readActivity } = await load("history");
  const activity = await readActivity();
  assert.equal(activity.length, 2);
  assert.equal(activity[0].text, "second"); // reversed = newest first
  assert.equal(activity[0].project, "proj");
});

test("readInventory reads markdown items and plugins", async () => {
  mkdirSync(path.join(home, "agents"), { recursive: true });
  writeFileSync(
    path.join(home, "agents", "reviewer.md"),
    "---\nname: reviewer\ndescription: reviews code\n---\nbody",
  );
  const { readInventory } = await load("inventory");
  const inv = await readInventory();
  assert.equal(inv.agents.length, 1);
  assert.equal(inv.agents[0].name, "reviewer");
  assert.equal(inv.agents[0].description, "reviews code");
  assert.deepEqual(inv.plugins, []);
});

test("readStats reports unavailable when no cache file exists", async () => {
  const { readStats } = await load("stats");
  const stats = await readStats();
  assert.equal(stats.available, false);
});

test("readTasks lists task directories with file counts", async () => {
  mkdirSync(path.join(home, "tasks", "t-1"), { recursive: true });
  writeFileSync(path.join(home, "tasks", "t-1", "1.json"), "{}");
  writeFileSync(path.join(home, "tasks", "t-1", "2.json"), "{}");
  const { readTasks } = await load("tasks");
  const tasks = await readTasks();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, "t-1");
  assert.ok(tasks[0].fileCount >= 2);
});

test("readAgents returns [] on an empty home and merges daemon liveness", async () => {
  const { readAgents } = await load("jobs");
  assert.deepEqual(await readAgents(), []);
  mkdirSync(path.join(home, "jobs", "abc123"), { recursive: true });
  writeFileSync(
    path.join(home, "jobs", "abc123", "state.json"),
    JSON.stringify({ state: "working", name: "job one" }),
  );
  const agents = await (await load("jobs")).readAgents();
  assert.equal(agents.length, 1);
  assert.equal(agents[0].short, "abc123");
  assert.equal(agents[0].status, "working");
  assert.equal(agents[0].live, false);
});
