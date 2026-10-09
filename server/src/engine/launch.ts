import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  encodeProject,
  readRun,
  runInvocationDir,
  runLogPath,
  runResultPath,
  writeInvocation,
  writeRun,
} from "../sources/runs.js";
import { paths } from "../claudeHome.js";
import { atomicWriteJson } from "../sources/atomicWrite.js";
import {
  candidateArtifactDir,
  phaseArtifactDir,
  phaseBaselinePath,
  prepareInvocation,
  readGitHead,
  resolveTimeoutSeconds,
} from "../harness/invocation.js";
import type { PreparedInvocation } from "../harness/invocation.js";
import { snapshotWorkingTree } from "../harness/verification.js";
import type { WorkingTreeSnapshot } from "../harness/verification.js";
import { createWorktree, workspacePolicyFor, workspaceTarget } from "../harness/workspace.js";
import {
  DEFAULT_MEMORY_BYTES,
  ensureMemoryDir,
  isSettled,
  memoryDirFor,
  readMemoryNotes,
  summarizeInstance,
} from "../harness/memory.js";
import { resolveStallSeconds } from "../harness/stall.js";
import { mintSignalToken, signalAuthFor } from "../harness/signalToken.js";
import {
  describeScopeOfClaim,
  knowledgeScopePolicyFor,
  readableScopes,
  resolveKnowledgeScope,
  sameScope,
} from "../knowledge/scope.js";
import { registerSuppliedContext, readLedger } from "../knowledge/store.js";
import { ensureKnowledgeDeltaDir, knowledgeDeltaFile } from "../knowledge/staging.js";
import {
  KnowledgeContextError,
  effectiveContextSpec,
  knowledgeContextFile,
  resolveKnowledgeContext,
  writeKnowledgeContextFile,
  sha256Hex,
} from "../knowledge/context.js";
import {
  formatClaimRef,
  acceptedChangeProposalOfPhase,
  scopeOfAcceptedChange,
  changeRealizationOfPhase,
} from "../knowledge/kernel.js";
import { discoveryInstruction } from "../knowledge/discovery.js";
import { selectedRules, verificationInstruction } from "../knowledge/ruleVerification.js";
import {
  ensureRuleVerificationDir,
  ruleVerificationFile,
} from "../knowledge/verificationStaging.js";
import {
  buildChangeContext,
  buildChangeIntentInput,
  changeContextFile,
  changeContextInstruction,
  changeIntentInstruction,
  changeRequestFile,
  requestWithIdentity,
  selectedChangeRules,
  validateChangeRequest,
  writeReadOnlyInput,
} from "../knowledge/changeIntent.js";
import { ensureChangeProposalDir, changeProposalFile } from "../knowledge/changeStaging.js";
import { implementationScopeInstruction } from "../knowledge/implementationScope.js";
import {
  implementationScopeFile,
  remediationContextFile,
  remediationInstruction,
} from "../knowledge/realization.js";
import { acceptanceInstruction } from "../knowledge/acceptance.js";
import { acceptanceVerificationFile, ensureAcceptanceDir } from "../knowledge/acceptanceStaging.js";
import { markPipelineStarted } from "../sources/pipelines.js";
import { INSTANCE_KEEP, pruneInstances, readInstances } from "../sources/instances.js";
import { initInstance, applyLaunchPlan } from "../pipelineTransitions.js";
import { interpolate, previousPayloadFor, resultStepName } from "../sources/dag.js";
import { journal } from "../sources/journal.js";
import { resolveRuntimeId, runtimeFor } from "../runtimes/index.js";
import type { PipelineProcessHandle } from "../pipelineProcess.js";
import type { ChangeRequest, InvocationChannelKind } from "@argus/contracts";
import type { Run } from "../sources/scheduleTypes.js";
import type {
  PhaseDef,
  PhaseProgress,
  WorkspacePolicy,
  WorkspaceRecord,
  PipelineDefinition,
  PipelineInstance,
} from "../sources/pipelineTypes.js";
import { log } from "../log.js";
import type {
  LaunchContext,
  Launched,
  PlannedChangeContext,
  PlannedChangeIntent,
  PlannedKnowledgeContext,
  PlannedRun,
  SpawnUnit,
} from "./types.js";
import { PreflightError } from "./spawn.js";
import {
  STEP_CONTRACT,
  artifactInstruction,
  knowledgeContextInstruction,
  memoryInstruction,
  resultInstruction,
} from "./prompts.js";
import type { EngineCore, EngineFns } from "./context.js";

/** Planning a phase attempt and launching its runs: worktrees, semantic and change inputs, the invocation, the spawn. Moved verbatim from `createEngine`. */
export function createLaunch(core: EngineCore) {
  const { deps, sem, locks, nowISO, parentEnv, queuedLaunches, awaitingSlot, track, persist, T } =
    core.ctx;
  const failPhaseConfiguration: EngineFns["failPhaseConfiguration"] = (...args) =>
    core.fns.failPhaseConfiguration(...args);
  const failStepInPlace: EngineFns["failStepInPlace"] = (...args) =>
    core.fns.failStepInPlace(...args);
  const failUnlaunchable: EngineFns["failUnlaunchable"] = (...args) =>
    core.fns.failUnlaunchable(...args);
  const killPhaseRuns: EngineFns["killPhaseRuns"] = (...args) => core.fns.killPhaseRuns(...args);
  const loadDef: EngineFns["loadDef"] = (...args) => core.fns.loadDef(...args);
  const planRealization: EngineFns["planRealization"] = (...args) =>
    core.fns.planRealization(...args);
  const readLive: EngineFns["readLive"] = (...args) => core.fns.readLive(...args);
  const removeWorkspace: EngineFns["removeWorkspace"] = (...args) =>
    core.fns.removeWorkspace(...args);
  const saveInstance: EngineFns["saveInstance"] = (...args) => core.fns.saveInstance(...args);
  const settleCandidates: EngineFns["settleCandidates"] = (...args) =>
    core.fns.settleCandidates(...args);
  const trackStep: EngineFns["trackStep"] = (...args) => core.fns.trackStep(...args);

  /**
   * The worktree this phase attempt runs in, created (or re-attached) before
   * anything is planned.
   *
   * `scope: "instance"` resolves to one tree per instance, shared by every
   * phase that opts in and recorded on the instance the first time it is used —
   * the record is kept as it was, so the base commit it was cut from stays the
   * one it was cut from however many phases reuse it. `scope: "attempt"` gives
   * each attempt its own, and the superseded attempt's tree is removed as the
   * new one is created unless the policy says to keep it.
   *
   * Throws {@link WorkspaceError} (with git's own words) when the repository,
   * the base ref or git itself is not what the definition assumed: the caller
   * turns that into a `configuration` failure of the phase.
   */
  async function ensureWorkspace(
    inst: PipelineInstance,
    phaseDef: PhaseDef,
    progress: PhaseProgress,
    policy: WorkspacePolicy,
    /** One candidate of this attempt, when the phase runs best-of-N: each gets
     *  its own tree, because candidates that share a checkout are not samples. */
    candidate?: number,
  ): Promise<WorkspaceRecord> {
    const target = workspaceTarget({
      root: paths.worktreesDir(),
      instanceId: inst.id,
      phaseId: phaseDef.id,
      attempt: progress.attempt,
      policy,
      ...(candidate === undefined ? {} : { candidate }),
    });
    const previous = candidate === undefined ? progress.workspace : undefined;
    if (previous && previous.path !== target.path && policy.keep !== true) {
      await removeWorkspace(inst.id, phaseDef.cwd, previous.path, previous.branch);
    }
    // A restart finds the directory already there (reused as it stands) or the
    // branch already there without it (checked out again, keeping its commits).
    const shared =
      policy.scope === "instance" && inst.workspace?.path === target.path ? inst.workspace : null;
    const created = await createWorktree({
      repoCwd: phaseDef.cwd,
      path: target.path,
      branch: target.branch,
      ...(policy.base ? { base: policy.base } : {}),
    });
    const record = shared ?? created;
    if (policy.scope === "instance") inst.workspace = record;
    if (!shared) {
      void journal(inst.id, {
        at: nowISO(),
        kind: "workspace.created",
        phaseId: phaseDef.id,
        attempt: progress.attempt,
        detail:
          candidate === undefined
            ? `${record.branch} at ${record.path}`
            : `c${candidate}: ${record.branch} at ${record.path}`,
      });
    }
    return record;
  }

  /**
   * Launch a wave of ready phases, given as indices into `inst.phases`.
   *
   * Sequential over the wave rather than `Promise.all`: each phase's launch
   * writes the instance, and two concurrent writers would race on the same
   * file. The steps *within* a phase already run concurrently, and the phases
   * themselves proceed concurrently once launched — this loop only serializes
   * the handful of milliseconds it takes to record their runIds.
   */
  async function startPhases(
    def: PipelineDefinition,
    inst: PipelineInstance,
    indices: number[],
    noteSuffix = "",
  ): Promise<void> {
    for (const i of indices) await startPhase(def, inst, i, noteSuffix);
  }

  /**
   * Launch one instance phase. `phaseIndex` indexes `inst.phases`; the phase's
   * definition is found by id, never by that index. `def` is normally the
   * instance's own snapshot, where the two line up — but an instance from
   * before the snapshot existed runs against the live definition, which may
   * have been edited since it started (a phase inserted ahead shifts every
   * index, and its id is the one stable key).
   */
  async function startPhase(
    def: PipelineDefinition,
    inst: PipelineInstance,
    phaseIndex: number,
    noteSuffix = "",
  ): Promise<void> {
    const progress = inst.phases[phaseIndex];
    // Launch identity is the run: a phase attempt whose steps already carry
    // run ids has been planned, and planning it again — or doing any of the
    // work below, which opens realizations and creates worktrees — would
    // start a second set of runs for one attempt. Only a phase whose steps
    // have no run yet is launched; a sibling phase is a different attempt and
    // is never held back by this one.
    if (progress.steps.some((s) => s.runId)) {
      log.warn("phase attempt already planned; not launching it twice", {
        instanceId: inst.id,
        phaseId: progress.id,
        attempt: progress.attempt,
      });
      return;
    }
    const phaseDef = def.phases.find((p) => p.id === progress.id);
    if (!phaseDef) {
      await failUnlaunchable(def, inst, progress.id);
      return;
    }
    // "Previous" is the phase's own dependency, which for a linear pipeline is
    // the phase before it — the same value the cursor version produced. A
    // dependency the edited definition names but the instance never had reads
    // as absent, which is the honest answer.
    const prevPayload = previousPayloadFor(def, inst, phaseDef.id);
    const startedAt = nowISO();
    // Isolation first: the worktree is what the steps' `cwd` will be, so it has
    // to exist before a single run is planned — and a tree that cannot be
    // created is a definition Argus cannot honour, not a step that failed.
    const policy = workspacePolicyFor(def, phaseDef);
    // Best-of-N: `count` runs of the phase's one step, each in a worktree of
    // its own. The phase-level tree is *not* created for such an attempt — the
    // winner's becomes the phase's at selection, and a shared one would be a
    // directory nothing ever ran in.
    const candidates = phaseDef.candidates;
    // "none" is a phase opting *out* of a pipeline-wide policy it inherited —
    // the same as no policy at all for this one phase: it runs in its own
    // `cwd`, no worktree is created or recorded.
    if (policy && policy.scope !== "none" && !candidates) {
      try {
        progress.workspace = await ensureWorkspace(inst, phaseDef, progress, policy);
      } catch (e) {
        await failPhaseConfiguration(
          def,
          inst,
          phaseDef.id,
          e instanceof Error ? e.message : String(e),
        );
        return;
      }
    }
    const artifactDir = phaseArtifactDir(paths.artifactsDir(), inst.id, phaseDef.id);
    progress.artifactDir = artifactDir;
    const byPhase = Object.fromEntries(
      inst.phases.flatMap((p) => (p.artifactDir ? [[p.id, p.artifactDir]] : [])),
    ) as Record<string, string>;
    // Exactly one step may publish the phase's result; only that step is told
    // about it, so concurrent siblings cannot race to write a decision. Every
    // candidate of a candidates phase is that step — each writes to its own
    // run's result file, and the phase takes the winner's.
    const publishingStep = resultStepName(phaseDef);

    // Pipeline memory (§B): read once per phase-start, and only when a step
    // actually asks for it — the common case is a pipeline with `memory` off,
    // or a phase whose prompt has nothing to do with it, and neither should
    // pay for a file read it never uses.
    const promptsHere = phaseDef.steps.map((s) => s.prompt).join("\n");
    const memoryPolicy = def.memory;
    const memoryDir = memoryPolicy?.enabled ? memoryDirFor(def.id) : null;
    const memoryText =
      memoryPolicy?.enabled && promptsHere.includes("{{memory}}")
        ? await readMemoryNotes(def.id, memoryPolicy.maxBytes ?? DEFAULT_MEMORY_BYTES)
        : "";
    if (memoryDir) await ensureMemoryDir(def.id);

    // `{{previous.instance}}` (§B): the most recent settled instance of this
    // pipeline that started before this one. Not gated on `memory.enabled` —
    // it costs one instance listing, already read from disk elsewhere, and
    // says nothing a pipeline needs to opt into.
    let previousInstanceSummary = "";
    if (promptsHere.includes("{{previous.instance}}")) {
      const siblings = (await readInstances({ pipelineId: def.id }))
        .filter((i) => i.id !== inst.id && i.createdAt < inst.createdAt && isSettled(i))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      if (siblings[0]) previousInstanceSummary = summarizeInstance(siblings[0]);
    }
    // Semantic context (Phase 4): one ledger snapshot per phase attempt, read
    // only when some step of the phase declares a `knowledgeContext`. Every
    // selector of every run of this attempt — exact and active alike — is
    // resolved against this one document, so the runs of one attempt cannot
    // disagree about which revision "active" meant, and a revision committed
    // while the agents run is, by construction, not in any of their files.
    // A retry or a revise plans a new attempt and reads a new snapshot.
    // The same snapshot answers Phase 7's two questions — which rules a change
    // agent is accountable for, and which accepted proposal an implementation
    // run receives — so a change phase reads the ledger exactly once too.
    // The knowledge scope this attempt owns (§KnowledgeScope), resolved once
    // and frozen on the phase record before a single run is planned.
    //
    // Frozen because ownership must not be able to move: editing the pipeline,
    // or moving the checkout, while the instance runs would otherwise change
    // who owns knowledge already written. Resolved here, rather than at commit,
    // for the same reason the ledger snapshot is — every run of one attempt
    // must agree about which project it is working in. A policy Argus cannot
    // resolve is a definition it cannot honour, so it fails the phase as a
    // `configuration` error instead of silently writing unscoped knowledge.
    const scopePolicy = knowledgeScopePolicyFor(def, phaseDef);
    if (scopePolicy && !progress.knowledgeScope) {
      const resolvedScope = await resolveKnowledgeScope(scopePolicy, phaseDef.cwd);
      if (!resolvedScope.ok) {
        await failPhaseConfiguration(def, inst, phaseDef.id, resolvedScope.reason);
        return;
      }
      progress.knowledgeScope = resolvedScope.resolved.scope;
      if (resolvedScope.resolved.alsoRead.length > 0) {
        progress.knowledgeAlsoRead = resolvedScope.resolved.alsoRead;
      }
    }
    const knowledgeScope = progress.knowledgeScope;
    const knowledgeAlsoRead = progress.knowledgeAlsoRead;
    const contextSpecs = phaseDef.steps.map((sd) => effectiveContextSpec(phaseDef, sd));
    const needsLedger =
      contextSpecs.some((spec) => spec !== null) ||
      phaseDef.changeIntent !== undefined ||
      phaseDef.changeContext !== undefined;
    const ledgerSnapshot = needsLedger ? await readLedger() : null;
    // The repository revision a change-intent phase's conformance projection is
    // scoped to: the phase's own tree, read once. A change phase reads no code,
    // so this is only the commit the answer is *about* — never evidence.
    const changeGitHead = phaseDef.changeIntent ? await readGitHead(phaseDef.cwd) : null;
    // What is actually launched: one run per declared step, or `count` runs of
    // the single step a candidates phase has.
    const units = candidates
      ? Array.from({ length: candidates.count }, (_, i) => ({
          stepDef: phaseDef.steps[0],
          candidate: i as number | undefined,
        }))
      : phaseDef.steps.map((stepDef) => ({ stepDef, candidate: undefined as number | undefined }));

    // The accepted change intent this phase acts on (Phase 7 §downstream
    // handoff), resolved once per attempt from the same snapshot: it is a
    // phase-level selector, and every run of the attempt must receive exactly
    // the same approved intent. Resolved from the ledger's *accepted*
    // proposals only, so a proposal still staged at its gate resolves to
    // nothing and refuses the launch.
    let phaseChangeContext: PlannedChangeContext | null = null;
    if (phaseDef.changeContext) {
      const spec = phaseDef.changeContext;
      const accepted = ledgerSnapshot
        ? acceptedChangeProposalOfPhase(ledgerSnapshot, inst.id, spec.fromPhase)
        : null;
      if (!accepted) {
        phaseChangeContext = {
          error:
            `change context: phase "${spec.fromPhase}" has no accepted ChangeProposal on this ` +
            "instance; a staged proposal waiting at a gate is deliberately not readable here",
        };
      } else if ((spec.requireReady ?? true) && accepted.readiness !== "ready") {
        phaseChangeContext = {
          error:
            `change context: the accepted proposal ${accepted.id} from phase ` +
            `"${spec.fromPhase}" is ${accepted.readiness}; it has unresolved questions or ` +
            "uncovered rule changes, so it may not drive an implementation",
        };
      } else if (
        ledgerSnapshot &&
        !readableScopes({ scope: knowledgeScope, alsoRead: knowledgeAlsoRead }).some((sc) =>
          sameScope(scopeOfAcceptedChange(ledgerSnapshot, accepted), sc),
        )
      ) {
        // A phase-level scope override can put two phases of one instance in
        // two different projects. The accepted intent of the *other* one is
        // another project's semantics — and the ImplementationScope derived
        // from it would name another repository's file paths — so it is
        // refused here rather than handed to an implementation agent.
        phaseChangeContext = {
          error:
            `change context: the accepted proposal ${accepted.id} from phase ` +
            `"${spec.fromPhase}" belongs to ` +
            `${describeScopeOfClaim(scopeOfAcceptedChange(ledgerSnapshot, accepted))}, which this ` +
            `phase is not authorized to read`,
        };
      } else {
        phaseChangeContext = { accepted, text: buildChangeContext(accepted, startedAt).text };
      }
    }
    // The change realization this attempt belongs to (Phase 8). Opened before
    // any run is planned — and therefore before any agent exists — so "which
    // implementation run was intended to realize CP-12?" is answerable even if
    // every one of them crashes.
    const plannedRealization = await planRealization(
      def,
      inst,
      phaseDef,
      progress,
      phaseChangeContext,
      ledgerSnapshot,
      startedAt,
    );
    if (plannedRealization && "realization" in plannedRealization) {
      progress.realization = {
        id: plannedRealization.realization.id,
        proposalId: plannedRealization.realization.proposalId,
        attempt: plannedRealization.attempt,
        kind: plannedRealization.kind,
        maxAttempts: plannedRealization.realization.maxAttempts,
      };
    } else {
      delete progress.realization;
    }
    // The acceptance criteria this attempt must answer for (Phase 8). Exactly
    // the accepted proposal's own, so there is no second selection mechanism
    // here any more than there is for rules.
    const plannedAcceptance =
      phaseDef.acceptanceVerification && phaseChangeContext && "accepted" in phaseChangeContext
        ? {
            proposalId: phaseChangeContext.accepted.id,
            required: phaseChangeContext.accepted.acceptanceCriteria,
          }
        : null;
    if (plannedAcceptance && ledgerSnapshot) {
      const linked = changeRealizationOfPhase(
        ledgerSnapshot,
        inst.id,
        phaseDef.acceptanceVerification!.implementationPhase,
      );
      if (linked) {
        progress.realization = {
          id: linked.id,
          proposalId: linked.proposalId,
          attempt: Math.max(1, linked.attempts.length + 1),
          kind: linked.attempts.length > 0 ? "remediation" : "implementation",
          maxAttempts: linked.maxAttempts,
        };
      }
    }

    const planned: PlannedRun[] = [];
    for (const { stepDef, candidate } of units) {
      let workspace = progress.workspace ?? null;
      if (candidates && policy && policy.scope !== "none") {
        try {
          workspace = await ensureWorkspace(inst, phaseDef, progress, policy, candidate);
        } catch (e) {
          await failPhaseConfiguration(
            def,
            inst,
            phaseDef.id,
            e instanceof Error ? e.message : String(e),
          );
          return;
        }
      }
      // Where this run's work actually happens: its worktree, else the phase's
      // own directory exactly as before workspaces existed.
      const cwd = workspace?.path ?? phaseDef.cwd;
      const own =
        candidate === undefined ? artifactDir : candidateArtifactDir(artifactDir, candidate);
      // Cycled, so `count: 4` with two variants alternates them. Absent = the
      // step's own settings, which is what makes `count` alone mean "sample the
      // same thing N times".
      const variant =
        candidates && candidate !== undefined && candidates.variants?.length
          ? candidates.variants[candidate % candidates.variants.length]
          : undefined;
      const runId = deps.newId();
      const publishes = stepDef.name === publishingStep;
      // This run's semantic context, frozen now. A selector the snapshot
      // cannot resolve is carried to the launch as the reason the step will
      // not start — the definition names knowledge the ledger does not hold.
      const contextSpec = effectiveContextSpec(phaseDef, stepDef);
      let knowledgeContext: PlannedKnowledgeContext | null = null;
      if (contextSpec && ledgerSnapshot) {
        try {
          knowledgeContext = {
            resolved: resolveKnowledgeContext(ledgerSnapshot, contextSpec, startedAt, {
              instanceId: inst.id,
              phaseStatus: (id) => inst.phases.find((ph) => ph.id === id)?.status ?? null,
              ...(knowledgeScope ? { knowledge: knowledgeScope } : {}),
              ...(knowledgeAlsoRead ? { alsoRead: knowledgeAlsoRead } : {}),
            }),
          };
        } catch (e) {
          knowledgeContext = {
            error:
              e instanceof KnowledgeContextError
                ? `knowledge context ${e.code}: ${e.message}`
                : e instanceof Error
                  ? e.message
                  : String(e),
          };
        }
      }
      // The change-intent input (Phase 7), frozen now for the same reason the
      // semantic context is: every run of one attempt must answer the same
      // request against the same reading of the ledger. The rules the run is
      // accountable for are exactly the ones its KnowledgeContext supplied —
      // there is no second selection mechanism — and their current
      // implementation conformance is projected at the commit the run will
      // work at.
      let changeIntent: PlannedChangeIntent | null = null;
      if (phaseDef.changeIntent) {
        const resolved = resolveChangeRequest(phaseDef, inst, progress.attempt, startedAt);
        if ("error" in resolved) {
          changeIntent = { error: resolved.error };
        } else {
          const request = resolved.request;
          const supplied =
            knowledgeContext && "resolved" in knowledgeContext
              ? knowledgeContext.resolved.supplied
              : [];
          const selected = selectedChangeRules(ledgerSnapshot, supplied, phaseDef.changeIntent);
          const built = buildChangeIntentInput(
            ledgerSnapshot,
            request,
            selected,
            changeGitHead,
            startedAt,
          );
          changeIntent = { request, selected, relevant: built.relevant, text: built.text };
        }
      }
      // The accepted change intent this run implements (Phase 7 §downstream
      // handoff). Resolved from the ledger's *accepted* proposals only, so a
      // proposal still staged at its gate resolves to nothing and refuses the
      // launch — unapproved intent can never reach an implementation run.
      const changeContext = phaseChangeContext;
      // Narrowest wins: a candidate's variant names its runtime, else the step,
      // else its phase, else the pipeline, else the server default. Resolved and
      // written down here, so a mixed-runtime pipeline stays readable on the
      // board and in the record.
      const runtime = resolveRuntimeId(
        variant?.runtime,
        stepDef.runtime,
        phaseDef.runtime,
        def.runtime,
      );
      const timeoutSeconds = resolveTimeoutSeconds(phaseDef, stepDef);
      const stallSeconds = resolveStallSeconds(phaseDef, stepDef);
      // Argus-injected blocks ride after the agent's own prompt, in a fixed
      // order, with the retry note last: the note is what matters most on a
      // retry, and recency in the prompt is what the model weighs most (see
      // docs/HARNESS-RESEARCH.md §2 #5, "lost in the middle").
      const rendered = interpolate(
        stepDef.prompt,
        prevPayload,
        inst.artifacts ?? {},
        { own, byPhase },
        {
          triggerPayload: inst.triggerPayload,
          memory: memoryText,
          previousInstanceSummary,
          maxPlaceholderBytes: def.contextLimits?.placeholderBytes,
          contextDir: runInvocationDir(runId),
        },
      );
      const run: Run = {
        id: runId,
        scheduleId: `pipeline:${inst.pipelineId}`,
        scheduleName: `${inst.pipelineName} · ${phaseDef.name}`,
        prompt:
          rendered.prompt +
          (publishes ? resultInstruction(phaseDef.result) : "") +
          artifactInstruction(phaseDef.checks, own) +
          discoveryInstruction(phaseDef.discovery) +
          // Business-rule verification (Phase 6): the rules this run is
          // accountable for are exactly the business rules its own
          // KnowledgeContext supplies — there is no second selection
          // mechanism — so the instruction can name them, and Argus can hold
          // the answer to them.
          verificationInstruction(
            phaseDef.ruleVerification,
            knowledgeContext && "resolved" in knowledgeContext
              ? selectedRules(
                  ledgerSnapshot,
                  knowledgeContext.resolved.supplied,
                  phaseDef.ruleVerification,
                )
              : [],
          ) +
          // Change-intent reasoning (Phase 7): the request, the rules this run
          // must account for, and their current implementation conformance —
          // context for the reasoning, never a reason to change a rule.
          changeIntentInstruction(
            phaseDef.changeIntent,
            changeIntent && "error" in changeIntent ? null : (changeIntent?.request ?? null),
            changeIntent && "error" in changeIntent ? [] : (changeIntent?.relevant ?? []),
          ) +
          changeContextInstruction(
            changeContext && "accepted" in changeContext ? changeContext.accepted : null,
          ) +
          // Targeted implementation (Phase 8): where the ledger says this
          // change lives, and — on a remediation — exactly what the previous
          // attempt left unmet. Both are provenance Argus derived, never an
          // agent's recollection of a previous transcript.
          implementationScopeInstruction(
            plannedRealization && "realization" in plannedRealization
              ? plannedRealization.scope
              : null,
          ) +
          remediationInstruction(
            plannedRealization && "realization" in plannedRealization
              ? (plannedRealization.remediation?.context ?? null)
              : null,
          ) +
          acceptanceInstruction(
            phaseDef.acceptanceVerification,
            plannedAcceptance?.proposalId ?? null,
            plannedAcceptance?.required ?? [],
          ) +
          memoryInstruction(memoryPolicy) +
          (knowledgeContext && "resolved" in knowledgeContext
            ? knowledgeContextInstruction(knowledgeContext.resolved.supplied)
            : "") +
          noteSuffix,
        cwd,
        status: "running",
        trigger: "scheduled",
        queuedAt: startedAt,
        startedAt,
        endedAt: null,
        durationMs: null,
        pid: null,
        exitCode: null,
        sessionId: runtimeFor(runtime).capabilities.presetSessionId ? deps.newId() : null,
        model: variant?.model ?? stepDef.model ?? def.model,
        reasoningEffort: variant?.reasoningEffort ?? stepDef.reasoningEffort ?? def.reasoningEffort,
        runtime,
        project: encodeProject(cwd),
        resultSummary: null,
        error: null,
        instanceId: inst.id,
        phaseId: phaseDef.id,
        // The deadline is set at spawn, not here: a step may wait for a
        // concurrency slot first, and waiting is not running.
        deadlineAt: null,
        stallSeconds,
      };
      // This run's own signal credential, bound to exactly this instance,
      // phase, attempt and run (harness/signalToken.ts). A runtime with no
      // signal hook is handed none at all — it completes from its run record,
      // and a credential nothing uses is only something to leak.
      const binding = {
        instanceId: inst.id,
        phaseId: phaseDef.id,
        attempt: progress.attempt,
        runId,
      };
      const signalToken = runtimeFor(runtime).capabilities.signalHook
        ? (deps.newSignalToken?.(binding) ?? mintSignalToken())
        : null;
      run.signalAuth = signalToken ? signalAuthFor(binding, signalToken) : { scheme: "none" };
      planned.push({
        stepDef,
        run,
        publishes,
        timeoutSeconds,
        candidate,
        artifactDir: own,
        workspace,
        contextFiles: rendered.contextFiles,
        knowledgeContext,
        changeIntent,
        changeContext,
        realization: plannedRealization,
        acceptance: plannedAcceptance,
        signalToken,
      });
    }
    // Record the runIds on the instance up front, then persist once (no write races).
    // The plan is recorded by a transition (it also clears the previous
    // attempt's discovery, verification, change-intent and acceptance
    // summaries: their counts describe work nobody can accept any more), and
    // committed before a single process starts — so a crash from here on
    // leaves runs the reconcile pass knows about, never invisible ones.
    const plannedRes = T(
      applyLaunchPlan(
        inst,
        phaseDef.id,
        {
          artifactDir,
          steps: planned.map(({ stepDef, run, candidate, workspace }) => ({
            name: stepDef.name,
            runId: run.id,
            status: "running" as const,
            ...(run.signalAuth ? { signalAuth: run.signalAuth } : {}),
            ...(candidate === undefined ? {} : { candidate }),
            ...(candidate === undefined ? {} : { workspace }),
          })),
        },
        nowISO(),
      ),
    );
    if (!plannedRes.events?.length) {
      // Already planned for this attempt — another launch got here first.
      // Launching again would start a second set of runs for one attempt.
      log.warn("phase attempt already planned; not launching it twice", {
        instanceId: inst.id,
        phaseId: phaseDef.id,
        attempt: progress.attempt,
      });
      return;
    }
    await saveInstance(inst);
    void journal(inst.id, {
      at: startedAt,
      kind: "phase.started",
      phaseId: phaseDef.id,
      attempt: progress.attempt,
      detail: candidates
        ? `${planned.length} candidates`
        : `${planned.length} step${planned.length === 1 ? "" : "s"}`,
    });
    // Every attempt starts with an empty artifact directory: a file left by a
    // previous attempt must never satisfy this attempt's checks or mislead the
    // agent about what it has already done.
    await rm(artifactDir, { recursive: true, force: true });
    await mkdir(artifactDir, { recursive: true });
    for (const unit of planned) {
      if (unit.artifactDir !== artifactDir) await mkdir(unit.artifactDir, { recursive: true });
    }

    // A working-tree baseline for `changed-files` checks, kept out of the
    // agent's reach (beside the invocation records, not in the artifact dir).
    // Per candidate, because each candidate has a tree of its own and is
    // judged on what *it* changed. Taken for every run before any of them
    // starts: steps sharing one tree are judged against the tree as it was
    // before the first of them ran, however long a later one waits for a slot.
    const launches: SpawnUnit[] = [];
    for (const unit of planned) {
      const { stepDef, run, publishes, timeoutSeconds, candidate } = unit;
      let baseline: WorkingTreeSnapshot | null = null;
      if (phaseDef.checks?.some((c) => c.kind === "changed-files")) {
        baseline = await snapshotWorkingTree(run.cwd);
        const file = phaseBaselinePath(
          paths.invocationsDir(),
          inst.id,
          phaseDef.id,
          progress.attempt,
          candidate,
        );
        if (baseline) await atomicWriteJson(file, baseline);
        else await rm(file, { force: true });
      }
      const gitHead = baseline?.head ?? (await readGitHead(run.cwd));
      launches.push({
        def,
        phaseDef,
        run,
        candidate,
        attempt: progress.attempt,
        startedAt,
        ctx: {
          def,
          phaseDef,
          stepDef,
          publishes,
          artifactDir: unit.artifactDir,
          timeoutSeconds,
          gitHead,
          workspace: unit.workspace,
          memoryDir,
          contextFiles: unit.contextFiles,
          knowledgeContext: unit.knowledgeContext,
          changeIntent: unit.changeIntent,
          changeContext: unit.changeContext,
          realization: unit.realization,
          acceptance: unit.acceptance,
          signalToken: unit.signalToken,
        },
      });
    }

    // Launch each run that may start: in a free slot now, or — past the cap —
    // queued for one. A queued run waits *off* the instance lock, so a signal,
    // a reconcile tick or a gate decision is never held behind it; it takes
    // the lock again and re-checks that it is still wanted before spawning.
    // Callers on the HTTP request path (start/approve/revise) therefore see
    // every run that fit under the cap spawned when they return, and the rest
    // queued. Candidates are ordinary runs in that respect: `count` of them
    // take `count` slots, and queue when the cap is smaller than the count.
    const unlaunchable: { run: Run; reason: string }[] = [];
    for (const launch of launches) {
      const refusal = plannedRefusal(launch.ctx);
      if (refusal) {
        await refuseLaunch(inst.id, launch, refusal);
        unlaunchable.push({ run: launch.run, reason: refusal });
      } else if (sem.tryAcquire()) {
        const failed = await spawnUnit(launch, inst);
        if (failed) unlaunchable.push(failed);
      } else {
        queueSpawn(launch, inst.id);
      }
    }
    await concludeUnlaunchable(def, inst, phaseDef, unlaunchable);
    deps.onChange?.();
  }

  /**
   * Why a planned run may not start at all, decided at planning and needing
   * no slot. A semantic context the planning snapshot could not resolve
   * refuses the step as a `configuration` failure: the definition names
   * knowledge the ledger does not hold, and running again cannot change that.
   * The two change-intent inputs (Phase 7) refuse it the same way and for the
   * same reason: a change phase with no request, or an implementation phase
   * whose intent is unapproved or unfinished, must not launch an agent at all.
   */
  function plannedRefusal(ctx: Omit<LaunchContext, "inst">): string | null {
    return (
      (ctx.knowledgeContext && "error" in ctx.knowledgeContext
        ? ctx.knowledgeContext.error
        : null) ??
      (ctx.changeIntent && "error" in ctx.changeIntent ? ctx.changeIntent.error : null) ??
      (ctx.changeContext && "error" in ctx.changeContext ? ctx.changeContext.error : null) ??
      // Phase 8's two preconditions: the accepted intent this realization
      // targets must still be the domain's current intent, and the attempt
      // budget must not be spent. Both refuse the launch as `configuration`
      // rather than starting an agent against work that cannot count.
      (ctx.realization && "error" in ctx.realization ? ctx.realization.error : null)
    );
  }

  async function refuseLaunch(instanceId: string, launch: SpawnUnit, reason: string) {
    await writeRun({
      ...launch.run,
      status: "failed",
      termination: "spawn-failed",
      error: reason,
      endedAt: nowISO(),
    });
    void journal(instanceId, {
      at: nowISO(),
      kind: "step.spawned",
      phaseId: launch.phaseDef.id,
      runId: launch.run.id,
      detail: `not launched: ${reason}${candidateSuffix(launch.candidate)}`,
    });
  }

  const candidateSuffix = (candidate: number | undefined) =>
    candidate === undefined ? "" : ` (c${candidate})`;

  /**
   * Spawn one run in the slot the caller already holds. The slot passes to
   * the run's exit tracking on a spawn; on every other outcome it is released
   * here. A step Argus refused to launch as declared is returned, for the
   * caller to fail under `configuration`.
   */
  async function spawnUnit(
    launch: SpawnUnit,
    inst: PipelineInstance,
  ): Promise<{ run: Run; reason: string } | null> {
    const { run, phaseDef, candidate } = launch;
    let launched: Launched;
    try {
      launched = await launchStep(run, { ...launch.ctx, inst });
    } catch (e) {
      sem.release();
      throw e;
    }
    void journal(inst.id, {
      at: nowISO(),
      kind: "step.spawned",
      phaseId: phaseDef.id,
      runId: run.id,
      detail:
        ("handle" in launched
          ? `pid ${run.pid ?? "unknown"}`
          : launched.failure === "configuration"
            ? `not launched: ${launched.reason}`
            : "spawn failed") + candidateSuffix(candidate),
    });
    if ("handle" in launched) {
      trackStep(run, launched.handle, launch.startedAt, inst.id, phaseDef.id);
      return null;
    }
    sem.release();
    return launched.failure === "configuration" ? { run, reason: launched.reason } : null;
  }

  /**
   * Wait for a slot off the instance lock, then spawn — only if the run is
   * still wanted. While it waits, an abort, a revise, a failed sibling or a
   * restart may have decided its step; spawning it then would start an agent
   * nobody is waiting for.
   */
  function queueSpawn(launch: SpawnUnit, instanceId: string): void {
    const { run, phaseDef } = launch;
    awaitingSlot.add(run.id);
    void track(
      (async () => {
        let held = false;
        try {
          await sem.acquire();
          held = true;
          await locks.withLock(instanceId, async () => {
            const fresh = await readLive(instanceId, "launch");
            const phase = fresh?.phases.find((p) => p.id === phaseDef.id);
            const wanted =
              !!fresh &&
              (fresh.status === "running" || fresh.status === "awaiting-approval") &&
              phase?.status === "running" &&
              phase.attempt === launch.attempt &&
              phase.steps.some((s) => s.runId === run.id && s.status === "running") &&
              !(await readRun(run.id));
            if (!fresh || !wanted) {
              void journal(instanceId, {
                at: nowISO(),
                kind: "step.spawned",
                phaseId: phaseDef.id,
                runId: run.id,
                detail: `not launched: decided while waiting for a slot${candidateSuffix(launch.candidate)}`,
              });
              return;
            }
            held = false;
            const failed = await spawnUnit(launch, fresh);
            if (failed) await concludeUnlaunchable(launch.def, fresh, phaseDef, [failed]);
            deps.onChange?.();
          });
        } catch (e) {
          log.error("queued step launch failed", { instanceId, runId: run.id, err: e });
        } finally {
          if (held) sem.release();
          awaitingSlot.delete(run.id);
        }
      })(),
    );
  }

  /**
   * A step Argus refused to launch as declared fails its phase now, under the
   * `configuration` class — never retried, because the definition is what is
   * wrong. (A spawn *error* keeps its existing path: the run record says
   * failed and the reconcile pass classes it as `spawn`.)
   */
  async function concludeUnlaunchable(
    def: PipelineDefinition,
    inst: PipelineInstance,
    phaseDef: PhaseDef,
    unlaunchable: { run: Run; reason: string }[],
  ): Promise<void> {
    if (unlaunchable.length === 0) return;
    const readyAfterFailure: number[] = [];
    for (const { run, reason } of unlaunchable) {
      // A queued run can be refused after a sibling paused at its gate, which
      // leaves the instance `awaiting-approval` while this phase still runs.
      if (inst.status !== "running" && inst.status !== "awaiting-approval") break;
      readyAfterFailure.push(
        ...failStepInPlace(def, inst, phaseDef.id, run.id, "configuration", reason).startPhases,
      );
    }
    await saveInstance(inst);
    if (phaseDef.candidates) {
      // A candidate Argus would not launch as declared is one candidate lost,
      // not a phase lost: the others may still win, and the phase only fails
      // when none of them can.
      await settleCandidates(def, inst, phaseDef.id);
    } else {
      // Siblings that did launch belong to a phase that has already failed.
      await killPhaseRuns(inst, [phaseDef.id], "stopped: phase failed");
      queueReadyPhases(inst.id, def, inst, readyAfterFailure);
      if (inst.status === "failed") deps.onFailure?.(inst);
    }
  }

  /**
   * The {@link ChangeRequest} one change-intent phase attempt answers.
   *
   * Two sources, in a fixed precedence, and no third:
   *
   * - the **instance's trigger payload**, when it carries a `changeRequest`.
   *   A request supplied when this particular run was started is more specific
   *   than the pipeline's default, so it wins;
   * - the phase's authored `changeIntent.request`.
   *
   * An error when neither resolves, or when a supplied one is malformed —
   * which fails the step as `configuration` before any process starts. Argus
   * never invents a request, and never silently falls back from a malformed
   * supplied one to the pipeline's default: the run would then answer a
   * different question from the one somebody asked.
   *
   * The request is given an identity here when its author gave it none, keyed
   * to the phase attempt so both runs of one attempt answer the same request.
   */
  function resolveChangeRequest(
    phaseDef: PhaseDef,
    inst: PipelineInstance,
    attempt: number,
    now: string,
  ): { request: ChangeRequest } | { error: string } {
    const fromTrigger = (inst.triggerPayload as { changeRequest?: unknown } | undefined)
      ?.changeRequest;
    let request: ChangeRequest | null = null;
    if (fromTrigger !== undefined && fromTrigger !== null) {
      try {
        request = validateChangeRequest(fromTrigger, "triggerPayload.changeRequest");
      } catch (e) {
        return {
          error: `change intent: the ChangeRequest supplied with this instance is invalid: ${
            e instanceof Error ? e.message : String(e)
          }`,
        };
      }
    }
    request ??= phaseDef.changeIntent?.request ?? null;
    if (!request) {
      return {
        error:
          `change intent: phase "${phaseDef.id}" declares changeIntent but no ChangeRequest ` +
          "was supplied — author one on the phase, or start the instance with a " +
          "triggerPayload carrying `changeRequest`",
      };
    }
    return {
      request: requestWithIdentity(request, `CR-${inst.id}-${phaseDef.id}-${attempt}`, now),
    };
  }

  /**
   * Prepare, record and spawn one step, persisting its pid.
   *
   * Preparation decides everything before the process exists: the runtime maps
   * the step's capability profile onto flags and config files, the environment
   * policy is applied, and the invocation record is written — so even a step
   * that never launches leaves a record of what Argus would have run and why it
   * refused. Under strict enforcement a profile the runtime cannot honour is a
   * `configuration` failure; the step does not launch with more capability than
   * its author declared.
   */
  async function launchStep(run: Run, ctx: LaunchContext): Promise<Launched> {
    const env: Record<string, string> = {
      ARGUS_SIGNAL_URL: `${deps.signalUrlBase}/api/instances/${ctx.inst.id}/signal`,
      ARGUS_INSTANCE_ID: ctx.inst.id,
      ARGUS_PHASE_ID: ctx.phaseDef.id,
      ARGUS_RUN_ID: run.id,
      ARGUS_STEP_NAME: run.scheduleName,
      // Which CLI the hook is running under. One hook file serves both, and the
      // two deliver slightly different Stop payloads; this removes the guess.
      ARGUS_RUNTIME: resolveRuntimeId(run.runtime),
      // Where this phase's file artifacts go; later phases read them from here.
      ARGUS_ARTIFACT_DIR: ctx.artifactDir,
    };
    // The run's own signal credential — never the instance's — and only for a
    // runtime whose hook will use it.
    if (ctx.signalToken) env.ARGUS_SIGNAL_TOKEN = ctx.signalToken;
    // The isolated worktree the step is already running in, named so a script
    // (or a nested tool) does not have to derive it from `pwd`. Per-invocation,
    // and therefore stripped from the inherited environment by buildChildEnv.
    if (ctx.workspace) env.ARGUS_WORKSPACE = ctx.workspace.path;
    // This pipeline's durable-notes directory, when `memory` is enabled.
    if (ctx.memoryDir) env.ARGUS_MEMORY_DIR = ctx.memoryDir;
    // The result file is named for every runtime, hook or no hook: the agent
    // writes the same file either way, and a runtime without a command hook has
    // it read off disk on the next reconcile tick instead.
    let resultFile: string | null = null;
    if (ctx.publishes) {
      resultFile = runResultPath(run.id);
      await mkdir(path.dirname(resultFile), { recursive: true });
      env.ARGUS_RESULT_FILE = resultFile;
    }
    // Where this run may propose semantic knowledge (docs/KNOWLEDGE-LEDGER.md
    // § KnowledgeDelta protocol). Named for every run, like the result file:
    // an agent that has nothing to propose writes nothing, and the engine
    // reads the file — or its absence — when the run completes.
    //
    // The one exception (Phase 8 §protocol channels match phase
    // responsibilities): a change-intent run's semantic half travels inside
    // its ChangeProposal, and a run that writes both files is refused
    // outright — so it is not told a path whose use would fail the step. The
    // refusal itself does not depend on the variable: the engine reads the
    // per-run path either way, so an agent that writes there unbidden is
    // still caught.
    const offersDelta = ctx.phaseDef.changeIntent === undefined;
    const deltaFile = offersDelta ? knowledgeDeltaFile(run.id) : null;
    if (deltaFile) env.ARGUS_KNOWLEDGE_DELTA_FILE = deltaFile;
    const invocationDir = runInvocationDir(run.id);
    // The read-only KnowledgeContext (docs/KNOWLEDGE-LEDGER.md § KnowledgeContext
    // protocol): materialized in the run's own invocation directory before the
    // process exists, named to the agent by the variable, and recorded on the
    // invocation — exact refs and the file's hash — as what Argus supplied.
    const resolvedContext =
      ctx.knowledgeContext && "resolved" in ctx.knowledgeContext
        ? ctx.knowledgeContext.resolved
        : null;
    const contextFile = resolvedContext ? knowledgeContextFile(run.id) : null;
    if (contextFile) env.ARGUS_KNOWLEDGE_CONTEXT_FILE = contextFile;
    // Where a verification phase's run must leave its conformance results
    // (docs/KNOWLEDGE-LEDGER.md § Phase 6). Its own Argus-owned sidecar,
    // deliberately not the KnowledgeDelta: a conformance result is not a
    // knowledge mutation, and sharing the channel would invite an agent to
    // express "the code violates this rule" as opposing evidence on the rule.
    const verificationFile = ctx.phaseDef.ruleVerification ? ruleVerificationFile(run.id) : null;
    if (verificationFile) env.ARGUS_RULE_VERIFICATION_FILE = verificationFile;
    // The change-intent channels (docs/KNOWLEDGE-LEDGER.md § Phase 7): the
    // request Argus materializes for the run to read, and the proposal file it
    // must answer with. Its own sidecar, deliberately not the KnowledgeDelta:
    // a proposal carries what is preserved, how success is judged and what is
    // unresolved, none of which are claims.
    const plannedIntent =
      ctx.changeIntent && "request" in ctx.changeIntent ? ctx.changeIntent : null;
    const requestFile = plannedIntent ? changeRequestFile(run.id) : null;
    const proposalFile = plannedIntent ? changeProposalFile(run.id) : null;
    if (requestFile) env.ARGUS_CHANGE_REQUEST_FILE = requestFile;
    if (proposalFile) env.ARGUS_CHANGE_PROPOSAL_FILE = proposalFile;
    // And the downstream half: the accepted intent an implementation run acts
    // on, read-only, naming exact canonical revisions.
    const plannedChange =
      ctx.changeContext && "accepted" in ctx.changeContext ? ctx.changeContext : null;
    const changeFile = plannedChange ? changeContextFile(run.id) : null;
    if (changeFile) env.ARGUS_CHANGE_CONTEXT_FILE = changeFile;
    // The Phase 8 channels: the deterministic scope of the change this run is
    // realizing, the exact failures a remediation is fixing, and the file an
    // acceptance-verification run answers in. All three are Argus-owned, and
    // the two read ones are hashed at launch and re-hashed at completion.
    const plannedRealization =
      ctx.realization && "realization" in ctx.realization ? ctx.realization : null;
    const scopeFile = plannedRealization ? implementationScopeFile(run.id) : null;
    if (scopeFile) env.ARGUS_IMPLEMENTATION_SCOPE_FILE = scopeFile;
    const remediationFile = plannedRealization?.remediation ? remediationContextFile(run.id) : null;
    if (remediationFile) env.ARGUS_REMEDIATION_CONTEXT_FILE = remediationFile;
    const acceptanceFile = ctx.acceptance ? acceptanceVerificationFile(run.id) : null;
    if (acceptanceFile) env.ARGUS_ACCEPTANCE_VERIFICATION_FILE = acceptanceFile;
    let prepared: PreparedInvocation;
    const suppliedInputs: { kind: InvocationChannelKind; path: string; sha256: string }[] = [];
    try {
      await mkdir(invocationDir, { recursive: true });
      await ensureKnowledgeDeltaDir(run.id);
      if (verificationFile) await ensureRuleVerificationDir(run.id);
      if (contextFile && resolvedContext) {
        await writeKnowledgeContextFile(contextFile, resolvedContext.text);
      }
      if (proposalFile) await ensureChangeProposalDir(run.id);
      if (requestFile && plannedIntent) await writeReadOnlyInput(requestFile, plannedIntent.text);
      if (acceptanceFile) await ensureAcceptanceDir(run.id);
      // Every Argus-owned read-only input, written and hashed in one place, so
      // the completion can prove the bytes the agent read are the bytes Argus
      // supplied (Phase 8 §ChangeContext integrity). The KnowledgeContext is
      // not here: its hash is durable in the ledger, which is stronger.
      if (changeFile && plannedChange) {
        await writeReadOnlyInput(changeFile, plannedChange.text);
        suppliedInputs.push({
          kind: "change-context",
          path: changeFile,
          sha256: sha256Hex(plannedChange.text),
        });
      }
      if (scopeFile && plannedRealization) {
        await writeReadOnlyInput(scopeFile, plannedRealization.scopeText);
        suppliedInputs.push({
          kind: "implementation-scope",
          path: scopeFile,
          sha256: sha256Hex(plannedRealization.scopeText),
        });
      }
      if (remediationFile && plannedRealization?.remediation) {
        await writeReadOnlyInput(remediationFile, plannedRealization.remediation.text);
        suppliedInputs.push({
          kind: "remediation-context",
          path: remediationFile,
          sha256: sha256Hex(plannedRealization.remediation.text),
        });
      }
      // The clock the deadline runs from: now, with the slot held and the
      // process about to start.
      run.startedAt = nowISO();
      prepared = prepareInvocation({
        run,
        def: ctx.def,
        phaseDef: ctx.phaseDef,
        stepDef: ctx.stepDef,
        instanceId: ctx.inst.id,
        attempt: ctx.inst.phases.find((p) => p.id === ctx.phaseDef.id)?.attempt ?? 0,
        systemPrompt: STEP_CONTRACT,
        argusEnv: env,
        invocationDir,
        artifactDir: ctx.artifactDir,
        memoryDir: ctx.memoryDir,
        workspace: ctx.workspace,
        resultFile,
        knowledgeDeltaFile: deltaFile,
        ruleVerificationFile: verificationFile,
        changeRequestFile: requestFile,
        changeProposalFile: proposalFile,
        changeContextFile: changeFile,
        implementationScopeFile: scopeFile,
        remediationContextFile: remediationFile,
        acceptanceVerificationFile: acceptanceFile,
        suppliedInputs,
        knowledgeContext:
          contextFile && resolvedContext
            ? {
                file: contextFile,
                record: {
                  schemaVersion: 1,
                  claims: resolvedContext.supplied,
                  sha256: resolvedContext.sha256,
                },
              }
            : null,
        timeoutSeconds: ctx.timeoutSeconds,
        gitHead: ctx.gitHead,
        parentEnv: parentEnv(),
        now: new Date(run.startedAt),
      });
      run.deadlineAt = prepared.record.deadlineAt;
      await writeInvocation(prepared.record);
      // Durable supplied provenance (Phase 4.1, docs/KNOWLEDGE-LEDGER.md
      // §13.10): the identity of the context — exact refs, hash, when — goes
      // into `knowledge.json` *before* the process exists, so the answer to
      // "what did this run receive?" outlives the invocation directory that
      // is pruned with the run. Idempotent on the run id, so a retried
      // preparation or a reconcile re-observing the launch adds nothing; a
      // *different* context for the same run throws, and the throw is caught
      // below as a launch failure rather than rewriting history.
      if (resolvedContext) {
        await registerSuppliedContext(
          { runId: run.id, instanceId: ctx.inst.id, phaseId: ctx.phaseDef.id },
          {
            claims: resolvedContext.supplied,
            sha256: resolvedContext.sha256,
            attempt: prepared.record.attempt,
            schemaVersion: 1,
          },
          new Date(run.startedAt),
        );
        void journal(ctx.inst.id, {
          at: run.startedAt,
          kind: "knowledge.supplied",
          phaseId: ctx.phaseDef.id,
          runId: run.id,
          detail: `${resolvedContext.supplied.map(formatClaimRef).join(", ")} (sha256 ${resolvedContext.sha256.slice(0, 12)})`,
        });
      }
      for (const file of prepared.files) await writeFile(file.path, file.contents, "utf8");
      // Any placeholder {@link interpolate} trimmed for this run's prompt: the
      // full value, so the agent can still read the whole thing if it needs to.
      for (const file of ctx.contextFiles) {
        await mkdir(path.dirname(file.path), { recursive: true });
        await writeFile(file.path, file.contents, "utf8");
      }
    } catch (e) {
      await writeRun({
        ...run,
        status: "failed",
        termination: "spawn-failed",
        error: String(e),
        endedAt: nowISO(),
      });
      return { failure: "spawn", reason: String(e) };
    }
    if (prepared.blocking.length > 0) {
      const reason = `capability profile cannot be enforced by ${resolveRuntimeId(run.runtime)}: ${prepared.blocking.join("; ")}`;
      await writeRun({
        ...run,
        status: "failed",
        termination: "spawn-failed",
        error: reason,
        endedAt: nowISO(),
      });
      return { failure: "configuration", reason };
    }
    let handle: PipelineProcessHandle;
    try {
      const logPath = runLogPath(run.id);
      await mkdir(path.dirname(logPath), { recursive: true });
      handle = await Promise.resolve(deps.spawn(run, logPath, env, prepared));
    } catch (e) {
      await writeRun({
        ...run,
        status: "failed",
        termination: "spawn-failed",
        error: String(e),
        endedAt: nowISO(),
      });
      return { failure: "spawn", reason: String(e) };
    }
    run.pid = handle.pid;
    await writeRun(run);
    deps.tailer?.track(run.id, ctx.inst.id, run.runtime);
    return { handle };
  }

  async function start(
    pipelineId: string,
    trigger: PipelineInstance["trigger"] = "manual",
    firing?: { triggerPayload?: unknown; chainedFrom?: string },
  ) {
    const def = await loadDef(pipelineId);
    if (!def) throw new Error("pipeline not found");
    if (def.overlapPolicy === "skip") {
      const busy = (await readInstances({ pipelineId })).some(
        (i) => i.status === "running" || i.status === "awaiting-approval",
      );
      if (busy) return null;
    }
    if (deps.preflight) {
      const pf = await deps.preflight();
      if (!pf.ok) throw new PreflightError(pf.reasons);
    }
    const init = initInstance(
      def,
      trigger,
      { instanceId: deps.newId(), token: deps.newId() },
      nowISO(),
      firing,
    );
    persist.fresh(init.instance, "start");
    const { instance, startPhases: ready } = T(init);
    await saveInstance(instance);
    await markPipelineStarted(def.id, instance.createdAt);
    void journal(instance.id, {
      at: instance.createdAt,
      kind: "instance.started",
      detail: `${def.name} (${trigger})`,
    });
    // Under the lock like every other launch, so a reconcile tick that sees
    // the new instance cannot mistake a step still being prepared for one
    // whose launch was lost. Runs past the concurrency cap are left queued
    // for a slot, off the lock; this returns without waiting for them.
    await locks.withLock(instance.id, () => startPhases(def, instance, ready));
    await pruneInstances(def.id, INSTANCE_KEEP);
    deps.onChange?.();
    return instance;
  }

  /**
   * Launch phases exposed by a transition after the caller releases the
   * instance lock. Signal handlers must answer the child before planning a
   * phase, and reconciliation uses the same path so fallback and a delayed
   * hook have one idempotency boundary. Neither waits for a concurrency slot
   * under the lock: a run past the cap is queued for one by `startPhase`.
   */
  function queueReadyPhases(
    instanceId: string,
    def: PipelineDefinition,
    transitioned: PipelineInstance,
    ready: number[],
    suffix = "",
  ): void {
    if (ready.length === 0) return;
    const wantIds = ready.map((i) => transitioned.phases[i].id);
    const keys = ready.map(
      (i) => `${instanceId}:${transitioned.phases[i].id}:${transitioned.phases[i].attempt}`,
    );
    for (const key of keys) queuedLaunches.add(key);
    void track(
      locks
        .withLock(instanceId, async () => {
          const fresh = await readLive(instanceId, "launch");
          // A sibling paused at a gate does not hold back a launch a committed
          // transition ordered: the approval path starts its successors
          // directly while other gates wait, and this deferred path — used by
          // gate recovery and reconcile — must not be stricter than that. A
          // terminal or aborted instance launches nothing.
          if (!fresh || (fresh.status !== "running" && fresh.status !== "awaiting-approval")) {
            return;
          }
          // Re-resolve by phase id: an abort/revise landing in the transition
          // window may have changed which work is live. Only phases that are
          // themselves running are launched — never a paused one.
          const stillWanted = wantIds
            .map((id) => fresh.phases.findIndex((p) => p.id === id))
            .filter((i) => i >= 0 && fresh.phases[i].status === "running");
          await startPhases(def, fresh, stillWanted, suffix);
        })
        .catch((e: unknown) => log.error("deferred phase start failed", { instanceId, err: e }))
        .finally(() => {
          for (const key of keys) queuedLaunches.delete(key);
        }),
    );
  }

  return {
    ensureWorkspace,
    startPhases,
    startPhase,
    resolveChangeRequest,
    launchStep,
    start,
    queueReadyPhases,
  };
}
