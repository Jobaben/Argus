import { test } from "node:test";
import assert from "node:assert/strict";
import { isStalled, resolveStallSeconds } from "./stall.js";

test("resolveStallSeconds: step overrides phase, else off", () => {
  assert.equal(resolveStallSeconds({ stallSeconds: 60 }, { stallSeconds: 30 }), 30);
  assert.equal(resolveStallSeconds({ stallSeconds: 60 }, {}), 60);
  assert.equal(resolveStallSeconds({}, {}), null);
});

test("isStalled: off when stallSeconds is absent, zero or negative", () => {
  const now = new Date("2026-01-01T00:10:00.000Z");
  assert.equal(
    isStalled({ stallSeconds: null, lastActivityAt: null, startedAt: null, now }),
    false,
  );
  assert.equal(
    isStalled({
      stallSeconds: 0,
      lastActivityAt: "2026-01-01T00:00:00.000Z",
      startedAt: null,
      now,
    }),
    false,
  );
});

test("isStalled: true once now is at least stallSeconds past the last activity", () => {
  const started = "2026-01-01T00:00:00.000Z";
  assert.equal(
    isStalled({
      stallSeconds: 60,
      lastActivityAt: started,
      startedAt: started,
      now: new Date("2026-01-01T00:00:59.000Z"),
    }),
    false,
    "one second short of the limit",
  );
  assert.equal(
    isStalled({
      stallSeconds: 60,
      lastActivityAt: started,
      startedAt: started,
      now: new Date("2026-01-01T00:01:00.000Z"),
    }),
    true,
    "exactly at the limit counts",
  );
});

test("isStalled: falls back to startedAt when no activity has been observed yet", () => {
  const started = "2026-01-01T00:00:00.000Z";
  assert.equal(
    isStalled({
      stallSeconds: 30,
      lastActivityAt: null,
      startedAt: started,
      now: new Date("2026-01-01T00:00:31.000Z"),
    }),
    true,
  );
});

test("isStalled: activity resets the clock — a run that just spoke is not stalled", () => {
  assert.equal(
    isStalled({
      stallSeconds: 30,
      lastActivityAt: "2026-01-01T00:05:00.000Z",
      startedAt: "2026-01-01T00:00:00.000Z", // long past its own stall window
      now: new Date("2026-01-01T00:05:10.000Z"),
    }),
    false,
  );
});

test("isStalled: an unparseable timestamp is treated as no signal, never as stalled", () => {
  assert.equal(
    isStalled({
      stallSeconds: 30,
      lastActivityAt: "not-a-date",
      startedAt: null,
      now: new Date(),
    }),
    false,
  );
});
