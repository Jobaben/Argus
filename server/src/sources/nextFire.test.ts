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
