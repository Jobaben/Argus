import { describe, it, expect } from "vitest";
import { axisTicks, shortenLanePath, spanGeometry, tickLabel } from "./chronicleLayout";

const START = Date.parse("2026-07-09T00:00:00.000Z");
const END = Date.parse("2026-07-09T10:00:00.000Z"); // 10h window

describe("spanGeometry", () => {
  it("positions a span proportionally inside the window", () => {
    const geo = spanGeometry("2026-07-09T01:00:00.000Z", "2026-07-09T06:00:00.000Z", START, END);
    expect(geo).not.toBeNull();
    expect(geo!.left).toBeCloseTo(10);
    expect(geo!.width).toBeCloseTo(50);
    expect(geo!.openEnded).toBe(false);
  });

  it("clips a span straddling the window start", () => {
    const geo = spanGeometry("2026-07-08T20:00:00.000Z", "2026-07-09T05:00:00.000Z", START, END);
    expect(geo!.left).toBe(0);
    expect(geo!.width).toBeCloseTo(50);
  });

  it("draws an open-ended span through the right edge", () => {
    const geo = spanGeometry("2026-07-09T08:00:00.000Z", null, START, END);
    expect(geo!.openEnded).toBe(true);
    expect(geo!.left + geo!.width).toBeCloseTo(100);
  });

  it("gives instant spans a minimum visible width, kept inside the panel", () => {
    const geo = spanGeometry("2026-07-09T10:00:00.000Z", "2026-07-09T10:00:00.000Z", START, END);
    expect(geo!.width).toBeGreaterThan(0);
    expect(geo!.left + geo!.width).toBeLessThanOrEqual(100);
  });

  it("returns null for spans outside the window or bad input", () => {
    expect(
      spanGeometry("2026-07-08T00:00:00.000Z", "2026-07-08T01:00:00.000Z", START, END),
    ).toBeNull();
    expect(spanGeometry("garbage", null, START, END)).toBeNull();
    expect(spanGeometry("2026-07-09T01:00:00.000Z", null, END, START)).toBeNull();
  });
});

describe("axisTicks", () => {
  it("spaces ticks evenly from the window start", () => {
    const ticks = axisTicks(START, END, 5);
    expect(ticks).toHaveLength(5);
    expect(ticks.map((t) => t.pct)).toEqual([0, 20, 40, 60, 80]);
    expect(ticks.every((t) => /^\d{2}:\d{2}$/.test(t.label))).toBe(true);
  });

  it("returns nothing for a degenerate window", () => {
    expect(axisTicks(END, START)).toEqual([]);
  });
});

describe("tickLabel", () => {
  it("adds the weekday for multi-day windows", () => {
    const at = Date.parse("2026-07-06T12:00:00.000Z"); // a Monday
    expect(tickLabel(at, 24 * 3_600_000)).toMatch(/^\d{2}:\d{2}$/);
    expect(tickLabel(at, 7 * 24 * 3_600_000)).toMatch(
      /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{2}:\d{2}$/,
    );
  });
});

describe("shortenLanePath", () => {
  it("keeps the identifying tail of a path", () => {
    expect(shortenLanePath("home/mtrushbad/GIT/spectacle")).toBe("…/GIT/spectacle");
  });

  it("leaves a short label alone", () => {
    expect(shortenLanePath("Background agents")).toBe("Background agents");
    expect(shortenLanePath("GIT/spectacle")).toBe("GIT/spectacle");
  });

  it("honours a custom segment count", () => {
    expect(shortenLanePath("a/b/c/d", 1)).toBe("…/d");
    expect(shortenLanePath("a/b/c/d", 3)).toBe("…/b/c/d");
  });

  it("ignores empty segments from leading or doubled separators", () => {
    expect(shortenLanePath("/a/b//c")).toBe("…/b/c");
  });
});
