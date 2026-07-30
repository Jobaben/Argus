import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DURATION, EASE } from "./motion";

/**
 * The motion tokens are declared twice and must not be.
 *
 * `index.css` is where they live for CSS, and CSS is where they belong: every
 * declarative animation reads `var(--duration-base)` and none may inline a
 * number. But the Web Animations API takes milliseconds, so the interruptible
 * parts of the motion layer have to know the values too — and a second copy of a
 * constant is not a second copy, it is a future disagreement.
 *
 * These tests are that disagreement, made loud. Change a duration in one place
 * and CI names the other.
 */

const css = readFileSync(path.join(__dirname, "..", "index.css"), "utf8");

function declared(name: string): string | null {
  const match = new RegExp(`--${name}:\\s*([^;]+);`).exec(css);
  return match ? match[1].trim() : null;
}

describe("duration tokens", () => {
  const expected: Record<keyof typeof DURATION, string> = {
    quick: "duration-quick",
    base: "duration-base",
    slow: "duration-slow",
    exit: "duration-exit",
    exitQuick: "duration-exit-quick",
    press: "duration-press",
    pulse: "duration-pulse",
    sweep: "duration-sweep",
    ping: "duration-ping",
    alert: "duration-alert",
    shimmer: "duration-shimmer",
  };

  for (const [key, token] of Object.entries(expected) as [keyof typeof DURATION, string][]) {
    it(`DURATION.${key} matches --${token}`, () => {
      expect(declared(token)).toBe(`${DURATION[key]}ms`);
    });
  }
});

describe("easing tokens", () => {
  it("ease-out-expo matches", () => {
    expect(normalise(declared("ease-out-expo"))).toBe(normalise(EASE.outExpo));
  });
  it("ease-in-expo matches", () => {
    expect(normalise(declared("ease-in-expo"))).toBe(normalise(EASE.inExpo));
  });
  it("ease-spring matches", () => {
    expect(normalise(declared("ease-spring"))).toBe(normalise(EASE.spring));
  });
});

describe("the exit contract", () => {
  it("exits are shorter than the entrances they mirror", () => {
    // "Exit ≈ 0.7× entrance" is the rule the whole lifecycle is built on: things
    // arrive with a settle and leave with urgency. A change that quietly makes an
    // exit slower than its entrance breaks the feel without breaking anything.
    expect(DURATION.exit).toBeLessThan(DURATION.base);
    expect(DURATION.exitQuick).toBeLessThan(DURATION.quick);
    expect(DURATION.exit / DURATION.base).toBeCloseTo(0.7, 1);
    expect(DURATION.exitQuick / DURATION.quick).toBeCloseTo(0.7, 1);
  });

  it("a press is the fastest thing in the system", () => {
    expect(DURATION.press).toBeLessThan(DURATION.quick);
  });
});

function normalise(value: string | null): string {
  return (value ?? "").replace(/\s+/g, "");
}
