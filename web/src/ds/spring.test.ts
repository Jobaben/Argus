import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  SPRING,
  settleDuration,
  settleFrom,
  springDurationMs,
  springLinear,
  springValue,
} from "./spring";

describe("springValue", () => {
  it("starts at rest and arrives", () => {
    expect(springValue(0)).toBe(0);
    expect(springValue(springDurationMs() / 1000)).toBeCloseTo(1, 2);
  });

  it("overshoots once — that is what makes it read as physical rather than eased", () => {
    const samples = Array.from({ length: 200 }, (_, i) => springValue((i / 200) * 0.5));
    const peak = Math.max(...samples);
    expect(peak).toBeGreaterThan(1);
    // But only just. A spring that overshoots 10% is a toy, not a UI.
    expect(peak).toBeLessThan(1.05);
  });

  it("does not overshoot when critically damped", () => {
    const critical = { stiffness: 100, damping: 20, mass: 1 }; // ζ = 1
    const samples = Array.from({ length: 200 }, (_, i) => springValue((i / 200) * 1, critical));
    expect(Math.max(...samples)).toBeLessThanOrEqual(1);
  });
});

describe("springLinear", () => {
  it("ends at exactly 1, so nothing it drives comes to rest off-target", () => {
    expect(springLinear()).toMatch(/ 1 100%\)$/);
  });

  it("is the string `index.css` publishes as --ease-spring-settle", () => {
    // The CSS token and this generator are two statements of one curve, and two
    // places holding the same value is how they drift. This is the check that
    // stops that: regenerate the token when the spring changes, or this fails.
    const css = readFileSync(path.join(__dirname, "..", "index.css"), "utf8");
    const declared = /--ease-spring-settle:\s*([\s\S]*?);/.exec(css);
    expect(declared).not.toBeNull();
    // Whitespace-insensitive: the token is pretty-printed across 25 lines and the
    // generator emits one, and the difference is not the thing under test.
    const normalise = (s: string) => s.replace(/\s+/g, "");
    expect(normalise(declared![1])).toBe(normalise(springLinear()));
  });

  it("samples densely enough that the peak is not a corner", () => {
    const stops = springLinear().slice("linear(".length, -1).split(",").length;
    expect(stops).toBeGreaterThanOrEqual(20);
  });
});

describe("springDurationMs", () => {
  it("runs long enough that the tail has actually settled", () => {
    const ms = springDurationMs();
    expect(springValue(ms / 1000)).toBeCloseTo(1, 2);
  });

  it("is derived from the spring, not fixed", () => {
    const stiffer = springDurationMs({ ...SPRING, damping: SPRING.damping * 2 });
    expect(stiffer).toBeLessThan(springDurationMs());
  });
});

describe("settleFrom", () => {
  it("treats a parked pointer as parked", () => {
    expect(settleFrom(0)).toEqual({ distance: 0, ms: 0 });
    expect(settleFrom(0.01).ms).toBe(0);
  });

  it("glides further the faster the flick", () => {
    expect(settleFrom(2).distance).toBeGreaterThan(settleFrom(0.2).distance);
  });

  it("glides longer the faster the flick, up to the cap", () => {
    // Chosen below the cap on purpose: past it every flick is the same length,
    // which is the cap doing its job rather than the maths failing.
    expect(settleFrom(0.05).ms).toBeGreaterThan(settleFrom(0.03).ms);
  });

  it("keeps the sign, so a leftward flick glides left", () => {
    expect(settleFrom(-1).distance).toBeLessThan(0);
  });

  it("caps the glide — a seek that overshoots the moment you aimed at is worse than none", () => {
    expect(settleDuration(500)).toBeLessThanOrEqual(600);
  });
});
