# Scheduled Runs Monitoring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Argus create, fire, and monitor scheduled headless Claude runs — surfacing upcoming, currently-running, and past runs with their detail.

**Architecture:** Approach A from the design doc. A scheduler module embedded in the existing Argus server re-reads `~/.claude/argus/schedules.json` on a fixed tick, spawns due `claude -p` runs as child processes, and writes per-run records + logs under `~/.claude/argus/runs/`. All state is files; the existing chokidar→WebSocket pattern pushes live updates. A new Schedules pane in the React app provides create/edit plus the running/recent runs view.

**Tech Stack:** TypeScript (ESM), Node ≥20 run via `tsx`, Hono + `ws` (server), React + Vite + Tailwind (web). Tests use Node's built-in `node:test` runner via `tsx` (no new dependency).

**Spec:** `docs/superpowers/specs/2026-06-22-scheduled-runs-monitoring-design.md`

## Global Constraints

- **Module system:** ESM throughout. Relative imports in server code use the `.js` extension (e.g. `import { paths } from "../claudeHome.js"`), matching the existing source.
- **No new runtime dependencies.** Tests run with the already-present `tsx`. Frontend has no test runner; frontend tasks are verified by `typecheck` + `build` + a manual check.
- **Node ≥20**, workspaces are `server` and `web`. Package manager is yarn; per-workspace scripts are invoked as shown in each step.
- **Localhost only.** The new write routes inherit the server's existing localhost bind — do not add network exposure or auth.
- **SOLID / single responsibility:** each new file has one job; the scheduler depends on the sources' functions and takes an injected clock + spawn function so its logic is testable without a real clock or real `claude`.
- **Scope strictly to scheduled runs.** Do not refactor unrelated files or restructure existing views.
- **Commits:** Per the user's standing workflow, do NOT auto-commit. Each task ends by staging its files (`git add`) and leaving them uncommitted for the user to review in their IDE. Before starting Task 1, create a feature branch: `git checkout -b feat/scheduled-runs`.
- **Times are local machine time.** Pure date functions take `from`/`now`/`anchor` as parameters (never read the clock internally) so tests are deterministic and timezone-agnostic.
- **Defaults (from spec):** tick 30s (`ARGUS_SCHED_TICK_MS`), grace = `max(2×tick, 5min)`, overlap default `skip`, retention 50 runs/schedule, log cap 1 MB/run, no backfill of missed windows.

---

### Task 1: Shared types + Claude-home paths

**Files:**
- Create: `server/src/sources/scheduleTypes.ts`
- Modify: `server/src/claudeHome.ts` (extend the `paths` object)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `scheduleTypes.ts`: `TriggerKind`, `Trigger`, `Schedule`, `RunStatus`, `Run` (exact shapes below).
  - `claudeHome.ts` `paths`: adds `argus(): string`, `schedulesFile(): string`, `runsDir(): string`.

- [ ] **Step 1: Create the shared types**

Create `server/src/sources/scheduleTypes.ts`:

```ts
export type TriggerKind = "interval" | "daily" | "weekly";

/** When a schedule fires. `everyMinutes` for interval; `time` ("HH:MM", local)
 * for daily/weekly; `weekday` (0=Sun..6=Sat) for weekly. */
export interface Trigger {
  kind: TriggerKind;
  everyMinutes?: number;
  time?: string;
  weekday?: number;
}

export interface Schedule {
  id: string;
  name: string;
  prompt: string;
  cwd: string;
  trigger: Trigger;
  enabled: boolean;
  overlapPolicy: "skip" | "allow";
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  lastRunId: string | null;
}

export type RunStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "interrupted";

export interface Run {
  id: string;
  scheduleId: string;
  scheduleName: string;
  prompt: string;
  cwd: string;
  status: RunStatus;
  trigger: "scheduled" | "manual";
  queuedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  pid: number | null;
  exitCode: number | null;
  sessionId: string | null;
  project: string | null;
  resultSummary: string | null;
  error: string | null;
}
```

- [ ] **Step 2: Extend the paths object**

In `server/src/claudeHome.ts`, add three entries to the exported `paths` object (after `tasks`):

```ts
  tasks: () => path.join(claudeHome(), "tasks"),
  argus: () => path.join(claudeHome(), "argus"),
  schedulesFile: () => path.join(claudeHome(), "argus", "schedules.json"),
  runsDir: () => path.join(claudeHome(), "argus", "runs"),
```

- [ ] **Step 3: Verify it typechecks**

Run: `npm -w server run typecheck`
Expected: PASS (no errors).

- [ ] **Step 4: Stage**

```bash
git add server/src/sources/scheduleTypes.ts server/src/claudeHome.ts
```

---

### Task 2: Pure scheduling functions (the testable core)

**Files:**
- Create: `server/src/sources/nextFire.ts`
- Test: `server/src/sources/nextFire.test.ts`

**Interfaces:**
- Consumes: `Trigger`, `Schedule` from `scheduleTypes.js`.
- Produces:
  - `parseHHMM(time: string | undefined): [number, number]`
  - `nextFireTime(trigger: Trigger, from: Date): Date | null`
  - `nextFireAfter(trigger: Trigger, anchor: Date, now: Date): Date | null`
  - `previousFireTime(trigger: Trigger, anchor: Date, now: Date): Date | null`
  - `graceMsFor(tickMs: number): number`
  - `shouldFire(schedule: Schedule, now: Date, graceMs: number): boolean`

- [ ] **Step 1: Write the failing tests**

Create `server/src/sources/nextFire.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  nextFireTime,
  nextFireAfter,
  previousFireTime,
  graceMsFor,
  shouldFire,
} from "./nextFire.js";
import type { Schedule } from "./scheduleTypes.js";

// Local-time helper so assertions are timezone-agnostic.
const at = (y: number, mo: number, d: number, h: number, mi: number) =>
  new Date(y, mo, d, h, mi, 0, 0);

test("interval: previousFireTime returns null before one step elapses", () => {
  const anchor = at(2026, 5, 22, 10, 0);
  const now = at(2026, 5, 22, 10, 30);
  assert.equal(
    previousFireTime({ kind: "interval", everyMinutes: 60 }, anchor, now),
    null,
  );
});

test("interval: previousFireTime is the most recent mark <= now", () => {
  const anchor = at(2026, 5, 22, 10, 0);
  const now = at(2026, 5, 22, 12, 30);
  const prev = previousFireTime({ kind: "interval", everyMinutes: 60 }, anchor, now);
  assert.deepEqual(prev, at(2026, 5, 22, 12, 0));
});

test("daily: previousFireTime is today's time when already past", () => {
  const now = at(2026, 5, 22, 9, 0);
  const prev = previousFireTime({ kind: "daily", time: "02:00" }, at(2026, 5, 21, 0, 0), now);
  assert.deepEqual(prev, at(2026, 5, 22, 2, 0));
});

test("daily: previousFireTime is yesterday when today's time not reached", () => {
  const now = at(2026, 5, 22, 1, 0);
  const prev = previousFireTime({ kind: "daily", time: "02:00" }, at(2026, 5, 20, 0, 0), now);
  assert.deepEqual(prev, at(2026, 5, 21, 2, 0));
});

test("weekly: previousFireTime finds the most recent matching weekday", () => {
  // 2026-06-22 is a Monday (getDay()===1).
  const now = at(2026, 5, 22, 12, 0);
  const prev = previousFireTime({ kind: "weekly", time: "09:00", weekday: 1 }, at(2026, 5, 1, 0, 0), now);
  assert.deepEqual(prev, at(2026, 5, 22, 9, 0));
});

test("nextFireTime: daily rolls to tomorrow when past", () => {
  const next = nextFireTime({ kind: "daily", time: "02:00" }, at(2026, 5, 22, 9, 0));
  assert.deepEqual(next, at(2026, 5, 23, 2, 0));
});

test("nextFireAfter: interval steps strictly past now", () => {
  const next = nextFireAfter(
    { kind: "interval", everyMinutes: 60 },
    at(2026, 5, 22, 10, 0),
    at(2026, 5, 22, 12, 30),
  );
  assert.deepEqual(next, at(2026, 5, 22, 13, 0));
});

test("graceMsFor: max of 2x tick and 5 minutes", () => {
  assert.equal(graceMsFor(30000), 5 * 60000);
  assert.equal(graceMsFor(300000), 600000);
});

const baseSchedule = (over: Partial<Schedule>): Schedule => ({
  id: "s1",
  name: "n",
  prompt: "p",
  cwd: "/tmp",
  trigger: { kind: "interval", everyMinutes: 60 },
  enabled: true,
  overlapPolicy: "skip",
  createdAt: at(2026, 5, 22, 10, 0).toISOString(),
  updatedAt: at(2026, 5, 22, 10, 0).toISOString(),
  lastRunAt: null,
  lastRunId: null,
  ...over,
});

test("shouldFire: true when a fresh occurrence is within grace", () => {
  const s = baseSchedule({});
  assert.equal(shouldFire(s, at(2026, 5, 22, 11, 1), graceMsFor(30000)), true);
});

test("shouldFire: false when disabled", () => {
  const s = baseSchedule({ enabled: false });
  assert.equal(shouldFire(s, at(2026, 5, 22, 11, 1), graceMsFor(30000)), false);
});

test("shouldFire: false when the occurrence already ran", () => {
  const s = baseSchedule({ lastRunAt: at(2026, 5, 22, 11, 0).toISOString() });
  assert.equal(shouldFire(s, at(2026, 5, 22, 11, 1), graceMsFor(30000)), false);
});

test("shouldFire: false when the window was missed (Argus was down)", () => {
  // Daily 02:00; now is 09:00, far past the 5-min grace → skip, no backfill.
  const s = baseSchedule({
    trigger: { kind: "daily", time: "02:00" },
    lastRunAt: at(2026, 5, 21, 2, 0).toISOString(),
  });
  assert.equal(shouldFire(s, at(2026, 5, 22, 9, 0), graceMsFor(30000)), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test server/src/sources/nextFire.test.ts`
Expected: FAIL — cannot find module `./nextFire.js`.

- [ ] **Step 3: Implement the pure functions**

Create `server/src/sources/nextFire.ts`:

```ts
import type { Schedule, Trigger } from "./scheduleTypes.js";

export function parseHHMM(time: string | undefined): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time ?? "");
  if (!m) return [0, 0];
  const h = Math.min(23, Math.max(0, Number(m[1])));
  const mi = Math.min(59, Math.max(0, Number(m[2])));
  return [h, mi];
}

function atTime(ref: Date, h: number, mi: number): Date {
  return new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), h, mi, 0, 0);
}

/** The most recent scheduled instant at or before `now`, or null if none. */
export function previousFireTime(
  trigger: Trigger,
  anchor: Date,
  now: Date,
): Date | null {
  if (trigger.kind === "interval") {
    const step = (trigger.everyMinutes ?? 0) * 60000;
    if (step <= 0) return null;
    const elapsed = now.getTime() - anchor.getTime();
    if (elapsed < step) return null;
    const k = Math.floor(elapsed / step);
    return new Date(anchor.getTime() + k * step);
  }
  const [h, mi] = parseHHMM(trigger.time);
  if (trigger.kind === "daily") {
    const cand = atTime(now, h, mi);
    if (cand.getTime() <= now.getTime()) return cand;
    const y = new Date(cand);
    y.setDate(y.getDate() - 1);
    return y;
  }
  // weekly
  const wd = trigger.weekday ?? 0;
  const cand = atTime(now, h, mi);
  const back = (now.getDay() - wd + 7) % 7;
  const occ = new Date(cand);
  occ.setDate(occ.getDate() - back);
  if (occ.getTime() > now.getTime()) occ.setDate(occ.getDate() - 7);
  return occ;
}

/** The next scheduled instant strictly after `from`. */
export function nextFireTime(trigger: Trigger, from: Date): Date | null {
  if (trigger.kind === "interval") {
    const step = (trigger.everyMinutes ?? 0) * 60000;
    if (step <= 0) return null;
    return new Date(from.getTime() + step);
  }
  const [h, mi] = parseHHMM(trigger.time);
  if (trigger.kind === "daily") {
    const cand = atTime(from, h, mi);
    if (cand.getTime() > from.getTime()) return cand;
    const n = new Date(cand);
    n.setDate(n.getDate() + 1);
    return n;
  }
  const wd = trigger.weekday ?? 0;
  const cand = atTime(from, h, mi);
  const fwd = (wd - from.getDay() + 7) % 7;
  const occ = new Date(cand);
  occ.setDate(occ.getDate() + fwd);
  if (occ.getTime() <= from.getTime()) occ.setDate(occ.getDate() + 7);
  return occ;
}

/** The next fire strictly after `now`, given an interval anchor for cadence. */
export function nextFireAfter(
  trigger: Trigger,
  anchor: Date,
  now: Date,
): Date | null {
  if (trigger.kind === "interval") {
    const step = (trigger.everyMinutes ?? 0) * 60000;
    if (step <= 0) return null;
    if (now.getTime() < anchor.getTime()) {
      return new Date(anchor.getTime() + step);
    }
    const k = Math.floor((now.getTime() - anchor.getTime()) / step) + 1;
    return new Date(anchor.getTime() + k * step);
  }
  return nextFireTime(trigger, now);
}

export function graceMsFor(tickMs: number): number {
  return Math.max(2 * tickMs, 5 * 60000);
}

/** Whether this schedule is due to fire at `now` (within the grace window). */
export function shouldFire(
  schedule: Schedule,
  now: Date,
  graceMs: number,
): boolean {
  if (!schedule.enabled) return false;
  const anchor = new Date(schedule.lastRunAt ?? schedule.createdAt);
  const prev = previousFireTime(schedule.trigger, anchor, now);
  if (!prev) return false;
  if (schedule.lastRunAt && new Date(schedule.lastRunAt).getTime() >= prev.getTime()) {
    return false;
  }
  return now.getTime() - prev.getTime() <= graceMs;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test server/src/sources/nextFire.test.ts`
Expected: PASS — all tests (`# pass 13`, `# fail 0`).

- [ ] **Step 5: Stage**

```bash
git add server/src/sources/nextFire.ts server/src/sources/nextFire.test.ts
```

---

### Task 3: Schedules source (CRUD + atomic, corrupt-safe persistence)

**Files:**
- Create: `server/src/sources/schedules.ts`
- Test: `server/src/sources/schedules.test.ts`

**Interfaces:**
- Consumes: `Schedule`, `Trigger` from `scheduleTypes.js`; `paths` from `../claudeHome.js`; `nextFireAfter` from `./nextFire.js`.
- Produces:
  - `ScheduleInput` = `{ name, prompt, cwd, trigger, enabled?, overlapPolicy? }`
  - `class ScheduleValidationError extends Error`
  - `validateInput(input: unknown): ScheduleInput` (throws `ScheduleValidationError`)
  - `readSchedules(): Promise<Schedule[]>`
  - `readSchedulesWithNext(now: Date): Promise<(Schedule & { nextRun: string | null })[]>`
  - `createSchedule(input: ScheduleInput, now: Date, id: string): Promise<Schedule>`
  - `updateSchedule(id: string, patch: Partial<ScheduleInput>, now: Date): Promise<Schedule | null>`
  - `deleteSchedule(id: string): Promise<boolean>`
  - `markScheduleRan(id: string, runId: string, atISO: string): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Create `server/src/sources/schedules.test.ts`:

```ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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

const input = {
  name: "Nightly",
  prompt: "do it",
  cwd: home || tmpdir(),
  trigger: { kind: "daily", time: "02:00" },
};

test("createSchedule persists and reads back", async () => {
  const m = await fresh();
  const created = await m.createSchedule(
    { ...input, cwd: home },
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
  await m.createSchedule({ ...input, cwd: home }, new Date(2026, 5, 22, 10, 0), "id-1");
  const updated = await m.updateSchedule("id-1", { enabled: false }, new Date(2026, 5, 22, 11, 0));
  assert.equal(updated?.enabled, false);
});

test("deleteSchedule removes the row", async () => {
  const m = await fresh();
  await m.createSchedule({ ...input, cwd: home }, new Date(2026, 5, 22, 10, 0), "id-1");
  assert.equal(await m.deleteSchedule("id-1"), true);
  assert.equal((await m.readSchedules()).length, 0);
});

test("corrupt schedules.json reads as empty and is never overwritten", async () => {
  const m = await fresh();
  mkdirSync(path.join(home, "argus"), { recursive: true });
  writeFileSync(path.join(home, "argus", "schedules.json"), "{ not json");
  assert.deepEqual(await m.readSchedules(), []);
  await assert.rejects(
    () => m.createSchedule({ ...input, cwd: home }, new Date(), "id-2"),
    /could not be parsed/,
  );
});

test("readSchedulesWithNext attaches a future nextRun", async () => {
  const m = await fresh();
  await m.createSchedule({ ...input, cwd: home }, new Date(2026, 5, 22, 10, 0), "id-1");
  const rows = await m.readSchedulesWithNext(new Date(2026, 5, 22, 9, 0));
  assert.deepEqual(new Date(rows[0].nextRun), new Date(2026, 5, 23, 2, 0));
});
```

> Note: delete `process.env.ARGUS_CLAUDE_HOME` between runs is unnecessary — `beforeEach` overwrites it. The temp dirs are left for the OS to reap.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test server/src/sources/schedules.test.ts`
Expected: FAIL — cannot find module `./schedules.js`.

- [ ] **Step 3: Implement the schedules source**

Create `server/src/sources/schedules.ts`:

```ts
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { paths } from "../claudeHome.js";
import { nextFireAfter } from "./nextFire.js";
import type { Schedule, Trigger } from "./scheduleTypes.js";

export class ScheduleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleValidationError";
  }
}

export interface ScheduleInput {
  name: string;
  prompt: string;
  cwd: string;
  trigger: Trigger;
  enabled?: boolean;
  overlapPolicy?: "skip" | "allow";
}

function validateTrigger(t: unknown): Trigger {
  if (!t || typeof t !== "object") throw new ScheduleValidationError("trigger is required");
  const trig = t as Trigger;
  if (trig.kind === "interval") {
    if (!Number.isFinite(trig.everyMinutes) || (trig.everyMinutes ?? 0) < 1) {
      throw new ScheduleValidationError("interval trigger needs everyMinutes >= 1");
    }
    return { kind: "interval", everyMinutes: Math.floor(trig.everyMinutes as number) };
  }
  if (trig.kind === "daily" || trig.kind === "weekly") {
    if (!/^\d{1,2}:\d{2}$/.test(trig.time ?? "")) {
      throw new ScheduleValidationError(`${trig.kind} trigger needs time "HH:MM"`);
    }
    if (trig.kind === "weekly" && !(Number(trig.weekday) >= 0 && Number(trig.weekday) <= 6)) {
      throw new ScheduleValidationError("weekly trigger needs weekday 0-6");
    }
    return trig.kind === "weekly"
      ? { kind: "weekly", time: trig.time, weekday: Number(trig.weekday) }
      : { kind: "daily", time: trig.time };
  }
  throw new ScheduleValidationError("trigger.kind must be interval|daily|weekly");
}

export function validateInput(raw: unknown): ScheduleInput {
  if (!raw || typeof raw !== "object") throw new ScheduleValidationError("body required");
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string" || !r.name.trim()) {
    throw new ScheduleValidationError("name is required");
  }
  if (typeof r.prompt !== "string" || !r.prompt.trim()) {
    throw new ScheduleValidationError("prompt is required");
  }
  if (typeof r.cwd !== "string" || !r.cwd.trim()) {
    throw new ScheduleValidationError("cwd is required");
  }
  if (!existsSync(r.cwd) || !statSync(r.cwd).isDirectory()) {
    throw new ScheduleValidationError(`cwd does not exist: ${r.cwd}`);
  }
  const trigger = validateTrigger(r.trigger);
  const overlapPolicy = r.overlapPolicy === "allow" ? "allow" : "skip";
  const enabled = r.enabled === undefined ? true : Boolean(r.enabled);
  return { name: r.name.trim(), prompt: r.prompt.trim(), cwd: r.cwd, trigger, enabled, overlapPolicy };
}

/** Reads the raw file; returns { ok, list } so writers can refuse on corruption. */
async function readRaw(): Promise<{ ok: boolean; list: Schedule[] }> {
  let text: string;
  try {
    text = await readFile(paths.schedulesFile(), "utf8");
  } catch {
    return { ok: true, list: [] }; // missing file = empty, writable
  }
  try {
    const parsed = JSON.parse(text) as Schedule[];
    return { ok: true, list: Array.isArray(parsed) ? parsed : [] };
  } catch {
    return { ok: false, list: [] }; // present but corrupt = do not overwrite
  }
}

export async function readSchedules(): Promise<Schedule[]> {
  return (await readRaw()).list;
}

async function writeSchedules(list: Schedule[]): Promise<void> {
  const current = await readRaw();
  if (!current.ok) {
    throw new Error("schedules.json could not be parsed; refusing to overwrite it");
  }
  await mkdir(paths.argus(), { recursive: true });
  const file = paths.schedulesFile();
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(list, null, 2), "utf8");
  await rename(tmp, file);
}

export async function readSchedulesWithNext(
  now: Date,
): Promise<(Schedule & { nextRun: string | null })[]> {
  const list = await readSchedules();
  return list.map((s) => {
    const anchor = new Date(s.lastRunAt ?? s.createdAt);
    const next = s.enabled ? nextFireAfter(s.trigger, anchor, now) : null;
    return { ...s, nextRun: next ? next.toISOString() : null };
  });
}

export async function createSchedule(
  input: ScheduleInput,
  now: Date,
  id: string,
): Promise<Schedule> {
  const iso = now.toISOString();
  const schedule: Schedule = {
    id,
    name: input.name,
    prompt: input.prompt,
    cwd: input.cwd,
    trigger: input.trigger,
    enabled: input.enabled ?? true,
    overlapPolicy: input.overlapPolicy ?? "skip",
    createdAt: iso,
    updatedAt: iso,
    lastRunAt: null,
    lastRunId: null,
  };
  const list = await readSchedules();
  list.push(schedule);
  await writeSchedules(list);
  return schedule;
}

export async function updateSchedule(
  id: string,
  patch: Partial<ScheduleInput>,
  now: Date,
): Promise<Schedule | null> {
  const list = await readSchedules();
  const idx = list.findIndex((s) => s.id === id);
  if (idx === -1) return null;
  const merged: Schedule = {
    ...list[idx],
    ...("name" in patch ? { name: patch.name! } : {}),
    ...("prompt" in patch ? { prompt: patch.prompt! } : {}),
    ...("cwd" in patch ? { cwd: patch.cwd! } : {}),
    ...("trigger" in patch ? { trigger: patch.trigger! } : {}),
    ...("enabled" in patch ? { enabled: patch.enabled! } : {}),
    ...("overlapPolicy" in patch ? { overlapPolicy: patch.overlapPolicy! } : {}),
    updatedAt: now.toISOString(),
  };
  list[idx] = merged;
  await writeSchedules(list);
  return merged;
}

export async function deleteSchedule(id: string): Promise<boolean> {
  const list = await readSchedules();
  const next = list.filter((s) => s.id !== id);
  if (next.length === list.length) return false;
  await writeSchedules(next);
  return true;
}

export async function markScheduleRan(
  id: string,
  runId: string,
  atISO: string,
): Promise<void> {
  const list = await readSchedules();
  const idx = list.findIndex((s) => s.id === id);
  if (idx === -1) return;
  list[idx] = { ...list[idx], lastRunAt: atISO, lastRunId: runId };
  await writeSchedules(list);
}

// Re-export so callers have one import site for path joins if needed later.
export { path };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test server/src/sources/schedules.test.ts`
Expected: PASS — `# fail 0`.

- [ ] **Step 5: Stage**

```bash
git add server/src/sources/schedules.ts server/src/sources/schedules.test.ts
```

---

### Task 4: Runs source (records, log, retention, transcript link)

**Files:**
- Create: `server/src/sources/runs.ts`
- Test: `server/src/sources/runs.test.ts`

**Interfaces:**
- Consumes: `Run`, `RunStatus` from `scheduleTypes.js`; `paths` from `../claudeHome.js`.
- Produces:
  - `LOG_CAP_BYTES = 1_048_576`, `RUN_KEEP = 50`
  - `encodeProject(cwd: string): string`
  - `runLogPath(id: string): string`
  - `writeRun(run: Run): Promise<void>` (atomic)
  - `readRuns(opts?: { scheduleId?: string; limit?: number }): Promise<Run[]>` (newest first by `queuedAt`)
  - `readRun(id: string): Promise<{ run: Run; log: string } | null>` (log is the last `LOG_CAP_BYTES` tail)
  - `pruneRuns(scheduleId: string, keep: number): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Create `server/src/sources/runs.test.ts`:

```ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-runs-"));
  process.env.ARGUS_CLAUDE_HOME = home;
});

async function fresh() {
  return import(`./runs.js?${Math.random()}`);
}

const makeRun = (id: string, scheduleId: string, queuedAt: string) => ({
  id,
  scheduleId,
  scheduleName: "n",
  prompt: "p",
  cwd: "/tmp",
  status: "succeeded" as const,
  trigger: "scheduled" as const,
  queuedAt,
  startedAt: queuedAt,
  endedAt: queuedAt,
  durationMs: 10,
  pid: 123,
  exitCode: 0,
  sessionId: "sess-1",
  project: null,
  resultSummary: "ok",
  error: null,
});

test("encodeProject mirrors Claude Code's dir encoding", async () => {
  const m = await fresh();
  assert.equal(m.encodeProject("C:\\GIT\\argus"), "C--GIT-argus");
});

test("writeRun then readRun round-trips with a log tail", async () => {
  const m = await fresh();
  const run = makeRun("r1", "s1", new Date(2026, 5, 22, 10, 0).toISOString());
  await m.writeRun(run);
  writeFileSync(m.runLogPath("r1"), "hello log");
  const got = await m.readRun("r1");
  assert.equal(got?.run.id, "r1");
  assert.equal(got?.log, "hello log");
});

test("readRuns returns newest first and filters by schedule", async () => {
  const m = await fresh();
  await m.writeRun(makeRun("a", "s1", new Date(2026, 5, 22, 10, 0).toISOString()));
  await m.writeRun(makeRun("b", "s1", new Date(2026, 5, 22, 11, 0).toISOString()));
  await m.writeRun(makeRun("c", "s2", new Date(2026, 5, 22, 12, 0).toISOString()));
  const s1 = await m.readRuns({ scheduleId: "s1" });
  assert.deepEqual(s1.map((r: { id: string }) => r.id), ["b", "a"]);
});

test("pruneRuns keeps only the newest N of a schedule", async () => {
  const m = await fresh();
  for (let i = 0; i < 5; i++) {
    await m.writeRun(makeRun(`r${i}`, "s1", new Date(2026, 5, 22, 10, i).toISOString()));
  }
  await m.pruneRuns("s1", 2);
  const left = await m.readRuns({ scheduleId: "s1" });
  assert.deepEqual(left.map((r: { id: string }) => r.id), ["r4", "r3"]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test server/src/sources/runs.test.ts`
Expected: FAIL — cannot find module `./runs.js`.

- [ ] **Step 3: Implement the runs source**

Create `server/src/sources/runs.ts`:

```ts
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { open } from "node:fs/promises";
import path from "node:path";
import { paths } from "../claudeHome.js";
import type { Run } from "./scheduleTypes.js";

export const LOG_CAP_BYTES = 1_048_576; // 1 MB
export const RUN_KEEP = 50;

/** Mirrors Claude Code's project-dir encoding so we can link to transcripts. */
export function encodeProject(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

export function runLogPath(id: string): string {
  return path.join(paths.runsDir(), `${id}.log`);
}

function runJsonPath(id: string): string {
  return path.join(paths.runsDir(), `${id}.json`);
}

export async function writeRun(run: Run): Promise<void> {
  await mkdir(paths.runsDir(), { recursive: true });
  const file = runJsonPath(run.id);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(run, null, 2), "utf8");
  await rename(tmp, file);
}

async function readRunFile(id: string): Promise<Run | null> {
  try {
    return JSON.parse(await readFile(runJsonPath(id), "utf8")) as Run;
  } catch {
    return null;
  }
}

export async function readRuns(
  opts: { scheduleId?: string; limit?: number } = {},
): Promise<Run[]> {
  let names: string[];
  try {
    names = (await readdir(paths.runsDir())).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const runs = (
    await Promise.all(names.map((f) => readRunFile(f.replace(/\.json$/, ""))))
  ).filter((r): r is Run => r !== null);
  let out = runs.sort((a, b) => b.queuedAt.localeCompare(a.queuedAt));
  if (opts.scheduleId) out = out.filter((r) => r.scheduleId === opts.scheduleId);
  if (opts.limit && opts.limit > 0) out = out.slice(0, opts.limit);
  return out;
}

/** Reads a run plus the last LOG_CAP_BYTES of its log. */
export async function readRun(
  id: string,
): Promise<{ run: Run; log: string } | null> {
  const run = await readRunFile(id);
  if (!run) return null;
  let log = "";
  try {
    const file = runLogPath(id);
    const size = (await stat(file)).size;
    const start = Math.max(0, size - LOG_CAP_BYTES);
    const handle = await open(file, "r");
    try {
      const { buffer } = await handle.read({
        buffer: Buffer.alloc(size - start),
        position: start,
      });
      log = (start > 0 ? "…(truncated)…\n" : "") + buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    log = "";
  }
  return { run, log };
}

export async function pruneRuns(scheduleId: string, keep: number): Promise<void> {
  const mine = await readRuns({ scheduleId });
  const drop = mine.slice(keep);
  await Promise.all(
    drop.flatMap((r) => [
      rm(runJsonPath(r.id), { force: true }),
      rm(runLogPath(r.id), { force: true }),
    ]),
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test server/src/sources/runs.test.ts`
Expected: PASS — `# fail 0`.

- [ ] **Step 5: Stage**

```bash
git add server/src/sources/runs.ts server/src/sources/runs.test.ts
```

---

### Task 5: Scheduler (tick, overlap, spawn, crash recovery)

**Files:**
- Create: `server/src/scheduler.ts`
- Test: `server/src/scheduler.test.ts`

**Interfaces:**
- Consumes: `Schedule`, `Run` from `sources/scheduleTypes.js`; `shouldFire`, `graceMsFor` from `sources/nextFire.js`; `readSchedules`, `markScheduleRan` from `sources/schedules.js`; `readRuns`, `writeRun`, `runLogPath`, `pruneRuns`, `encodeProject`, `RUN_KEEP` from `sources/runs.js`.
- Produces:
  - `interface SpawnHandle { pid: number | null; done: Promise<{ code: number | null; result: string | null; error: string | null }> }`
  - `type SpawnFn = (run: Run, logPath: string) => SpawnHandle`
  - `interface SchedulerDeps { now: () => Date; spawn: SpawnFn; tickMs: number; newId: () => string; onChange?: () => void }`
  - `defaultSpawn: SpawnFn`
  - `isAlive(pid: number | null): boolean`
  - `recoverInterruptedRuns(deps: Pick<SchedulerDeps, "now">): Promise<void>`
  - `fireRun(schedule: Schedule, trigger: "scheduled" | "manual", deps: SchedulerDeps): Promise<Run>`
  - `tick(deps: SchedulerDeps): Promise<void>`
  - `startScheduler(overrides?: Partial<SchedulerDeps>): { stop: () => Promise<void> }`

- [ ] **Step 1: Write the failing tests**

Create `server/src/scheduler.test.ts`:

```ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-scheduler-"));
  process.env.ARGUS_CLAUDE_HOME = home;
});

async function load() {
  const scheduler = await import(`./scheduler.js?${Math.random()}`);
  const schedules = await import(`./sources/schedules.js?${Math.random()}`);
  const runs = await import(`./sources/runs.js?${Math.random()}`);
  return { scheduler, schedules, runs };
}

let counter = 0;
const deps = (over: Record<string, unknown>) => ({
  now: () => new Date(2026, 5, 22, 11, 1),
  tickMs: 30000,
  newId: () => `run-${++counter}`,
  spawn: () => ({ pid: 999, done: Promise.resolve({ code: 0, result: "done", error: null }) }),
  ...over,
});

test("tick fires a due schedule and records a succeeded run", async () => {
  const { scheduler, schedules, runs } = await load();
  await schedules.createSchedule(
    { name: "n", prompt: "p", cwd: home, trigger: { kind: "interval", everyMinutes: 60 } },
    new Date(2026, 5, 22, 10, 0),
    "s1",
  );
  await scheduler.tick(deps({}));
  // let the spawn promise resolve
  await new Promise((r) => setTimeout(r, 10));
  const list = await runs.readRuns({ scheduleId: "s1" });
  assert.equal(list.length, 1);
  assert.equal(list[0].status, "succeeded");
  const after = (await schedules.readSchedules())[0];
  assert.equal(after.lastRunId, list[0].id);
});

test("overlap=skip records a skipped run when a prior run is alive", async () => {
  const { scheduler, schedules, runs } = await load();
  await schedules.createSchedule(
    { name: "n", prompt: "p", cwd: home, trigger: { kind: "interval", everyMinutes: 60 } },
    new Date(2026, 5, 22, 10, 0),
    "s1",
  );
  // A prior run still "running" with this process's own (alive) pid.
  await runs.writeRun({
    id: "old", scheduleId: "s1", scheduleName: "n", prompt: "p", cwd: home,
    status: "running", trigger: "scheduled",
    queuedAt: new Date(2026, 5, 22, 10, 30).toISOString(),
    startedAt: new Date(2026, 5, 22, 10, 30).toISOString(),
    endedAt: null, durationMs: null, pid: process.pid, exitCode: null,
    sessionId: null, project: null, resultSummary: null, error: null,
  });
  await scheduler.tick(deps({ spawn: () => { throw new Error("should not spawn"); } }));
  const skipped = (await runs.readRuns({ scheduleId: "s1" })).find((r) => r.status === "skipped");
  assert.ok(skipped, "expected a skipped run");
});

test("recoverInterruptedRuns marks dead 'running' rows interrupted", async () => {
  const { scheduler, runs } = await load();
  await runs.writeRun({
    id: "dead", scheduleId: "s1", scheduleName: "n", prompt: "p", cwd: home,
    status: "running", trigger: "scheduled",
    queuedAt: new Date(2026, 5, 22, 10, 0).toISOString(),
    startedAt: new Date(2026, 5, 22, 10, 0).toISOString(),
    endedAt: null, durationMs: null, pid: 2_000_000_000, exitCode: null,
    sessionId: null, project: null, resultSummary: null, error: null,
  });
  await scheduler.recoverInterruptedRuns({ now: () => new Date(2026, 5, 22, 12, 0) });
  const got = await runs.readRun("dead");
  assert.equal(got?.run.status, "interrupted");
});

test("a failed spawn yields a failed run, scheduler does not throw", async () => {
  const { scheduler, schedules, runs } = await load();
  await schedules.createSchedule(
    { name: "n", prompt: "p", cwd: home, trigger: { kind: "interval", everyMinutes: 60 } },
    new Date(2026, 5, 22, 10, 0),
    "s1",
  );
  await scheduler.tick(deps({
    spawn: () => ({ pid: null, done: Promise.resolve({ code: 1, result: null, error: "boom" }) }),
  }));
  await new Promise((r) => setTimeout(r, 10));
  const list = await runs.readRuns({ scheduleId: "s1" });
  assert.equal(list[0].status, "failed");
  assert.equal(list[0].error, "boom");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test server/src/scheduler.test.ts`
Expected: FAIL — cannot find module `./scheduler.js`.

- [ ] **Step 3: Implement the scheduler**

Create `server/src/scheduler.ts`:

```ts
import { spawn as nodeSpawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { graceMsFor, shouldFire } from "./sources/nextFire.js";
import {
  markScheduleRan,
  readSchedules,
} from "./sources/schedules.js";
import {
  RUN_KEEP,
  encodeProject,
  pruneRuns,
  readRun,
  readRuns,
  runLogPath,
  writeRun,
} from "./sources/runs.js";
import type { Run, Schedule } from "./sources/scheduleTypes.js";

export interface SpawnHandle {
  pid: number | null;
  done: Promise<{ code: number | null; result: string | null; error: string | null }>;
}

export type SpawnFn = (run: Run, logPath: string) => SpawnHandle;

export interface SchedulerDeps {
  now: () => Date;
  spawn: SpawnFn;
  tickMs: number;
  newId: () => string;
  onChange?: () => void;
}

/** True if a process with `pid` is currently alive. */
export function isAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Real spawn: runs `claude -p <prompt>` in the run's cwd, piping stdout+stderr
 * to the log file. A pre-generated session id (already on the run) is passed so
 * the transcript can be linked; `--output-format json` lets us capture a result.
 *
 * NOTE: verify these flags against the installed CLI before relying on them:
 *   claude -p "hi" --output-format json --session-id <uuid>
 * Adjust the args here if the installed version differs.
 */
export const defaultSpawn: SpawnFn = (run, logPath) => {
  const out = createWriteStream(logPath, { flags: "a" });
  const child = nodeSpawn(
    "claude",
    ["-p", run.prompt, "--output-format", "json", "--session-id", run.sessionId ?? randomUUID()],
    { cwd: run.cwd, shell: process.platform === "win32" },
  );
  child.stdout?.pipe(out, { end: false });
  child.stderr?.pipe(out, { end: false });

  const done = new Promise<{ code: number | null; result: string | null; error: string | null }>(
    (resolve) => {
      let tail = "";
      child.stdout?.on("data", (d: Buffer) => {
        tail = (tail + d.toString("utf8")).slice(-8192);
      });
      child.on("error", (err) => {
        out.end();
        resolve({ code: null, result: null, error: err.message });
      });
      child.on("close", (code) => {
        out.end();
        let result: string | null = null;
        try {
          const parsed = JSON.parse(tail) as { result?: string };
          result = parsed.result ?? null;
        } catch {
          result = null;
        }
        resolve({ code, result, error: code === 0 ? null : `exit code ${code}` });
      });
    },
  );
  return { pid: child.pid ?? null, done };
};

/** Creates a run record, spawns it, and updates the record on completion. */
export async function fireRun(
  schedule: Schedule,
  trigger: "scheduled" | "manual",
  deps: SchedulerDeps,
): Promise<Run> {
  const startedAt = deps.now();
  const sessionId = randomUUID();
  const run: Run = {
    id: deps.newId(),
    scheduleId: schedule.id,
    scheduleName: schedule.name,
    prompt: schedule.prompt,
    cwd: schedule.cwd,
    status: "running",
    trigger,
    queuedAt: startedAt.toISOString(),
    startedAt: startedAt.toISOString(),
    endedAt: null,
    durationMs: null,
    pid: null,
    exitCode: null,
    sessionId,
    project: encodeProject(schedule.cwd),
    resultSummary: null,
    error: null,
  };
  await writeRun(run);
  await markScheduleRan(schedule.id, run.id, run.queuedAt);

  const handle = deps.spawn(run, runLogPath(run.id));
  run.pid = handle.pid;
  await writeRun(run);
  deps.onChange?.();

  // Track completion without blocking the tick.
  void handle.done.then(async (res) => {
    const ended = deps.now();
    const finished: Run = {
      ...run,
      status: res.code === 0 ? "succeeded" : "failed",
      endedAt: ended.toISOString(),
      durationMs: ended.getTime() - startedAt.getTime(),
      exitCode: res.code,
      resultSummary: res.result,
      error: res.error,
    };
    await writeRun(finished);
    await pruneRuns(schedule.id, RUN_KEEP);
    deps.onChange?.();
  });

  return run;
}

/** One scheduler pass: fire every due schedule, honouring overlap policy. */
export async function tick(deps: SchedulerDeps): Promise<void> {
  const now = deps.now();
  const grace = graceMsFor(deps.tickMs);
  const schedules = await readSchedules();
  for (const schedule of schedules) {
    if (!shouldFire(schedule, now, grace)) continue;

    if (schedule.overlapPolicy === "skip") {
      const alive = (await readRuns({ scheduleId: schedule.id })).some(
        (r) => r.status === "running" && isAlive(r.pid),
      );
      if (alive) {
        const iso = now.toISOString();
        await writeRun({
          id: deps.newId(),
          scheduleId: schedule.id,
          scheduleName: schedule.name,
          prompt: schedule.prompt,
          cwd: schedule.cwd,
          status: "skipped",
          trigger: "scheduled",
          queuedAt: iso,
          startedAt: null,
          endedAt: iso,
          durationMs: 0,
          pid: null,
          exitCode: null,
          sessionId: null,
          project: null,
          resultSummary: null,
          error: "skipped: previous run still in progress",
        });
        await markScheduleRan(schedule.id, "", iso);
        deps.onChange?.();
        continue;
      }
    }

    try {
      await fireRun(schedule, "scheduled", deps);
    } catch (e) {
      // Never let one schedule's failure break the tick.
      const iso = now.toISOString();
      await writeRun({
        id: deps.newId(),
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        prompt: schedule.prompt,
        cwd: schedule.cwd,
        status: "failed",
        trigger: "scheduled",
        queuedAt: iso,
        startedAt: iso,
        endedAt: iso,
        durationMs: 0,
        pid: null,
        exitCode: null,
        sessionId: null,
        project: null,
        resultSummary: null,
        error: e instanceof Error ? e.message : String(e),
      });
      deps.onChange?.();
    }
  }
}

/** On startup, mark any 'running' run whose process is gone as interrupted. */
export async function recoverInterruptedRuns(
  deps: Pick<SchedulerDeps, "now">,
): Promise<void> {
  const running = (await readRuns()).filter((r) => r.status === "running");
  for (const r of running) {
    if (isAlive(r.pid)) continue;
    const got = await readRun(r.id);
    if (!got) continue;
    const ended = deps.now();
    await writeRun({
      ...got.run,
      status: "interrupted",
      endedAt: ended.toISOString(),
      durationMs: got.run.startedAt
        ? ended.getTime() - new Date(got.run.startedAt).getTime()
        : null,
      error: "interrupted: Argus restarted while this run was in progress",
    });
  }
}

/** Boots the scheduler loop; returns a stop handle for graceful shutdown. */
export function startScheduler(
  overrides: Partial<SchedulerDeps> = {},
): { stop: () => Promise<void> } {
  const deps: SchedulerDeps = {
    now: () => new Date(),
    spawn: defaultSpawn,
    tickMs: Number(process.env.ARGUS_SCHED_TICK_MS ?? 30000),
    newId: () => randomUUID(),
    ...overrides,
  };

  let stopped = false;
  void recoverInterruptedRuns(deps).then(() => deps.onChange?.());

  const loop = setInterval(() => {
    if (stopped) return;
    void tick(deps).catch((e) => console.error("[argus] scheduler tick failed:", e));
  }, deps.tickMs);

  return {
    stop: async () => {
      stopped = true;
      clearInterval(loop);
    },
  };
}
```

> Note: `new Date()` and `randomUUID()` live only inside `startScheduler`'s default deps — every function under test receives an injected `now`/`newId`, keeping tests deterministic.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test server/src/scheduler.test.ts`
Expected: PASS — `# fail 0`.

- [ ] **Step 5: Run the whole server test suite**

Run: `npx tsx --test server/src/**/*.test.ts`
Expected: PASS across `nextFire`, `schedules`, `runs`, `scheduler`.

- [ ] **Step 6: Stage**

```bash
git add server/src/scheduler.ts server/src/scheduler.test.ts
```

---

### Task 6: API routes, scheduler boot, and file watch

**Files:**
- Modify: `server/src/index.ts` (add routes; boot/stop scheduler)
- Modify: `server/src/watch.ts` (add `watchSchedules`)
- Modify: `server/package.json` (add a `test` script)

**Interfaces:**
- Consumes: everything from `sources/schedules.js`, `sources/runs.js`, `scheduler.js`; `watchSchedules` from `watch.js`.
- Produces: HTTP routes `GET/POST /api/schedules`, `PUT/DELETE /api/schedules/:id`, `POST /api/schedules/:id/run`, `GET /api/runs`, `GET /api/runs/:id`. WS message type `"schedules:changed"`.

- [ ] **Step 1: Add a server `test` script**

In `server/package.json`, add to `scripts`:

```json
    "typecheck": "tsc --noEmit",
    "test": "tsx --test src/**/*.test.ts"
```

- [ ] **Step 2: Add the schedules watcher**

In `server/src/watch.ts`, add a second exported function below `watchAgents` (reuse the same debounce shape):

```ts
/** Watches the Argus scheduler state (schedules + run records). */
export function watchSchedules(onChange: () => void): () => Promise<void> {
  let timer: NodeJS.Timeout | null = null;
  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, 150);
  };

  const watcher = chokidar.watch([paths.argus()], {
    ignoreInitial: true,
    depth: 3,
    awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 },
  });

  watcher.on("add", fire).on("change", fire).on("unlink", fire).on("addDir", fire);

  return async () => {
    if (timer) clearTimeout(timer);
    await watcher.close();
  };
}
```

- [ ] **Step 3: Wire routes + scheduler into `index.ts`**

In `server/src/index.ts`, add imports near the existing source imports:

```ts
import { watchAgents, watchSchedules } from "./watch.js";
import {
  createSchedule,
  deleteSchedule,
  readSchedulesWithNext,
  updateSchedule,
  validateInput,
  ScheduleValidationError,
  readSchedules,
} from "./sources/schedules.js";
import { readRun, readRuns } from "./sources/runs.js";
import { defaultSpawn, fireRun, startScheduler } from "./scheduler.js";
import { randomUUID } from "node:crypto";
```

(Replace the existing `import { watchAgents } from "./watch.js";` line with the combined import above.)

Add these routes after the existing `/api/cron` route:

```ts
app.get("/api/schedules", async (c) =>
  c.json({ schedules: await readSchedulesWithNext(new Date()) }),
);

app.post("/api/schedules", async (c) => {
  try {
    const body = await c.req.json();
    const input = validateInput(body);
    const created = await createSchedule(input, new Date(), randomUUID());
    return c.json(created, 201);
  } catch (e) {
    if (e instanceof ScheduleValidationError) return c.json({ error: e.message }, 400);
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

app.put("/api/schedules/:id", async (c) => {
  try {
    const body = await c.req.json();
    // Full validation when core fields are present; partial enable/disable allowed.
    if ("prompt" in body || "cwd" in body || "trigger" in body || "name" in body) {
      validateInput({ ...body, name: body.name ?? "x", prompt: body.prompt ?? "x", cwd: body.cwd ?? process.cwd() });
    }
    const updated = await updateSchedule(c.req.param("id"), body, new Date());
    if (!updated) return c.json({ error: "not found" }, 404);
    return c.json(updated);
  } catch (e) {
    if (e instanceof ScheduleValidationError) return c.json({ error: e.message }, 400);
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

app.delete("/api/schedules/:id", async (c) =>
  (await deleteSchedule(c.req.param("id")))
    ? c.json({ ok: true })
    : c.json({ error: "not found" }, 404),
);

app.post("/api/schedules/:id/run", async (c) => {
  const all = await readSchedules();
  const schedule = all.find((s) => s.id === c.req.param("id"));
  if (!schedule) return c.json({ error: "not found" }, 404);
  const run = await fireRun(schedule, "manual", {
    now: () => new Date(),
    spawn: defaultSpawn,
    tickMs: Number(process.env.ARGUS_SCHED_TICK_MS ?? 30000),
    newId: () => randomUUID(),
    onChange: () => broadcast({ type: "schedules:changed" }),
  });
  return c.json(run, 202);
});

app.get("/api/runs", async (c) =>
  c.json({
    runs: await readRuns({
      scheduleId: c.req.query("scheduleId") || undefined,
      limit: c.req.query("limit") ? Number(c.req.query("limit")) : 100,
    }),
  }),
);

app.get("/api/runs/:id", async (c) => {
  const got = await readRun(c.req.param("id"));
  return got ? c.json(got) : c.json({ error: "not found" }, 404);
});
```

> `broadcast` is defined later in the file; route handlers run after module init, so the reference resolves. If your linter flags use-before-define, move the `broadcast` function declaration above the routes.

Then, after the existing `const stopWatching = watchAgents(...)` line, add:

```ts
const stopWatchingSchedules = watchSchedules(() =>
  broadcast({ type: "schedules:changed" }),
);
const scheduler = startScheduler({
  onChange: () => broadcast({ type: "schedules:changed" }),
});
```

And update `shutdown()` to tear them down:

```ts
async function shutdown() {
  await stopWatching();
  await stopWatchingSchedules();
  await scheduler.stop();
  wss.close();
  server.close();
  process.exit(0);
}
```

- [ ] **Step 4: Typecheck and smoke-test the routes**

Run: `npm -w server run typecheck`
Expected: PASS.

Then manually smoke-test against a temp home (does not spawn `claude`):

```bash
ARGUS_CLAUDE_HOME="$(mktemp -d)" ARGUS_PORT=7788 npx tsx server/src/index.ts &
sleep 1
curl -s -X POST localhost:7788/api/schedules -H 'content-type: application/json' \
  -d "{\"name\":\"t\",\"prompt\":\"hi\",\"cwd\":\"$PWD\",\"trigger\":{\"kind\":\"daily\",\"time\":\"02:00\"}}"
curl -s localhost:7788/api/schedules
kill %1
```
Expected: POST returns the created schedule (201); GET lists it with a `nextRun` ISO timestamp.

- [ ] **Step 5: Stage**

```bash
git add server/src/index.ts server/src/watch.ts server/package.json
```

---

### Task 7: Frontend types and data hooks

**Files:**
- Modify: `web/src/types.ts` (add scheduler types)
- Create: `web/src/useSchedules.ts`
- Create: `web/src/useRuns.ts`

**Interfaces:**
- Consumes: `/api/schedules`, `/api/runs`, `/api/schedules/:id*` routes; the `/ws` `"schedules:changed"` message.
- Produces:
  - `types.ts`: `Trigger`, `Schedule`, `ScheduleWithNext`, `RunStatus`, `Run`.
  - `useSchedules()` → `{ schedules: ScheduleWithNext[]; loading; error; refresh; create; update; remove; runNow }`.
  - `useRuns(scheduleId?: string)` → `{ runs: Run[]; loading; error; refresh }`.

- [ ] **Step 1: Add the frontend types**

Append to `web/src/types.ts`:

```ts
export type TriggerKind = "interval" | "daily" | "weekly";

export interface Trigger {
  kind: TriggerKind;
  everyMinutes?: number;
  time?: string;
  weekday?: number;
}

export interface Schedule {
  id: string;
  name: string;
  prompt: string;
  cwd: string;
  trigger: Trigger;
  enabled: boolean;
  overlapPolicy: "skip" | "allow";
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  lastRunId: string | null;
}

export interface ScheduleWithNext extends Schedule {
  nextRun: string | null;
}

export type RunStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "interrupted";

export interface Run {
  id: string;
  scheduleId: string;
  scheduleName: string;
  prompt: string;
  cwd: string;
  status: RunStatus;
  trigger: "scheduled" | "manual";
  queuedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  pid: number | null;
  exitCode: number | null;
  sessionId: string | null;
  project: string | null;
  resultSummary: string | null;
  error: string | null;
}

export interface ScheduleInput {
  name: string;
  prompt: string;
  cwd: string;
  trigger: Trigger;
  enabled?: boolean;
  overlapPolicy?: "skip" | "allow";
}
```

- [ ] **Step 2: Create the schedules hook**

Create `web/src/useSchedules.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import type { ScheduleInput, ScheduleWithNext } from "./types";

interface State {
  schedules: ScheduleWithNext[];
  loading: boolean;
  error: string | null;
}

/** Lists schedules, refreshing on the server's "schedules:changed" WS ping. */
export function useSchedules() {
  const [state, setState] = useState<State>({ schedules: [], loading: true, error: null });
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/schedules");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { schedules: ScheduleWithNext[] };
      if (mounted.current) setState({ schedules: data.schedules, loading: false, error: null });
    } catch (e) {
      if (mounted.current) {
        setState((s) => ({ ...s, loading: false, error: e instanceof Error ? e.message : String(e) }));
      }
    }
  }, []);

  const mutate = useCallback(
    async (path: string, method: string, body?: unknown) => {
      const res = await fetch(path, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const msg = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(msg.error ?? `HTTP ${res.status}`);
      }
      await refresh();
      return res;
    },
    [refresh],
  );

  const create = useCallback((input: ScheduleInput) => mutate("/api/schedules", "POST", input), [mutate]);
  const update = useCallback(
    (id: string, patch: Partial<ScheduleInput>) => mutate(`/api/schedules/${id}`, "PUT", patch),
    [mutate],
  );
  const remove = useCallback((id: string) => mutate(`/api/schedules/${id}`, "DELETE"), [mutate]);
  const runNow = useCallback((id: string) => mutate(`/api/schedules/${id}/run`, "POST"), [mutate]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const poll = setInterval(() => void refresh(), 10000);
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as { type?: string };
        if (msg.type === "schedules:changed") void refresh();
      } catch {
        /* ignore */
      }
    };
    return () => {
      mounted.current = false;
      clearInterval(poll);
      ws.close();
    };
  }, [refresh]);

  return { ...state, refresh, create, update, remove, runNow };
}
```

- [ ] **Step 3: Create the runs hook**

Create `web/src/useRuns.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import type { Run } from "./types";

/** Lists runs (optionally for one schedule), refreshing on the WS ping. */
export function useRuns(scheduleId?: string) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const qs = scheduleId ? `?scheduleId=${encodeURIComponent(scheduleId)}` : "";
      const res = await fetch(`/api/runs${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { runs: Run[] };
      if (!mounted.current) return;
      setRuns(data.runs);
      setError(null);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [scheduleId]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const poll = setInterval(() => void refresh(), 10000);
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as { type?: string };
        if (msg.type === "schedules:changed") void refresh();
      } catch {
        /* ignore */
      }
    };
    return () => {
      mounted.current = false;
      clearInterval(poll);
      ws.close();
    };
  }, [refresh]);

  return { runs, loading, error, refresh };
}
```

- [ ] **Step 4: Typecheck**

Run: `npm -w web run build`
Expected: build succeeds (tsc + vite). If `web` has no `typecheck` script, `build` runs `tsc` first per its config.

- [ ] **Step 5: Stage**

```bash
git add web/src/types.ts web/src/useSchedules.ts web/src/useRuns.ts
```

---

### Task 8: Schedules pane (list + create/edit + Run now), wired into nav

**Files:**
- Create: `web/src/views/Schedules.tsx`
- Modify: `web/src/App.tsx` (import + add a tab)

**Interfaces:**
- Consumes: `useSchedules`, `useRuns`; `ScheduleWithNext`, `Run`, `Trigger`, `ScheduleInput` from `types`.
- Produces: default-exported `Schedules` component; a `"schedules"` tab in `App.tsx`.

- [ ] **Step 1: Create the Schedules view**

Create `web/src/views/Schedules.tsx`:

```tsx
import { useEffect, useState } from "react";
import { useSchedules } from "../useSchedules";
import { useRuns } from "../useRuns";
import type { Run, RunStatus, ScheduleInput, ScheduleWithNext, Trigger } from "../types";

const RUN_STYLE: Record<RunStatus, string> = {
  running: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  succeeded: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  failed: "bg-rose-500/15 text-rose-300 ring-rose-500/30",
  skipped: "bg-slate-500/15 text-slate-300 ring-slate-500/30",
  interrupted: "bg-zinc-600/20 text-zinc-300 ring-zinc-500/30",
};

function when(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

function triggerSummary(t: Trigger): string {
  if (t.kind === "interval") return `every ${t.everyMinutes} min`;
  if (t.kind === "daily") return `daily at ${t.time}`;
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return `weekly ${days[t.weekday ?? 0]} at ${t.time}`;
}

const EMPTY: ScheduleInput = {
  name: "",
  prompt: "",
  cwd: "",
  trigger: { kind: "daily", time: "02:00" },
  overlapPolicy: "skip",
};

function ScheduleForm({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: ScheduleInput;
  onSubmit: (input: ScheduleInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<ScheduleInput>(initial);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await onSubmit(form);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const field = "w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-white placeholder-white/30";

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-5 space-y-3">
      {err && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
          {err}
        </div>
      )}
      <input
        className={field}
        placeholder="Name"
        value={form.name}
        onChange={(e) => setForm({ ...form, name: e.target.value })}
      />
      <textarea
        className={`${field} h-24`}
        placeholder="Prompt for claude -p"
        value={form.prompt}
        onChange={(e) => setForm({ ...form, prompt: e.target.value })}
      />
      <input
        className={field}
        placeholder="Working directory (absolute path)"
        value={form.cwd}
        onChange={(e) => setForm({ ...form, cwd: e.target.value })}
      />
      <div className="flex flex-wrap items-center gap-2">
        <select
          className={`${field} w-auto`}
          value={form.trigger.kind}
          onChange={(e) => {
            const kind = e.target.value as Trigger["kind"];
            setForm({
              ...form,
              trigger:
                kind === "interval"
                  ? { kind, everyMinutes: 60 }
                  : kind === "daily"
                    ? { kind, time: "02:00" }
                    : { kind, time: "02:00", weekday: 1 },
            });
          }}
        >
          <option value="interval">Every N minutes</option>
          <option value="daily">Daily at time</option>
          <option value="weekly">Weekly on day</option>
        </select>

        {form.trigger.kind === "interval" && (
          <input
            type="number"
            min={1}
            className={`${field} w-28`}
            value={form.trigger.everyMinutes ?? 60}
            onChange={(e) =>
              setForm({ ...form, trigger: { kind: "interval", everyMinutes: Number(e.target.value) } })
            }
          />
        )}
        {form.trigger.kind !== "interval" && (
          <input
            type="time"
            className={`${field} w-32`}
            value={form.trigger.time ?? "02:00"}
            onChange={(e) => setForm({ ...form, trigger: { ...form.trigger, time: e.target.value } })}
          />
        )}
        {form.trigger.kind === "weekly" && (
          <select
            className={`${field} w-auto`}
            value={form.trigger.weekday ?? 1}
            onChange={(e) =>
              setForm({ ...form, trigger: { ...form.trigger, weekday: Number(e.target.value) } })
            }
          >
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => (
              <option key={d} value={i}>{d}</option>
            ))}
          </select>
        )}
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          disabled={busy}
          onClick={submit}
          className="rounded-lg bg-emerald-500/20 px-3 py-1.5 text-sm text-emerald-200 ring-1 ring-emerald-500/30 transition hover:bg-emerald-500/30 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save schedule"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-white/10 px-3 py-1.5 text-sm text-white/60 transition hover:text-white"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function RunRow({ run }: { run: Run }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-lg border border-white/10 bg-white/[0.03]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 px-3 py-2 text-left"
      >
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium uppercase ring-1 ${RUN_STYLE[run.status]}`}
        >
          {run.status}
        </span>
        <span className="text-xs text-white/55">{when(run.startedAt ?? run.queuedAt)}</span>
        {run.durationMs != null && (
          <span className="text-xs text-white/40">{Math.round(run.durationMs / 1000)}s</span>
        )}
        {run.trigger === "manual" && <span className="text-xs text-sky-300/70">manual</span>}
        <span className="ml-auto text-xs text-white/30">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-white/10 px-3 py-2 text-sm">
          {run.error && <p className="text-rose-300">{run.error}</p>}
          {run.resultSummary && <p className="text-emerald-200/80">{run.resultSummary}</p>}
          {run.sessionId && run.project && (
            <a
              href={`#/sessions`}
              className="inline-block font-mono text-xs text-sky-300 hover:underline"
              title="Transcript session id"
            >
              transcript: {run.sessionId.slice(0, 8)}
            </a>
          )}
          <RunLog id={run.id} />
        </div>
      )}
    </li>
  );
}

function RunLog({ id }: { id: string }) {
  const [log, setLog] = useState<string>("loading…");
  // Fetch on expand; live runs also refresh via the list's WS ping re-rendering this.
  useEffect(() => {
    let alive = true;
    void fetch(`/api/runs/${id}`)
      .then((r) => r.json())
      .then((d: { log?: string }) => alive && setLog(d.log || "(no output)"))
      .catch(() => alive && setLog("(could not load log)"));
    return () => {
      alive = false;
    };
  }, [id]);
  return (
    <pre className="max-h-64 overflow-auto rounded-lg bg-black/40 p-2 font-mono text-xs text-white/70">
      {log}
    </pre>
  );
}

function ScheduleCard({
  schedule,
  onEdit,
}: {
  schedule: ScheduleWithNext;
  onEdit: () => void;
}) {
  const { update, remove, runNow } = useSchedules();
  const { runs } = useRuns(schedule.id);
  const running = runs.filter((r) => r.status === "running");
  const recent = runs.slice(0, 5);

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-white">{schedule.name}</h3>
          <p className="mt-0.5 text-xs text-white/45">
            {triggerSummary(schedule.trigger)} · next {when(schedule.nextRun)}
          </p>
          <p className="mt-0.5 truncate font-mono text-xs text-white/30">{schedule.cwd}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {running.length > 0 && (
            <span className="inline-flex items-center gap-1.5 text-xs text-amber-300">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-400" />
              </span>
              running
            </span>
          )}
        </div>
      </header>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void runNow(schedule.id)}
          className="rounded-lg bg-emerald-500/15 px-2.5 py-1 text-xs text-emerald-200 ring-1 ring-emerald-500/30 hover:bg-emerald-500/25"
        >
          Run now
        </button>
        <button
          type="button"
          onClick={() => void update(schedule.id, { enabled: !schedule.enabled })}
          className="rounded-lg border border-white/10 px-2.5 py-1 text-xs text-white/70 hover:text-white"
        >
          {schedule.enabled ? "Disable" : "Enable"}
        </button>
        <button
          type="button"
          onClick={onEdit}
          className="rounded-lg border border-white/10 px-2.5 py-1 text-xs text-white/70 hover:text-white"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={() => {
            if (confirm(`Delete schedule "${schedule.name}"?`)) void remove(schedule.id);
          }}
          className="rounded-lg border border-rose-500/20 px-2.5 py-1 text-xs text-rose-300/80 hover:bg-rose-500/10"
        >
          Delete
        </button>
        {!schedule.enabled && (
          <span className="text-xs text-white/30">disabled</span>
        )}
      </div>

      {recent.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {recent.map((r) => (
            <RunRow key={r.id} run={r} />
          ))}
        </ul>
      )}
    </div>
  );
}

export default function Schedules() {
  const { schedules, loading, error, create, update } = useSchedules();
  const [mode, setMode] = useState<{ kind: "none" } | { kind: "new" } | { kind: "edit"; id: string }>(
    { kind: "none" },
  );

  const editing = mode.kind === "edit" ? schedules.find((s) => s.id === mode.id) : undefined;

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2.5 text-3xl font-bold tracking-tight text-white">
            <span aria-hidden>⏰</span> Schedules
          </h1>
          <p className="mt-1 text-sm text-white/45">
            Headless Claude runs Argus fires on a schedule
          </p>
        </div>
        {mode.kind === "none" && (
          <button
            type="button"
            onClick={() => setMode({ kind: "new" })}
            className="rounded-lg bg-emerald-500/20 px-3 py-1.5 text-sm text-emerald-200 ring-1 ring-emerald-500/30 hover:bg-emerald-500/30"
          >
            + New schedule
          </button>
        )}
      </header>

      {error && (
        <div className="mb-6 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          Couldn’t reach the Argus server: {error}
        </div>
      )}

      {mode.kind === "new" && (
        <div className="mb-6">
          <ScheduleForm
            initial={EMPTY}
            onCancel={() => setMode({ kind: "none" })}
            onSubmit={async (input) => {
              await create(input);
              setMode({ kind: "none" });
            }}
          />
        </div>
      )}

      {mode.kind === "edit" && editing && (
        <div className="mb-6">
          <ScheduleForm
            initial={editing}
            onCancel={() => setMode({ kind: "none" })}
            onSubmit={async (input) => {
              await update(editing.id, input);
              setMode({ kind: "none" });
            }}
          />
        </div>
      )}

      {loading ? (
        <p className="text-white/40">Loading schedules…</p>
      ) : schedules.length === 0 && mode.kind === "none" ? (
        <div className="rounded-xl border border-dashed border-white/15 px-6 py-16 text-center text-white/40">
          No schedules yet. Create one and Argus will fire it on time.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {schedules.map((s) => (
            <ScheduleCard key={s.id} schedule={s} onEdit={() => setMode({ kind: "edit", id: s.id })} />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add the tab to `App.tsx`**

Add the import alongside the other view imports:

```tsx
import Schedules from "./views/Schedules";
```

Add an entry to the `TABS` array (after the `cron` entry):

```tsx
  { id: "cron", label: "Cron", render: () => <Cron /> },
  { id: "schedules", label: "Schedules", render: () => <Schedules /> },
```

- [ ] **Step 3: Build the frontend**

Run: `npm -w web run build`
Expected: build succeeds, no type errors.

- [ ] **Step 4: Stage**

```bash
git add web/src/views/Schedules.tsx web/src/App.tsx
```

---

### Task 9: End-to-end manual verification

**Files:** none (verification only).

This task confirms the full loop works against a real (temporary) Claude home. It is the only place a real `claude` process is spawned.

- [ ] **Step 1: Verify the headless CLI flags (adjust Task 5 if needed)**

Run: `claude -p "say hi in one word" --output-format json --session-id 00000000-0000-0000-0000-000000000001`
Expected: a JSON object containing a `result` field, and a transcript file appears under `~/.claude/projects/<encoded-cwd>/`.
If the installed CLI rejects `--session-id` or `--output-format json`, update the args in `defaultSpawn` (`server/src/scheduler.ts`) accordingly and re-run the scheduler tests.

- [ ] **Step 2: Run the server against the real home and create a fast schedule**

```bash
ARGUS_SCHED_TICK_MS=5000 ARGUS_PORT=7788 npm -w server run start &
sleep 1
curl -s -X POST localhost:7788/api/schedules -H 'content-type: application/json' \
  -d "{\"name\":\"smoke\",\"prompt\":\"say hi in one word\",\"cwd\":\"$PWD\",\"trigger\":{\"kind\":\"interval\",\"everyMinutes\":1}}"
```
Expected: schedule created (201).

- [ ] **Step 3: Trigger a manual run and watch it complete**

```bash
SID=$(curl -s localhost:7788/api/schedules | python -c "import sys,json;print(json.load(sys.stdin)['schedules'][0]['id'])")
curl -s -X POST "localhost:7788/api/schedules/$SID/run"
sleep 20
curl -s "localhost:7788/api/runs?scheduleId=$SID"
```
Expected: a run that transitions to `succeeded` with a non-null `sessionId`, `exitCode: 0`, and a `durationMs`. `GET /api/runs/<id>` returns a non-empty `log`.

- [ ] **Step 4: Verify the UI**

In a browser open `http://localhost:7788` (or the Vite dev server via `npm run dev`), go to the **Schedules** tab. Confirm: the schedule shows its next-run time; a manual "Run now" produces a run that shows "running" then a terminal badge; expanding a run shows its log tail; the transcript id links out.

- [ ] **Step 5: Verify crash recovery**

While a run is in progress, `kill` the server, then restart it. Confirm the previously-running run is now marked `interrupted` in `GET /api/runs`.

- [ ] **Step 6: Tidy up**

```bash
kill %1
curl -s -X DELETE "localhost:7788/api/schedules/$SID" 2>/dev/null || true
```

- [ ] **Step 7: Final staging**

```bash
git add -A docs/ server/ web/
git status
```
Report the staged file list to the user; leave everything uncommitted for their review.

---

## Self-Review

**Spec coverage** (each design section → task):
- §1 Data model → Task 1 (types) + Tasks 3/4 (persistence).
- §2 Three states → Task 4 `readRuns`/status + Task 3 `nextRun` + Task 8 UI grouping.
- §3 Scheduler lifecycle, grace/no-backfill, overlap, transcript link → Task 2 (`shouldFire`) + Task 5 (`tick`, `fireRun`, `defaultSpawn`).
- §4 Crash recovery → Task 5 `recoverInterruptedRuns`.
- §5 API + live updates → Task 6 routes/watch + Tasks 7 hooks (poll + WS).
- §6 Frontend pane → Tasks 7–8.
- §7 Error handling/retention → Task 3 (corrupt-safe, atomic) + Task 4 (`pruneRuns`, `LOG_CAP_BYTES`) + Task 5 (spawn-failure path).
- §8 Structure → file layout across Tasks 1–8.
- §9 Testing → TDD steps in Tasks 2–5; manual gate in Task 9.

**Out of scope (v1)** honored: no raw cron, no WS log streaming (log fetched on expand), no global concurrency cap, Claude-only runs, localhost-only.

**Open verification item:** the exact headless flags (`--session-id`, `--output-format json`) are confirmed in Task 9 Step 1 before the feature is trusted; `defaultSpawn` is the single place to adjust them.
