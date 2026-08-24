import { describe, it, expect } from "vitest";
import { conditionLabel, edgeViews, effectiveEdges } from "./routes";
import type { PhaseDef } from "../types";

const phase = (id: string, over: Partial<PhaseDef> = {}): PhaseDef => ({
  id,
  name: id,
  cwd: "/tmp",
  gated: false,
  steps: [{ name: "s", prompt: "p" }],
  ...over,
});

describe("conditionLabel", () => {
  it("reads a predicate the way the definition says it", () => {
    expect(
      conditionLabel({ predicate: { path: ["accepted"], operator: "equals", value: true } }),
    ).toBe("accepted = true");
    expect(
      conditionLabel({ predicate: { path: ["verdict"], operator: "not-equals", value: "fail" } }),
    ).toBe('verdict ≠ "fail"');
    expect(
      conditionLabel({
        predicate: { path: ["verdict"], operator: "one-of", value: ["warn", "fail"] },
      }),
    ).toBe('verdict ∈ ["warn","fail"]');
    expect(conditionLabel({ predicate: { path: ["notes", "count"], operator: "exists" } })).toBe(
      "notes.count exists",
    );
  });

  it("names the two conditions that are not predicates", () => {
    expect(conditionLabel(undefined)).toBe("always");
    expect(conditionLabel({ group: "g", default: true })).toBe("otherwise");
  });
});

describe("effectiveEdges", () => {
  it("supplies the linear default when no phase declares needs", () => {
    const edges = effectiveEdges([phase("a"), phase("b"), phase("c")]);
    expect(edges.get("a")).toEqual([]);
    expect(edges.get("b")).toEqual([{ phase: "a" }]);
    expect(edges.get("c")).toEqual([{ phase: "b" }]);
  });

  it("takes an explicit graph at face value, conditions and all", () => {
    const when = { predicate: { path: ["accepted"], operator: "equals" as const, value: true } };
    const edges = effectiveEdges([
      phase("evaluate"),
      phase("publish", { needs: [{ phase: "evaluate", when }] }),
      phase("report", { needs: [{ phase: "publish", allowSkipped: true }] }),
    ]);
    expect(edges.get("evaluate")).toEqual([]);
    expect(edges.get("publish")).toEqual([{ phase: "evaluate", when }]);
    expect(edges.get("report")).toEqual([{ phase: "publish", allowSkipped: true }]);
  });
});

describe("edgeViews", () => {
  it("marks which edges carry a condition and which tolerate a skip", () => {
    expect(
      edgeViews([
        { phase: "a" },
        {
          phase: "b",
          when: { predicate: { path: ["ok"], operator: "equals", value: false } },
          allowSkipped: true,
        },
      ]),
    ).toEqual([
      { phase: "a", label: "always", conditional: false, allowSkipped: false },
      { phase: "b", label: "ok = false", conditional: true, allowSkipped: true },
    ]);
  });
});
