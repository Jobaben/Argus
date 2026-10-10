import { describe, it, expect } from "vitest";
import { applyTuningReport, proposalKey, toInput } from "./tuningApply";
import type { PipelineDefinition, TuningProposal, TuningReport, PhaseTuning } from "../types";

/**
 * The guarantee behind "never touch the prompt": every step is rebuilt by
 * whitelisted assignment, so no proposal — however many are ticked — can reach
 * `prompt`, `name`, `runtime`, `checks`, `needs` or anything else outside the
 * four tunable fields. And with nothing ticked, the output is the input.
 */

function def(): PipelineDefinition {
  const phases = ["alpha", "beta", "gamma"].map((id, pi) => ({
    id,
    name: id.toUpperCase(),
    cwd: `/repo/${id}`,
    gated: pi === 1,
    needs: pi === 0 ? undefined : [["alpha", "beta", "gamma"][pi - 1]],
    checks: [{ kind: "command" as const, run: "npm test" }],
    produces: `${id}-out`,
    capabilities: pi === 2 ? { maxTurns: 30, tools: { allow: ["Edit"] } } : undefined,
    timeoutSeconds: pi === 1 ? 900 : undefined,
    steps: [0, 1, 2].map((si) => ({
      name: `${id}-step-${si}`,
      prompt: `Prompt ${pi}.${si}: do the ${id} work carefully.\nSecond line.`,
      ...(si === 0 ? { model: "opus" } : {}),
      ...(si === 1 ? { runtime: "codex" as const, reasoningEffort: "medium" as const } : {}),
      ...(si === 2 ? { capabilities: { filesystem: "read-only" as const } } : {}),
    })),
  }));
  return {
    id: "p1",
    name: "Nightly",
    phases,
    trigger: null,
    enabled: true,
    overlapPolicy: "skip",
    model: "sonnet",
    capabilities: { maxTurns: 100 },
    lastStartedAt: null,
    createdAt: "",
    updatedAt: "",
  };
}

function proposal(over: Partial<TuningProposal>): TuningProposal {
  return {
    phaseId: "alpha",
    phaseName: "ALPHA",
    scope: "step",
    stepName: "alpha-step-0",
    stepIndex: 0,
    field: "model",
    current: "opus",
    proposed: "haiku",
    inheritedFrom: "step",
    before: "opus",
    after: "haiku",
    reason: "r",
    ...over,
  };
}

/** A report proposing a change to every tunable field of every step, plus
 *  both phase-level fields on every phase. */
function everything(d: PipelineDefinition): TuningReport {
  const phases: PhaseTuning[] = d.phases.map((ph) => ({
    phaseId: ph.id,
    phaseName: ph.name,
    status: "ready",
    summary: "s",
    unchanged: [],
    warnings: [],
    costUsd: null,
    tokens: null,
    durationMs: null,
    error: null,
    proposals: [
      ...ph.steps.flatMap((st) => [
        proposal({ phaseId: ph.id, stepName: st.name, field: "model", proposed: "haiku" }),
        proposal({ phaseId: ph.id, stepName: st.name, field: "reasoningEffort", proposed: "high" }),
        proposal({ phaseId: ph.id, stepName: st.name, field: "timeoutSeconds", proposed: 1200 }),
        proposal({ phaseId: ph.id, stepName: st.name, field: "maxTurns", proposed: 7 }),
      ]),
      proposal({
        phaseId: ph.id,
        scope: "phase",
        stepName: null,
        stepIndex: null,
        field: "timeoutSeconds",
        proposed: 3600,
      }),
      proposal({
        phaseId: ph.id,
        scope: "phase",
        stepName: null,
        stepIndex: null,
        field: "maxTurns",
        proposed: 50,
      }),
    ],
  }));
  return {
    id: "r1",
    pipelineId: d.id,
    pipelineName: d.name,
    status: "ready",
    startedAt: "",
    endedAt: "",
    phasesDone: 3,
    phasesTotal: 3,
    phases,
    costUsd: null,
    tokens: null,
    error: null,
  };
}

const allKeys = (r: TuningReport) => new Set(r.phases.flatMap((p) => p.proposals.map(proposalKey)));

describe("applyTuningReport", () => {
  it("never changes a prompt, name, runtime, checks, needs or produces — even applying everything", () => {
    const d = def();
    const out = applyTuningReport(d, everything(d), allKeys(everything(d)));
    expect(out.phases).toHaveLength(3);
    d.phases.forEach((ph, pi) => {
      const o = out.phases[pi];
      expect(o.id).toBe(ph.id);
      expect(o.name).toBe(ph.name);
      expect(o.cwd).toBe(ph.cwd);
      expect(o.gated).toBe(ph.gated);
      expect(o.needs).toEqual(ph.needs);
      expect(o.checks).toEqual(ph.checks);
      expect(o.produces).toBe(ph.produces);
      ph.steps.forEach((st, si) => {
        const s = o.steps[si];
        expect(s.prompt).toBe(st.prompt);
        expect(s.name).toBe(st.name);
        expect(s.runtime).toBe(st.runtime);
        expect(s.capabilities?.filesystem).toBe(st.capabilities?.filesystem);
      });
    });
    // and the tunable fields did move
    expect(out.phases[0].steps[0].model).toBe("haiku");
    expect(out.phases[0].steps[0].reasoningEffort).toBe("high");
    expect(out.phases[0].steps[0].timeoutSeconds).toBe(1200);
    expect(out.phases[0].steps[0].capabilities?.maxTurns).toBe(7);
    expect(out.phases[1].timeoutSeconds).toBe(3600);
    expect(out.phases[2].capabilities).toEqual({ maxTurns: 50, tools: { allow: ["Edit"] } });
  });

  it("with nothing selected, the result is the current definition", () => {
    const d = def();
    const out = applyTuningReport(d, everything(d), new Set());
    expect(out).toEqual({ ...toInput(d), capabilities: d.capabilities, phases: d.phases });
    // Not just deep-equal: absent fields stay absent.
    expect("model" in out.phases[0].steps[1]).toBe(false);
    expect("timeoutSeconds" in out.phases[0].steps[0]).toBe(false);
    expect("capabilities" in out.phases[0].steps[0]).toBe(false);
  });

  it("applies only the selected proposals and leaves inherited fields unmaterialised", () => {
    const d = def();
    const r = everything(d);
    const chosen = r.phases[0].proposals.find(
      (p) => p.stepName === "alpha-step-1" && p.field === "maxTurns",
    )!;
    const out = applyTuningReport(d, r, new Set([proposalKey(chosen)]));
    const step = out.phases[0].steps[1];
    expect(step.capabilities).toEqual({ maxTurns: 7 });
    // its sibling keeps no capabilities, and the pipeline-level model is not
    // copied down onto the step that inherits it
    expect(out.phases[0].steps[0].capabilities).toBeUndefined();
    expect("model" in step).toBe(false);
    expect(out.phases[0].steps[0].model).toBe("opus");
    expect(out.phases[1]).toEqual(d.phases[1]);
    expect(out.model).toBe("sonnet");
    expect(out.capabilities).toEqual({ maxTurns: 100 });
  });

  it("does not spread anything from the proposal into the step", () => {
    const d = def();
    const r = everything(d);
    const poisoned = {
      ...r.phases[0].proposals[0],
      prompt: "REPLACED",
      name: "REPLACED",
    } as unknown as TuningProposal;
    r.phases[0].proposals[0] = poisoned;
    const out = applyTuningReport(d, r, new Set([proposalKey(poisoned)]));
    expect(out.phases[0].steps[0].prompt).toBe(d.phases[0].steps[0].prompt);
    expect(out.phases[0].steps[0].name).toBe(d.phases[0].steps[0].name);
    expect(out.phases[0].steps[0].model).toBe("haiku");
  });
});
