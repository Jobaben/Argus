/**
 * Preparing one agent invocation: what Argus is about to launch, decided in
 * full before anything is spawned.
 *
 * The pipeline engine used to hand the runtime a prompt and a model and inherit
 * everything else — its own environment, the operator's global CLI config —
 * into the child. Here the step's declared capability profile is resolved, the
 * runtime maps it onto flags and config files, the child environment is built
 * under the profile's policy, and the result is written down as an
 * {@link AgentInvocationRecord} beside the run. A person reading that record
 * can answer "what exactly did Argus ask this agent to do, with which
 * capabilities, against which repository state?" — and reproduce it.
 *
 * Pure: nothing here touches the filesystem. The engine writes the files this
 * returns, in the order it chooses, and owns every side effect.
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildChildEnv } from "./childEnv.js";
import { runtimeFor, resolveRuntimeId } from "../runtimes/index.js";
import type { CapabilityRequest, MaterializedFile, SpawnPlan } from "../runtimes/types.js";
import type { Run } from "../sources/scheduleTypes.js";
import type {
  AgentInvocationRecord,
  CapabilityProfile,
  PhaseDef,
  PhaseStep,
  PipelineDefinition,
} from "../sources/pipelineTypes.js";

/**
 * Narrowest wins, key by key: a step's profile overrides the keys its phase
 * sets, which override the pipeline's. Merging by top-level key (rather than
 * replacing the whole profile) is what lets a pipeline set an environment
 * policy once and a single review phase add `filesystem: "read-only"` without
 * restating it. Absent everywhere = no profile: the CLI's own defaults, exactly
 * as before capabilities existed.
 */
export function resolveCapabilities(
  def: Pick<PipelineDefinition, "capabilities">,
  phaseDef: Pick<PhaseDef, "capabilities">,
  stepDef: Pick<PhaseStep, "capabilities">,
): CapabilityProfile | undefined {
  const layers = [def.capabilities, phaseDef.capabilities, stepDef.capabilities].filter(
    (c): c is CapabilityProfile => c !== undefined,
  );
  if (layers.length === 0) return undefined;
  return Object.assign({}, ...layers) as CapabilityProfile;
}

/** A step's limit, else its phase's, else none. */
export function resolveTimeoutSeconds(
  phaseDef: Pick<PhaseDef, "timeoutSeconds">,
  stepDef: Pick<PhaseStep, "timeoutSeconds">,
): number | null {
  return stepDef.timeoutSeconds ?? phaseDef.timeoutSeconds ?? null;
}

/** Canonical hook source shipped in the repo: <repo>/hooks/argus-signal.mjs */
const REPO_HOOK_SRC = fileURLToPath(new URL("../../../hooks/argus-signal.mjs", import.meta.url));

/**
 * The command line for Argus's completion hook, registered per invocation.
 *
 * Points at the hook shipped with this Argus rather than the copy the Setup
 * panel installs under the CLI's home, so an invocation-owned registration
 * never depends on that install step having run (or on it being current).
 */
export function invocationHookCommand(arg?: string): string {
  const p = REPO_HOOK_SRC.replace(/\\/g, "/");
  return arg ? `node "${p}" ${arg}` : `node "${p}"`;
}

export interface InvocationInputs {
  run: Run;
  def: PipelineDefinition;
  phaseDef: PhaseDef;
  stepDef: PhaseStep;
  instanceId: string;
  attempt: number;
  /** The Argus-owned instructions carried into the agent's system prompt. */
  systemPrompt: string;
  /** Argus's per-run signal environment (ARGUS_SIGNAL_URL and friends). */
  argusEnv: Record<string, string>;
  invocationDir: string;
  artifactDir: string | null;
  resultFile: string | null;
  timeoutSeconds: number | null;
  gitHead: string | null;
  /** The environment the policy is applied to — Argus's own, in production. */
  parentEnv: NodeJS.ProcessEnv;
  now: Date;
}

export interface PreparedInvocation {
  plan: SpawnPlan;
  /** The complete child environment, policy applied. Replaces `process.env`. */
  env: Record<string, string>;
  files: MaterializedFile[];
  record: AgentInvocationRecord;
  /**
   * Limitations that forbid the launch: the profile asked for a restriction the
   * runtime cannot enforce and enforcement is strict. Empty means launch.
   */
  blocking: string[];
}

export function prepareInvocation(inputs: InvocationInputs): PreparedInvocation {
  const { run, def, phaseDef, stepDef } = inputs;
  const runtimeId = resolveRuntimeId(run.runtime);
  const runtime = runtimeFor(runtimeId);
  const profile = resolveCapabilities(def, phaseDef, stepDef);
  const capabilities: CapabilityRequest | undefined = profile
    ? {
        profile,
        invocationDir: inputs.invocationDir,
        cwd: run.cwd,
        artifactDir: inputs.artifactDir,
        hooks: {
          stop: invocationHookCommand(),
          gate: invocationHookCommand("needs-input"),
        },
      }
    : undefined;
  const plan = runtime.streamPlan({
    prompt: run.prompt,
    sessionId: run.sessionId,
    model: run.model,
    reasoningEffort: run.reasoningEffort,
    systemPrompt: inputs.systemPrompt,
    capabilities,
  });
  const files = plan.files ?? [];
  const limitations = plan.limitations ?? [];
  const strict = (profile?.enforcement ?? "strict") === "strict";

  const child = buildChildEnv(inputs.parentEnv, profile?.env, plan.env, inputs.argusEnv);
  const deadlineAt =
    inputs.timeoutSeconds != null
      ? new Date(inputs.now.getTime() + inputs.timeoutSeconds * 1000).toISOString()
      : null;

  const record: AgentInvocationRecord = {
    runId: run.id,
    instanceId: inputs.instanceId,
    phaseId: phaseDef.id,
    step: stepDef.name,
    attempt: inputs.attempt,
    runtime: runtimeId,
    bin: plan.bin,
    args: plan.args,
    cwd: run.cwd,
    envNames: child.passed,
    envStripped: child.stripped,
    capabilities: profile ?? null,
    limitations,
    materializedFiles: files.map((f) => f.path),
    artifactDir: inputs.artifactDir,
    resultFile: inputs.resultFile,
    timeoutSeconds: inputs.timeoutSeconds,
    deadlineAt,
    gitHead: inputs.gitHead,
    startedAt: inputs.now.toISOString(),
  };

  return {
    plan,
    env: child.env,
    files,
    record,
    blocking: strict ? limitations : [],
  };
}

/** `git rev-parse HEAD` in `cwd`, or null when it is not a repository (or git
 *  is missing). Never throws: the record is evidence, not a precondition. */
export function readGitHead(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        "git",
        ["rev-parse", "HEAD"],
        { cwd, timeout: 5000, windowsHide: true },
        (err, stdout) => resolve(err ? null : stdout.trim() || null),
      );
    } catch {
      resolve(null);
    }
  });
}

/** Where a phase attempt's steps leave their file artifacts. */
export function phaseArtifactDir(root: string, instanceId: string, phaseId: string): string {
  return path.join(root, instanceId, phaseId);
}

/** Where a phase attempt's working-tree baseline is kept, beside the run
 *  invocation records, out of the agent's reach. */
export function phaseBaselinePath(
  root: string,
  instanceId: string,
  phaseId: string,
  attempt: number,
): string {
  return path.join(root, instanceId, `${phaseId}.${attempt}.baseline.json`);
}
