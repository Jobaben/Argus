import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-sched-"));
  process.env.ARGUS_CLAUDE_HOME = home;
});

async function fresh() {
  // Import after env is set so claudeHome() resolves to the temp dir.
  return import(`./schedules.js?${Math.random()}`);
}

function getInput() {
  return {
    name: "Nightly",
    prompt: "do it",
    cwd: home,
    trigger: { kind: "daily", time: "02:00" },
  };
}

test("createSchedule persists and reads back", async () => {
  const m = await fresh();
  const created = await m.createSchedule(
    { ...getInput(), cwd: home },
    new Date(2026, 5, 22, 10, 0),
    "id-1",
  );
  assert.equal(created.id, "id-1");
  assert.equal(created.enabled, true);
  assert.equal(created.overlapPolicy, "skip");
  const all = await m.readSchedules();
  assert.equal(all.length, 1);
  assert.equal(all[0].name, "Nightly");
});

test("validateInput rejects missing prompt", async () => {
  const m = await fresh();
  assert.throws(
    () => m.validateInput({ name: "x", cwd: home, trigger: { kind: "daily", time: "02:00" } }),
    (e: Error) => e.name === "ScheduleValidationError",
  );
});

test("validateInput rejects a cwd that does not exist", async () => {
  const m = await fresh();
  assert.throws(
    () =>
      m.validateInput({
        name: "x",
        prompt: "p",
        cwd: path.join(home, "nope"),
        trigger: { kind: "interval", everyMinutes: 30 },
      }),
    (e: Error) => e.name === "ScheduleValidationError",
  );
});

test("updateSchedule patches and returns the row", async () => {
  const m = await fresh();
  await m.createSchedule({ ...getInput(), cwd: home }, new Date(2026, 5, 22, 10, 0), "id-1");
  const updated = await m.updateSchedule("id-1", { enabled: false }, new Date(2026, 5, 22, 11, 0));
  assert.equal(updated?.enabled, false);
});

test("deleteSchedule removes the row", async () => {
  const m = await fresh();
  await m.createSchedule({ ...getInput(), cwd: home }, new Date(2026, 5, 22, 10, 0), "id-1");
  assert.equal(await m.deleteSchedule("id-1"), true);
  assert.equal((await m.readSchedules()).length, 0);
});

test("corrupt schedules.json reads as empty and is never overwritten", async () => {
  const m = await fresh();
  mkdirSync(path.join(home, "argus"), { recursive: true });
  writeFileSync(path.join(home, "argus", "schedules.json"), "{ not json");
  assert.deepEqual(await m.readSchedules(), []);
  await assert.rejects(
    () => m.createSchedule({ ...getInput(), cwd: home }, new Date(), "id-2"),
    /could not be parsed/,
  );
});

test("readSchedulesWithNext attaches a future nextRun", async () => {
  const m = await fresh();
  await m.createSchedule({ ...getInput(), cwd: home }, new Date(2026, 5, 22, 10, 0), "id-1");
  const rows = await m.readSchedulesWithNext(new Date(2026, 5, 22, 9, 0));
  assert.deepEqual(new Date(rows[0].nextRun), new Date(2026, 5, 23, 2, 0));
});

test("validateInput rejects an out-of-range time", async () => {
  const m = await fresh();
  assert.throws(
    () =>
      m.validateInput({
        name: "x",
        prompt: "p",
        cwd: home,
        trigger: { kind: "daily", time: "25:61" },
      }),
    (e: Error) => e.name === "ScheduleValidationError",
  );
});

test("validatePatch accepts a partial body (enable/disable only)", async () => {
  const m = await fresh();
  const patch = m.validatePatch({ enabled: false });
  assert.deepEqual(patch, { enabled: false });
});

test("validatePatch validates only present fields and rejects a bad trigger", async () => {
  const m = await fresh();
  assert.throws(
    () => m.validatePatch({ trigger: { kind: "daily", time: "99:99" } }),
    (e: Error) => e.name === "ScheduleValidationError",
  );
});

test("validatePatch rejects a non-existent cwd when cwd is present", async () => {
  const m = await fresh();
  assert.throws(
    () => m.validatePatch({ cwd: path.join(home, "nope") }),
    (e: Error) => e.name === "ScheduleValidationError",
  );
});
