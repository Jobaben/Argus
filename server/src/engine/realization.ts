import { snapshotWorkingTree } from "../harness/verification.js";
import {
  formatClaimRef,
  changeProposalById,
  changeRealizationById,
  changeRealizationOfPhase,
  formatRepositoryState,
  realizationIntentCurrency,
  sameRepositoryState,
} from "../knowledge/kernel.js";
import {
  deriveImplementationScope,
  describeScope,
  implementationScopeText,
} from "../knowledge/implementationScope.js";
import {
  buildRemediationContext,
  evaluateCompletion,
  remediationContextText,
  repositoryStateFrom,
  technicalResultFrom,
  type CompletionVerdict,
} from "../knowledge/realization.js";
import {
  closeRealization,
  openChangeRealization,
  recordRealizationAttempt,
  readLedger,
} from "../knowledge/store.js";
import { applyRemediation } from "../pipelineTransitions.js";
import { resolveNeeds } from "../sources/dag.js";
import { journal } from "../sources/journal.js";
import type {
  AcceptanceVerification,
  ChangeRealization,
  ChangeRealizationAttempt,
  RemediationContext,
  RepositoryStateRef,
  RuleVerification,
  RunExecutionRef,
} from "@argus/contracts";
import type {
  PhaseDef,
  PhaseFailurePayload,
  PhaseProgress,
  PipelineDefinition,
  PipelineInstance,
} from "../sources/pipelineTypes.js";
import type { TransitionResult } from "../pipelineTransitions.js";
import { log } from "../log.js";
import type { PlannedChangeContext, PlannedRealization } from "./types.js";
import {
  DEFAULT_REALIZATION_ATTEMPTS,
  REALIZATION_ATTEMPT_CAP,
  TERMINAL_PHASE,
} from "./constants.js";
import type { EngineCore } from "./context.js";

/** Change realization (Phase 8): opening a realization, and closing or remediating it once its halves settle. Moved verbatim from `createEngine`. */
export function createRealization(core: EngineCore) {
  const { deps, nowISO, T } = core.ctx;

  /**
   * A phase the instance has but the definition no longer names. Nothing was
   * spawned for this attempt (its steps carry no runId), so there is nothing
   * to kill; the phase fails under `configuration`, the instance settles, and
   * whatever that makes ready is queued exactly as after any other failure.
   */
  // ── Change realization (Phase 8) ──────────────────────────────────────────
  //
  // The loop the whole phase exists for:
  //
  //   accepted ChangeProposal
  //     ↓ deterministic scope from provenance Argus already holds
  //   implementation run       (KnowledgeContext + ChangeContext + scope)
  //     ↓ Argus's own PhaseChecks
  //   verification run         (RuleVerification + AcceptanceVerification)
  //     ↓ the completion invariant, evaluated from Argus's records alone
  //   succeeded  |  targeted remediation  |  a terminal, explained failure
  //
  // Four separate dimensions decide it and none of them is an agent's word
  // about its own work. `ARGUS_OUTCOME: succeeded` decides one of them.

  /**
   * `${instanceId}:${phaseId}:${attempt}` for every implementation attempt
   * whose repository state this process has already snapshotted. In memory
   * only, and deliberately: it prevents a repeat within one process, and a
   * restart legitimately takes a fresh reading.
   */
  const implementationSnapshots = new Set<string>();

  /**
   * Open (or continue) the realization an implementation phase attempt belongs
   * to, and derive everything its runs receive.
   *
   * Three things refuse the launch here rather than after an agent has run:
   *
   * - **a stale semantic target** — the accepted proposal's revisions are no
   *   longer the domain's active ones, so implementing them would realize
   *   intent the business has already moved past (§preflight). Configurable
   *   off for a deliberately historical operation;
   * - **an exhausted attempt budget** — the loop's bound, checked before the
   *   spawn so an exhausted realization terminates rather than looping;
   * - **an unusable proposal** — no accepted intent resolved at all, which the
   *   `changeContext` error already says.
   */
  async function planRealization(
    def: PipelineDefinition,
    inst: PipelineInstance,
    phaseDef: PhaseDef,
    progress: PhaseProgress,
    changeContext: PlannedChangeContext | null,
    ledger: Awaited<ReturnType<typeof readLedger>> | null,
    now: string,
  ): Promise<PlannedRealization | null> {
    const policy = phaseDef.implementation;
    if (!policy) return null;
    if (!changeContext || "error" in changeContext) {
      // The changeContext error is already the launch refusal; saying it twice
      // would only make the failure reason worse.
      return null;
    }
    if (!ledger) return { error: "change realization: the ledger could not be read" };
    const accepted = changeContext.accepted;
    const maxAttempts = Math.min(
      REALIZATION_ATTEMPT_CAP,
      Math.max(1, policy.maxAttempts ?? DEFAULT_REALIZATION_ATTEMPTS),
    );

    // Preflight: is the intent this proposal carries still the current intent?
    if (policy.requireCurrentIntent !== false) {
      const currency = realizationIntentCurrency(ledger, accepted.semanticChanges);
      if (!currency.current) {
        return {
          error:
            `change realization: the accepted proposal ${accepted.id} targets ` +
            `${currency.superseded.map((x) => formatClaimRef(x.from)).join(", ")}, which ` +
            `${currency.superseded.length === 1 ? "is" : "are"} no longer the active revision` +
            `${currency.superseded.length === 1 ? "" : "s"} (now ` +
            `${currency.superseded.map((x) => formatClaimRef(x.to)).join(", ")}). The domain has ` +
            "moved past this intent; a new change decision is required, not an implementation of " +
            "the old one",
        };
      }
    }

    const existing = changeRealizationOfPhase(ledger, inst.id, phaseDef.id);
    const scope =
      existing?.scope ??
      deriveImplementationScope(ledger, accepted, {
        includePreserved: policy.includePreserved ?? true,
        now,
      });
    // The scope is derived once and frozen on the realization: a remediation
    // realizes the same accepted intent as attempt 1, against the same
    // provenance, and a scope that drifted between attempts would make the
    // history unreadable.
    let realization: ChangeRealization;
    try {
      realization = (
        await openChangeRealization(
          {
            proposalId: accepted.id,
            target: accepted.semanticChanges,
            instanceId: inst.id,
            phaseId: phaseDef.id,
            ...(realizationVerifierOf(def, phaseDef.id)
              ? { verificationPhaseId: realizationVerifierOf(def, phaseDef.id)! }
              : {}),
            maxAttempts,
            scope,
          },
          deps.now(),
        )
      ).realization;
    } catch (e) {
      return { error: `change realization: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (realization.outcome) {
      return {
        error: `change realization ${realization.id} already ended as ${realization.outcome.status}: ${realization.outcome.reason}`,
      };
    }
    const attempt = realization.attempts.length + 1;
    if (attempt > realization.maxAttempts) {
      return {
        error:
          `change realization ${realization.id} has used all ${realization.maxAttempts} configured ` +
          "attempts; autonomous remediation is bounded and this one is exhausted",
      };
    }
    const kind: "implementation" | "remediation" = attempt === 1 ? "implementation" : "remediation";
    let remediation: { context: RemediationContext; text: string } | null = null;
    if (kind === "remediation") {
      const previous = realization.attempts[realization.attempts.length - 1];
      const verdict: CompletionVerdict = {
        outcome: previous.outcome,
        reason: previous.reason ?? previous.outcome,
        ruleResults: previous.ruleResults,
        acceptanceResults: previous.acceptanceResults,
        remediable: true,
      };
      const runs = previous.verification.map((v) => v.runId);
      const context = buildRemediationContext({
        realization,
        proposal: accepted,
        ledger,
        attempt,
        previous: verdict,
        ruleVerifications: ledger.verifications.filter((v) => runs.includes(v.execution.runId)),
        acceptanceVerifications: ledger.acceptanceVerifications.filter((v) =>
          runs.includes(v.execution.runId),
        ),
        now,
      });
      remediation = { context, text: remediationContextText(context) };
    }
    void journal(inst.id, {
      at: now,
      kind: attempt === 1 ? "realization.started" : "realization.remediation-started",
      phaseId: phaseDef.id,
      attempt: progress.attempt,
      detail: `${realization.id} → ${accepted.id} (attempt ${attempt}/${realization.maxAttempts}; ${describeScope(scope)})`,
    });
    return {
      realization,
      attempt,
      kind,
      scope,
      scopeText: implementationScopeText(scope),
      remediation,
    };
  }

  /** The phase that verifies one implementation phase's realization, from the
   *  definition alone: the one whose `acceptanceVerification` names it. */
  function realizationVerifierOf(def: PipelineDefinition, phaseId: string): string | null {
    return (
      def.phases.find((p) => p.acceptanceVerification?.implementationPhase === phaseId)?.id ?? null
    );
  }

  /**
   * Drive every change realization of this instance through whatever the
   * transition just settled (Phase 8).
   *
   * Called immediately after {@link settleKnowledge}, inside the same instance
   * lock, so it sees the phases in exactly the state the transition left them
   * and its own writes are saved with them. Idempotent: an attempt already
   * recorded on the realization is never recorded twice, and a realization
   * that already has an outcome is left alone — so a restart, a reconcile or a
   * second transition in the same window heals rather than duplicating.
   */
  async function settleRealizations(
    def: PipelineDefinition,
    res: TransitionResult,
  ): Promise<TransitionResult> {
    let out = res;
    for (const phaseDef of def.phases) {
      if (!phaseDef.implementation) continue;
      out = await settleRealization(def, out, phaseDef);
    }
    return out;
  }

  /** The phases that must run again for a remediation: the verifier, and every
   *  phase between the implementation and it. Earlier accepted work —
   *  discovery, change intent, the human approval — is historical input and is
   *  never re-run. */
  function realizationPhases(
    def: PipelineDefinition,
    implId: string,
    verifierId: string,
  ): string[] {
    const needs = resolveNeeds(def.phases);
    const ancestors = (id: string): Set<string> => {
      const seen = new Set<string>();
      const queue = [...(needs.get(id) ?? [])];
      while (queue.length) {
        const next = queue.shift()!;
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(...(needs.get(next) ?? []));
      }
      return seen;
    };
    const verifierAncestors = ancestors(verifierId);
    return def.phases
      .map((p) => p.id)
      .filter(
        (id) =>
          id !== implId &&
          (id === verifierId || (verifierAncestors.has(id) && ancestors(id).has(implId))),
      );
  }

  async function settleRealization(
    def: PipelineDefinition,
    res: TransitionResult,
    implPhaseDef: PhaseDef,
  ): Promise<TransitionResult> {
    const inst = res.instance;
    const impl = inst.phases.find((p) => p.id === implPhaseDef.id);
    if (!impl) return res;
    const ledger = await readLedger();
    const link = impl.realization;
    // A phase that ended without carrying its link — an abort, a launch the
    // preflight refused after the realization was opened, a crash between the
    // ledger write and the instance write — must not leave a realization
    // reading `running` forever. It is closed with what actually happened.
    if (!link) {
      const orphan = changeRealizationOfPhase(ledger, inst.id, implPhaseDef.id);
      if (orphan && !orphan.outcome && TERMINAL_PHASE.includes(impl.status)) {
        await closeRealization(orphan.id, {
          status: "failed",
          reason: `the implementation phase ended ${impl.status} without completing an attempt`,
          unmetRules: [],
          unmetCriteria: [],
          completedAt: nowISO(),
        });
      }
      return res;
    }
    const realization = changeRealizationById(ledger, link.id);
    if (!realization || realization.outcome) return res;
    const attempt = realization.attempts.length + 1;
    if (link.attempt !== attempt) return res;
    const proposal = changeProposalById(ledger, realization.proposalId);
    if (!proposal) return res;
    const verifierId = realizationVerifierOf(def, implPhaseDef.id);
    const verifier = verifierId ? inst.phases.find((p) => p.id === verifierId) : undefined;
    const at = nowISO();

    // The implementation's own repository state, taken the moment the phase
    // concludes and before the verification phase is queued — so what the
    // verifier is asked about and what the implementation produced are the
    // same tree, and a verifier that modified it is caught rather than
    // credited.
    //
    // Once per (phase, attempt): a transition may reach here several times
    // while the verification runs, and re-snapshotting would both cost a
    // `git status` each time and, on a tree an agent is still writing to,
    // answer differently. A restart re-snapshots, which is the honest
    // behaviour when the in-memory note is gone.
    let repository = link.repository;
    const snapshotKey = `${inst.id}:${implPhaseDef.id}:${attempt}`;
    if (impl.status === "succeeded" && !repository && !implementationSnapshots.has(snapshotKey)) {
      implementationSnapshots.add(snapshotKey);
      repository =
        repositoryStateFrom(await snapshotWorkingTree(implCwd(def, implPhaseDef, impl))) ??
        undefined;
      impl.realization = { ...link, ...(repository ? { repository } : {}) };
      void journal(inst.id, {
        at,
        kind: "realization.implementation-completed",
        phaseId: implPhaseDef.id,
        attempt: impl.attempt,
        detail: `${realization.id} attempt ${attempt} @ ${formatRepositoryState(repository)}`,
      });
    }

    // Which half, if either, has ended? Every terminal status counts, not just
    // `failed`: an aborted or routed-out phase ends the attempt as surely as a
    // failed one, and leaving the realization `running` would be a completion
    // question nothing would ever answer.
    if (!TERMINAL_PHASE.includes(impl.status)) return res;
    const verifierDone = !verifier || TERMINAL_PHASE.includes(verifier.status);
    if (impl.status === "succeeded" && !verifierDone) return res;

    const runsOf = (phase: PhaseProgress | undefined): RunExecutionRef[] =>
      (phase?.steps ?? []).flatMap((st) =>
        st.runId ? [{ runId: st.runId, instanceId: inst.id, phaseId: phase!.id }] : [],
      );
    const verificationRuns = runsOf(verifier);
    const verificationRunIds = verificationRuns.map((r) => r.runId);
    const ruleVerifications = ledger.verifications.filter((v) =>
      verificationRunIds.includes(v.execution.runId),
    );
    const acceptanceVerifications = ledger.acceptanceVerifications.filter((v) =>
      verificationRunIds.includes(v.execution.runId),
    );
    const verificationState = await verifiedRepositoryState(
      ruleVerifications,
      acceptanceVerifications,
    );

    const implementation: "succeeded" | "failed" | "blocked" =
      impl.status !== "succeeded"
        ? isBlocker(impl)
          ? "blocked"
          : "failed"
        : verifier && verifier.status !== "succeeded"
          ? "failed"
          : "succeeded";
    const verdict = evaluateCompletion({
      ledger,
      proposal,
      implementation,
      ...(technicalResultFrom([impl.verification, verifier?.verification])
        ? { technical: technicalResultFrom([impl.verification, verifier?.verification])! }
        : {}),
      implementationState: impl.status === "succeeded" ? (repository ?? null) : null,
      verificationState: impl.status === "succeeded" ? verificationState : null,
      ruleVerifications,
      acceptanceVerifications,
      ...(def.phases.find((p) => p.id === verifierId)?.acceptanceVerification
        ? {
            acceptancePolicy: def.phases.find((p) => p.id === verifierId)!.acceptanceVerification!,
          }
        : {}),
    });

    // The last precondition, and the one §stale intent exists for: the
    // implementation may be perfect and the business may have moved on while
    // it ran. The attempt's results stay historically true about the exact
    // revisions they named; what may not happen is presenting the realization
    // as *current* completion.
    const currency = realizationIntentCurrency(ledger, realization.target);
    const outcome = currency.current ? verdict.outcome : "stale-intent";
    const reason = currency.current
      ? verdict.reason
      : `the semantic target moved while this realization ran: ${currency.superseded
          .map((x) => `${formatClaimRef(x.from)} → ${formatClaimRef(x.to)}`)
          .join(
            ", ",
          )}. The implementation's own results stand for the revisions they named; this realization is not current completion`;

    const record: ChangeRealizationAttempt = {
      attempt,
      kind: link.kind,
      implementation: runsOf(impl),
      verification: verificationRuns,
      ...(repository ? { repository } : {}),
      ...(technicalResultFrom([impl.verification, verifier?.verification])
        ? { technical: technicalResultFrom([impl.verification, verifier?.verification])! }
        : {}),
      ruleResults: verdict.ruleResults,
      acceptanceResults: verdict.acceptanceResults,
      outcome,
      reason,
      startedAt: realization.createdAt,
      endedAt: at,
    };
    try {
      await recordRealizationAttempt(realization.id, record);
    } catch (e) {
      log.error("realization attempt could not be recorded", {
        instanceId: inst.id,
        realizationId: realization.id,
        err: e,
      });
      return res;
    }
    if (verifier) {
      void journal(inst.id, {
        at,
        kind: "realization.verification-completed",
        phaseId: verifier.id,
        attempt: verifier.attempt,
        detail: `${realization.id} attempt ${attempt}: ${outcome} — ${reason}`,
      });
    }

    // ── Succeeded ────────────────────────────────────────────────────────────
    if (outcome === "succeeded") {
      await closeRealization(realization.id, {
        status: "succeeded",
        ...(repository ? { repository } : {}),
        reason,
        unmetRules: [],
        unmetCriteria: [],
        completedAt: at,
      });
      void journal(inst.id, {
        at,
        kind: "realization.succeeded",
        phaseId: implPhaseDef.id,
        detail: `${realization.id} → ${proposal.id} @ ${formatRepositoryState(repository)} after ${attempt} attempt${attempt === 1 ? "" : "s"}`,
      });
      return res;
    }

    const unmetRules = verdict.ruleResults.filter((r) => r.outcome !== "holds");
    const unmetCriteria = verdict.acceptanceResults.filter((r) => r.outcome !== "satisfied");

    // ── Stale intent: stop, never remediate ─────────────────────────────────
    if (outcome === "stale-intent") {
      await closeRealization(realization.id, {
        status: "stale",
        ...(repository ? { repository } : {}),
        reason,
        unmetRules,
        unmetCriteria,
        completedAt: at,
      });
      void journal(inst.id, {
        at,
        kind: "realization.stale",
        phaseId: implPhaseDef.id,
        detail: `${realization.id}: ${reason}`,
      });
      return res;
    }

    // ── Another targeted attempt, or a terminal failure ─────────────────────
    const attemptsLeft = realization.maxAttempts - attempt;
    if (verdict.remediable && attemptsLeft > 0 && verifierId && inst.status !== "aborted") {
      const next = T(
        applyRemediation(
          inst,
          implPhaseDef.id,
          realizationPhases(def, implPhaseDef.id, verifierId),
          at,
        ),
      );
      void journal(inst.id, {
        at,
        kind: "realization.remediation-started",
        phaseId: implPhaseDef.id,
        detail: `${realization.id}: attempt ${attempt} ${outcome} (${reason}); ${attemptsLeft} attempt${attemptsLeft === 1 ? "" : "s"} left`,
      });
      return {
        ...res,
        instance: next.instance,
        startPhases: [...new Set([...res.startPhases, ...next.startPhases])],
      };
    }

    // Why no further attempt is taken, when one could otherwise have been. The
    // three reasons are different facts and the record says which: a spent
    // budget, an aborted instance, and a realization with no verifier at all.
    const blocked =
      inst.status === "aborted"
        ? "the instance was aborted"
        : !verifierId
          ? "this realization has no verification phase, so nothing can decide it"
          : attemptsLeft <= 0
            ? `the realization's ${realization.maxAttempts}-attempt budget is exhausted`
            : null;
    const terminal = verdict.remediable && blocked ? `${reason}; ${blocked}` : reason;
    await closeRealization(realization.id, {
      status: "failed",
      ...(repository ? { repository } : {}),
      reason: terminal,
      unmetRules,
      unmetCriteria,
      completedAt: at,
    });
    void journal(inst.id, {
      at,
      kind: "realization.failed",
      phaseId: implPhaseDef.id,
      detail: `${realization.id}: ${terminal}`,
    });
    return res;
  }

  /** Where an implementation phase's work happened: its worktree, else its own
   *  `cwd`. Synchronous, because the phase record already knows. */
  function implCwd(def: PipelineDefinition, phaseDef: PhaseDef, phase: PhaseProgress): string {
    return phase.workspace?.path ?? phaseDef.cwd;
  }

  /** Did the implementation phase fail because the agent reported a blocker?
   *  `ARGUS_OUTCOME: blocked` becomes a `signal` failure whose reason the hook
   *  prefixes with `blocked`, which is the existing mechanism Phase 8 reuses
   *  rather than inventing a second one. */
  function isBlocker(phase: PhaseProgress): boolean {
    const reason = (phase.payload as PhaseFailurePayload | null)?.reason ?? "";
    return /^blocked\b/i.test(reason.trim());
  }

  /**
   * The one repository state every result of this attempt's verification was
   * bound to, or null when they disagree (or none exists).
   *
   * Disagreement is not smoothed over: two verification runs that examined
   * different trees cannot jointly prove anything about one implementation, so
   * the completion check sees `null` and fails closed as `state-mismatch`.
   */
  async function verifiedRepositoryState(
    rules: RuleVerification[],
    acceptance: AcceptanceVerification[],
  ): Promise<RepositoryStateRef | null> {
    const states: (RepositoryStateRef | undefined)[] = [
      ...rules.map((r) => r.repositoryState),
      ...acceptance.map((a) => a.repository),
    ];
    const present = states.filter((x): x is RepositoryStateRef => x !== undefined);
    if (present.length === 0) return null;
    const first = present[0];
    return present.every((s) => sameRepositoryState(s, first)) ? first : null;
  }

  return {
    implementationSnapshots,
    planRealization,
    realizationVerifierOf,
    settleRealizations,
    realizationPhases,
    settleRealization,
    implCwd,
    isBlocker,
    verifiedRepositoryState,
  };
}
