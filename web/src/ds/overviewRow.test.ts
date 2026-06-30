import { describe, it, expect } from "vitest";
import { toOverviewRow } from "./overviewRow";
import type {
  OverviewEntry, PipelineDefinition, PipelineInstance, InstanceStatus, PhaseStatus,
} from "../types";

function def(over: Partial<PipelineDefinition> = {}): PipelineDefinition {
  return {
    id: "p1", name: "scheduler-prune",
    phases: [
      { id: "bs", name: "Brainstorm", cwd: "/", gated: true, steps: [{ name: "s", prompt: "x" }] },
      { id: "impl", name: "Implement", cwd: "/", gated: false, steps: [{ name: "s", prompt: "x" }] },
    ],
    trigger: null, enabled: true, overlapPolicy: "skip",
    lastStartedAt: null, createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z",
    ...over,
  };
}

function inst(status: InstanceStatus, phaseStatuses: PhaseStatus[]): PipelineInstance {
  return {
    id: "i1", pipelineId: "p1", pipelineName: "scheduler-prune", status,
    currentPhaseIndex: 0,
    phases: phaseStatuses.map((s, idx) => ({
      id: idx === 0 ? "bs" : "impl",
      name: idx === 0 ? "Brainstorm" : "Implement",
      gated: idx === 0,
      status: s,
      steps: s === "running" ? [{ name: "red-green", runId: "r1", status: "running" }] : [],
      attempt: 1, payload: null,
    })),
    trigger: "manual", signalToken: "tok",
    createdAt: "2026-06-30T09:00:00.000Z", updatedAt: "2026-06-30T10:00:00.000Z", endedAt: null,
  };
}

describe("toOverviewRow", () => {
  it("maps phase statuses to DsStatus pills", () => {
    const entry: OverviewEntry = { definition: def(), latest: inst("running", ["succeeded", "running"]) };
    const row = toOverviewRow(entry);
    expect(row.phases.map((p) => p.status)).toEqual(["done", "working"]);
  });

  it("maps the instance badge", () => {
    const row = toOverviewRow({ definition: def(), latest: inst("awaiting-approval", ["succeeded", "awaiting-approval"]) });
    expect(row.badge).toBe("await");
  });

  it("extracts the active step name from the running phase", () => {
    const row = toOverviewRow({ definition: def(), latest: inst("running", ["succeeded", "running"]) });
    expect(row.phases[1].activeStep).toBe("red-green");
    expect(row.phases[0].activeStep).toBeNull();
  });

  it("exposes an approve+revise gate on an awaiting-approval phase", () => {
    const row = toOverviewRow({ definition: def(), latest: inst("awaiting-approval", ["succeeded", "awaiting-approval"]) });
    expect(row.gate).toEqual({ phaseId: "impl", canApprove: true });
    expect(row.instanceId).toBe("i1");
  });

  it("exposes a revise-only gate on a failed instance", () => {
    const row = toOverviewRow({ definition: def(), latest: inst("failed", ["succeeded", "failed"]) });
    expect(row.gate).toEqual({ phaseId: "impl", canApprove: false });
  });

  it("has no gate on a running instance", () => {
    const row = toOverviewRow({ definition: def(), latest: inst("running", ["succeeded", "running"]) });
    expect(row.gate).toBeNull();
  });

  it("renders a never-run row from the definition when latest is null", () => {
    const row = toOverviewRow({ definition: def(), latest: null });
    expect(row.badge).toBe("idle");
    expect(row.instanceId).toBeNull();
    expect(row.gate).toBeNull();
    expect(row.phases.map((p) => p.status)).toEqual(["idle", "idle"]);
    expect(row.phases.map((p) => p.name)).toEqual(["Brainstorm", "Implement"]);
  });
});
