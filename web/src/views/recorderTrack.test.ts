import { describe, it, expect } from "vitest";
import { eventWindow, indexAtTime, laneDensity, stepIndex, trackTime } from "./recorderTrack";
import type { RecorderEvent } from "../types";

const ev = (atMs: number, over: Partial<RecorderEvent> = {}): RecorderEvent => ({
  id: `e${atMs}-${over.lane ?? "agent"}`,
  atMs,
  at: new Date(atMs).toISOString(),
  lane: "agent",
  kind: "text",
  label: `at ${atMs}`,
  ...over,
});

describe("indexAtTime", () => {
  const events = [ev(0), ev(1000), ev(1000), ev(5000)];

  it("returns -1 before the first event", () => {
    expect(indexAtTime([ev(500)], 100)).toBe(-1);
  });

  it("lands on the last event at or before the playhead", () => {
    expect(indexAtTime(events, 0)).toBe(0);
    expect(indexAtTime(events, 999)).toBe(0);
    expect(indexAtTime(events, 1000)).toBe(2); // the last of a same-instant cluster
    expect(indexAtTime(events, 4999)).toBe(2);
    expect(indexAtTime(events, 999999)).toBe(3);
  });

  it("handles an empty recording", () => {
    expect(indexAtTime([], 10)).toBe(-1);
  });
});

describe("stepIndex", () => {
  const events = [ev(0), ev(1000), ev(1000), ev(1000), ev(5000)];

  it("regression: stepping forward skips a whole same-instant cluster", () => {
    // Three events share t=1000. One press from there must reach 5000, not
    // shuffle within the cluster and appear to be stuck.
    expect(stepIndex(events, 1000, 1)).toBe(4);
  });

  it("regression: stepping back leaves the cluster too", () => {
    expect(stepIndex(events, 1000, -1)).toBe(0);
  });

  it("returns null past either end", () => {
    expect(stepIndex(events, 5000, 1)).toBeNull();
    expect(stepIndex(events, 0, -1)).toBeNull();
    expect(stepIndex([], 0, 1)).toBeNull();
  });
});

describe("laneDensity", () => {
  it("normalizes the busiest column to 1 and leaves empty ones at 0", () => {
    const events = [
      ev(0, { lane: "tool" }),
      ev(10, { lane: "tool" }),
      ev(900, { lane: "tool" }),
      ev(500, { lane: "file" }),
    ];
    const cols = laneDensity(events, "tool", 1000, 10);
    expect(cols).toHaveLength(10);
    expect(Math.max(...cols)).toBe(1);
    expect(cols[0]).toBe(1); // two tool events in the first tenth
    expect(cols[5]).toBe(0); // the file event does not bleed into the tool lane
  });

  it("regression: a zero-length recording yields an all-zero strip, not NaN", () => {
    const cols = laneDensity([ev(0, { lane: "tool" })], "tool", 0, 4);
    expect(cols).toEqual([0, 0, 0, 0]);
  });

  it("clamps an event sitting exactly at the end into the last column", () => {
    const cols = laneDensity([ev(1000, { lane: "tool" })], "tool", 1000, 4);
    expect(cols[3]).toBe(1);
  });
});

describe("eventWindow", () => {
  const events = Array.from({ length: 100 }, (_, i) => ev(i * 10));

  it("centres on the index", () => {
    const { start, slice } = eventWindow(events, 50, 11);
    expect(start).toBe(45);
    expect(slice).toHaveLength(11);
  });

  it("clamps at both ends without shrinking the window", () => {
    expect(eventWindow(events, 0, 11).start).toBe(0);
    expect(eventWindow(events, 99, 11).start).toBe(89);
    expect(eventWindow(events, 99, 11).slice).toHaveLength(11);
  });

  it("handles a window larger than the recording", () => {
    const { start, slice } = eventWindow(events.slice(0, 3), 1, 41);
    expect(start).toBe(0);
    expect(slice).toHaveLength(3);
  });

  it("handles an empty recording and a -1 index", () => {
    expect(eventWindow([], 0, 5)).toEqual({ start: 0, slice: [] });
    expect(eventWindow(events, -1, 5).start).toBe(0);
  });
});

describe("trackTime", () => {
  it("formats mm:ss below an hour and h:mm:ss above", () => {
    expect(trackTime(0)).toBe("00:00");
    expect(trackTime(42_000)).toBe("00:42");
    expect(trackTime(3_723_000)).toBe("1:02:03");
  });

  it("never renders a negative clock", () => {
    expect(trackTime(-5000)).toBe("00:00");
  });
});
