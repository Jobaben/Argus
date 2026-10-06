import { KnowledgeDeltaError } from "../knowledge/delta.js";
import type { DeltaProposal } from "../knowledge/delta.js";
import { commitPhaseSemantics, readLedger } from "../knowledge/store.js";
import { readDeltaRecord, updateDeltaStatus } from "../knowledge/staging.js";
import { checkDiscoveryDelta } from "../knowledge/discovery.js";
import { updateVerificationStatus } from "../knowledge/verificationStaging.js";
import { updateProposalStatus } from "../knowledge/changeStaging.js";
import { updateAcceptanceStatus } from "../knowledge/acceptanceStaging.js";
import { applyKnowledgeCommit, commitFailureClass } from "../pipelineTransitions.js";
import { journal } from "../sources/journal.js";
import type {
  PhaseProgress,
  RetryableClass,
  StepProgress,
  PipelineDefinition,
  PipelineInstance,
} from "../sources/pipelineTypes.js";
import type { KnowledgeCommitVerdict, TransitionResult } from "../pipelineTransitions.js";
import type { EngineCore, EngineFns } from "./context.js";

/** Committing a phase attempt's staged records to the Knowledge Ledger at acceptance, and retiring the ones that can never be. Moved verbatim from `createEngine`. */
export function createKnowledgeCommit(core: EngineCore) {
  const { deps, nowISO, T } = core.ctx;
  const acceptanceProposalsOf: EngineFns["acceptanceProposalsOf"] = (...args) =>
    core.fns.acceptanceProposalsOf(...args);
  const changeAcceptancesOf: EngineFns["changeAcceptancesOf"] = (...args) =>
    core.fns.changeAcceptancesOf(...args);
  const discoveryContextFor: EngineFns["discoveryContextFor"] = (...args) =>
    core.fns.discoveryContextFor(...args);
  const mergeRouting: EngineFns["mergeRouting"] = (...args) => core.fns.mergeRouting(...args);
  const noteFailure: EngineFns["noteFailure"] = (...args) => core.fns.noteFailure(...args);
  const refreshChangeIntentSummary: EngineFns["refreshChangeIntentSummary"] = (...args) =>
    core.fns.refreshChangeIntentSummary(...args);
  const refreshDiscoverySummary: EngineFns["refreshDiscoverySummary"] = (...args) =>
    core.fns.refreshDiscoverySummary(...args);
  const refreshVerificationSummary: EngineFns["refreshVerificationSummary"] = (...args) =>
    core.fns.refreshVerificationSummary(...args);
  const saveInstance: EngineFns["saveInstance"] = (...args) => core.fns.saveInstance(...args);
  const verificationProposalsOf: EngineFns["verificationProposalsOf"] = (...args) =>
    core.fns.verificationProposalsOf(...args);
  const verifyDeltaArtifacts: EngineFns["verifyDeltaArtifacts"] = (...args) =>
    core.fns.verifyDeltaArtifacts(...args);

  /**
   * Apply a held phase's staged deltas as one ledger transition and return
   * the verdict. Reads each step's staged record (refusing one staged for
   * another attempt — the instance says which attempt this is), commits them
   * in step order under the ledger mutex, and moves the records to `applied`
   * or `rejected`. Any refusal — a stale precondition, a conflict between two
   * steps, an unreadable ledger — is a verdict, never a thrown error: the
   * phase fails with the reason, and nothing was written.
   */
  async function commitPhaseKnowledge(
    def: PipelineDefinition,
    inst: PipelineInstance,
    phase: PhaseProgress,
  ): Promise<KnowledgeCommitVerdict> {
    const wanted = phase.knowledge?.deltas ?? [];
    const proposals: DeltaProposal[] = [];
    for (const step of phase.steps) {
      const id = step.knowledgeDelta?.id;
      if (!id || !wanted.includes(id) || !step.runId) continue;
      const record = await readDeltaRecord(step.runId);
      if (!record || record.id !== id || !record.delta) {
        return { ok: false, reason: `KnowledgeDelta ${id} is not staged for run ${step.runId}` };
      }
      if (record.attempt !== phase.attempt) {
        return {
          ok: false,
          reason: `KnowledgeDelta ${id} was staged for attempt ${record.attempt}, not ${phase.attempt}`,
        };
      }
      proposals.push({
        id,
        delta: record.delta,
        execution: { runId: step.runId, instanceId: inst.id, phaseId: phase.id },
        attempt: phase.attempt,
        ...(record.supplied !== undefined ? { supplied: record.supplied } : {}),
        ...(phase.knowledgeScope ? { scope: phase.knowledgeScope } : {}),
        ...(phase.knowledgeAlsoRead ? { alsoRead: phase.knowledgeAlsoRead } : {}),
      });
    }
    const at = nowISO();
    // The declared artifacts, checked again now: intake proved they existed
    // when the run finished, not that they still do after checks ran and a
    // gate waited. One missing artifact refuses the whole attempt's commit
    // before the ledger is touched, so no sibling's delta lands without it.
    const phaseDef = def.phases.find((pd) => pd.id === phase.id);
    // Every refusal refuses the *whole* attempt: a phase that revises a rule,
    // verifies one and answers four criteria leaves all of it durable or none
    // of it. `failureClass` names which half was refused, so a retry policy
    // that opted into one class is not triggered by another.
    const refuseAll = async (
      reason: string,
      failureClass?: RetryableClass,
    ): Promise<KnowledgeCommitVerdict> => {
      for (const q of proposals) {
        await updateDeltaStatus(q.execution.runId, "rejected", { at, reason });
      }
      await refuseChangeProposals(phase, reason, at);
      await refuseAcceptance(phase, reason, at);
      return { ok: false, reason, ...(failureClass ? { failureClass } : {}) };
    };
    for (const p of proposals) {
      const missing = await verifyDeltaArtifacts(def, phase, p.execution.runId, p.delta);
      if (missing) {
        return refuseAll(
          `KnowledgeDelta commit refused: delta ${p.id} (run ${p.execution.runId}): artifact: ${missing}`,
          "knowledge-delta",
        );
      }
      // The discovery evidence, checked again at the commit boundary. Intake
      // proved the source files existed when the run finished, not that they
      // still do after checks ran and a person deliberated at the gate. A
      // rule whose evidence has gone missing in the meantime is refused
      // rather than committed as provenance for a file that is not there —
      // the same discipline the artifact check above applies, for the same
      // reason. One refusal refuses the whole attempt's commit, so no
      // sibling's delta lands without it.
      if (phaseDef?.discovery) {
        const verdict = await checkDiscoveryDelta(
          p.delta,
          await readLedger(),
          await discoveryContextFor(def, phase, p.execution.runId, phaseDef.discovery),
          p.supplied,
        );
        if (verdict.refusal) {
          return refuseAll(
            `KnowledgeDelta commit refused: delta ${p.id} (run ${p.execution.runId}): ${verdict.refusal}`,
            "knowledge-delta",
          );
        }
      }
    }
    // The attempt's conformance results (Phase 6), resolved against the checks
    // Argus itself ran. Gathered before the write so a forged or unsatisfied
    // check reference refuses the whole attempt rather than landing half of it.
    const verifications = await verificationProposalsOf(def, inst, phase);
    if (!verifications.ok) {
      const reason = `rule-verification commit refused: ${verifications.reason}`;
      await refuseVerifications(phase, reason, at);
      await refuseChangeProposals(phase, reason, at);
      return refuseAll(reason, "rule-verification");
    }
    // The attempt's accepted change intent (Phase 7). Gathered before the write
    // so the request that caused a revision, and the revision itself, are one
    // transition: a ledger holding RULE-42:v2 with no record of why it exists
    // is exactly the provenance gap this phase closes.
    const changes = await changeAcceptancesOf(inst, phase);
    if (!changes.ok) {
      const reason = `change-proposal commit refused: ${changes.reason}`;
      await refuseVerifications(phase, reason, at);
      await refuseChangeProposals(phase, reason, at);
      return refuseAll(reason, "change-proposal");
    }
    // The attempt's acceptance results (Phase 8), resolved against the checks
    // Argus itself ran. Gathered before the write for the same reason as the
    // conformance results: a forged or failing check reference refuses the
    // whole attempt rather than landing half of it.
    const acceptance = await acceptanceProposalsOf(inst, phase);
    if (!acceptance.ok) {
      const reason = `acceptance-verification commit refused: ${acceptance.reason}`;
      await refuseVerifications(phase, reason, at);
      await refuseChangeProposals(phase, reason, at);
      await refuseAcceptance(phase, reason, at);
      return refuseAll(reason, "acceptance-verification");
    }
    try {
      const results = await commitPhaseSemantics(
        proposals,
        verifications.proposals,
        deps.now(),
        changes.acceptances,
        acceptance.proposals,
      );
      for (const [i, p] of proposals.entries()) {
        await updateDeltaStatus(p.execution.runId, "applied", { at, result: results.deltas[i] });
      }
      // Each run's staged record keeps the durable records its proposal
      // became, so "what did this attempt make canonical?" is answerable from
      // the sidecar as well as from the ledger.
      for (const step of phase.steps) {
        if (!step.runId || !step.ruleVerification) continue;
        if (!(phase.knowledge?.verifications ?? []).includes(step.ruleVerification.id)) continue;
        await updateVerificationStatus(step.runId, "applied", {
          at,
          result: {
            verifications: results.verifications.filter((v) => v.execution.runId === step.runId),
          },
        });
      }
      // And the acceptance sidecar keeps the durable results it became.
      for (const step of phase.steps) {
        if (!step.runId || !step.acceptanceVerification) continue;
        if (
          !(phase.knowledge?.acceptanceVerifications ?? []).includes(step.acceptanceVerification.id)
        ) {
          continue;
        }
        await updateAcceptanceStatus(step.runId, "applied", {
          at,
          result: {
            criteria: results.acceptanceVerifications.filter(
              (v) => v.execution.runId === step.runId,
            ),
          },
        });
      }
      // And the change-intent sidecar keeps the durable proposal it became, so
      // "what did this attempt make canonical, and why?" is answerable from the
      // record beside the run as well as from the ledger.
      for (const step of phase.steps) {
        if (!step.runId || !step.changeProposal) continue;
        if (!(phase.knowledge?.changeProposals ?? []).includes(step.changeProposal.id)) continue;
        const accepted = results.changeProposals.find((c) => c.execution.runId === step.runId);
        await updateProposalStatus(step.runId, "accepted", {
          at,
          ...(accepted ? { result: { proposal: accepted } } : {}),
        });
      }
      return { ok: true };
    } catch (e) {
      // The ledger itself refused the transition. Which half it was about is
      // not decidable from the throw, so the reason names the half that was
      // the *only* thing at stake when there was one, and the class falls back
      // to what the attempt staged.
      const half =
        proposals.length > 0
          ? "KnowledgeDelta"
          : verifications.proposals.length > 0
            ? "rule-verification"
            : acceptance.proposals.length > 0
              ? "acceptance-verification"
              : "KnowledgeDelta";
      const reason = `${half} commit refused: ${
        e instanceof KnowledgeDeltaError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e)
      }`;
      for (const p of proposals) {
        await updateDeltaStatus(p.execution.runId, "rejected", { at, reason });
      }
      await refuseVerifications(phase, reason, at);
      await refuseChangeProposals(phase, reason, at);
      await refuseAcceptance(phase, reason, at);
      return { ok: false, reason };
    }
  }

  /** Mark this attempt's staged acceptance records rejected, so the refusal is
   *  readable beside the run as well as on the phase. */
  async function refuseAcceptance(phase: PhaseProgress, reason: string, at: string): Promise<void> {
    for (const step of phase.steps) {
      if (!step.runId || !step.acceptanceVerification) continue;
      if (
        !(phase.knowledge?.acceptanceVerifications ?? []).includes(step.acceptanceVerification.id)
      ) {
        continue;
      }
      await updateAcceptanceStatus(step.runId, "rejected", { at, reason });
    }
  }

  /** Mark every staged change proposal of a held phase as rejected: the commit
   *  is one transition, so one refusal refuses all of it. */
  async function refuseChangeProposals(
    phase: PhaseProgress,
    reason: string,
    at: string,
  ): Promise<void> {
    for (const step of phase.steps) {
      if (!step.runId || !step.changeProposal) continue;
      if (!(phase.knowledge?.changeProposals ?? []).includes(step.changeProposal.id)) continue;
      await updateProposalStatus(step.runId, "rejected", { at, reason });
    }
  }

  /** Mark every staged verification of a held phase as rejected: the commit is
   *  one transition, so one refusal refuses all of it. */
  async function refuseVerifications(
    phase: PhaseProgress,
    reason: string,
    at: string,
  ): Promise<void> {
    for (const step of phase.steps) {
      if (!step.runId || !step.ruleVerification) continue;
      if (!(phase.knowledge?.verifications ?? []).includes(step.ruleVerification.id)) continue;
      await updateVerificationStatus(step.runId, "rejected", { at, reason });
    }
  }

  /**
   * Take a transition through the knowledge commit it asked for.
   *
   * A transition that met every other acceptance condition of a phase with
   * staged deltas has held it `running` under `knowledge.status: "pending"`
   * and named it in `commitKnowledge`. The held state is persisted *first*
   * — so a crash after the ledger write is healed by committing again, which
   * is idempotent — then the deltas are committed and the verdict applied.
   * Returns the transition the caller should continue with: what the verdict
   * settled (the successors it made ready, the routes it decided), merged
   * with what the original transition had already settled.
   */
  async function settleKnowledge(
    def: PipelineDefinition,
    res: TransitionResult,
  ): Promise<TransitionResult> {
    if (!res.commitKnowledge?.length) return res;
    let out: TransitionResult = { ...res };
    delete out.commitKnowledge;
    for (const phaseId of res.commitKnowledge) {
      const phase = out.instance.phases.find((p) => p.id === phaseId);
      if (!phase || phase.knowledge?.status !== "pending") continue;
      await saveInstance(out.instance);
      const verdict = await commitPhaseKnowledge(def, out.instance, phase);
      const next = T(applyKnowledgeCommit(def, out.instance, phaseId, verdict, nowISO()));
      if (!next.knowledgeApplied) continue;
      // The candidates are canonical now (or refused): the phase's discovery
      // summary is recomputed so `requiresReview` stops saying a decision is
      // outstanding once it has been made.
      const settledPhase = next.instance.phases.find((p) => p.id === phaseId);
      if (settledPhase?.discovery) await refreshDiscoverySummary(def, settledPhase);
      if (settledPhase?.ruleVerification) await refreshVerificationSummary(settledPhase);
      if (settledPhase?.changeIntent) await refreshChangeIntentSummary(def, settledPhase);
      // One commit, two journals — each written only when that half had
      // something at stake, so a verification-only phase never logs "0 deltas"
      // and a delta-only phase never logs a verification.
      const verifications = phase.knowledge.verifications ?? [];
      if (verifications.length > 0) {
        void journal(out.instance.id, {
          at: nowISO(),
          kind: verdict.ok ? "verification.applied" : "verification.rejected",
          phaseId,
          attempt: phase.attempt,
          detail: verdict.ok
            ? `${verifications.length} verification proposal${verifications.length === 1 ? "" : "s"}`
            : verdict.reason,
        });
      }
      const changes = phase.knowledge.changeProposals ?? [];
      if (changes.length > 0) {
        void journal(out.instance.id, {
          at: nowISO(),
          kind: verdict.ok ? "change.accepted" : "change.rejected",
          phaseId,
          attempt: phase.attempt,
          detail: verdict.ok ? changes.join(", ") : verdict.reason,
        });
      }
      if (phase.knowledge.deltas.length > 0) {
        void journal(out.instance.id, {
          at: nowISO(),
          kind: verdict.ok ? "knowledge.applied" : "knowledge.rejected",
          phaseId,
          attempt: phase.attempt,
          detail: verdict.ok
            ? `${phase.knowledge.deltas.length} delta${phase.knowledge.deltas.length === 1 ? "" : "s"}: ${phase.knowledge.deltas.join(", ")}`
            : verdict.reason,
        });
      }
      // The failure class matches what `applyKnowledgeCommit` already wrote on
      // the phase: a commit that carried only conformance results failed as
      // `rule-verification`, not as a knowledge delta.
      if (!verdict.ok) {
        // The same class the transition wrote onto the phase: derived from
        // what the attempt staged unless the commit said which half it was.
        noteFailure(
          def,
          next.instance,
          phaseId,
          verdict.failureClass ?? commitFailureClass(phase.knowledge),
          verdict.reason,
        );
      }
      out = {
        ...next,
        startPhases: [...new Set([...out.startPhases, ...next.startPhases])],
        routing: mergeRouting(out.routing, next.routing),
      };
    }
    return out;
  }

  /** Move the named steps' staged deltas, verification proposals and change
   *  proposals to `superseded`, on disk and on the instance. An `applied` or
   *  `accepted` record is never touched. */
  async function supersedeDeltas(
    inst: PipelineInstance,
    phase: PhaseProgress,
    steps: StepProgress[],
    reason: string,
  ): Promise<void> {
    for (const step of steps) {
      if (!step.runId) continue;
      if (step.knowledgeDelta?.status === "staged") {
        await updateDeltaStatus(step.runId, "superseded", { at: nowISO(), reason });
        step.knowledgeDelta = { ...step.knowledgeDelta, status: "superseded" };
        void journal(inst.id, {
          at: nowISO(),
          kind: "knowledge.superseded",
          phaseId: phase.id,
          runId: step.runId,
          attempt: phase.attempt,
          detail: `${step.knowledgeDelta.id}: ${reason}`,
        });
      }
      if (step.acceptanceVerification?.status === "staged") {
        await updateAcceptanceStatus(step.runId, "superseded", { at: nowISO(), reason });
        step.acceptanceVerification = { ...step.acceptanceVerification, status: "superseded" };
        void journal(inst.id, {
          at: nowISO(),
          kind: "acceptance.superseded",
          phaseId: phase.id,
          runId: step.runId,
          attempt: phase.attempt,
          detail: `${step.acceptanceVerification.id}: ${reason}`,
        });
      }
      if (step.ruleVerification?.status === "staged") {
        await updateVerificationStatus(step.runId, "superseded", { at: nowISO(), reason });
        step.ruleVerification = { ...step.ruleVerification, status: "superseded" };
        void journal(inst.id, {
          at: nowISO(),
          kind: "verification.superseded",
          phaseId: phase.id,
          runId: step.runId,
          attempt: phase.attempt,
          detail: `${step.ruleVerification.id}: ${reason}`,
        });
      }
      if (step.changeProposal?.status === "staged") {
        await updateProposalStatus(step.runId, "superseded", { at: nowISO(), reason });
        step.changeProposal = { ...step.changeProposal, status: "superseded" };
        void journal(inst.id, {
          at: nowISO(),
          kind: "change.superseded",
          phaseId: phase.id,
          runId: step.runId,
          attempt: phase.attempt,
          detail: `${step.changeProposal.id}: ${reason}`,
        });
      }
    }
  }

  /**
   * Every staged delta, verification proposal and change proposal on an
   * attempt that can no longer be accepted — a
   * failed, aborted or skipped phase, or a step that failed, was aborted (a
   * losing candidate) or was skipped — is superseded. Run on every instance
   * write, because an attempt can end from a dozen places and a hook on each
   * is a hook somebody forgets. Cheap when nothing is staged (the common case:
   * one pass over the steps, no I/O).
   */
  async function retireStagedDeltas(inst: PipelineInstance): Promise<void> {
    for (const phase of inst.phases) {
      const phaseOver =
        phase.status === "failed" || phase.status === "aborted" || phase.status === "skipped";
      const doomed = phase.steps.filter(
        (s) =>
          (s.knowledgeDelta?.status === "staged" ||
            s.ruleVerification?.status === "staged" ||
            s.acceptanceVerification?.status === "staged" ||
            s.changeProposal?.status === "staged") &&
          (phaseOver || s.status === "failed" || s.status === "aborted" || s.status === "skipped"),
      );
      if (doomed.length === 0) continue;
      await supersedeDeltas(
        inst,
        phase,
        doomed,
        phaseOver
          ? `phase attempt ${phase.attempt} ${phase.status}`
          : `step ${doomed.map((s) => `${s.name} ${s.status}`).join(", ")}`,
      );
    }
  }

  return {
    commitPhaseKnowledge,
    refuseAcceptance,
    refuseChangeProposals,
    refuseVerifications,
    settleKnowledge,
    supersedeDeltas,
    retireStagedDeltas,
  };
}
