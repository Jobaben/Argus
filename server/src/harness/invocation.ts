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
import { invocationChannels } from "./channels.js";
import { runtimeFor, resolveRuntimeId } from "../runtimes/index.js";
import type {
  CapabilityRequest,
  ChannelOutcome,
  InvocationChannel,
  MaterializedFile,
  SpawnPlan,
} from "../runtimes/types.js";
import type { Run } from "../sources/scheduleTypes.js";
import type { InvocationKnowledgeContext } from "@argus/contracts";
import type {
  AgentInvocationRecord,
  CapabilityProfile,
  InvocationChannelRecord,
  PhaseDef,
  PhaseStep,
  PipelineDefinition,
  WorkspaceRecord,
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
  /** This pipeline's durable-notes directory, when `memory` is enabled. */
  memoryDir?: string | null;
  /** The isolated worktree the step runs in, when its phase declared one. */
  workspace?: WorkspaceRecord | null;
  resultFile: string | null;
  /** Where this run may leave its KnowledgeDelta. One of the Argus-owned
   *  channels the runtime is asked to make reachable. Absent = the protocol is
   *  off for this invocation (tests that build one by hand). */
  knowledgeDeltaFile?: string | null;
  /**
   * The read-only KnowledgeContext Argus materialized for this run, when the
   * step declares one: where the file is, and exactly what it holds (exact
   * refs, sha256). The channel it becomes is `required` — the step was
   * authored to reason from this context. Absent/null = no semantic context.
   */
  knowledgeContext?: { file: string; record: InvocationKnowledgeContext } | null;
  /** Where this run must leave its rule-verification report, when its phase
   *  declares `ruleVerification` (Phase 6). The channel it becomes is
   *  `required`: it is the phase's output, not an optional proposal.
   *  Absent/null = this is not a verification phase. */
  ruleVerificationFile?: string | null;
  /** Where this run's read-only ChangeIntentInput was materialized, when its
   *  phase declares `changeIntent` (Phase 7). The channel it becomes is
   *  `required`: it is the phase's input. */
  changeRequestFile?: string | null;
  /** Where this run must leave its ChangeProposal, when its phase declares
   *  `changeIntent`. `required`: it is the phase's output. */
  changeProposalFile?: string | null;
  /** Where this run's read-only ChangeContext was materialized, when its phase
   *  declares `changeContext`. `required`: the step was authored to implement
   *  that accepted intent. */
  changeContextFile?: string | null;
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
   * runtime cannot enforce, or a channel the launch depends on is unreachable,
   * and enforcement is strict. Empty means launch.
   */
  blocking: string[];
}

/**
 * The runtime's verdicts on the channels it was handed, made total: a runtime
 * that answers for a channel decides it; one that fails to mention a channel
 * has not made it reachable, and the gap is reported as such rather than
 * assumed away. Fail closed — a protocol path is never presumed writable.
 */
export function settleChannels(
  channels: InvocationChannel[],
  reported: ChannelOutcome[] | undefined,
  runtimeLabel: string,
): ChannelOutcome[] {
  return channels.map((channel) => {
    const verdict = reported?.find(
      (o) => o.channel.kind === channel.kind && o.channel.path === channel.path,
    );
    if (verdict) return verdict;
    return {
      channel,
      status: "unavailable",
      reason: `${runtimeLabel} did not account for the ${channel.label} (${channel.envVar})`,
    };
  });
}

function channelRecord(
  channel: InvocationChannel,
  status: InvocationChannelRecord["status"],
  reason?: string,
): InvocationChannelRecord {
  return {
    kind: channel.kind,
    envVar: channel.envVar,
    path: channel.path,
    access: channel.access,
    required: channel.required,
    status,
    ...(reason !== undefined ? { reason } : {}),
  };
}

export function prepareInvocation(inputs: InvocationInputs): PreparedInvocation {
  const { run, def, phaseDef, stepDef } = inputs;
  const runtimeId = resolveRuntimeId(run.runtime);
  const runtime = runtimeFor(runtimeId);
  const profile = resolveCapabilities(def, phaseDef, stepDef);
  // Every Argus-owned path this invocation is told about, with the access it
  // needs and whether the launch depends on it. Built once, here; the runtime
  // maps the whole list and answers for every entry.
  const channels = invocationChannels({
    resultFile: inputs.resultFile,
    knowledgeDeltaFile: inputs.knowledgeDeltaFile ?? null,
    knowledgeContextFile: inputs.knowledgeContext?.file ?? null,
    ruleVerificationFile: inputs.ruleVerificationFile ?? null,
    changeRequestFile: inputs.changeRequestFile ?? null,
    changeProposalFile: inputs.changeProposalFile ?? null,
    changeContextFile: inputs.changeContextFile ?? null,
    artifactDir: inputs.artifactDir,
    memoryDir: inputs.memoryDir ?? null,
    phaseDef,
  });
  const capabilities: CapabilityRequest | undefined = profile
    ? {
        profile,
        invocationDir: inputs.invocationDir,
        cwd: run.cwd,
        channels,
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
  const strict = (profile?.enforcement ?? "strict") === "strict";

  // What each channel's availability means. With a profile, the runtime was
  // asked to map every channel and its verdicts stand: an unreachable channel
  // is a recorded limitation always, and a refusal when the launch depends on
  // it and enforcement is strict. Without a profile Argus does not shape the
  // runtime's filesystem at all — the CLI's own defaults apply, exactly as
  // before capability profiles existed — so it records the channels it offered
  // and claims nothing about them.
  let channelRecords: InvocationChannelRecord[];
  let channelLimitations: string[] = [];
  let channelBlocking: string[] = [];
  if (profile) {
    const outcomes = settleChannels(channels, plan.channels, runtime.label);
    channelRecords = outcomes.map((o) => channelRecord(o.channel, o.status, o.reason));
    const unavailable = outcomes.filter((o) => o.status === "unavailable");
    channelLimitations = unavailable.map((o) => o.reason ?? `${o.channel.label} is unavailable`);
    channelBlocking = unavailable
      .filter((o) => o.channel.required)
      .map((o) => o.reason ?? `${o.channel.label} is unavailable`);
  } else {
    channelRecords = channels.map((c) => channelRecord(c, "unmanaged"));
  }
  const profileLimitations = plan.limitations ?? [];
  const limitations = [...profileLimitations, ...channelLimitations];

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
    capabilities: profile ? redactProfile(profile) : null,
    limitations,
    materializedFiles: files.map((f) => f.path),
    artifactDir: inputs.artifactDir,
    ...(inputs.workspace !== undefined ? { workspace: inputs.workspace } : {}),
    resultFile: inputs.resultFile,
    knowledgeDeltaFile: inputs.knowledgeDeltaFile ?? null,
    knowledgeContextFile: inputs.knowledgeContext?.file ?? null,
    knowledgeContext: inputs.knowledgeContext?.record ?? null,
    ruleVerificationFile: inputs.ruleVerificationFile ?? null,
    changeRequestFile: inputs.changeRequestFile ?? null,
    changeProposalFile: inputs.changeProposalFile ?? null,
    changeContextFile: inputs.changeContextFile ?? null,
    channels: channelRecords,
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
    // Strict: a profile the runtime cannot enforce, or a required channel it
    // cannot reach, refuses the launch. An optional channel it cannot reach is
    // on the record but never a reason not to run. Best-effort: never refuse;
    // the record carries every limitation either way.
    blocking: strict ? [...profileLimitations, ...channelBlocking] : [],
  };
}

const REDACTED = "<redacted>";

/**
 * The profile as the record may show it: every value an author could have
 * put a secret in — `env.set`, an MCP server's `env` and `headers` — replaced
 * by a marker, keys kept. The values still reach the process (and the
 * materialized MCP config) where they are needed; the record is read by
 * anyone with a session, and promises to hold names only.
 */
export function redactProfile(profile: CapabilityProfile): CapabilityProfile {
  const redactValues = (r: Record<string, string> | undefined) =>
    r ? Object.fromEntries(Object.keys(r).map((k) => [k, REDACTED])) : undefined;
  const out: CapabilityProfile = { ...profile };
  if (profile.env?.set) out.env = { ...profile.env, set: redactValues(profile.env.set) };
  if (profile.mcpServers) {
    out.mcpServers = Object.fromEntries(
      Object.entries(profile.mcpServers).map(([name, spec]) => [
        name,
        {
          ...spec,
          ...(spec.env ? { env: redactValues(spec.env) } : {}),
          ...(spec.headers ? { headers: redactValues(spec.headers) } : {}),
        },
      ]),
    );
  }
  return out;
}

/** One path segment derived from an identifier: anything outside
 *  `[A-Za-z0-9._-]` becomes `_`, and a segment that would mean "here" or
 *  "up" becomes a literal name. Validation already enforces the same shape;
 *  this keeps a directory join from ever leaving its root even if it didn't. */
export function safeSegment(id: string): string {
  const s = id.replace(/[^A-Za-z0-9._-]/g, "_");
  return s === "" || s === "." || s === ".." ? `_${s}_` : s;
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
  return path.join(root, safeSegment(instanceId), safeSegment(phaseId));
}

/** Where one candidate of a phase attempt leaves its file artifacts: a
 *  subdirectory of the phase's own, so the candidates cannot satisfy each
 *  other's `artifact` checks and the winner's files stay identifiable. */
export function candidateArtifactDir(phaseDir: string, candidate: number): string {
  return path.join(phaseDir, `c${Math.max(0, Math.trunc(candidate))}`);
}

/** Where a phase attempt's working-tree baseline is kept, beside the run
 *  invocation records, out of the agent's reach. */
export function phaseBaselinePath(
  root: string,
  instanceId: string,
  phaseId: string,
  attempt: number,
  /** Which candidate of the attempt this baseline belongs to. Absent for an
   *  ordinary attempt, whose steps all share one working tree and one baseline. */
  candidate?: number,
): string {
  const suffix = candidate === undefined ? "" : `.c${Math.max(0, Math.trunc(candidate))}`;
  return path.join(
    root,
    safeSegment(instanceId),
    `${safeSegment(phaseId)}.${Math.max(0, Math.trunc(attempt))}${suffix}.baseline.json`,
  );
}
