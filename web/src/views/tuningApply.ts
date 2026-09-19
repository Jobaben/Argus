import type {
  PhaseDef,
  PhaseStep,
  PipelineDefinition,
  PipelineInput,
  TuningProposal,
  TuningReport,
} from "../types";

/** The editable half of a definition, as the form and the tuning apply both need it. */
export function toInput(def: PipelineDefinition): PipelineInput {
  return {
    name: def.name,
    phases: def.phases,
    trigger: def.trigger,
    enabled: def.enabled,
    overlapPolicy: def.overlapPolicy,
    ...(def.model ? { model: def.model } : {}),
    ...(def.reasoningEffort ? { reasoningEffort: def.reasoningEffort } : {}),
    ...(def.runtime ? { runtime: def.runtime } : {}),
  };
}

/** A stable identity for one proposal, for selection sets and React keys. */
export function proposalKey(p: TuningProposal): string {
  return [p.phaseId, p.scope, p.stepName ?? "", p.field].join("\u0000");
}

type Capabilities = NonNullable<PhaseStep["capabilities"]>;

function withMaxTurns(caps: Capabilities | undefined, maxTurns: number): Capabilities {
  return { ...(caps ?? {}), maxTurns };
}

/**
 * Merge the selected proposals from a report into a saveable definition.
 *
 * The step is rebuilt by **explicit key assignment**, never by spreading
 * anything the model produced: `prompt` is copied from the current step and
 * nothing on this path can reach it. A field with no selected proposal is
 * copied as it is — including staying absent, so an inherited value is not
 * quietly materialised onto the step — and with an empty selection the result
 * is the current definition, unchanged.
 */
export function applyTuningReport(
  def: PipelineDefinition,
  report: TuningReport,
  selected: ReadonlySet<string>,
): PipelineInput {
  const chosen = new Map<string, TuningProposal>();
  for (const phase of report.phases) {
    for (const p of phase.proposals) {
      const key = proposalKey(p);
      if (selected.has(key)) chosen.set(key, p);
    }
  }

  const pick = (
    phaseId: string,
    scope: TuningProposal["scope"],
    stepName: string | null,
    field: TuningProposal["field"],
  ): TuningProposal | undefined =>
    chosen.get([phaseId, scope, stepName ?? "", field].join("\u0000"));

  const phases: PhaseDef[] = def.phases.map((phase) => {
    const steps: PhaseStep[] = phase.steps.map((step) => {
      const model = pick(phase.id, "step", step.name, "model");
      const effort = pick(phase.id, "step", step.name, "reasoningEffort");
      const timeout = pick(phase.id, "step", step.name, "timeoutSeconds");
      const turns = pick(phase.id, "step", step.name, "maxTurns");

      const next: PhaseStep = { name: step.name, prompt: step.prompt };
      const nextModel = model ? String(model.proposed) : step.model;
      if (nextModel !== undefined) next.model = nextModel;
      const nextEffort = effort
        ? (String(effort.proposed) as PhaseStep["reasoningEffort"])
        : step.reasoningEffort;
      if (nextEffort !== undefined) next.reasoningEffort = nextEffort;
      if (step.runtime !== undefined) next.runtime = step.runtime;
      const nextTimeout = timeout ? Number(timeout.proposed) : step.timeoutSeconds;
      if (nextTimeout !== undefined) next.timeoutSeconds = nextTimeout;
      const nextCaps = turns
        ? withMaxTurns(step.capabilities, Number(turns.proposed))
        : step.capabilities;
      if (nextCaps !== undefined) next.capabilities = nextCaps;
      return next;
    });

    const timeout = pick(phase.id, "phase", null, "timeoutSeconds");
    const turns = pick(phase.id, "phase", null, "maxTurns");
    const next: PhaseDef = { ...phase, steps };
    if (timeout) next.timeoutSeconds = Number(timeout.proposed);
    if (turns) next.capabilities = withMaxTurns(phase.capabilities, Number(turns.proposed));
    return next;
  });

  return {
    ...toInput(def),
    ...(def.capabilities ? { capabilities: def.capabilities } : {}),
    phases,
  };
}
