/**
 * The side effects a saved instance still owes — derived from the instance
 * itself, never from a log record's say-so.
 *
 * That is the whole recovery rule in one function. A transition record lists
 * the effects its state called for, as evidence; recovery asks *this* function
 * about the *saved* instance, so a record that is ahead of the instance (it
 * was appended, and then the process died before the instance was published)
 * can never cause a launch, a check, a stop or a commit by itself.
 *
 * Pure.
 */
import type { OwedEffect, PipelineInstance } from "@argus/contracts";

export function owedEffects(
  inst: Pick<PipelineInstance, "phases" | "pendingGateOperation" | "status">,
): OwedEffect[] {
  const out: OwedEffect[] = [];
  if (inst.pendingGateOperation) {
    out.push({ kind: "gate-operation", decisionId: inst.pendingGateOperation.decisionId });
    if (inst.pendingGateOperation.stopRunIds.length > 0) {
      out.push({
        kind: "stop",
        runIds: [...inst.pendingGateOperation.stopRunIds],
        reason: `gate ${inst.pendingGateOperation.decision}`,
      });
    }
  }
  for (const phase of inst.phases) {
    if (phase.status === "running") {
      // Marked running by a settle, a retry, a revise or a remediation, and
      // not yet planned: a launch is owed for this exact attempt.
      if (phase.steps.length > 0 && phase.steps.every((s) => !s.runId)) {
        out.push({ kind: "launch", phaseId: phase.id, attempt: phase.attempt });
      }
      if (phase.verification?.status === "running") {
        out.push({ kind: "verify", phaseId: phase.id, attempt: phase.attempt });
      }
      for (const step of phase.steps) {
        if (step.candidate !== undefined && step.verification?.status === "running") {
          out.push({
            kind: "verify",
            phaseId: phase.id,
            attempt: phase.attempt,
            candidate: step.candidate,
          });
        }
      }
      if (phase.knowledge?.status === "pending") {
        out.push({ kind: "commit-knowledge", phaseId: phase.id, attempt: phase.attempt });
      }
    }
  }
  return out;
}

/**
 * Runs whose steps have been decided — failed, aborted, skipped or
 * superseded — while their processes may still be alive: each one owes a stop
 * until its process is known to be gone. Liveness is the engine's question;
 * this only names the candidates.
 */
export function decidedRuns(inst: Pick<PipelineInstance, "phases">): string[] {
  const out: string[] = [];
  for (const phase of inst.phases) {
    const phaseOver =
      phase.status === "failed" ||
      phase.status === "aborted" ||
      phase.status === "skipped" ||
      phase.status === "succeeded";
    for (const step of phase.steps) {
      if (!step.runId) continue;
      if (
        step.status === "failed" ||
        step.status === "aborted" ||
        step.status === "skipped" ||
        (phaseOver && step.status === "running")
      ) {
        out.push(step.runId);
      }
    }
  }
  return out;
}
