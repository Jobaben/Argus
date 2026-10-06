import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { readInvocation } from "../sources/runs.js";
import { checkLabel, snapshotWorkingTree } from "../harness/verification.js";
import { KnowledgeDeltaError, isEmptyDelta, parseKnowledgeDelta } from "../knowledge/delta.js";
import {
  validArtifactPath,
  formatClaimRef,
  suppliedContextOf,
  changeProposalById,
  formatCriterionRef,
  formatRepositoryState,
} from "../knowledge/kernel.js";
import type { DeltaProposal } from "../knowledge/delta.js";
import type { VerificationProposal, AcceptanceProposal } from "../knowledge/store.js";
import { preflightKnowledgeDeltas, readLedger } from "../knowledge/store.js";
import { readAgentDelta, readDeltaRecord, writeDeltaRecord } from "../knowledge/staging.js";
import {
  describeIntegrityFailure,
  knowledgeContextFile,
  verifyKnowledgeContextIntegrity,
} from "../knowledge/context.js";
import {
  checkDiscoveryDelta,
  previewKnowledgeDelta,
  summarizeDiscovery,
  type DiscoveryContext,
} from "../knowledge/discovery.js";
import {
  RuleVerificationError,
  bindCheckEvidence,
  checkRuleVerification,
  declaredCheckLabels,
  describeReport,
  holdsPolicy,
  holdsPolicyRefusal,
  parseRuleVerificationReport,
  previewRuleVerification,
  selectedRules,
  summarizeRuleVerification,
  verificationDeltaRefusal,
  type VerificationContext,
} from "../knowledge/ruleVerification.js";
import {
  readAgentVerification,
  readVerificationRecord,
  writeVerificationRecord,
} from "../knowledge/verificationStaging.js";
import {
  ChangeProposalError,
  changeContextFile,
  changeRequestFile,
  checkChangeProposal,
  describeChangeProposal,
  parseChangeProposal,
  previewChangeProposal,
  summarizeChangeIntent,
  type ChangeIntentContext,
} from "../knowledge/changeIntent.js";
import type { ChangeProposalAcceptance } from "../knowledge/changeIntent.js";
import {
  readAgentProposal,
  readProposalRecord,
  writeProposalRecord,
} from "../knowledge/changeStaging.js";
import { repositoryStateFrom } from "../knowledge/realization.js";
import {
  AcceptanceVerificationError,
  acceptanceCheckLabels,
  acceptanceCheckRefusal,
  acceptanceProposalMissing,
  bindAcceptanceChecks,
  checkAcceptanceReport,
  describeAcceptanceReport,
  parseAcceptanceReport,
  previewAcceptance,
  summarizeAcceptance,
  type AcceptanceContext,
} from "../knowledge/acceptance.js";
import {
  readAcceptanceRecord,
  readAgentAcceptance,
  writeAcceptanceRecord,
} from "../knowledge/acceptanceStaging.js";
import { journal } from "../sources/journal.js";
import type {
  AcceptanceVerificationRecord,
  ChangeProposalRecord,
  ChangeRequest,
  ChangeRuleState,
  ClaimRef,
  KnowledgeDelta,
  KnowledgeDeltaRecord,
  RuleVerificationRecord,
} from "@argus/contracts";
import type {
  CheckResult,
  PhaseDef,
  PhaseProgress,
  PipelineDefinition,
  PipelineInstance,
} from "../sources/pipelineTypes.js";
import type { Intake, ProposalIntake } from "./types.js";
import type { EngineCore } from "./context.js";

/** Reading, validating and staging what a completed run proposed: KnowledgeDeltas, rule verifications, change proposals, acceptance results — after the context-integrity gates. Moved verbatim from `createEngine`. */
export function createKnowledgeIntake(core: EngineCore) {
  const { deps, nowISO } = core.ctx;

  // ── Knowledge deltas ───────────────────────────────────────────────────────
  //
  // The engine's side of docs/KNOWLEDGE-LEDGER.md § KnowledgeDelta protocol.
  // Three moments, none of which touch `knowledge.json` except the middle one:
  //
  //   intake   — a run completed; its delta file is read, validated against
  //              the ledger as it stands, and staged beside the run (or
  //              refused, failing the step under `knowledge-delta`);
  //   commit   — the phase crossed every acceptance condition; every staged
  //              delta of *this attempt* is applied as one ledger transition,
  //              or none is, and the phase succeeds or fails on the verdict;
  //   retire   — an attempt failed, was revised, was aborted, or lost a
  //              selection; its staged deltas are superseded and can never
  //              become canonical.

  /** The phase and step a completion signal would drive, when both are live. */
  function liveStep(inst: PipelineInstance, phaseId: string, runId: string): boolean {
    const phase = inst.phases.find((p) => p.id === phaseId);
    if (!phase || phase.status !== "running") return false;
    const step = phase.steps.find((s) => s.runId === runId);
    return step?.status === "running";
  }

  /**
   * The context-integrity gate (Phase 4.1, docs/KNOWLEDGE-LEDGER.md §13.11).
   *
   * Argus hashed the KnowledgeContext file when it materialized it and wrote
   * that hash into the ledger. Before a completion is accepted, the file is
   * re-hashed: the bytes the agent was given must be the bytes Argus supplied,
   * or the provenance record is a promise Argus cannot keep. A mismatch — or a
   * file that has disappeared — refuses the completion deterministically, so
   * nothing the run proposed reaches the ledger.
   *
   * Three things it deliberately is not:
   *
   * - **Not a currency check.** A claim revised in the ledger while the agent
   *   ran leaves the file untouched; the run continues on the historical
   *   revision it was given. Only changed *bytes* fail here.
   * - **Not a check on legacy runs.** No durable supplied record (the run was
   *   launched without a semantic context, or predates Phase 4.1) means
   *   nothing to verify, and the completion proceeds exactly as before.
   * - **Not a read of the contents.** The refusal names the run, the two
   *   hashes and the path — never a byte of the context.
   *
   * Returns the refusal, or null when the completion may proceed.
   */
  async function checkContextIntegrity(
    inst: PipelineInstance,
    phaseId: string,
    runId: string,
  ): Promise<Intake | null> {
    const ledger = await readLedger();
    const supplied = suppliedContextOf(ledger, runId);
    if (!supplied) return null;
    const invocation = await readInvocation(runId);
    const file = invocation?.knowledgeContextFile ?? knowledgeContextFile(runId);
    const result = await verifyKnowledgeContextIntegrity(file, supplied.sha256);
    if (result.status === "unchanged") return null;
    const reason = describeIntegrityFailure(runId, result);
    void journal(inst.id, {
      at: nowISO(),
      kind: "knowledge.integrity",
      phaseId,
      runId,
      detail: `${result.status}: expected sha256 ${result.expected?.slice(0, 12)}${
        result.actual ? `, found ${result.actual.slice(0, 12)}` : ""
      }`,
    });
    return { ok: false, reason, failure: "knowledge-context-integrity" };
  }

  /**
   * The same gate for the Argus-owned read-only inputs Phase 8 added: the
   * ChangeContext, the ImplementationScope and the RemediationContext
   * (docs/KNOWLEDGE-LEDGER.md §Phase 8, context integrity).
   *
   * Phase 7 materialized the ChangeContext read-only but never checked it
   * again, so an implementation could have been driven by bytes nobody could
   * vouch for. This closes that, by exactly the Phase 4.1 model: hash at
   * launch, re-hash at completion, deterministic failure on a mismatch or a
   * missing file.
   *
   * It asks **one** question — *did the bytes supplied to this invocation
   * change?* — and deliberately not *is this still the newest proposal?*. An
   * accepted ChangeProposal's identity is immutable, so a newer proposal
   * accepted while the agent ran is never tampering; a realization that has
   * been overtaken is a `stale` realization, decided at close-out from the
   * ledger, not an integrity failure here.
   *
   * A record with no `suppliedInputs` (written before Phase 8, or a run that
   * received none) has nothing to verify and passes, exactly as a
   * pre-Phase-4.1 context does.
   */
  async function checkSuppliedInputs(
    inst: PipelineInstance,
    phaseId: string,
    runId: string,
  ): Promise<Intake | null> {
    const invocation = await readInvocation(runId);
    const inputs = invocation?.suppliedInputs ?? [];
    for (const input of inputs) {
      const result = await verifyKnowledgeContextIntegrity(input.path, input.sha256);
      if (result.status === "unchanged") continue;
      const reason =
        result.status === "missing"
          ? `change context integrity: run ${runId}'s ${input.kind} file is missing at ${input.path} (expected sha256 ${input.sha256})`
          : `change context integrity: run ${runId}'s ${input.kind} file changed during execution at ${input.path} (expected sha256 ${input.sha256}, found ${result.actual})`;
      void journal(inst.id, {
        at: nowISO(),
        kind: "knowledge.integrity",
        phaseId,
        runId,
        detail: `${input.kind} ${result.status}: expected sha256 ${input.sha256.slice(0, 12)}${
          result.actual ? `, found ${result.actual.slice(0, 12)}` : ""
        }`,
      });
      return { ok: false, reason, failure: "change-context-integrity" };
    }
    return null;
  }

  /**
   * Everything Argus checks before a step's completion — and the semantic
   * output it carries — is accepted: the context it was given is unchanged
   * (above), then its KnowledgeDelta is read, validated and staged (below).
   * Order matters: a run whose input Argus cannot vouch for never gets its
   * proposal staged, so a tampered context can never become canonical
   * knowledge.
   */
  async function acceptCompletion(
    def: PipelineDefinition,
    inst: PipelineInstance,
    phaseId: string,
    runId: string,
  ): Promise<Intake> {
    const refused = await checkContextIntegrity(inst, phaseId, runId);
    if (refused) return refused;
    // The Phase 8 inputs, under the same rule and before anything is staged: a
    // run whose accepted intent Argus cannot vouch for must not have its
    // conformance or acceptance results become durable.
    const tampered = await checkSuppliedInputs(inst, phaseId, runId);
    if (tampered) return tampered;
    // Change intent (Phase 7) is read *before* the delta, because on a
    // change-intent phase the proposal carries the delta: the semantic half of
    // a ChangeProposal is staged through exactly the KnowledgeDelta machinery,
    // so there is still one path by which anything becomes canonical.
    const proposal = await intakeChangeProposal(def, inst, phaseId, runId);
    if (!proposal.ok) return proposal;
    const delta = await intakeKnowledgeDelta(def, inst, phaseId, runId, proposal.semanticDelta);
    if (!delta.ok) return delta;
    if (proposal.recordRunId) {
      await bindProposalDelta(def, inst, phaseId, proposal.recordRunId, delta.staged?.id);
    }
    // Business-rule verification (Phase 6) rides the same boundary: a
    // conformance proposal is read, validated and staged exactly as a delta
    // is, and refused the same way. Its own channel, its own record, its own
    // failure class — and the same rule that nothing becomes durable before
    // the phase is accepted.
    const verification = await intakeRuleVerification(def, inst, phaseId, runId);
    if (!verification.ok) return verification;
    // Acceptance verification (Phase 8) rides the same boundary again, on its
    // own channel and its own record. Independent of the rule results by
    // construction: neither can rewrite the other, and a phase that answers
    // both writes two files.
    const acceptance = await intakeAcceptance(def, inst, phaseId, runId);
    return acceptance.ok ? delta : acceptance;
  }

  /**
   * The exact revisions Argus supplied to a run, from the two sources that can
   * answer, in a fixed precedence (docs/KNOWLEDGE-LEDGER.md §13.7): the
   * ledger's **durable** supplied record first — written before the process
   * starts and surviving every pruning path — and the invocation record only
   * when there is none. They cannot disagree (the durable record is registered
   * from the same resolution that produced the invocation record's, and a
   * conflicting registration is refused), so the precedence matters only for
   * availability: a recovery path where the invocation directory is gone still
   * answers correctly.
   *
   * `undefined` (not empty) when neither can be read: no claim either way. A
   * run launched *with* no context has an invocation record saying so, which
   * is positive evidence of an empty supply — never the same as unknown.
   */
  async function suppliedFor(runId: string): Promise<ClaimRef[] | undefined> {
    const durable = suppliedContextOf(await readLedger(), runId);
    if (durable) return durable.claims.map((c) => ({ id: c.id, revision: c.revision }));
    const invocation = await readInvocation(runId);
    if (!invocation) return undefined;
    return (invocation.knowledgeContext?.claims ?? []).map((c) => ({
      id: c.id,
      revision: c.revision,
    }));
  }

  /**
   * Read, validate, preflight and stage the delta a completed run may have
   * written. Sets `step.knowledgeDelta` on the in-memory instance when one
   * was staged, so the transition that follows sees it. Never touches the
   * ledger: `preflightKnowledgeDeltas` is a dry run against the current
   * snapshot, there so a proposal that is already refusable — an unknown
   * revision, a precondition that no longer holds, a cycle — fails the step
   * at once rather than after a gate has waited on a person. The proposal is
   * checked again, against the snapshot of that moment, at commit.
   */
  async function intakeKnowledgeDelta(
    def: PipelineDefinition,
    inst: PipelineInstance,
    phaseId: string,
    runId: string,
    /** The semantic half of a ChangeProposal (Phase 7), when this run is a
     *  change-intent run. Supplied instead of the agent's delta file, which a
     *  change-intent run may not write: one run, one account of what it
     *  proposes. */
    provided?: KnowledgeDelta,
  ): Promise<Intake> {
    const phase = inst.phases.find((p) => p.id === phaseId);
    const step = phase?.steps.find((s) => s.runId === runId);
    if (!phase || !step) return { ok: true, staged: null };
    const at = nowISO();

    // Staged already (a restart between the record write and the instance
    // write): the record decides, exactly as it did the first time.
    const existing = await readDeltaRecord(runId);
    if (existing && existing.attempt === phase.attempt) {
      if (existing.status === "rejected") {
        return {
          ok: false,
          reason: existing.reason ?? "KnowledgeDelta was rejected",
          failure: "knowledge-delta",
        };
      }
      step.knowledgeDelta = { id: existing.id, status: existing.status };
      return { ok: true, staged: step.knowledgeDelta };
    }

    const file = await readAgentDelta(runId);
    if (provided === undefined && file.kind === "none") return { ok: true, staged: null };

    // What Argus supplied to this run ({@link suppliedFor}). Copied onto the
    // staged record so the commit can classify each consumed entry as
    // supplied or agent-discovered (ClaimConsumption.source), and so the two
    // lists sit side by side for a reader. Absent (not empty) = unknown, and
    // every consumption is then recorded without a `source`.
    const supplied = await suppliedFor(runId);

    const base: Omit<KnowledgeDeltaRecord, "status"> = {
      id: `KD-${deps.newId()}`,
      runId,
      instanceId: inst.id,
      phaseId,
      attempt: phase.attempt,
      step: step.name,
      receivedAt: at,
      updatedAt: at,
      ...(supplied !== undefined ? { supplied } : {}),
    };
    const reject = async (
      reason: string,
      delta?: KnowledgeDeltaRecord["delta"],
    ): Promise<Intake> => {
      const full = `KnowledgeDelta rejected: ${reason}`;
      await writeDeltaRecord({
        ...base,
        status: "rejected",
        reason: full,
        ...(delta ? { delta } : {}),
      });
      void journal(inst.id, {
        at,
        kind: "knowledge.rejected",
        phaseId,
        runId,
        attempt: phase.attempt,
        detail: `${base.id}: ${reason}`,
      });
      return { ok: false, reason: full, failure: "knowledge-delta" };
    };

    let delta: KnowledgeDeltaRecord["delta"];
    if (provided !== undefined) {
      // A change-intent run proposes semantics only through its proposal. A
      // delta file beside it would be a second, unreviewed account of what the
      // change means, so it refuses the step rather than being ignored.
      if (file.kind !== "none") {
        return reject(
          "this is a change-intent run: propose semantics through the ChangeProposal's " +
            "semanticDelta, not through a separate KnowledgeDelta file",
        );
      }
      delta = provided;
    } else {
      if (file.kind === "none") return { ok: true, staged: null };
      if (file.kind === "unreadable") return reject(file.reason);
      try {
        delta = parseKnowledgeDelta(file.text);
      } catch (e) {
        return reject(
          e instanceof KnowledgeDeltaError
            ? `${e.code}: ${e.message}`
            : e instanceof Error
              ? e.message
              : String(e),
        );
      }
    }
    // A document that proposes nothing is the same as no document.
    if (isEmptyDelta(delta)) return { ok: true, staged: null };

    // Artifacts the agent claims to have produced must exist where the run
    // could have produced them — its artifact directory, or its working tree.
    // Checked now, while the worktree the run used still exists, and again at
    // the commit boundary, so nothing that vanished in between is recorded.
    const missing = await verifyDeltaArtifacts(def, phase, runId, delta);
    if (missing) return reject(missing, delta);

    // Business-rule discovery (Phase 5): the deterministic half of the
    // discovery contract. Every business rule must carry evidence, and every
    // source-code evidence path must be safe, in the declared scope, at the
    // commit Argus recorded for this run, and actually there. Fail-closed:
    // a rule nobody can go and check is worse than no rule. What the checks
    // deliberately do NOT decide is whether the rule the agent read out of
    // the code is the rule the business has — that is what the gate is for.
    const phaseDef = def.phases.find((pd) => pd.id === phaseId);

    // Business-rule verification (Phase 6): the one thing a verification
    // phase's delta may not do is express "the code is in breach" as doubt
    // about the rule. Structural and narrow — opposing evidence or an
    // opposing justification aimed at one of the exact rules this run was
    // supplied to verify — and it closes the single path by which a failing
    // test could turn a supported rule `contested`.
    if (phaseDef?.ruleVerification) {
      const contamination = verificationDeltaRefusal(
        delta,
        selectedRules(await readLedger(), supplied, phaseDef.ruleVerification),
      );
      if (contamination) return reject(contamination, delta);
    }

    if (phaseDef?.discovery) {
      const verdict = await checkDiscoveryDelta(
        delta,
        await readLedger(),
        await discoveryContextFor(def, phase, runId, phaseDef.discovery),
        supplied,
      );
      if (verdict.refusal) return reject(verdict.refusal, delta);
    }

    const proposal: DeltaProposal = {
      id: base.id,
      delta,
      execution: { runId, instanceId: inst.id, phaseId },
      attempt: phase.attempt,
      ...(supplied !== undefined ? { supplied } : {}),
      // The scope the attempt froze at planning, never one re-derived now: a
      // delta is judged against the ownership its run was launched under.
      ...(phase.knowledgeScope ? { scope: phase.knowledgeScope } : {}),
      ...(phase.knowledgeAlsoRead ? { alsoRead: phase.knowledgeAlsoRead } : {}),
    };
    try {
      await preflightKnowledgeDeltas([proposal], deps.now());
    } catch (e) {
      return reject(
        e instanceof KnowledgeDeltaError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e),
        delta,
      );
    }
    await writeDeltaRecord({ ...base, status: "staged", delta });
    step.knowledgeDelta = { id: base.id, status: "staged" };
    if (phaseDef?.discovery) await refreshDiscoverySummary(def, phase);
    void journal(inst.id, {
      at,
      kind: "knowledge.staged",
      phaseId,
      runId,
      attempt: phase.attempt,
      detail: `${base.id}: ${describeDelta(delta)}`,
    });
    return { ok: true, staged: step.knowledgeDelta };
  }

  /**
   * What a discovery check needs to know about the run: the tree it worked in
   * and the commit Argus recorded for it.
   *
   * Read from the invocation record, with the phase definition as the
   * fallback — the same precedence {@link verifyDeltaArtifacts} uses for the
   * `repository` root, and for the same reason: the record is what the run
   * actually got, the definition is only where it would have gone. A run with
   * no recorded head leaves `gitHead` null, which makes an agent-supplied
   * commit unverifiable rather than wrong: Argus refuses what it can
   * disprove, never what it merely cannot confirm.
   */
  async function discoveryContextFor(
    def: PipelineDefinition,
    phase: PhaseProgress,
    runId: string,
    policy: NonNullable<PhaseDef["discovery"]>,
  ): Promise<DiscoveryContext> {
    const invocation = await readInvocation(runId);
    const phaseDef = def.phases.find((p) => p.id === phase.id);
    return {
      policy,
      repoRoot: invocation?.workspace?.path ?? invocation?.cwd ?? phaseDef?.cwd ?? null,
      gitHead: invocation?.gitHead ?? null,
    };
  }

  /**
   * Recompute a discovery phase's {@link DiscoverySummary} from the attempt's
   * staged deltas (Phase 5 §17).
   *
   * Counts only — routing, status and observability. The candidates
   * themselves stay in the staged KnowledgeDelta, which is the one
   * authoritative form of the proposal; duplicating them onto the instance
   * would create a second copy that could drift from it.
   *
   * `requiresReview` is true exactly while the candidates are not canonical,
   * so the board can say "4 candidates, waiting on you" and then "4
   * candidates, committed" without anyone reading the ledger.
   */
  async function refreshDiscoverySummary(
    def: PipelineDefinition,
    phase: PhaseProgress,
  ): Promise<void> {
    const ledger = await readLedger();
    const previews = [];
    const deltas = [];
    for (const step of phase.steps) {
      if (!step.runId || !step.knowledgeDelta) continue;
      const record = await readDeltaRecord(step.runId);
      if (!record?.delta || record.attempt !== phase.attempt) continue;
      const phaseDef = def.phases.find((p) => p.id === phase.id);
      const warnings = phaseDef?.discovery
        ? (
            await checkDiscoveryDelta(
              record.delta,
              ledger,
              await discoveryContextFor(def, phase, step.runId, phaseDef.discovery),
              record.supplied,
            )
          ).warnings
        : undefined;
      previews.push(previewKnowledgeDelta(record, ledger, warnings));
      deltas.push(record.delta);
    }
    phase.discovery = summarizeDiscovery(
      previews,
      deltas,
      phase.knowledge?.status !== "applied" && previews.some((p) => p.status === "staged"),
    );
  }

  // ── Rule verification (Phase 6) ────────────────────────────────────────────
  //
  // The same three moments as a KnowledgeDelta, on their own channel:
  //
  //   intake   — a verification run completed; its report is read, validated
  //              against the rules Argus supplied it, and staged beside the
  //              run (or refused, failing the step under `rule-verification`);
  //   commit   — the phase crossed every acceptance condition; every staged
  //              proposal of *this attempt* is written into `knowledge.json`
  //              in the same transition as the attempt's deltas, or none is;
  //   retire   — an attempt failed, was revised, was aborted, or lost a
  //              selection; its staged proposals are superseded and can never
  //              become durable.
  //
  // What a verification never does, at any of the three: touch claim support.

  /** What a verification check needs to know about the run: the rules it was
   *  accountable for, the tree it worked in, the commit Argus recorded for it,
   *  and the checks its phase declares. */
  async function verificationContextFor(
    def: PipelineDefinition,
    phase: PhaseProgress,
    runId: string,
    policy: NonNullable<PhaseDef["ruleVerification"]>,
  ): Promise<VerificationContext> {
    const invocation = await readInvocation(runId);
    const phaseDef = def.phases.find((p) => p.id === phase.id);
    const ledger = await readLedger();
    return {
      policy,
      selected: selectedRules(ledger, await suppliedFor(runId), policy),
      repoRoot: invocation?.workspace?.path ?? invocation?.cwd ?? phaseDef?.cwd ?? null,
      gitHead: invocation?.gitHead ?? null,
      checkLabels: declaredCheckLabels(phaseDef?.checks, checkLabel),
    };
  }

  /**
   * Read, validate and stage the conformance results a completed verification
   * run wrote. Sets `step.ruleVerification` on the in-memory instance when one
   * was staged, so the transition that follows sees it. Never touches the
   * ledger.
   *
   * The one asymmetry with a KnowledgeDelta, and it is deliberate: **no file
   * is not "nothing proposed"**. A run supplied rules and asked to verify them
   * has an obligation, so an absent report with a non-empty selection refuses
   * the step rather than letting the phase succeed as though the rules had
   * been considered. A verification phase whose context supplied no rules at
   * all has nothing to answer for, and proceeds.
   */
  async function intakeRuleVerification(
    def: PipelineDefinition,
    inst: PipelineInstance,
    phaseId: string,
    runId: string,
  ): Promise<Intake> {
    const phaseDef = def.phases.find((pd) => pd.id === phaseId);
    const policy = phaseDef?.ruleVerification;
    if (!policy) return { ok: true, staged: null };
    const phase = inst.phases.find((p) => p.id === phaseId);
    const step = phase?.steps.find((sp) => sp.runId === runId);
    if (!phase || !step) return { ok: true, staged: null };
    const at = nowISO();

    // Staged already (a restart between the record write and the instance
    // write): the record decides, exactly as it did the first time.
    const existing = await readVerificationRecord(runId);
    if (existing && existing.attempt === phase.attempt) {
      if (existing.status === "rejected") {
        return {
          ok: false,
          reason: existing.reason ?? "rule verification was rejected",
          failure: "rule-verification",
        };
      }
      step.ruleVerification = { id: existing.id, status: existing.status };
      return { ok: true, staged: null };
    }

    const ctx = await verificationContextFor(def, phase, runId, policy);
    // The exact repository state this run examined, snapshotted at completion
    // (Phase 8). Recorded beside `gitHead` rather than instead of it: the head
    // still answers a head-scoped conformance question, and this answers the
    // stricter one a realization has to ask — *was it this implementation?*
    //
    // Only on a realization's verifier. An ordinary Phase 6 verification phase
    // behaves exactly as it did — no snapshot, no `git` process, no new field
    // on its records — because nothing asks a state-scoped question of it.
    const verifiedState = phaseDef?.acceptanceVerification
      ? repositoryStateFrom(await snapshotWorkingTree(await runCwd(def, phase, runId)))
      : null;
    const base: Omit<RuleVerificationRecord, "status"> = {
      id: `RV-${deps.newId()}`,
      runId,
      instanceId: inst.id,
      phaseId,
      attempt: phase.attempt,
      step: step.name,
      receivedAt: at,
      updatedAt: at,
      selected: ctx.selected,
      ...(ctx.gitHead ? { gitHead: ctx.gitHead } : {}),
      ...(verifiedState ? { repository: verifiedState } : {}),
    };
    const reject = async (
      reason: string,
      report?: RuleVerificationRecord["report"],
    ): Promise<Intake> => {
      const full = `rule verification rejected: ${reason}`;
      await writeVerificationRecord({
        ...base,
        status: "rejected",
        reason: full,
        ...(report ? { report } : {}),
      });
      void journal(inst.id, {
        at,
        kind: "verification.rejected",
        phaseId,
        runId,
        attempt: phase.attempt,
        detail: `${base.id}: ${reason}`,
      });
      return { ok: false, reason: full, failure: "rule-verification" };
    };

    const file = await readAgentVerification(runId);
    if (file.kind === "none") {
      if (ctx.selected.length === 0) return { ok: true, staged: null };
      return reject(
        `this phase supplied ${ctx.selected.length} rule${ctx.selected.length === 1 ? "" : "s"} (${ctx.selected
          .map(formatClaimRef)
          .join(
            ", ",
          )}) but the run wrote no rule-verification file; every selected rule must receive an outcome`,
      );
    }
    if (file.kind === "unreadable") return reject(file.reason);
    let report: RuleVerificationRecord["report"];
    try {
      report = parseRuleVerificationReport(file.text);
    } catch (e) {
      return reject(
        e instanceof RuleVerificationError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e),
      );
    }
    const refusal = await checkRuleVerification(report, await readLedger(), ctx);
    if (refusal) return reject(`${refusal.code}: ${refusal.message}`, report);

    await writeVerificationRecord({ ...base, status: "staged", report });
    step.ruleVerification = { id: base.id, status: "staged" };
    await refreshVerificationSummary(phase);
    void journal(inst.id, {
      at,
      kind: "verification.staged",
      phaseId,
      runId,
      attempt: phase.attempt,
      detail: `${base.id}: ${describeReport(report)}`,
    });
    return { ok: true, staged: null };
  }

  /** Recompute a verification phase's {@link RuleVerificationSummary} from the
   *  attempt's staged records. Counts only; the results themselves stay in the
   *  staged record, which is the one authoritative form of the proposal. */
  async function refreshVerificationSummary(phase: PhaseProgress): Promise<void> {
    const ledger = await readLedger();
    const previews = [];
    for (const step of phase.steps) {
      if (!step.runId || !step.ruleVerification) continue;
      const record = await readVerificationRecord(step.runId);
      if (!record?.report || record.attempt !== phase.attempt) continue;
      previews.push(previewRuleVerification(record, ledger));
    }
    phase.ruleVerification = summarizeRuleVerification(
      previews,
      phase.knowledge?.status !== "applied" && previews.some((p) => p.status === "staged"),
    );
  }

  /**
   * The verification proposals a held phase would commit, resolved into the
   * durable records they become — or a refusal.
   *
   * This is where the agent's citation of a deterministic check meets Argus's
   * own report: every `check` evidence record is bound to the
   * {@link VerificationReport} of the phase (or, on a candidates phase, of the
   * winning step), so `status`, `exitCode` and `detail` come from the run
   * Argus performed rather than from the document the agent wrote. A cited
   * check missing from the report refuses the commit, and under
   * `holds: "deterministic-check"` a `holds` outcome whose checks did not pass
   * refuses it too.
   */
  async function verificationProposalsOf(
    def: PipelineDefinition,
    inst: PipelineInstance,
    phase: PhaseProgress,
  ): Promise<{ ok: true; proposals: VerificationProposal[] } | { ok: false; reason: string }> {
    const wanted = phase.knowledge?.verifications ?? [];
    if (wanted.length === 0) return { ok: true, proposals: [] };
    const policy = def.phases.find((pd) => pd.id === phase.id)?.ruleVerification;
    const proposals: VerificationProposal[] = [];
    for (const step of phase.steps) {
      const id = step.ruleVerification?.id;
      if (!id || !wanted.includes(id) || !step.runId) continue;
      const record = await readVerificationRecord(step.runId);
      if (!record || record.id !== id || !record.report) {
        return { ok: false, reason: `rule verification ${id} is not staged for run ${step.runId}` };
      }
      if (record.attempt !== phase.attempt) {
        return {
          ok: false,
          reason: `rule verification ${id} was staged for attempt ${record.attempt}, not ${phase.attempt}`,
        };
      }
      // The checks Argus actually ran for this attempt: the phase's report,
      // or this candidate's own when the phase ran candidates. A check that
      // was not evaluated substantiates nothing: citing it is unsupported.
      const results = evaluatedChecks((step.verification ?? phase.verification)?.checks);
      for (const v of record.report.verifications) {
        const bound = bindCheckEvidence(v.evidence, results);
        if (bound.missing.length > 0) {
          return {
            ok: false,
            reason: `rule verification ${id}: ${formatClaimRef(v.rule)} cites check${
              bound.missing.length === 1 ? "" : "s"
            } ${bound.missing.map((l) => `"${l}"`).join(", ")}, which this phase's verification report does not contain`,
          };
        }
        const policyRefusal = holdsPolicyRefusal(v.rule, v.outcome, bound.evidence, policy);
        if (policyRefusal) {
          return { ok: false, reason: `rule verification ${id}: ${policyRefusal}` };
        }
        proposals.push({
          execution: { runId: step.runId, instanceId: inst.id, phaseId: phase.id },
          rule: v.rule,
          outcome: v.outcome,
          evidence: bound.evidence,
          attempt: phase.attempt,
          ...(record.gitHead ? { gitHead: record.gitHead } : {}),
          ...(record.repository ? { repositoryState: record.repository } : {}),
          ...(v.reason !== undefined ? { reason: v.reason } : {}),
          ...(v.note !== undefined ? { note: v.note } : {}),
          policy: holdsPolicy(policy),
        });
      }
    }
    return { ok: true, proposals };
  }

  // ── Acceptance verification (Phase 8) ─────────────────────────────────────
  //
  // The same three moments as every other semantic output, on a fourth
  // channel: intake stages what the run wrote, the commit makes it durable in
  // the phase's one ledger transition, and a retired attempt supersedes it.
  //
  // What is deliberately *not* shared with rule verification: the record, the
  // read model, the completeness rule, and the failure class. A criterion is
  // bound to `CP-12/AC-1` and a rule to a `ClaimRef`, and "every rule holds
  // and AC-3 is violated" must remain something Argus can say.

  /** What an acceptance check needs to know about the run that wrote the
   *  report: which accepted change it answers for, every criterion of it, and
   *  the run's own world. */
  async function acceptanceContextFor(
    def: PipelineDefinition,
    phase: PhaseProgress,
    runId: string,
    policy: NonNullable<PhaseDef["acceptanceVerification"]>,
    proposalId: string,
  ): Promise<AcceptanceContext> {
    const invocation = await readInvocation(runId);
    const phaseDef = def.phases.find((p) => p.id === phase.id);
    const ledger = await readLedger();
    const proposal = changeProposalById(ledger, proposalId);
    return {
      policy,
      proposalId,
      required: proposal?.acceptanceCriteria ?? [],
      repoRoot: invocation?.workspace?.path ?? invocation?.cwd ?? phaseDef?.cwd ?? null,
      gitHead: invocation?.gitHead ?? null,
      checkLabels: acceptanceCheckLabels(phaseDef?.checks, checkLabel),
    };
  }

  /**
   * Which accepted proposal a run was answering for, read back from the
   * ChangeContext Argus materialized for it.
   *
   * Deliberately read from that file rather than re-resolved from the ledger:
   * the file *is* the record of what this run was given, it survives a restart
   * between the launch and the completion, and re-resolving would let a
   * proposal accepted while the agent ran retarget a finished run.
   */
  async function acceptanceProposalOf(runId: string): Promise<string | null> {
    const invocation = await readInvocation(runId);
    const file = invocation?.changeContextFile ?? changeContextFile(runId);
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as { proposalId?: string };
      return typeof parsed.proposalId === "string" ? parsed.proposalId : null;
    } catch {
      return null;
    }
  }

  /**
   * Read, validate and stage the acceptance results a completed run wrote.
   *
   * The same asymmetry with a KnowledgeDelta as a verification report has:
   * **no file is not "nothing proposed"**. A run given an accepted change with
   * criteria has an obligation to answer them, so an absent report refuses the
   * step rather than letting the phase succeed as though the criteria had been
   * considered. A proposal that declares no criteria has nothing to answer.
   */
  async function intakeAcceptance(
    def: PipelineDefinition,
    inst: PipelineInstance,
    phaseId: string,
    runId: string,
  ): Promise<Intake> {
    const phaseDef = def.phases.find((pd) => pd.id === phaseId);
    const policy = phaseDef?.acceptanceVerification;
    if (!policy) return { ok: true, staged: null };
    const phase = inst.phases.find((p) => p.id === phaseId);
    const step = phase?.steps.find((sp) => sp.runId === runId);
    if (!phase || !step) return { ok: true, staged: null };
    const at = nowISO();

    const existing = await readAcceptanceRecord(runId);
    if (existing && existing.attempt === phase.attempt) {
      if (existing.status === "rejected") {
        return {
          ok: false,
          reason: existing.reason ?? "acceptance verification was rejected",
          failure: "acceptance-verification",
        };
      }
      step.acceptanceVerification = { id: existing.id, status: existing.status };
      return { ok: true, staged: null };
    }

    const proposalId = await acceptanceProposalOf(runId);
    if (!proposalId) {
      return {
        ok: false,
        reason:
          "acceptance verification rejected: this phase declares acceptanceVerification but the run received no ChangeContext naming an accepted change to answer for",
        failure: "acceptance-verification",
      };
    }
    const ctx = await acceptanceContextFor(def, phase, runId, policy, proposalId);
    const state = repositoryStateFrom(await snapshotWorkingTree(await runCwd(def, phase, runId)));
    const base: Omit<AcceptanceVerificationRecord, "status"> = {
      id: `AVR-${deps.newId()}`,
      runId,
      instanceId: inst.id,
      phaseId,
      attempt: phase.attempt,
      step: step.name,
      receivedAt: at,
      updatedAt: at,
      proposalId,
      required: ctx.required,
      ...(state ? { repository: state } : {}),
    };
    const reject = async (
      reason: string,
      report?: AcceptanceVerificationRecord["report"],
    ): Promise<Intake> => {
      const full = `acceptance verification rejected: ${reason}`;
      await writeAcceptanceRecord({
        ...base,
        status: "rejected",
        reason: full,
        ...(report ? { report } : {}),
      });
      void journal(inst.id, {
        at,
        kind: "acceptance.rejected",
        phaseId,
        runId,
        attempt: phase.attempt,
        detail: `${base.id}: ${reason}`,
      });
      return { ok: false, reason: full, failure: "acceptance-verification" };
    };

    const file = await readAgentAcceptance(runId);
    if (file.kind === "none") {
      if (ctx.required.length === 0) return { ok: true, staged: null };
      return reject(
        `the accepted change ${proposalId} declares ${ctx.required.length} acceptance criteri${
          ctx.required.length === 1 ? "on" : "a"
        } (${ctx.required.map((c) => c.id).join(", ")}) but the run wrote no acceptance-verification file; every one must receive an outcome`,
      );
    }
    if (file.kind === "unreadable") return reject(file.reason);
    let report: AcceptanceVerificationRecord["report"];
    try {
      report = parseAcceptanceReport(file.text);
    } catch (e) {
      return reject(
        e instanceof AcceptanceVerificationError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e),
      );
    }
    const refusal = await checkAcceptanceReport(report, ctx);
    if (refusal) return reject(`${refusal.code}: ${refusal.message}`, report);

    await writeAcceptanceRecord({ ...base, status: "staged", report });
    step.acceptanceVerification = { id: base.id, status: "staged" };
    await refreshAcceptanceSummary(phase, proposalId);
    void journal(inst.id, {
      at,
      kind: "acceptance.staged",
      phaseId,
      runId,
      attempt: phase.attempt,
      detail: `${base.id}: ${describeAcceptanceReport(report)} @ ${formatRepositoryState(state ?? undefined)}`,
    });
    return { ok: true, staged: null };
  }

  /** Where one run's work actually happened: its worktree, else the phase's
   *  own directory. The tree a repository-state snapshot must be taken of. */
  async function runCwd(
    def: PipelineDefinition,
    phase: PhaseProgress,
    runId: string,
  ): Promise<string> {
    const invocation = await readInvocation(runId);
    return (
      invocation?.workspace?.path ??
      invocation?.cwd ??
      phase.workspace?.path ??
      def.phases.find((p) => p.id === phase.id)?.cwd ??
      process.cwd()
    );
  }

  /** Recompute an acceptance phase's summary from the attempt's staged
   *  records. Counts only; the results stay in the staged record. */
  async function refreshAcceptanceSummary(phase: PhaseProgress, proposalId: string): Promise<void> {
    const previews = [];
    for (const step of phase.steps) {
      if (!step.runId || !step.acceptanceVerification) continue;
      const record = await readAcceptanceRecord(step.runId);
      if (!record?.report || record.attempt !== phase.attempt) continue;
      previews.push(previewAcceptance(record));
    }
    phase.acceptanceVerification = summarizeAcceptance(
      proposalId,
      previews,
      phase.knowledge?.status !== "applied" && previews.some((p) => p.status === "staged"),
    );
  }

  /**
   * The acceptance proposals a held phase would commit, resolved into the
   * durable records they become — or a refusal.
   *
   * This is where an agent's citation of a deterministic check meets Argus's
   * own report, exactly as it does for rule verification: every `check`
   * evidence record is bound to the phase's {@link VerificationReport}, and a
   * `satisfied` outcome citing a check Argus observed **failing** refuses the
   * commit. An agent can cite a test; it cannot claim one passed.
   */
  async function acceptanceProposalsOf(
    inst: PipelineInstance,
    phase: PhaseProgress,
  ): Promise<{ ok: true; proposals: AcceptanceProposal[] } | { ok: false; reason: string }> {
    const wanted = phase.knowledge?.acceptanceVerifications ?? [];
    if (wanted.length === 0) return { ok: true, proposals: [] };
    const ledger = await readLedger();
    const proposals: AcceptanceProposal[] = [];
    for (const step of phase.steps) {
      const id = step.acceptanceVerification?.id;
      if (!id || !wanted.includes(id) || !step.runId) continue;
      const record = await readAcceptanceRecord(step.runId);
      if (!record || record.id !== id || !record.report) {
        return {
          ok: false,
          reason: `acceptance verification ${id} is not staged for run ${step.runId}`,
        };
      }
      if (record.attempt !== phase.attempt) {
        return {
          ok: false,
          reason: `acceptance verification ${id} was staged for attempt ${record.attempt}, not ${phase.attempt}`,
        };
      }
      const missingProposal = acceptanceProposalMissing(ledger, record.proposalId);
      if (missingProposal) {
        return { ok: false, reason: `acceptance verification ${id}: ${missingProposal}` };
      }
      const results = evaluatedChecks((step.verification ?? phase.verification)?.checks);
      for (const c of record.report.criteria) {
        const bound = bindAcceptanceChecks(c.evidence, results);
        if (bound.missing.length > 0) {
          return {
            ok: false,
            reason: `acceptance verification ${id}: ${formatCriterionRef(
              record.proposalId,
              c.criterionId,
            )} cites check${bound.missing.length === 1 ? "" : "s"} ${bound.missing
              .map((l) => `"${l}"`)
              .join(", ")}, which this phase's verification report does not contain`,
          };
        }
        const forged = acceptanceCheckRefusal(
          record.proposalId,
          c.criterionId,
          c.outcome,
          bound.evidence,
        );
        if (forged) return { ok: false, reason: `acceptance verification ${id}: ${forged}` };
        proposals.push({
          proposalId: record.proposalId,
          criterionId: c.criterionId,
          outcome: c.outcome,
          execution: { runId: step.runId, instanceId: inst.id, phaseId: phase.id },
          evidence: bound.evidence,
          attempt: phase.attempt,
          ...(record.repository ? { repository: record.repository } : {}),
          ...(c.reason !== undefined ? { reason: c.reason } : {}),
          ...(c.note !== undefined ? { note: c.note } : {}),
        });
      }
    }
    return { ok: true, proposals };
  }

  /**
   * The deterministic facts Argus can establish about the artifacts a delta
   * declares: that the run *has* the root the location names (its artifact
   * directory; its worktree or working directory), that the path stays inside
   * that root, and that something exists there. Nothing about contents — the
   * agent's claim about what the file *is* stays the agent's.
   *
   * Run at intake and again at commit, against the same roots (the invocation
   * record's, which do not change between the two). A staged delta whose
   * artifact was removed while checks ran or a gate waited is refused at the
   * commit boundary rather than persisted as provenance for a file that is not
   * there. Returns the refusal, or null when every artifact still holds.
   */
  async function verifyDeltaArtifacts(
    def: PipelineDefinition,
    phase: PhaseProgress,
    runId: string,
    delta: NonNullable<KnowledgeDeltaRecord["delta"]>,
  ): Promise<string | null> {
    if (!delta.artifacts?.length) return null;
    const invocation = await readInvocation(runId);
    const phaseDef = def.phases.find((p) => p.id === phase.id);
    const roots = {
      "artifact-dir": invocation?.artifactDir ?? phase.artifactDir ?? null,
      repository: invocation?.workspace?.path ?? invocation?.cwd ?? phaseDef?.cwd ?? null,
    };
    for (const a of delta.artifacts) {
      const root = roots[a.location];
      if (!root) return `artifact ${a.location}:${a.path}: the run has no ${a.location}`;
      // The same containment rule the ledger enforces on write, applied to
      // the resolved path as well as the declared one: a path that escapes its
      // root is refused here even if the declared form slipped past validation.
      const resolvedRoot = path.resolve(root);
      const resolved = path.resolve(resolvedRoot, ...a.path.split("/"));
      if (
        !validArtifactPath(a.path) ||
        (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep))
      ) {
        return `artifact ${a.location}:${a.path} is not inside the run's ${a.location}`;
      }
      try {
        await stat(resolved);
      } catch {
        return `artifact ${a.location}:${a.path} does not exist in the run's ${a.location}`;
      }
    }
    return null;
  }

  function describeDelta(delta: NonNullable<KnowledgeDeltaRecord["delta"]>): string {
    const parts = [
      [delta.claims?.length ?? 0, "claim"],
      [delta.revisions?.length ?? 0, "revision"],
      [delta.evidence?.length ?? 0, "evidence"],
      [delta.justifications?.length ?? 0, "justification"],
      [delta.consumed?.length ?? 0, "consumed"],
      [delta.artifacts?.length ?? 0, "artifact"],
    ] as const;
    return parts
      .filter(([n]) => n > 0)
      .map(
        ([n, what]) =>
          `${n} ${what}${n === 1 || what === "evidence" || what === "consumed" ? "" : "s"}`,
      )
      .join(", ");
  }

  /**
   * What the run was actually given, read back from the document Argus
   * materialized for it (`ARGUS_CHANGE_REQUEST_FILE`).
   *
   * Deliberately read from the file rather than recomputed from the definition:
   * that file *is* the record of what this run was asked, frozen at launch, and
   * it survives a restart between the launch and the completion. Recomputing it
   * would let a pipeline edited mid-flight change what a finished run is held
   * to.
   */
  async function changeIntentOf(
    runId: string,
  ): Promise<{ request: ChangeRequest; selected: ClaimRef[]; gitHead: string | null } | null> {
    const invocation = await readInvocation(runId);
    const file = invocation?.changeRequestFile ?? changeRequestFile(runId);
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as {
        schemaVersion?: number;
        request?: ChangeRequest;
        relevant?: ChangeRuleState[];
        gitHead?: string;
      };
      if (parsed.schemaVersion !== 1 || !parsed.request) return null;
      return {
        request: parsed.request,
        selected: (parsed.relevant ?? []).map((r) => r.claim),
        gitHead: parsed.gitHead ?? null,
      };
    } catch {
      return null;
    }
  }

  /**
   * Read, validate and stage the ChangeProposal a completed change-intent run
   * wrote. Sets `step.changeProposal` on the in-memory instance when one was
   * staged, so the transition that follows sees it. Never touches the ledger.
   *
   * The same asymmetry with a KnowledgeDelta as a verification report has, and
   * it is deliberate: **no file is not "nothing proposed"**. A run given an
   * explicit requested change has an obligation to answer it, so an absent
   * proposal refuses the step rather than letting the phase succeed as though
   * the change had been considered.
   */
  async function intakeChangeProposal(
    def: PipelineDefinition,
    inst: PipelineInstance,
    phaseId: string,
    runId: string,
  ): Promise<ProposalIntake> {
    const phaseDef = def.phases.find((pd) => pd.id === phaseId);
    const policy = phaseDef?.changeIntent;
    if (!policy) return { ok: true };
    const phase = inst.phases.find((p) => p.id === phaseId);
    const step = phase?.steps.find((sp) => sp.runId === runId);
    if (!phase || !step) return { ok: true };
    const at = nowISO();

    // Staged already (a restart between the record write and the instance
    // write): the record decides, exactly as it did the first time.
    const existing = await readProposalRecord(runId);
    if (existing && existing.attempt === phase.attempt) {
      if (existing.status === "rejected") {
        return {
          ok: false,
          reason: existing.reason ?? "the change proposal was rejected",
          failure: "change-proposal",
        };
      }
      step.changeProposal = { id: existing.id, status: existing.status };
      return {
        ok: true,
        semanticDelta: existing.proposal?.semanticDelta ?? { schemaVersion: 1 },
        recordRunId: runId,
      };
    }

    const given = await changeIntentOf(runId);
    const supplied = await suppliedFor(runId);
    const base: Omit<ChangeProposalRecord, "status" | "request" | "selected"> = {
      id: `CP-${deps.newId()}`,
      runId,
      instanceId: inst.id,
      phaseId,
      attempt: phase.attempt,
      step: step.name,
      receivedAt: at,
      updatedAt: at,
      ...(supplied !== undefined ? { supplied } : {}),
      ...(given?.gitHead ? { gitHead: given.gitHead } : {}),
    };
    const reject = async (
      reason: string,
      extra: Partial<ChangeProposalRecord> = {},
    ): Promise<ProposalIntake> => {
      const full = `change proposal rejected: ${reason}`;
      await writeProposalRecord({
        ...base,
        request: given?.request ?? { id: "CR-unknown", summary: "(unrecorded)" },
        selected: given?.selected ?? [],
        status: "rejected",
        reason: full,
        ...extra,
      });
      void journal(inst.id, {
        at,
        kind: "change.rejected",
        phaseId,
        runId,
        attempt: phase.attempt,
        detail: `${base.id}: ${reason}`,
      });
      return { ok: false, reason: full, failure: "change-proposal" };
    };

    // Argus cannot hold a run to a request it cannot read back. Refusing is
    // the only honest option: accepting would credit the proposal with
    // answering whatever the definition says *now*.
    if (!given) {
      return reject(
        `the change-intent input Argus materialized for run ${runId} could not be read back, so what this run was asked cannot be established`,
      );
    }

    const file = await readAgentProposal(runId);
    if (file.kind === "none") {
      return reject(
        `the run wrote no change proposal; a change-intent phase must answer the requested change "${given.request.summary}" with a structured proposal`,
      );
    }
    if (file.kind === "unreadable") return reject(file.reason);
    let proposal: ChangeProposalRecord["proposal"];
    try {
      proposal = parseChangeProposal(file.text);
    } catch (e) {
      return reject(
        e instanceof ChangeProposalError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e),
      );
    }

    const ctx: ChangeIntentContext = {
      policy,
      request: given.request,
      selected: given.selected,
      gitHead: given.gitHead,
    };
    const verdict = checkChangeProposal(proposal, await readLedger(), ctx);
    if (verdict.refusal) {
      return reject(`${verdict.refusal.code}: ${verdict.refusal.message}`, { proposal });
    }

    await writeProposalRecord({
      ...base,
      request: given.request,
      selected: given.selected,
      status: "staged",
      proposal,
      readiness: verdict.readiness,
    });
    step.changeProposal = { id: base.id, status: "staged" };
    void journal(inst.id, {
      at,
      kind: "change.staged",
      phaseId,
      runId,
      attempt: phase.attempt,
      detail: `${base.id}: ${describeChangeProposal(proposal)} (${verdict.readiness})`,
    });
    return {
      ok: true,
      semanticDelta: proposal.semanticDelta ?? { schemaVersion: 1 },
      recordRunId: runId,
    };
  }

  /**
   * Bind the staged proposal to the staged delta that carries its semantic
   * half, and recompute the phase's summary.
   *
   * The two records are written separately — the delta by the Phase 3 intake,
   * the proposal by Phase 7's — and this is what ties them together, so the
   * commit knows which apply result to resolve the proposal's local references
   * against. A proposal whose semantic delta was empty gets no `deltaId`, which
   * is the honest record of a change that proposed no canonical mutation.
   */
  async function bindProposalDelta(
    def: PipelineDefinition,
    inst: PipelineInstance,
    phaseId: string,
    runId: string,
    deltaId: string | undefined,
  ): Promise<void> {
    const record = await readProposalRecord(runId);
    if (record && record.status === "staged" && record.deltaId !== deltaId) {
      await writeProposalRecord({
        ...record,
        ...(deltaId ? { deltaId } : {}),
        updatedAt: nowISO(),
      });
    }
    const phase = inst.phases.find((p) => p.id === phaseId);
    if (phase) await refreshChangeIntentSummary(def, phase);
  }

  /** Recompute a change-intent phase's {@link ChangeIntentSummary} from the
   *  attempt's staged proposal. Counts only; the proposal itself stays in the
   *  staged record, which is the one authoritative form of it. */
  async function refreshChangeIntentSummary(
    def: PipelineDefinition,
    phase: PhaseProgress,
  ): Promise<void> {
    const phaseDef = def.phases.find((p) => p.id === phase.id);
    const ledger = await readLedger();
    let preview = null;
    let staged = false;
    for (const step of phase.steps) {
      if (!step.runId || !step.changeProposal) continue;
      const record = await readProposalRecord(step.runId);
      if (!record?.proposal || record.attempt !== phase.attempt) continue;
      const deltaRecord = record.deltaId ? await readDeltaRecord(step.runId) : null;
      preview = previewChangeProposal(
        record,
        ledger,
        deltaRecord?.id === record.deltaId ? deltaRecord : null,
        phaseDef?.changeIntent,
      );
      staged = record.status === "staged";
    }
    const summary = summarizeChangeIntent(preview, phase.knowledge?.status !== "applied" && staged);
    if (summary) phase.changeIntent = summary;
  }

  /**
   * The change proposals a held phase would accept, resolved into the durable
   * records they become — or a refusal.
   *
   * Everything here was already decided at intake; what is gathered now is the
   * material the ledger transition needs, and the one thing that can still have
   * changed: a staged record that belongs to another attempt, or is no longer
   * staged at all.
   */
  async function changeAcceptancesOf(
    inst: PipelineInstance,
    phase: PhaseProgress,
  ): Promise<
    { ok: true; acceptances: ChangeProposalAcceptance[] } | { ok: false; reason: string }
  > {
    const wanted = phase.knowledge?.changeProposals ?? [];
    if (wanted.length === 0) return { ok: true, acceptances: [] };
    const acceptances: ChangeProposalAcceptance[] = [];
    for (const step of phase.steps) {
      const id = step.changeProposal?.id;
      if (!id || !wanted.includes(id) || !step.runId) continue;
      const record = await readProposalRecord(step.runId);
      if (!record || record.id !== id || !record.proposal) {
        return { ok: false, reason: `change proposal ${id} is not staged for run ${step.runId}` };
      }
      if (record.attempt !== phase.attempt) {
        return {
          ok: false,
          reason: `change proposal ${id} was staged for attempt ${record.attempt}, not ${phase.attempt}`,
        };
      }
      acceptances.push({
        id,
        request: record.request,
        execution: { runId: step.runId, instanceId: inst.id, phaseId: phase.id },
        attempt: phase.attempt,
        ...(record.deltaId ? { deltaId: record.deltaId } : {}),
        readiness: record.readiness ?? "needs-input",
        preserved: record.proposal.preserved ?? [],
        acceptanceCriteria: record.proposal.acceptanceCriteria ?? [],
        unresolved: record.proposal.unresolved ?? [],
        classification: record.proposal.classification ?? [],
      });
    }
    return { ok: true, acceptances };
  }

  return {
    liveStep,
    checkContextIntegrity,
    checkSuppliedInputs,
    acceptCompletion,
    suppliedFor,
    intakeKnowledgeDelta,
    discoveryContextFor,
    refreshDiscoverySummary,
    verificationContextFor,
    intakeRuleVerification,
    refreshVerificationSummary,
    verificationProposalsOf,
    acceptanceContextFor,
    acceptanceProposalOf,
    intakeAcceptance,
    runCwd,
    refreshAcceptanceSummary,
    acceptanceProposalsOf,
    verifyDeltaArtifacts,
    describeDelta,
    changeIntentOf,
    intakeChangeProposal,
    bindProposalDelta,
    refreshChangeIntentSummary,
    changeAcceptancesOf,
  };
}

/**
 * The check results that may be bound as knowledge evidence: those Argus
 * actually evaluated. A `not-evaluated` result (a `trajectory` check without
 * the input to decide) neither passed nor failed, so it can substantiate no
 * claim — an agent citing it is citing a check Argus cannot vouch for, and the
 * commit is refused as for any unsubstantiated citation.
 */
function evaluatedChecks(
  checks: CheckResult[] | undefined,
): Array<CheckResult & { status: "passed" | "failed" }> {
  return (checks ?? []).filter(
    (c): c is CheckResult & { status: "passed" | "failed" } =>
      c.status === "passed" || c.status === "failed",
  );
}
