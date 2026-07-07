import { describe, it, expect } from "vitest";
import { toOverviewRow } from "./overviewRow";
import type {
  OverviewEntry,
  PipelineDefinition,
  PipelineInstance,
  InstanceStatus,
  PhaseStatus,
} from "../types";

function failedInst(payload: unknown, stepStatuses: ("failed" | "succeeded")[]): PipelineInstance {
  return {
    id: "i1",
    pipelineId: "p1",
    pipelineName: "scheduler-prune",
    status: "failed",
    currentPhaseIndex: 1,
    phases: [
      {
        id: "bs",
        name: "Brainstorm",
        gated: true,
        status: "succeeded",
        steps: [],
        attempt: 1,
        payload: null,
      },
      {
        id: "impl",
        name: "Implement",
        gated: false,
        status: "failed",
        steps: stepStatuses.map((s, i) => ({ name: `step-${i}`, runId: `r${i}`, status: s })),
        attempt: 1,
        payload,
      },
    ],
    trigger: "manual",
    signalToken: "tok",
    createdAt: "2026-06-30T09:00:00.000Z",
    updatedAt: "2026-06-30T10:00:00.000Z",
    endedAt: "2026-06-30T10:00:00.000Z",
  };
}

function def(over: Partial<PipelineDefinition> = {}): PipelineDefinition {
  return {
    id: "p1",
    name: "scheduler-prune",
    phases: [
      { id: "bs", name: "Brainstorm", cwd: "/", gated: true, steps: [{ name: "s", prompt: "x" }] },
      {
        id: "impl",
        name: "Implement",
        cwd: "/",
        gated: false,
        steps: [{ name: "s", prompt: "x" }],
      },
    ],
    trigger: null,
    enabled: true,
    overlapPolicy: "skip",
    lastStartedAt: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...over,
  };
}

function inst(status: InstanceStatus, phaseStatuses: PhaseStatus[]): PipelineInstance {
  return {
    id: "i1",
    pipelineId: "p1",
    pipelineName: "scheduler-prune",
    status,
    currentPhaseIndex: 0,
    phases: phaseStatuses.map((s, idx) => ({
      id: idx === 0 ? "bs" : "impl",
      name: idx === 0 ? "Brainstorm" : "Implement",
      gated: idx === 0,
      status: s,
      steps: s === "running" ? [{ name: "red-green", runId: "r1", status: "running" }] : [],
      attempt: 1,
      payload: null,
    })),
    trigger: "manual",
    signalToken: "tok",
    createdAt: "2026-06-30T09:00:00.000Z",
    updatedAt: "2026-06-30T10:00:00.000Z",
    endedAt: null,
  };
}

describe("toOverviewRow", () => {
  it("maps phase statuses to DsStatus pills", () => {
    const entry: OverviewEntry = {
      definition: def(),
      latest: inst("running", ["succeeded", "running"]),
    };
    const row = toOverviewRow(entry);
    expect(row.phases.map((p) => p.status)).toEqual(["done", "working"]);
  });

  it("maps the instance badge", () => {
    const row = toOverviewRow({
      definition: def(),
      latest: inst("awaiting-approval", ["succeeded", "awaiting-approval"]),
    });
    expect(row.badge).toBe("await");
  });

  it("extracts the active step name from the running phase", () => {
    const row = toOverviewRow({
      definition: def(),
      latest: inst("running", ["succeeded", "running"]),
    });
    expect(row.phases[1].activeStep).toBe("red-green");
    expect(row.phases[0].activeStep).toBeNull();
  });

  it("maps step progress to step pills", () => {
    const row = toOverviewRow({
      definition: def(),
      latest: inst("running", ["succeeded", "running"]),
    });
    expect(row.phases[1].steps).toEqual([{ name: "red-green", runId: "r1", status: "working" }]);
  });

  it("tiles phases without step progress from the definition", () => {
    const row = toOverviewRow({
      definition: def(),
      latest: inst("running", ["succeeded", "running"]),
    });
    // phase 0 reported no steps; fall back to the definition's step, done since the phase succeeded
    expect(row.phases[0].steps).toEqual([{ name: "s", runId: null, status: "done" }]);
  });

  it("exposes the failure reason on the failed phase pill", () => {
    const row = toOverviewRow({
      definition: def(),
      latest: failedInst({ reason: "exit code 1" }, ["failed"]),
    });
    expect(row.phases[1].reason).toBe("exit code 1");
    expect(row.phases[0].reason).toBeNull();
  });

  it("exposes an approve+revise gate on an awaiting-approval phase", () => {
    const row = toOverviewRow({
      definition: def(),
      latest: inst("awaiting-approval", ["succeeded", "awaiting-approval"]),
    });
    expect(row.gate).toEqual({ phaseId: "impl", canApprove: true });
    expect(row.instanceId).toBe("i1");
  });

  it("exposes a revise-only gate on a failed instance", () => {
    const row = toOverviewRow({
      definition: def(),
      latest: inst("failed", ["succeeded", "failed"]),
    });
    expect(row.gate).toEqual({ phaseId: "impl", canApprove: false });
  });

  it("has no gate on a running instance", () => {
    const row = toOverviewRow({
      definition: def(),
      latest: inst("running", ["succeeded", "running"]),
    });
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

  it("surfaces the failed step name and an object payload reason", () => {
    const row = toOverviewRow({
      definition: def(),
      latest: failedInst({ reason: "exit code 1" }, ["failed"]),
    });
    expect(row.failure).toEqual({ step: "step-0", reason: "exit code 1", kind: null });
  });

  it("accepts a bare string payload as the reason", () => {
    const row = toOverviewRow({
      definition: def(),
      latest: failedInst("tests failed: 3 red", ["failed"]),
    });
    expect(row.failure).toEqual({ step: "step-0", reason: "tests failed: 3 red", kind: null });
  });

  it("joins multiple failed step names and tolerates a garbage payload", () => {
    const row = toOverviewRow({
      definition: def(),
      latest: failedInst({ nope: 1 }, ["failed", "failed"]),
    });
    expect(row.failure).toEqual({ step: "step-0, step-1", reason: null, kind: null });
  });

  it("falls back to the phase name when no step is marked failed", () => {
    const row = toOverviewRow({ definition: def(), latest: failedInst(null, ["succeeded"]) });
    expect(row.failure).toEqual({ step: "Implement", reason: null, kind: null });
  });

  it("surfaces the restarted kind on the failure", () => {
    const inst = failedInst(
      { reason: "Argus restarted mid-run — revise to retry", kind: "restarted" },
      ["failed"],
    );
    const row = toOverviewRow({ definition: def(), latest: inst });
    expect(row.failure?.kind).toBe("restarted");
    expect(row.failure?.reason).toMatch(/revise to retry/);
  });

  it("leaves kind null for an ordinary failure", () => {
    const inst = failedInst({ reason: "blocked: no Jira" }, ["failed"]);
    const row = toOverviewRow({ definition: def(), latest: inst });
    expect(row.failure?.kind).toBeNull();
  });

  it("has no failure on a non-failed instance", () => {
    const row = toOverviewRow({
      definition: def(),
      latest: inst("running", ["succeeded", "running"]),
    });
    expect(row.failure).toBeNull();
  });

  it("maps an aborted instance to the distinct stopped badge", () => {
    const row = toOverviewRow({
      definition: def(),
      latest: inst("aborted", ["succeeded", "succeeded"]),
    });
    expect(row.badge).toBe("stopped");
  });
});
