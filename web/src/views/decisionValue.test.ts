import { describe, it, expect } from "vitest";
import { decisionFields, isLongValue, INLINE_VALUE_CHARS } from "./decisionValue";

describe("isLongValue", () => {
  it("keeps a small decision on its line and lifts a wordy one out", () => {
    expect(isLongValue({ accepted: true })).toBe(false);
    expect(isLongValue("ready")).toBe(false);
    expect(isLongValue({ verdict: "blocked", missing: ["x".repeat(INLINE_VALUE_CHARS)] })).toBe(
      true,
    );
  });
});

describe("decisionFields", () => {
  it("renders an object as one field per key, arrays as lists", () => {
    expect(decisionFields({ verdict: "blocked", missing: ["no SDK", "no test project"] })).toEqual([
      { key: "verdict", kind: "line", text: "blocked", items: [] },
      { key: "missing", kind: "list", text: "", items: ["no SDK", "no test project"] },
    ]);
  });

  it("gives a value with no shape of its own a single unlabelled field", () => {
    expect(decisionFields("blocked")).toEqual([
      { key: null, kind: "line", text: "blocked", items: [] },
    ]);
    expect(decisionFields(["a", "b"])).toEqual([
      { key: null, kind: "list", text: "", items: ["a", "b"] },
    ]);
  });

  it("keeps a string as itself and everything else as its JSON", () => {
    expect(decisionFields({ score: 7.5, ok: false, at: null, sub: { a: 1 } })).toEqual([
      { key: "score", kind: "line", text: "7.5", items: [] },
      { key: "ok", kind: "line", text: "false", items: [] },
      { key: "at", kind: "line", text: "null", items: [] },
      { key: "sub", kind: "line", text: '{"a":1}', items: [] },
    ]);
  });

  it("says nothing is there rather than rendering nothing", () => {
    // "no items" and "no value" are different answers: an empty array keeps its
    // JSON instead of collapsing into a blank row.
    expect(decisionFields([])).toEqual([{ key: null, kind: "line", text: "[]", items: [] }]);
    expect(decisionFields({})).toEqual([{ key: null, kind: "line", text: "{}", items: [] }]);
    expect(decisionFields({ missing: [] })).toEqual([
      { key: "missing", kind: "line", text: "[]", items: [] },
    ]);
    expect(decisionFields(undefined)).toEqual([
      { key: null, kind: "line", text: "undefined", items: [] },
    ]);
  });
});
