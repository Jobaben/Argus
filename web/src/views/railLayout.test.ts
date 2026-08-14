import { describe, it, expect } from "vitest";
import { packStages, packedRows } from "./railLayout";

describe("packStages", () => {
  it("keeps everything on one row while it fits", () => {
    expect(packStages([100, 100, 100], 400, 20)).toEqual([0]);
  });

  it("breaks a row exactly when the join no longer fits", () => {
    // 100 + 20 + 100 = 220 fits; + 20 + 100 = 340 does not.
    expect(packStages([100, 100, 100], 250, 20)).toEqual([0, 2]);
  });

  it("gives a stage wider than the limit a row of its own", () => {
    expect(packStages([100, 900, 100], 250, 20)).toEqual([0, 1, 2]);
  });

  it("packs everything into one row when the limit is unmeasured", () => {
    // Zero/negative limit means the container has not been measured (jsdom,
    // first render): the answer is the single-line rail, not one row each.
    expect(packStages([100, 100], 0, 20)).toEqual([0]);
    expect(packStages([100, 100], -5, 20)).toEqual([0]);
  });

  it("returns no rows for no stages", () => {
    expect(packStages([], 400, 20)).toEqual([]);
  });
});

describe("packedRows", () => {
  it("turns break indices into [start, end) pairs", () => {
    expect(packedRows([0, 2, 5], 7)).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 5 },
      { start: 5, end: 7 },
    ]);
    expect(packedRows([0], 3)).toEqual([{ start: 0, end: 3 }]);
    expect(packedRows([], 0)).toEqual([]);
  });
});
