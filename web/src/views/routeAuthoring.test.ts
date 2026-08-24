import { describe, it, expect } from "vitest";
import {
  edgeBetween,
  fieldsToSchema,
  groupNames,
  parseValue,
  schemaFields,
  withEdge,
  withGroupFlag,
} from "./routeAuthoring";
import type { EditableField } from "./routeAuthoring";
import type { PhaseDef } from "../types";

const phase = (id: string, over: Partial<PhaseDef> = {}): PhaseDef => ({
  id,
  name: id,
  cwd: "/tmp",
  gated: false,
  steps: [{ name: "s", prompt: "p" }],
  ...over,
});

const field = (over: Partial<EditableField> = {}): EditableField => ({
  name: "accepted",
  type: "boolean",
  values: "",
  required: true,
  ...over,
});

describe("schemaFields", () => {
  it("round-trips a flat object of scalars", () => {
    const schema = {
      type: "object" as const,
      required: ["verdict"],
      properties: {
        verdict: { type: "string" as const, enum: ["pass", "fail"] },
        score: { type: "number" as const },
      },
    };
    const fields = schemaFields(schema);
    expect(fields).toEqual([
      { name: "verdict", type: "string", values: "pass, fail", required: true },
      { name: "score", type: "number", values: "", required: false },
    ]);
    expect(fieldsToSchema(fields!)).toEqual(schema);
  });

  it("treats a shape it cannot draw as one to leave alone", () => {
    expect(schemaFields({ type: "object", properties: { deep: { type: "object" } } })).toBeNull();
    expect(schemaFields({ type: "array", items: { type: "string" } })).toBeNull();
    expect(schemaFields({ type: "string" })).toBeNull();
    // A required name with no property declared would be dropped on save.
    expect(schemaFields({ type: "object", required: ["ghost"], properties: {} })).toBeNull();
  });

  it("has nothing to show for a phase that declares no result", () => {
    expect(schemaFields(undefined)).toEqual([]);
  });
});

describe("fieldsToSchema", () => {
  it("drops unnamed fields and types the allowed values", () => {
    expect(
      fieldsToSchema([
        field({ name: "score", type: "number", values: "1, 2", required: false }),
        field({ name: "  ", required: false }),
      ]),
    ).toEqual({ type: "object", properties: { score: { type: "number", enum: [1, 2] } } });
  });

  it("parses each value as its field's own type", () => {
    expect(parseValue("boolean", "true")).toBe(true);
    expect(parseValue("boolean", "no")).toBe(false);
    expect(parseValue("number", "3.5")).toBe(3.5);
    expect(parseValue("number", "nope")).toBe(0);
    expect(parseValue("string", "pass")).toBe("pass");
  });
});

describe("withEdge", () => {
  const linear = [phase("a"), phase("b"), phase("c")];

  it("materializes the implicit linear edges rather than reshaping the graph", () => {
    const when = { predicate: { path: ["ok"], operator: "equals" as const, value: true } };
    const next = withEdge(linear, "b", { phase: "a", when });
    expect(next[0].needs).toEqual([]);
    expect(next[1].needs).toEqual([{ phase: "a", when }]);
    expect(next[2].needs).toEqual([{ phase: "b" }]);
  });

  it("leaves every other edge exactly as it was", () => {
    const when = { predicate: { path: ["ok"], operator: "equals" as const, value: false } };
    const explicit = [
      phase("a"),
      phase("b", { needs: [{ phase: "a", when }] }),
      phase("c", { needs: ["a", { phase: "b", allowSkipped: true }] }),
    ];
    const next = withEdge(explicit, "c", { phase: "b", allowSkipped: false, when });
    expect(next[1].needs).toEqual([{ phase: "a", when }]);
    expect(next[2].needs).toEqual([{ phase: "a" }, { phase: "b", allowSkipped: false, when }]);
  });
});

describe("edgeBetween", () => {
  it("finds the edge whichever form it takes, including the linear default", () => {
    expect(edgeBetween([phase("a"), phase("b")], "b", "a")).toEqual({ phase: "a" });
    expect(edgeBetween([phase("a"), phase("b", { needs: [] })], "b", "a")).toBeNull();
  });
});

describe("withGroupFlag", () => {
  it("sets the flag on every member, because the server rejects disagreement", () => {
    const member = (value: string) => ({
      phase: "audit",
      when: {
        group: "verdict",
        predicate: { path: ["verdict"], operator: "equals" as const, value },
      },
    });
    const phases = [
      phase("audit"),
      phase("ship", { needs: [member("pass")] }),
      phase("fix", { needs: [member("fail")] }),
    ];
    const on = withGroupFlag(phases, "verdict", "exclusive", true);
    expect(on[1].needs![0]).toMatchObject({ when: { exclusive: true } });
    expect(on[2].needs![0]).toMatchObject({ when: { exclusive: true } });

    const off = withGroupFlag(on, "verdict", "exclusive", false);
    expect(Object.hasOwn((off[1].needs![0] as { when: object }).when, "exclusive")).toBe(false);
  });

  it("lists the groups already in use", () => {
    const phases = [
      phase("audit"),
      phase("ship", { needs: [{ phase: "audit", when: { group: "verdict", default: true } }] }),
    ];
    expect(groupNames(phases)).toEqual(["verdict"]);
    expect(groupNames([phase("a"), phase("b")])).toEqual([]);
  });
});
