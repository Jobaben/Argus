import { describe, it, expect } from "vitest";
import { STUB_PIPELINE } from "./usePipeline";

const PHASES = [
  "brainstorm", "design", "spec", "plan", "implement", "review", "approve",
];

describe("STUB_PIPELINE", () => {
  it("has the seven canonical phases in order", () => {
    expect(STUB_PIPELINE.phases.map((p) => p.id)).toEqual(PHASES);
    STUB_PIPELINE.phases.forEach((p, i) => expect(p.index).toBe(i + 1));
  });
  it("contains at least one await tile (the approval gate)", () => {
    const all = STUB_PIPELINE.phases.flatMap((p) => p.tiles);
    expect(all.some((t) => t.status === "await")).toBe(true);
  });
});
