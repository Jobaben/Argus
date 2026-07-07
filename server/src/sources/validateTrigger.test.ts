import { test } from "node:test";
import assert from "node:assert/strict";
import { validateTrigger, ScheduleValidationError } from "./schedules.js";

test("windowed is rejected when allowWindowed is not set", () => {
  assert.throws(
    () =>
      validateTrigger({ kind: "windowed", startTime: "12:00", endTime: "14:00", everyMinutes: 30 }),
    ScheduleValidationError,
  );
});

test("windowed is accepted and normalized when allowWindowed is set", () => {
  const t = validateTrigger(
    {
      kind: "windowed",
      startTime: "12:00",
      endTime: "14:00",
      everyMinutes: 30.9,
      weekdays: [5, 1, 1],
    },
    { allowWindowed: true },
  );
  assert.deepEqual(t, {
    kind: "windowed",
    startTime: "12:00",
    endTime: "14:00",
    everyMinutes: 30,
    weekdays: [1, 5],
  });
});

test("windowed omits weekdays when empty (means every day)", () => {
  const t = validateTrigger(
    { kind: "windowed", startTime: "09:00", endTime: "17:00", everyMinutes: 30, weekdays: [] },
    { allowWindowed: true },
  );
  assert.deepEqual(t, { kind: "windowed", startTime: "09:00", endTime: "17:00", everyMinutes: 30 });
});

test("windowed rejects endTime <= startTime", () => {
  assert.throws(
    () =>
      validateTrigger(
        { kind: "windowed", startTime: "14:00", endTime: "12:00", everyMinutes: 30 },
        { allowWindowed: true },
      ),
    ScheduleValidationError,
  );
});

test("windowed rejects everyMinutes < 1", () => {
  assert.throws(
    () =>
      validateTrigger(
        { kind: "windowed", startTime: "12:00", endTime: "14:00", everyMinutes: 0 },
        { allowWindowed: true },
      ),
    ScheduleValidationError,
  );
});

test("windowed rejects weekdays out of range", () => {
  assert.throws(
    () =>
      validateTrigger(
        { kind: "windowed", startTime: "12:00", endTime: "14:00", everyMinutes: 30, weekdays: [7] },
        { allowWindowed: true },
      ),
    ScheduleValidationError,
  );
});

test("interval still validates unchanged", () => {
  assert.deepEqual(validateTrigger({ kind: "interval", everyMinutes: 60 }), {
    kind: "interval",
    everyMinutes: 60,
  });
});
