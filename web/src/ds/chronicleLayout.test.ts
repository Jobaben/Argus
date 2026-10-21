import { describe, it, expect } from "vitest";
import { axisTicks, shortenLanePath, spanGeometry } from "./chronicleLayout";

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
  // Local time throughout: the ticks are read on the viewer's clock.
  const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();
  const HOUR = 3_600_000;

  it("puts a day's ticks on round hours, where they fall, not on sixths of the window", () => {
    const end = at(21, 2, 3);
    const ticks = axisTicks(end - 24 * HOUR, end);
    expect(ticks.map((t) => t.label)).toEqual(["04:00", "08:00", "12:00", "16:00", "20:00", "Wed"]);
    // 04:00 is 1h57m into a window that opened at 02:03.
    expect(ticks[0].pct).toBeCloseTo((117 / 1440) * 100);
  });

  it("marks the day a midnight tick starts", () => {
    const end = at(21, 9);
    const labels = axisTicks(end - 24 * HOUR, end).map((t) => t.label);
    expect(labels).toContain("Wed");
    expect(labels.every((l) => /^(\d{2}:\d{2}|Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/.test(l))).toBe(true);
  });

  it("steps an hour in ten-minute ticks", () => {
    const end = at(21, 14, 3);
    expect(axisTicks(end - HOUR, end).map((t) => t.label)).toEqual([
      "13:10",
      "13:20",
      "13:30",
      "13:40",
      "13:50",
      "14:00",
    ]);
  });

  it("puts a week's ticks on midnights, named by weekday and date", () => {
    const end = at(21, 2, 3);
    const labels = axisTicks(end - 7 * 24 * HOUR, end).map((t) => t.label);
    expect(labels).toEqual(["Thu 15", "Fri 16", "Sat 17", "Sun 18", "Mon 19", "Tue 20", "Wed 21"]);
  });

  it("puts a year's ticks on months, and says the year at its turn", () => {
    const end = at(21, 2, 3);
    const labels = axisTicks(end - 365 * 24 * HOUR, end).map((t) => t.label);
    expect(labels).toEqual(["Nov", "2026", "Mar", "May", "Jul", "Sep"]);
  });

  it("tells the ticks that name a day from the hours inside one", () => {
    const end = at(21, 2, 3);
    const threeDays = axisTicks(end - 72 * HOUR, end);
    expect(threeDays.map((t) => t.label)).toEqual(["12:00", "Mon", "12:00", "Tue", "12:00", "Wed"]);
    expect(threeDays.filter((t) => t.major).map((t) => t.label)).toEqual(["Mon", "Tue", "Wed"]);
    expect(axisTicks(end - 168 * HOUR, end).every((t) => t.major)).toBe(true);
  });

  it("gives the hour a spring-forward night skips one tick, not two", () => {
    const tz = process.env.TZ;
    process.env.TZ = "Europe/Stockholm";
    try {
      // 02:00 does not exist on 29 March 2026 there; it resolves to 03:00.
      const end = new Date(2026, 2, 29, 5, 30).getTime();
      const labels = axisTicks(end - 6 * HOUR, end).map((t) => t.label);
      expect(labels.filter((l) => l === "03:00")).toHaveLength(1);
      expect(new Set(labels).size).toBe(labels.length);
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });

  it("never offers more ticks than asked for, and keeps them inside the window", () => {
    const end = at(21, 2, 3);
    for (const hours of [1, 6, 24, 72, 168, 2160, 8760]) {
      const ticks = axisTicks(end - hours * HOUR, end);
      expect(ticks.length).toBeGreaterThan(2);
      expect(ticks.length).toBeLessThanOrEqual(7);
      expect(ticks.every((t) => t.pct > 0 && t.pct <= 100)).toBe(true);
    }
  });

  it("returns nothing for a degenerate window", () => {
    expect(axisTicks(END, START)).toEqual([]);
    expect(axisTicks(START, Number.NaN)).toEqual([]);
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
