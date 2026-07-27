import { describe, it, expect } from "vitest";
import { graphColumns, graphEdges, isBranching, type GraphNode } from "./phaseGraph";

const node = (id: string, needs?: string[]): GraphNode => ({ id, ...(needs ? { needs } : {}) });

describe("graphColumns", () => {
  it("puts each phase one past its deepest dependency", () => {
    const cols = graphColumns([
      node("plan"),
      node("build", ["plan"]),
      node("test", ["plan"]),
      node("ship", ["build", "test"]),
    ]);
    expect(cols.map((c) => c.phases.map((p) => p.id))).toEqual([
      ["plan"],
      ["build", "test"],
      ["ship"],
    ]);
  });

  it("regression: an edge to a phase that isn't here is ignored, not treated as a root", () => {
    // A definition edited mid-flight can leave a dangling edge. Counting it as
    // depth zero would drag a late phase to the front of the graph.
    const cols = graphColumns([node("a"), node("b", ["a", "deleted"])]);
    expect(cols.map((c) => c.phases.map((p) => p.id))).toEqual([["a"], ["b"]]);
  });

  it("regression: a cycle settles instead of overflowing the stack", () => {
    // The server rejects cycles, but a hand-edited file has no such guard.
    const cols = graphColumns([node("a", ["b"]), node("b", ["a"])]);
    expect(cols.length).toBeGreaterThan(0);
  });

  it("handles an empty list", () => {
    expect(graphColumns([])).toEqual([]);
  });
});

describe("graphEdges", () => {
  it("returns every edge whose both ends exist", () => {
    expect(graphEdges([node("a"), node("b", ["a"]), node("c", ["a", "gone"])])).toEqual([
      { from: "a", to: "b" },
      { from: "a", to: "c" },
    ]);
  });
});

describe("isBranching", () => {
  it("is true for a real fan-out", () => {
    expect(isBranching([node("a"), node("b", ["a"]), node("c", ["a"])])).toBe(true);
  });

  it("is false for a linear graph — one column per phase teaches nothing", () => {
    expect(isBranching([node("a"), node("b", ["a"]), node("c", ["b"])])).toBe(false);
  });

  it("regression: no edges at all means unknown, not a total fan-out", () => {
    // An instance from before Weave carries no `needs`. Collapsing it into one
    // column looks exactly like a five-way parallel pipeline and is nothing of
    // the kind — the worst possible reading of missing information.
    expect(isBranching([node("a"), node("b"), node("c")])).toBe(false);
  });

  it("is false for a single phase, and for none", () => {
    expect(isBranching([node("a")])).toBe(false);
    expect(isBranching([])).toBe(false);
  });
});
