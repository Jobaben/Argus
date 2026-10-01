import { readFile } from "node:fs/promises";
import type {
  Anomaly,
  Baseline,
  GateDecision,
  PhaseDef,
  PhaseProgress,
  PipelineDefinition,
  PipelineInstance,
  Run,
  Verdict,
} from "@argus/contracts";
import { paths } from "../../claudeHome.js";
import { phaseBaselinePath } from "../../harness/invocation.js";
import {
  changedSince,
  committedSince,
  diffNumstat,
  snapshotWorkingTree,
  type DiffNumstat,
  type WorkingTreeSnapshot,
} from "../../harness/verification.js";
import { repositoryStateFrom } from "../../knowledge/realization.js";
import { buildPhaseReview, type ReviewResult } from "../../sources/artifacts.js";
import { readGateDecisions } from "../../sources/gateDecisions.js";
import { readInstance, readInstances } from "../../sources/instances.js";
import { readPipelines } from "../../sources/pipelines.js";
import { readRun, readRuns } from "../../sources/runs.js";
import { readCurrentVerdicts } from "../../sources/verdict.js";
import { baselineKey, buildWatchtower, readResets } from "../../sources/watchtower.js";
import type { GateChangesInput, GateReviewInput } from "./projection.js";
import { relevantSteps } from "./projection.js";

/**
 * Where H1 reads from (RFC §Q.4). Every member is a reader: nothing here
 * writes an Argus store, takes an instance lock or starts a model call. Git is
 * read with `--no-optional-locks`, so observing a worktree never refreshes its
 * index, and only an Argus attempt worktree or a directory with a recorded
 * phase baseline is read.
 */
export interface H1Sources {
  listInstances(): Promise<PipelineInstance[]>;
  readInstance(id: string): Promise<PipelineInstance | null>;
  definitionFor(inst: PipelineInstance): Promise<PipelineDefinition | undefined>;
  readGateDecisions(instanceId: string): Promise<GateDecision[]>;
  buildReview(
    inst: PipelineInstance,
    phaseId: string,
    def: PipelineDefinition | undefined,
  ): Promise<ReviewResult>;
  readRun(id: string): Promise<Run | null>;
  watchtower(now: Date): Promise<{ anomalies: Anomaly[]; baselines: Baseline[] } | null>;
  currentVerdicts(): Promise<Verdict[]>;
  workingTree(cwd: string): Promise<WorkingTreeSnapshot | null>;
  committedSince(
    base: WorkingTreeSnapshot,
    current: WorkingTreeSnapshot,
    cwd: string,
  ): Promise<string[] | null>;
  numstat(base: string, cwd: string): Promise<DiffNumstat | null>;
  readPhaseBaseline(
    instanceId: string,
    phaseId: string,
    attempt: number,
  ): Promise<WorkingTreeSnapshot | null>;
  keyOf(run: Run): string;
}

const readOnly = { readOnly: true } as const;

export function defaultH1Sources(): H1Sources {
  return {
    listInstances: () => readInstances(),
    readInstance,
    async definitionFor(inst) {
      return inst.definition ?? (await readPipelines()).find((p) => p.id === inst.pipelineId);
    },
    readGateDecisions: (id) => readGateDecisions(id),
    buildReview: (inst, phaseId, def) => buildPhaseReview(inst, phaseId, def),
    readRun: async (id) => (await readRun(id))?.run ?? null,
    async watchtower(now) {
      try {
        const [runs, resets] = await Promise.all([readRuns(), readResets()]);
        const report = buildWatchtower(runs, resets, now);
        return { anomalies: report.anomalies, baselines: report.baselines };
      } catch {
        return null;
      }
    },
    currentVerdicts: () => readCurrentVerdicts(),
    workingTree: (cwd) => snapshotWorkingTree(cwd, readOnly),
    committedSince: (base, current, cwd) => committedSince(base, current, cwd, readOnly),
    numstat: (base, cwd) => diffNumstat(base, cwd, readOnly),
    async readPhaseBaseline(instanceId, phaseId, attempt) {
      try {
        return JSON.parse(
          await readFile(
            phaseBaselinePath(paths.invocationsDir(), instanceId, phaseId, attempt),
            "utf8",
          ),
        ) as WorkingTreeSnapshot;
      } catch {
        return null;
      }
    },
    keyOf: (run) => baselineKey(run).key,
  };
}

const unavailable = (reason: string) => ({ status: "unavailable" as const, reason });

async function gatherChanges(
  src: H1Sources,
  inst: PipelineInstance,
  phase: PhaseProgress,
  phaseDef: PhaseDef | undefined,
): Promise<GateChangesInput> {
  const ws = phase.workspace;
  if (ws?.path && ws.baseHead) {
    const current = await src.workingTree(ws.path);
    if (!current) {
      const why = unavailable("the attempt worktree is not a readable git work tree");
      return { files: why, diffStat: why, repository: null };
    }
    const base: WorkingTreeSnapshot = { head: ws.baseHead, dirty: {} };
    const committed = await src.committedSince(base, current, ws.path);
    const numstat = await src.numstat(ws.baseHead, ws.path);
    return {
      files: current.truncated
        ? unavailable("the worktree has more dirty paths than Argus snapshots")
        : committed === null
          ? unavailable("the commits since the worktree base could not be diffed")
          : {
              status: "available",
              source: "attempt-worktree",
              paths: [...new Set([...changedSince(base, current), ...committed])],
            },
      diffStat: numstat
        ? { status: "available", ...numstat }
        : unavailable("git diff --numstat failed"),
      repository: repositoryStateFrom(current),
    };
  }
  const baseline = await src.readPhaseBaseline(inst.id, phase.id, phase.attempt);
  const cwd = phaseDef?.cwd;
  if (!baseline || !cwd) {
    const why = unavailable("no attempt worktree and no recorded phase baseline");
    return { files: why, diffStat: why, repository: null };
  }
  const current = await src.workingTree(cwd);
  if (!current) {
    const why = unavailable("the phase directory is not a readable git work tree");
    return { files: why, diffStat: why, repository: null };
  }
  const committed = await src.committedSince(baseline, current, cwd);
  return {
    files:
      baseline.truncated || current.truncated
        ? unavailable("the working tree has more dirty paths than Argus snapshots")
        : committed === null
          ? unavailable("the commits since the phase baseline could not be diffed")
          : {
              status: "available",
              source: "phase-baseline",
              paths: [...new Set([...changedSince(baseline, current), ...committed])],
            },
    diffStat: unavailable("line counts need an attempt worktree base; the phase ran without one"),
    repository: repositoryStateFrom(current),
  };
}

/** Per-check memo, so one check reads the Watchtower once however many gates it looks at. */
export interface GatherCache {
  watchtower?: Promise<{ anomalies: Anomaly[]; baselines: Baseline[] } | null>;
}

/** Everything the projection needs for one phase attempt, read now. */
export async function gatherGateReview(
  src: H1Sources,
  inst: PipelineInstance,
  phase: PhaseProgress,
  def: PipelineDefinition | undefined,
  now: Date,
  cache: GatherCache,
): Promise<GateReviewInput> {
  const phaseDef = def?.phases.find((p) => p.id === phase.id);
  let review: GateReviewInput["review"];
  try {
    const r = await src.buildReview(inst, phase.id, def);
    review = r.ok ? { ok: true, review: r.review } : { ok: false, reason: r.error };
  } catch (e) {
    review = {
      ok: false,
      reason: `the review model could not be built: ${(e as Error)?.message ?? e}`,
    };
  }
  const runs = new Map<string, Run>();
  for (const s of relevantSteps(phase)) {
    if (!s.runId) continue;
    const run = await src.readRun(s.runId).catch(() => null);
    if (run) runs.set(s.runId, run);
  }
  cache.watchtower ??= src.watchtower(now);
  const w = await cache.watchtower;
  return {
    instance: inst,
    phase,
    phaseDef,
    review,
    runs,
    watchtower: w ? { ...w, keyOf: (run) => src.keyOf(run) } : null,
    changes: await gatherChanges(src, inst, phase, phaseDef),
  };
}
