import { stat } from "node:fs/promises";
import path from "node:path";
import { paths } from "../claudeHome.js";
import { log } from "../log.js";
import { instanceArtifactDir } from "../harness/invocation.js";
import type { ChildArtifactsInput } from "../harness/channels.js";
import { clipText } from "./children.js";
import { decisionEffect, readGateDecisions } from "./gateDecisions.js";
import { readInstance } from "./instances.js";
import { readRuns, runInvocationDir } from "./runs.js";
import type { GateDecision } from "@argus/contracts";
import type { Run } from "./scheduleTypes.js";
import type {
  ChildrenContextSpec,
  ChildrenManifest,
  ChildrenManifestCost,
  ChildrenManifestDecision,
  ChildrenManifestInstance,
  ChildrenManifestPhase,
  ChildrenManifestRun,
  ChildrenManifestTask,
  PhaseFailurePayload,
  PhaseProgress,
  PipelineInstance,
  SpawnTaskState,
} from "./pipelineTypes.js";

/**
 * The children manifest (DL-A2b): what a phase that declares
 * `childrenContext` is told about the children an earlier spawn phase of its
 * instance started — every task in list order, each task's child (and any
 * child a fresh one replaced) with its phases, results, verification, gate
 * decisions and the cost its runs recorded — and about its own instance's
 * phases, decisions and cost. A later phase (a retrospective, a ship step)
 * reads it at `ARGUS_CHILDREN_FILE`, and each child's artifact folder as a
 * read channel.
 *
 * **Built once per phase attempt**, in `startPhase` beside the ledger
 * snapshot, and written per run by `launchStep`: every run of the attempt
 * reads the same bytes, the run's supplied inputs carry their hash, and the
 * completion re-hashes them. A retry or a revise builds a fresh one.
 *
 * **An explicit projection**, never a spread of a record: no signal token, no
 * definition (it holds the hook token), no prompt, and no decision's
 * principal. The agent's environment has no Argus token, so this file is all
 * it learns of the decisions and the cost, and it learns nothing of who made
 * them.
 *
 * {@link buildChildrenManifest} is pure; {@link planChildrenManifest} is the
 * I/O shell that reads the children, the decisions log and the runs once.
 * Child records are read without their locks: the caller holds the parent's,
 * and a parent's lock never waits for a child's (HARNESS.md §20, Lock order).
 */

/** Most child artifact folders one run is offered as read channels. Each adds
 *  an `--add-dir` and a deny rule to a Claude Code command line, and a Windows
 *  command line holds 32,767 characters: 100 folders is about 16,000. Past it,
 *  the remaining (earlier, replaced) children are listed without a folder. */
export const CHILD_ARTIFACT_CHANNELS_MAX = 100;
/** A failed phase's reason, as the manifest carries it. */
export const MANIFEST_REASON_MAX_CHARS = 2000;
/** A run's recorded error, as the manifest carries it. */
export const MANIFEST_RUN_ERROR_MAX_CHARS = 500;

/** Where one run's copy of the manifest goes: in a folder of its own under the
 *  run's invocation directory, so the read channel admits nothing else. */
export function childrenManifestFile(runId: string): string {
  return path.join(runInvocationDir(runId), "children", "children-manifest.json");
}

// ── The pure builder ──────────────────────────────────────────────────────────

/** Everything the manifest is built from, read once per attempt. */
export interface ChildrenManifestSources {
  parent: PipelineInstance;
  /** `childrenContext.fromPhase`. */
  fromPhase: string;
  /** The phase attempt the manifest is for. */
  phaseId: string;
  attempt: number;
  generatedAt: string;
  /** Every child record, by instance id; null = it could not be read. */
  children: ReadonlyMap<string, PipelineInstance | null>;
  /** Decisions about the parent or any child, in record order. */
  decisions: readonly GateDecision[];
  /** Runs of the parent or any child, any order. */
  runs: readonly Run[];
  /** The child folders offered as read channels, by child instance id. */
  artifactDirs: ReadonlyMap<string, string>;
  warnings: readonly string[];
}

const finiteOrNull = (v: number | null | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The runs' cost as recorded, summed. No estimate of its own: a supported
 *  Codex model's `costUsd` is already Argus's list-price estimate, and counts
 *  as priced like any other. */
function costOf(runs: readonly Run[]): ChildrenManifestCost {
  let usd = 0;
  let priced = 0;
  let tokens = 0;
  let counted = 0;
  let ms = 0;
  for (const r of runs) {
    const cost = finiteOrNull(r.costUsd);
    if (cost !== null) {
      usd += cost;
      priced++;
    }
    const used = finiteOrNull(r.tokens);
    if (used !== null) {
      tokens += used;
      counted++;
    }
    ms += finiteOrNull(r.durationMs) ?? 0;
  }
  return {
    runs: runs.length,
    costUsd: priced > 0 ? Math.round(usd * 10_000) / 10_000 : null,
    tokens: counted > 0 ? tokens : null,
    unpricedRuns: runs.length - priced,
    durationMs: ms,
  };
}

function runEntry(r: Run): ChildrenManifestRun {
  return {
    runId: r.id,
    status: r.status,
    queuedAt: r.queuedAt,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    durationMs: finiteOrNull(r.durationMs),
    costUsd: finiteOrNull(r.costUsd),
    tokens: finiteOrNull(r.tokens),
    model: r.model ?? null,
    // Absent means Claude Code: every run before runtimes existed was one.
    runtime: r.runtime ?? "claude",
    ...(r.outcome ? { outcome: r.outcome } : {}),
    ...(r.termination ? { termination: r.termination } : {}),
    ...(r.error ? { error: clipText(r.error, MANIFEST_RUN_ERROR_MAX_CHARS) } : {}),
  };
}

/** Why a failed phase failed, from its payload: a {@link PhaseFailurePayload},
 *  or a bare string, which is the reason. */
function failureOf(p: PhaseProgress): ChildrenManifestPhase["failure"] {
  if (p.status !== "failed") return undefined;
  const payload = p.payload;
  const narrowed: PhaseFailurePayload = isPlainObject(payload)
    ? (payload as PhaseFailurePayload)
    : typeof payload === "string"
      ? { reason: payload }
      : {};
  const reason = typeof narrowed.reason === "string" ? narrowed.reason.trim() : "";
  const failureClass = narrowed.failureClass;
  if (!failureClass && !reason) return undefined;
  return {
    ...(failureClass ? { failureClass } : {}),
    ...(reason ? { reason: clipText(reason, MANIFEST_REASON_MAX_CHARS) } : {}),
  };
}

function phaseEntry(
  p: PhaseProgress,
  phaseRuns: readonly Run[],
  withFolder: boolean,
): ChildrenManifestPhase {
  const failure = failureOf(p);
  return {
    id: p.id,
    name: p.name,
    status: p.status,
    attempt: p.attempt,
    gated: p.gated,
    ...(p.pause ? { pause: p.pause } : {}),
    ...(p.retries ? { retries: p.retries } : {}),
    ...(p.result !== undefined ? { result: p.result } : {}),
    ...(failure ? { failure } : {}),
    ...(p.verification ? { verification: p.verification } : {}),
    ...(withFolder && p.artifactDir ? { artifactDir: p.artifactDir } : {}),
    ...(p.workspace
      ? {
          workspace: {
            branch: p.workspace.branch,
            base: p.workspace.base,
            baseHead: p.workspace.baseHead,
          },
        }
      : {}),
    runs: phaseRuns.map(runEntry),
    cost: costOf(phaseRuns),
  };
}

function decisionEntry(
  d: GateDecision,
  effect: ChildrenManifestDecision["effect"],
): ChildrenManifestDecision {
  return {
    id: d.id,
    decision: d.decision,
    mechanism: d.mechanism,
    phases: d.phases.map(({ phaseId, attempt }) => ({ phaseId, attempt })),
    ...(d.note ? { note: d.note } : {}),
    recordedAt: d.recordedAt,
    effect,
    ...(d.parentDecisionId ? { parentDecisionId: d.parentDecisionId } : {}),
  };
}

/**
 * The manifest, or why there is none: the named phase is not a phase of this
 * instance (an instance running against a live definition it predates). Pure
 * and deterministic: the same sources give the same document, key for key.
 */
export function buildChildrenManifest(
  src: ChildrenManifestSources,
): ChildrenManifest | { error: string } {
  const spawn = src.parent.phases.find((p) => p.id === src.fromPhase);
  if (!spawn) {
    return { error: `children context: phase "${src.fromPhase}" is not a phase of this instance` };
  }
  const tasks = spawn.children?.tasks ?? [];

  const runsOf = (id: string): Run[] =>
    src.runs
      .filter((r) => r.instanceId === id)
      .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt) || a.id.localeCompare(b.id));

  // Only a decision the instance links took effect (`decisionEffect`), the
  // same filter the revise notes use. Oldest first; `sort` is stable.
  const decisionsOf = (record: PipelineInstance): ChildrenManifestDecision[] =>
    src.decisions
      .filter((d) => d.instanceId === record.id)
      .flatMap((d) => {
        const effect = decisionEffect(d, record);
        return effect === "applied" || effect === "incomplete" ? [decisionEntry(d, effect)] : [];
      })
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));

  const instanceEntry = (
    id: string,
    record: PipelineInstance | null,
    folder?: string,
  ): ChildrenManifestInstance => {
    if (!record) return { instanceId: id, status: null };
    const runs = runsOf(id);
    return {
      instanceId: id,
      status: record.status,
      pipelineId: record.pipelineId,
      createdAt: record.createdAt,
      endedAt: record.endedAt,
      ...(record.abortCause ? { abortCause: record.abortCause } : {}),
      ...(folder ? { artifactsDir: folder } : {}),
      phases: record.phases.map((p) =>
        phaseEntry(
          p,
          runs.filter((r) => r.phaseId === p.id),
          folder !== undefined,
        ),
      ),
      decisions: decisionsOf(record),
      cost: costOf(runs),
    };
  };

  const childEntry = (id: string): ChildrenManifestInstance =>
    instanceEntry(id, src.children.get(id) ?? null, src.artifactDirs.get(id));

  const childIds = new Set<string>();
  const counts: Partial<Record<SpawnTaskState, number>> = {};
  const taskEntries = tasks.map((t, index): ChildrenManifestTask => {
    counts[t.state] = (counts[t.state] ?? 0) + 1;
    const earlierIds = t.previousInstanceIds ?? [];
    for (const id of [...(t.instanceId ? [t.instanceId] : []), ...earlierIds]) childIds.add(id);
    // What the current child received, exactly (`SpawnTriggerPayload.task`).
    const payload = t.instanceId ? src.children.get(t.instanceId)?.triggerPayload : undefined;
    const given = isPlainObject(payload) ? payload.task : undefined;
    const task = isPlainObject(given) ? given : undefined;
    const earlier = earlierIds.map(childEntry);
    return {
      index,
      key: t.key,
      ...(t.title ? { title: t.title } : {}),
      // Positions on the parent; keys here, which is how the task list said it.
      dependsOn: (t.dependsOn ?? []).flatMap((i) => (tasks[i] ? [tasks[i].key] : [])),
      state: t.state,
      ...(t.reason ? { reason: t.reason } : {}),
      ...(task ? { task } : {}),
      ...(t.instanceId ? { child: childEntry(t.instanceId) } : {}),
      ...(earlier.length > 0 ? { earlierChildren: earlier } : {}),
    };
  });

  return {
    schemaVersion: 1,
    generatedAt: src.generatedAt,
    for: { instanceId: src.parent.id, phaseId: src.phaseId, attempt: src.attempt },
    spawnPhase: {
      id: spawn.id,
      name: spawn.name,
      status: spawn.status,
      attempt: spawn.attempt,
      childPipelineId: spawn.children?.pipelineId ?? null,
      counts,
    },
    tasks: taskEntries,
    // No folder for the parent: a read channel over its artifacts would deny
    // edits over this phase's own write channel beneath it (HARNESS.md §20).
    parent: instanceEntry(src.parent.id, src.parent),
    childrenCost: costOf(
      src.runs.filter(
        (r) =>
          r.instanceId !== undefined &&
          r.instanceId !== src.parent.id &&
          childIds.has(r.instanceId),
      ),
    ),
    warnings: [...src.warnings],
  };
}

// ── The I/O shell ─────────────────────────────────────────────────────────────

export type ChildrenManifestPlan =
  | {
      manifest: ChildrenManifest;
      /** The manifest as written: JSON, 2-space indent, trailing newline. */
      contents: string;
      /** The child folders to offer as read channels, in manifest order. */
      artifactDirs: ChildArtifactsInput[];
    }
  | { error: string };

/**
 * Read everything the manifest needs, once, and build it. Called by
 * `startPhase` under the parent's lock; takes no other lock. Never throws for
 * a read it cannot make: an unreadable child record or decisions log becomes a
 * line in `warnings` (and the server log). Only a manifest that cannot be
 * built at all — the named phase is not on the instance — is an error.
 */
export async function planChildrenManifest(
  inst: PipelineInstance,
  spec: ChildrenContextSpec,
  at: { phaseId: string; attempt: number; generatedAt: string },
  opts: { maxFolders?: number } = {},
): Promise<ChildrenManifestPlan> {
  const spawn = inst.phases.find((p) => p.id === spec.fromPhase);
  if (!spawn) {
    return { error: `children context: phase "${spec.fromPhase}" is not a phase of this instance` };
  }
  const tasks = spawn.children?.tasks ?? [];
  // Current children first, in task order, then the ones they replaced: the
  // order folders are offered in, so a cap drops history before the present.
  const keyOf = new Map<string, string>();
  const name = (id: string, key: string) => {
    if (!keyOf.has(id)) keyOf.set(id, key);
  };
  for (const t of tasks) if (t.instanceId) name(t.instanceId, t.key);
  for (const t of tasks) for (const id of t.previousInstanceIds ?? []) name(id, t.key);
  const ids = [...keyOf.keys()];
  const warnings: string[] = [];

  const children = new Map(
    await Promise.all(ids.map(async (id) => [id, await readInstance(id)] as const)),
  );
  for (const [id, record] of children) {
    if (record) continue;
    warnings.push(`child ${id} of task "${keyOf.get(id)}": its record could not be read`);
  }

  // One read of the decisions log for the parent and every child: with an
  // instance id, each call would re-read the whole file.
  const wanted = new Set([inst.id, ...ids]);
  let decisions: GateDecision[] = [];
  try {
    decisions = (await readGateDecisions()).filter((d) => wanted.has(d.instanceId));
  } catch (e) {
    warnings.push(
      `gate decisions could not be read: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const runs = (await readRuns()).filter(
    (r) => r.instanceId !== undefined && wanted.has(r.instanceId),
  );

  // A folder is offered only when it exists: Claude Code is handed `--add-dir`
  // for every channel, and a child that never started a phase has none.
  const max = opts.maxFolders ?? CHILD_ARTIFACT_CHANNELS_MAX;
  const artifactDirs = new Map<string, string>();
  const channels: ChildArtifactsInput[] = [];
  let skipped = 0;
  for (const id of ids) {
    if (!children.get(id)) continue;
    const dir = instanceArtifactDir(paths.artifactsDir(), id);
    if (!(await stat(dir).catch(() => null))?.isDirectory()) continue;
    if (channels.length >= max) {
      skipped++;
      continue;
    }
    artifactDirs.set(id, dir);
    channels.push({ dir, instanceId: id, key: keyOf.get(id) ?? "" });
  }
  if (skipped > 0) {
    warnings.push(
      `${skipped} child artifact folder${skipped === 1 ? " was" : "s were"} not offered: ` +
        `at most ${max} per run`,
    );
  }

  const built = buildChildrenManifest({
    parent: inst,
    fromPhase: spec.fromPhase,
    phaseId: at.phaseId,
    attempt: at.attempt,
    generatedAt: at.generatedAt,
    children,
    decisions,
    runs,
    artifactDirs,
    warnings,
  });
  if ("error" in built) return built;
  if (warnings.length > 0) {
    log.warn("children manifest built with warnings", {
      instanceId: inst.id,
      phaseId: at.phaseId,
      warnings,
    });
  }
  return {
    manifest: built,
    contents: `${JSON.stringify(built, null, 2)}\n`,
    artifactDirs: channels,
  };
}
