import { DEFAULT_MEMORY_BYTES } from "../harness/memory.js";
import { formatClaimRef } from "../knowledge/kernel.js";
import { claudeRuntime, runtimeFor } from "../runtimes/index.js";
import type { SpawnPlan } from "../runtimes/index.js";
import type { ClaimRef } from "@argus/contracts";
import type { Run } from "../sources/scheduleTypes.js";
import type { PhaseDef, PipelineDefinition } from "../sources/pipelineTypes.js";

/**
 * Injected into every step run's system prompt so the Stop hook can derive an
 * outcome without the pipeline author writing the ARGUS_OUTCOME mechanic. Must
 * stay a pure constant — no per-run data — or the prompt cache prefix breaks.
 */
export const OUTCOME_CONTRACT =
  "When you finish, the final line of your last message must report the outcome " +
  "so the pipeline can decide whether to advance. Write `ARGUS_OUTCOME: succeeded` " +
  "if you fully met the task's stated criteria, or `ARGUS_OUTCOME: failed` " +
  "(use `blocked` if you could not proceed) followed by a one-line reason. " +
  "Judge success against the criteria in the task, not merely whether you stopped cleanly. " +
  "This is a one-shot batch run: it will not be re-invoked when background tasks or " +
  "subagents finish, so do not stop while any are still in flight. If you must stop " +
  "with deferred work unfinished, report `ARGUS_OUTCOME: blocked`.";

/**
 * The Knowledge Ledger's half of the agent contract (docs/KNOWLEDGE-LEDGER.md
 * § KnowledgeDelta protocol). Like {@link OUTCOME_CONTRACT} it is a pure
 * constant — the per-run file path travels in the environment, never in the
 * text — so the system-prompt prefix stays cacheable. Deliberately short: it
 * says that a delta is optional, where it goes, what shape it has, and the two
 * rules an agent must not break (no invented canonical ids; exact revisions
 * only). Everything else is Argus's to validate, and the whole architecture
 * does not belong in every prompt.
 */
export const KNOWLEDGE_DELTA_CONTRACT =
  "Knowledge Ledger (optional). Only if this task establishes or revises durable semantic " +
  "knowledge that later work should rely on — a business rule, fact, assumption, constraint, " +
  "conclusion or decision — write one JSON KnowledgeDelta to the file path in the " +
  "ARGUS_KNOWLEDGE_DELTA_FILE environment variable before you finish. Shape: " +
  '{"schemaVersion":1,"claims":[{"localId":"<label>","kind":"business-rule","statement":"..."}],' +
  '"revisions":[{"claimId":"<existing id>","expectedRevision":<its current revision>,"statement":"..."}],' +
  '"justifications":[{"conclusion":{"local":"<label>"},"premises":["<ID>:v<N>"]}],' +
  '"evidence":[{"claim":{"local":"<label>"},"source":{"type":"source-code","path":"..."}}],' +
  '"consumed":["<ID>:v<N>"],"artifacts":[{"location":"repository","path":"<relative path>"}]}. ' +
  "Every section is optional. Do not invent canonical ids: a new claim gets a localId of your " +
  "choosing and Argus assigns its identity. Reference existing claims only by exact revision " +
  "(ID:vN), never by bare id. Argus validates the delta and applies it only once the phase is " +
  "accepted; a delta that fails validation fails this step. Ordinary work that establishes no " +
  "durable knowledge writes no file.";

/**
 * The KnowledgeContext half of the agent contract (docs/KNOWLEDGE-LEDGER.md
 * § KnowledgeContext protocol). A pure constant like the two above — phrased
 * conditionally on the variable, because most runs have no context and the
 * system-prompt prefix must be the same for every run. It says where the
 * context is, that each ref is immutable historical identity, and how to
 * declare consumption against it. It does not describe the ledger and does
 * not ask the agent to use everything it was given.
 */
export const KNOWLEDGE_CONTEXT_CONTRACT =
  "Semantic context. If the ARGUS_KNOWLEDGE_CONTEXT_FILE environment variable is set, Argus " +
  "has supplied canonical semantic context — business rules, facts, constraints, decisions — as " +
  "a read-only JSON file at that path; read it before reasoning about the task. Each entry's " +
  '"ref" (ID:vN) is an immutable historical identity: it names exactly that revision, whose ' +
  "lifecycle and support are stated in the entry. Never modify the file. Use only what is " +
  "relevant. If you write a KnowledgeDelta that declares an existing claim as consumed, name the " +
  'exact revision you relied upon, as given by its ref. The file\'s "scope" says which project ' +
  "and repository this knowledge belongs to; Argus has already filtered the file to it, so every " +
  "entry is about the repository you are working in, and a claim you were not given is one you " +
  "may not name.";

/** Everything Argus itself tells a step's agent, in one constant. */
export const STEP_CONTRACT = `${OUTCOME_CONTRACT}\n\n${KNOWLEDGE_DELTA_CONTRACT}\n\n${KNOWLEDGE_CONTEXT_CONTRACT}`;

/**
 * The instruction a result-producing step gets appended to its prompt.
 *
 * Not part of {@link OUTCOME_CONTRACT}: that is a pure constant so the prompt
 * cache prefix holds across every run, and this text carries the phase's own
 * schema. It goes in the prompt rather than the system prompt for the same
 * reason the schema is in the definition — it is this phase's contract, not
 * Argus's.
 *
 * The two say different things and both are needed. `ARGUS_OUTCOME` reports
 * whether the run *worked*; the result file reports what it *decided*. An agent
 * that decides "reject" has succeeded operationally, and conflating the two is
 * how a failing audit becomes a failing pipeline.
 */
export function resultInstruction(result: PhaseDef["result"]): string {
  if (!result) return "";
  return (
    "\n\nStructured result required. Before you finish, write this phase's result as JSON " +
    "to the file path given in the ARGUS_RESULT_FILE environment variable. It must match " +
    `this schema: ${JSON.stringify(result.schema)}. The pipeline reads that file — not your ` +
    "message text — to decide what runs next, and the phase fails if it is missing or does " +
    "not match. Reporting `ARGUS_OUTCOME: succeeded` still means the work itself went fine, " +
    "whatever the result says."
  );
}

/**
 * The instruction a step gets when its phase requires file artifacts.
 *
 * Which files must exist afterwards is system control — a check Argus runs —
 * so Argus states it, in the prompt, beside the path the files go to. The
 * author's prompt says what the files should contain; this says that they
 * must exist and where.
 */
export function artifactInstruction(checks: PhaseDef["checks"], artifactDir: string): string {
  const required = (checks ?? []).flatMap((c) => (c.kind === "artifact" ? [c.path] : []));
  if (required.length === 0) return "";
  return (
    "\n\nRequired artifacts. Before you finish, this phase must leave the following " +
    `file${required.length === 1 ? "" : "s"} in its artifact directory ${artifactDir} ` +
    `(also given as the ARGUS_ARTIFACT_DIR environment variable): ${required.join(", ")}. ` +
    "The pipeline checks that each exists and is non-empty; the phase fails otherwise."
  );
}

/**
 * The instruction a step gets when its pipeline has `memory` enabled.
 *
 * Argus states where the file is and what it is for; what to actually write
 * in it is the author's business (or the agent's own judgment) — this is only
 * the fixed, system-owned part: the path, and the cap Argus itself enforces
 * after the fact (§ harness/memory.ts `trimMemoryIfNeeded`).
 */
export function memoryInstruction(memory: PipelineDefinition["memory"] | undefined): string {
  if (!memory?.enabled) return "";
  const cap = memory.maxBytes ?? DEFAULT_MEMORY_BYTES;
  return (
    "\n\nDurable notes for this pipeline live at $ARGUS_MEMORY_DIR/NOTES.md. Append what a " +
    "future run of this pipeline must know (decisions, gotchas, what was tried); keep it under " +
    `${cap} bytes — Argus trims the head beyond that.`
  );
}

/**
 * The instruction a step gets when Argus supplied it a KnowledgeContext:
 * how many revisions, exactly which, and where. The refs in the prompt are
 * the same refs the file carries; the file is the channel, the prompt only
 * makes sure the agent knows the context is there and what it is called.
 */
export function knowledgeContextInstruction(supplied: ClaimRef[]): string {
  if (supplied.length === 0) return "";
  const refs = supplied.map(formatClaimRef).join(", ");
  return (
    `\n\nSemantic context supplied. Argus has placed ${supplied.length} canonical claim ` +
    `revision${supplied.length === 1 ? "" : "s"} (${refs}) as read-only JSON at the path in ` +
    "the ARGUS_KNOWLEDGE_CONTEXT_FILE environment variable. Read it before reasoning about " +
    "this task; treat each ref as the exact revision to cite if you declare it consumed."
  );
}

/**
 * Build the invocation for a step run, with the outcome contract carried into
 * the agent's instructions.
 *
 * The runtime decides how that contract is delivered — Claude Code takes it on
 * `--append-system-prompt`, Codex has no such flag so it rides at the top of
 * the prompt — and both produce a run that reports `ARGUS_OUTCOME` the same way.
 * Kept pure for unit testing.
 */
export function buildStepPlan(run: Run): SpawnPlan {
  return runtimeFor(run.runtime).streamPlan({
    prompt: run.prompt,
    sessionId: run.sessionId,
    model: run.model,
    reasoningEffort: run.reasoningEffort,
    systemPrompt: STEP_CONTRACT,
  });
}

/** The Claude Code argument vector for a step run. Retained as the narrow,
 *  named form of {@link buildStepPlan} for callers and tests that mean Claude. */
export function buildClaudeArgs(run: Run): string[] {
  return claudeRuntime.streamPlan({
    prompt: run.prompt,
    sessionId: run.sessionId,
    model: run.model,
    systemPrompt: STEP_CONTRACT,
  }).args;
}
