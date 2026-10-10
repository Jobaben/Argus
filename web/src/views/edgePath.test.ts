import { describe, it, expect } from "vitest";
import { roundedOrthogonalPath } from "./edgePath";

describe("roundedOrthogonalPath", () => {
  it("draws a straight run as one line", () => {
    expect(
      roundedOrthogonalPath([
        [10, 0],
        [10, 50],
      ]),
    ).toBe("M10 0L10 50");
  });

  it("rounds each corner", () => {
    expect(
      roundedOrthogonalPath([
        [0, 0],
        [0, 20],
        [40, 20],
        [40, 40],
      ]),
    ).toBe("M0 0L0 13Q0 20 7 20L33 20Q40 20 40 27L40 40");
  });

  it("never rounds a corner past half of a short leg", () => {
    expect(
      roundedOrthogonalPath([
        [0, 0],
        [0, 4],
        [10, 4],
      ]),
    ).toBe("M0 0L0 2Q0 4 2 4L10 4");
  });

  it("draws nothing for fewer than two points", () => {
    expect(roundedOrthogonalPath([])).toBe("");
    expect(roundedOrthogonalPath([[1, 1]])).toBe("");
  });
});
