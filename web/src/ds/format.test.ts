import { describe, it, expect } from "vitest";
import { formatDuration, sparklinePoints } from "./format";

describe("formatDuration", () => {
  it("renders minutes under an hour", () => {
    expect(formatDuration(12 * 60_000)).toBe("12m");
  });
  it("renders hours and minutes under a day", () => {
    expect(formatDuration((7 * 60 + 41) * 60_000)).toBe("7h 41m");
  });
  it("renders days and hours past a day", () => {
    expect(formatDuration((2 * 24 * 60 + 14 * 60) * 60_000)).toBe("2d 14h");
  });
  it('returns "now" for non-positive input', () => {
    expect(formatDuration(0)).toBe("now");
    expect(formatDuration(-5000)).toBe("now");
  });
});

describe("sparklinePoints", () => {
  it("maps a flat series to the vertical mid-line", () => {
    expect(sparklinePoints([5, 5, 5], 100, 26)).toBe("0,13 50,13 100,13");
  });
  it("puts the max at the top (y=0) and min at the bottom", () => {
    expect(sparklinePoints([0, 10], 100, 26)).toBe("0,26 100,0");
  });
  it("returns empty string for empty input", () => {
    expect(sparklinePoints([], 100, 26)).toBe("");
  });
});
