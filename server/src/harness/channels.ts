/**
 * The Argus-owned invocation channels: the one place that says which files and
 * directories Argus itself hands an agent process, under which environment
 * variable, with what access, and whether the launch depends on them.
 *
 * Before this existed, each channel was bolted on separately — the artifact
 * directory got `--add-dir`, then the memory directory did, then the
 * KnowledgeDelta directory, each with its own field on the capability request
 * and its own branch in every runtime — and the result file got nothing at
 * all, so a restricted Codex step could be *told* to write its decision to a
 * path its sandbox would refuse. Now the engine builds one list here, every
 * runtime maps the list (docs/HARNESS.md § Argus-owned invocation channels),
 * and `prepareInvocation` decides what an unreachable channel means.
 *
 * Pure. The KnowledgeContext file (Phase 4) is the one read channel: Argus →
 * agent, `access: "read"`, through the same list — a runtime that grants a
 * directory grants it whichever way the data flows, and the one thing a
 * runtime does differently for a read channel is refuse to make it writable.
 */

import path from "node:path";
import type { InvocationChannel } from "../runtimes/types.js";
import type { PhaseDef } from "../sources/pipelineTypes.js";

export interface ChannelInputs {
  /** `ARGUS_RESULT_FILE`, when this step publishes the phase's structured result. */
  resultFile: string | null;
  /** `ARGUS_KNOWLEDGE_DELTA_FILE`. Null only when the protocol is off (tests). */
  knowledgeDeltaFile: string | null;
  /** `ARGUS_KNOWLEDGE_CONTEXT_FILE`, when the step declares a
   *  `knowledgeContext`. Null = no semantic context for this run. */
  knowledgeContextFile?: string | null;
  /** `ARGUS_RULE_VERIFICATION_FILE`, when the phase declares
   *  `ruleVerification`. Null = this is not a verification phase. */
  ruleVerificationFile?: string | null;
  /** `ARGUS_ARTIFACT_DIR`. */
  artifactDir: string | null;
  /** `ARGUS_MEMORY_DIR`, when the pipeline's `memory` is enabled. */
  memoryDir: string | null;
  /** The phase the step belongs to: what it declares decides which channels
   *  the launch *depends on*, as opposed to merely offers. */
  phaseDef: Pick<PhaseDef, "checks" | "knowledgeDelta" | "ruleVerification">;
}

/** Does the phase run an `artifact` check, i.e. read the artifact directory back? */
export function phaseUsesArtifacts(phaseDef: Pick<PhaseDef, "checks">): boolean {
  return (phaseDef.checks ?? []).some((c) => c.kind === "artifact");
}

/**
 * Every channel this invocation offers, in a fixed order (result, delta,
 * context, rule verification, artifacts, memory) so records and argv are
 * deterministic.
 *
 * Which channels are *required* — the ones a runtime must be able to deliver
 * or the launch is refused under strict enforcement — follows from what the
 * phase actually depends on, never from the channel merely being present:
 *
 * - the result file, whenever the step publishes one: the phase's routing
 *   reads it, and a result Argus cannot receive is a phase that cannot succeed;
 * - the artifact directory, when the phase declares an `artifact` check —
 *   "write when used". Every run is offered the directory; only a phase that
 *   will fail without files in it depends on it;
 * - the memory directory, whenever `memory` is enabled: every step's prompt
 *   then instructs the agent to append to `NOTES.md`;
 * - the KnowledgeDelta file only when the phase says `knowledgeDelta:
 *   "required"`. The protocol is offered to every run and emitting a delta
 *   stays optional, so an ordinary step never fails to launch over it; a
 *   phase whose purpose is to propose knowledge opts in to the guarantee;
 * - the KnowledgeContext file whenever the step has one: the step was
 *   authored to reason from that context, and an agent that cannot read it
 *   would run without the premises its author selected. Read access only —
 *   the agent never writes it;
 * - the rule-verification file whenever the phase declares
 *   `ruleVerification`. Unlike the KnowledgeDelta, which every run is merely
 *   offered, this channel *is* the phase's output: a verification phase that
 *   cannot write its conformance results has no way to succeed, so the launch
 *   depends on it.
 */
export function invocationChannels(inputs: ChannelInputs): InvocationChannel[] {
  const out: InvocationChannel[] = [];
  if (inputs.resultFile) {
    out.push({
      kind: "result",
      envVar: "ARGUS_RESULT_FILE",
      path: inputs.resultFile,
      dir: path.dirname(inputs.resultFile),
      access: "write",
      required: true,
      label: "result file",
    });
  }
  if (inputs.knowledgeDeltaFile) {
    out.push({
      kind: "knowledge-delta",
      envVar: "ARGUS_KNOWLEDGE_DELTA_FILE",
      path: inputs.knowledgeDeltaFile,
      dir: path.dirname(inputs.knowledgeDeltaFile),
      access: "write",
      required: inputs.phaseDef.knowledgeDelta === "required",
      label: "KnowledgeDelta file",
    });
  }
  if (inputs.knowledgeContextFile) {
    out.push({
      kind: "knowledge-context",
      envVar: "ARGUS_KNOWLEDGE_CONTEXT_FILE",
      path: inputs.knowledgeContextFile,
      dir: path.dirname(inputs.knowledgeContextFile),
      access: "read",
      required: true,
      label: "KnowledgeContext file",
    });
  }
  if (inputs.ruleVerificationFile) {
    out.push({
      kind: "rule-verification",
      envVar: "ARGUS_RULE_VERIFICATION_FILE",
      path: inputs.ruleVerificationFile,
      dir: path.dirname(inputs.ruleVerificationFile),
      access: "write",
      required: true,
      label: "rule-verification file",
    });
  }
  if (inputs.artifactDir) {
    out.push({
      kind: "artifact-dir",
      envVar: "ARGUS_ARTIFACT_DIR",
      path: inputs.artifactDir,
      dir: inputs.artifactDir,
      access: "write",
      required: phaseUsesArtifacts(inputs.phaseDef),
      label: "artifact directory",
    });
  }
  if (inputs.memoryDir) {
    out.push({
      kind: "memory-dir",
      envVar: "ARGUS_MEMORY_DIR",
      path: inputs.memoryDir,
      dir: inputs.memoryDir,
      access: "write",
      required: true,
      label: "memory directory",
    });
  }
  return out;
}
