import { describe, it, expect } from "vitest";
import { createVelocityTracker, flickOutcome } from "./gesture";

describe("createVelocityTracker", () => {
  it("has no opinion until it has seen two positions", () => {
    const tracker = createVelocityTracker();
    expect(tracker.velocity()).toBe(0);
    tracker.sample(0, 0);
    expect(tracker.velocity()).toBe(0);
  });

  it("measures px per ms across the window", () => {
    const tracker = createVelocityTracker();
    tracker.sample(0, 0);
    tracker.sample(50, 50);
    expect(tracker.velocity()).toBeCloseTo(1);
  });

  it("ignores samples older than the window, so a pause before release reads as a stop", () => {
    const tracker = createVelocityTracker(90);
    // A fast sweep, then a long hold at the same place: the hold is what the user
    // meant, and averaging the sweep back in would dismiss something they parked.
    tracker.sample(0, 0);
    tracker.sample(400, 100);
    tracker.sample(400, 300);
    tracker.sample(400, 500);
    expect(Math.abs(tracker.velocity())).toBeLessThan(0.01);
  });

  it("keeps one sample older than the window so a slow drag still has a baseline", () => {
    const tracker = createVelocityTracker(90);
    tracker.sample(0, 0);
    tracker.sample(10, 100);
    expect(tracker.velocity()).toBeGreaterThan(0);
  });

  it("survives two samples at the same instant", () => {
    const tracker = createVelocityTracker();
    tracker.sample(0, 5);
    tracker.sample(30, 5);
    expect(tracker.velocity()).toBe(0);
  });

  it("forgets everything on reset", () => {
    const tracker = createVelocityTracker();
    tracker.sample(0, 0);
    tracker.sample(100, 10);
    tracker.reset();
    expect(tracker.velocity()).toBe(0);
  });
});

describe("flickOutcome", () => {
  const width = 500;

  it("releases when dragged past the threshold, however slowly", () => {
    expect(flickOutcome(300, 0, width).release).toBe(true);
  });

  it("releases on a fast flick from barely any distance — waiting for the threshold would feel ignored", () => {
    expect(flickOutcome(6, 1.4, width).release).toBe(true);
  });

  it("refuses a short slow drag, visibly", () => {
    const outcome = flickOutcome(40, 0.05, width);
    expect(outcome.release).toBe(false);
    expect(outcome.ms).toBeGreaterThan(0);
  });

  it("leaves faster the faster it was thrown", () => {
    const gentle = flickOutcome(100, 0.5, width);
    const hard = flickOutcome(100, 4, width);
    expect(hard.ms).toBeLessThan(gentle.ms);
  });

  it("never animates for so little time that the exit is a cut", () => {
    expect(flickOutcome(499, 40, width).ms).toBeGreaterThanOrEqual(80);
  });

  it("copes with a zero-width surface rather than dividing by it", () => {
    expect(Number.isFinite(flickOutcome(10, 1, 0).ms)).toBe(true);
  });
});
