import { describe, it, expect } from "vitest";
import { toOverviewRow } from "./overviewRow";
import type {
  OverviewEntry,
  PhaseDef,
  PhaseProgress,
  PhaseStatus,
  PipelineDefinition,
  PipelineInstance,
  RouteDecision,
} from "../types";

/**
 * What the board needs to know about a routed instance.
 *
 * A skipped phase is the case the old model could not express: it is terminal,
 * it is fine, and it is not idle. Reading it as "idle" tells a reader the work
 * is *about* to happen, which is the one thing that is certainly false.
 */

const accepted = (value: boolean) => ({
  predicate: { path: ["accepted"], operator: "equals" as const, value },
});

const phaseDef = (id: string, over: Partial<PhaseDef> = {}): PhaseDef => ({
  id,
  name: id,
  cwd: "/tmp",
  gated: false,
  steps: [{ name: "s", prompt: "p" }],
  ...over,
});

const definition = (): PipelineDefinition => ({
  id: "p1",
  name: "Routed",
  phases: [
    phaseDef("evaluate", {
      result: {
        artifact: "evaluation",
        schema: {
          type: "object",
          required: ["accepted"],
          properties: { accepted: { type: "boolean" } },
        },
      },
    }),
    phaseDef("publish", { needs: [{ phase: "evaluate", when: accepted(true) }] }),
    phaseDef("repair", { needs: [{ phase: "evaluate", when: accepted(false) }] }),
    phaseDef("report", {
      needs: [
        { phase: "publish", allowSkipped: true },
        { phase: "repair", allowSkipped: true },
      ],
    }),
  ],
  trigger: null,
  enabled: true,
  overlapPolicy: "skip",
  lastStartedAt: null,
  createdAt: "2026-08-13T09:00:00.000Z",
  updatedAt: "2026-08-13T09:00:00.000Z",
});

const progress = (id: string, status: PhaseStatus): PhaseProgress => ({
  id,
  name: id,
  gated: false,
  status,
  steps: [{ name: "s", runId: null, status: status === "skipped" ? "skipped" : "succeeded" }],
  attempt: 0,
  payload: null,
});

const decision: RouteDecision = {
  sourcePhase: "evaluate",
  artifact: "evaluation",
  value: { accepted: true },
  selected: ["publish"],
  skipped: ["repair"],
  reason: "selected publish (accepted equals true); skipped repair (accepted equals false)",
};

function instance(over: Partial<PipelineInstance> = {}): PipelineInstance {
  return {
    id: "i1",
    pipelineId: "p1",
    pipelineName: "Routed",
    status: "succeeded",
    currentPhaseIndex: 1,
    phases: [
      progress("evaluate", "succeeded"),
      progress("publish", "succeeded"),
      progress("repair", "skipped"),
      progress("report", "succeeded"),
    ],
    trigger: "manual",
    signalToken: "t",
    createdAt: "2026-08-13T12:00:00.000Z",
    updatedAt: "2026-08-13T12:00:00.000Z",
    endedAt: "2026-08-13T12:05:00.000Z",
    routeDecisions: [decision],
    ...over,
  };
}

/** An overview entry as the API returns it. */
const entry = (
  definitionOver: PipelineDefinition = definition(),
  latest: PipelineInstance | null = instance(),
): OverviewEntry => ({
  definition: definitionOver,
  latest,
  cost: null,
  active: [],
});

describe("route state on the board", () => {
  it("marks a skipped phase as skipped rather than leaving it to read as idle", () => {
    const row = toOverviewRow(entry());
    const repair = row.phases[2];
    expect(repair.skipped).toBe(true);
    expect(row.phases[1].skipped).toBe(false);
  });

  it("says which decision skipped a phase, and on what condition", () => {
    const row = toOverviewRow(entry());
    expect(row.phases[2].skipCause).toEqual({ source: "evaluate", label: "accepted = false" });
  });

  it("explains a skip that propagated down the cancelled branch", () => {
    const later = progress("announce", "skipped");
    const def = definition();
    def.phases.push(phaseDef("announce", { needs: ["repair"] }));
    const inst = instance();
    inst.phases.push(later);
    const row = toOverviewRow(entry(def, inst));
    expect(row.phases[4].skipCause).toEqual({ source: "repair", label: "was skipped too" });
  });

  it("carries the decision on the phase that took it", () => {
    const row = toOverviewRow(entry());
    expect(row.phases[0].decision).toEqual(decision);
    expect(row.phases[1].decision).toBeNull();
  });

  it("labels each incoming edge with the condition that governs it", () => {
    const row = toOverviewRow(entry());
    expect(row.phases[1].edges).toEqual([
      { phase: "evaluate", label: "accepted = true", conditional: true, allowSkipped: false },
    ]);
    expect(row.phases[3].edges).toEqual([
      { phase: "publish", label: "always", conditional: false, allowSkipped: true },
      { phase: "repair", label: "always", conditional: false, allowSkipped: true },
    ]);
  });

  it("leaves a pipeline that does not route with nothing to explain", () => {
    const def: PipelineDefinition = {
      ...definition(),
      phases: [phaseDef("a"), phaseDef("b")],
    };
    const inst = instance({
      phases: [progress("a", "succeeded"), progress("b", "running")],
      routeDecisions: undefined,
    });
    const row = toOverviewRow(entry(def, inst));
    expect(row.phases.map((p) => p.skipped)).toEqual([false, false]);
    expect(row.phases.map((p) => p.decision)).toEqual([null, null]);
    expect(row.phases.map((p) => p.skipCause)).toEqual([null, null]);
    // The linear default still supplies the edge, unconditionally.
    expect(row.phases[1].edges).toEqual([
      { phase: "a", label: "always", conditional: false, allowSkipped: false },
    ]);
  });

  it("falls back to the instance's own edges for a phase the definition dropped", () => {
    const def: PipelineDefinition = { ...definition(), phases: [phaseDef("evaluate")] };
    const inst = instance();
    inst.phases[1].needs = ["evaluate"];
    const row = toOverviewRow(entry(def, inst));
    expect(row.phases[1].edges).toEqual([
      { phase: "evaluate", label: "always", conditional: false, allowSkipped: false },
    ]);
  });

  it("labels edges before the pipeline has ever run", () => {
    const row = toOverviewRow(entry(definition(), null));
    expect(row.phases[1].edges?.[0].label).toBe("accepted = true");
    expect(row.phases[1].skipped).toBe(false);
    expect(row.phases[0].decision).toBeNull();
  });
});
