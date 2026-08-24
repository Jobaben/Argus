import { existsSync, statSync } from "node:fs";
import { paths } from "../claudeHome.js";
import { validateTrigger } from "./schedules.js";
import { createJsonArrayStore } from "./jsonArrayStore.js";
import type { Dependency, PhaseDef, PhaseStep, PipelineDefinition } from "./pipelineTypes.js";
import type { Trigger } from "./scheduleTypes.js";
import { RubricValidationError, validateAutoApprove, validateRubric } from "./verdict.js";
import { DagValidationError, validateDag } from "./dag.js";
import {
  RouteAuthoringError,
  validateDependency,
  validatePhaseResult,
  validateRoutes,
} from "./routeAuthoring.js";
import { isRuntimeId, runtimeIdList } from "../runtimes/index.js";
import type { AgentRuntimeId, ReasoningEffort } from "@argus/contracts";

// The crash-safe, mutex-serialized single-file store (shared with schedules).
const store = createJsonArrayStore<PipelineDefinition>({
  file: paths.pipelinesFile,
  label: "pipelines.json",
});
const withStoreLock = store.withLock;

export class PipelineValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipelineValidationError";
  }
}

export interface PipelineInput {
  name: string;
  phases: PhaseDef[];
  trigger: Trigger | null;
  enabled?: boolean;
  overlapPolicy?: "skip" | "allow";
  model?: string;
  reasoningEffort?: ReasoningEffort;
  runtime?: AgentRuntimeId;
}

// Model names are passed as a `--model <value>` argv pair to the agent CLI.
// Reject anything that could be mistaken for a flag (leading dash) or smuggle
// shell metacharacters on the win32 shell:true path — only plain identifier
// chars, plus the `/` that OpenCode's `<provider>/<model>` addressing requires.
// A slash is neither a shell metacharacter nor a flag introducer, and the first
// character still has to be alphanumeric.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const REASONING_EFFORTS = new Set<ReasoningEffort>(["minimal", "low", "medium", "high", "xhigh"]);

function validateReasoningEffort(raw: unknown, ctx: string): ReasoningEffort {
  if (!REASONING_EFFORTS.has(raw as ReasoningEffort)) {
    throw new PipelineValidationError(
      `${ctx}: reasoningEffort must be ${[...REASONING_EFFORTS].join(" | ")}`,
    );
  }
  return raw as ReasoningEffort;
}

/** A runtime override on a pipeline, phase or step. Undefined/null = inherit. */
function validateRuntime(raw: unknown, ctx: string): AgentRuntimeId | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRuntimeId(raw)) {
    throw new PipelineValidationError(`${ctx}: runtime must be ${runtimeIdList()}`);
  }
  return raw;
}

function validateModel(raw: unknown, ctx: string): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new PipelineValidationError(`${ctx}: model must be a non-empty string`);
  }
  const model = raw.trim();
  if (!MODEL_RE.test(model)) {
    throw new PipelineValidationError(`${ctx}: model "${model}" is not a valid model identifier`);
  }
  return model;
}

function validateStep(raw: unknown, ctx: string): PhaseStep {
  if (!raw || typeof raw !== "object")
    throw new PipelineValidationError(`${ctx}: step must be an object`);
  const s = raw as Record<string, unknown>;
  if (typeof s.name !== "string" || !s.name.trim())
    throw new PipelineValidationError(`${ctx}: step name is required`);
  if (typeof s.prompt !== "string" || !s.prompt.trim())
    throw new PipelineValidationError(`${ctx}: step prompt is required`);
  const step: PhaseStep = { name: s.name.trim(), prompt: s.prompt.trim() };
  if (s.model !== undefined && s.model !== null)
    step.model = validateModel(s.model, `${ctx}: step`);
  if (s.reasoningEffort !== undefined && s.reasoningEffort !== null) {
    step.reasoningEffort = validateReasoningEffort(s.reasoningEffort, `${ctx}: step`);
  }
  const runtime = validateRuntime(s.runtime, `${ctx}: step`);
  if (runtime) step.runtime = runtime;
  return step;
}

/**
 * Run a route/result check, re-badging its error as a pipeline validation error
 * so the route's existing 400 mapping covers it — the same wrapping the rubric
 * checks get, and for the same reason: an authoring mistake is a 400, not a 500.
 */
function routeChecked<T>(check: () => T): T {
  try {
    return check();
  } catch (e) {
    throw new PipelineValidationError(e instanceof RouteAuthoringError ? e.message : String(e));
  }
}

function validatePhase(raw: unknown, i: number): PhaseDef {
  if (!raw || typeof raw !== "object")
    throw new PipelineValidationError(`phase ${i} must be an object`);
  const p = raw as Record<string, unknown>;
  if (typeof p.id !== "string" || !p.id.trim())
    throw new PipelineValidationError(`phase ${i}: id is required`);
  const id = p.id.trim();
  if (typeof p.name !== "string" || !p.name.trim())
    throw new PipelineValidationError(`phase ${i}: name is required`);
  if (
    typeof p.cwd !== "string" ||
    !p.cwd.trim() ||
    !existsSync(p.cwd) ||
    !statSync(p.cwd).isDirectory()
  ) {
    throw new PipelineValidationError(`phase ${i}: cwd does not exist: ${String(p.cwd)}`);
  }
  if (!Array.isArray(p.steps) || p.steps.length === 0) {
    throw new PipelineValidationError(`phase ${i}: needs at least one step`);
  }
  const steps = p.steps.map((s) => validateStep(s, `phase ${i}`));
  const gated = Boolean(p.gated);

  // Rubric errors surface as pipeline validation errors so the route's existing
  // 400 mapping covers them instead of letting them escape as a 500.
  let rubric, autoApprove;
  try {
    rubric = validateRubric(p.rubric);
    autoApprove = validateAutoApprove(p.autoApprove, rubric !== undefined);
  } catch (e) {
    throw new PipelineValidationError(
      `phase ${i}: ${e instanceof RubricValidationError ? e.message : String(e)}`,
    );
  }
  if (autoApprove && !gated) {
    throw new PipelineValidationError(
      `phase ${i}: autoApprove only means something on a gated phase`,
    );
  }

  // Dependency edges. `needs: []` is meaningful (an explicit root), so the
  // key's *presence* is what switches the whole graph from linear-implicit to
  // explicit — see resolveNeeds. An entry is either the legacy phase id or a
  // route-carrying edge object; the string form is preserved as a string so a
  // pre-routing definition round-trips byte for byte.
  let needs: Dependency[] | undefined;
  if (p.needs !== undefined) {
    if (!Array.isArray(p.needs)) {
      throw new PipelineValidationError(`phase ${i}: needs must be a list of phase ids`);
    }
    needs = p.needs.map((n) => routeChecked(() => validateDependency(n, `phase "${id}"`)));
  }

  // The declared structured result. Validated against this phase's own steps
  // here; whether a *condition* can read it is a whole-graph question, checked
  // in validateRoutes once every phase's schema is known.
  const result =
    p.result === undefined || p.result === null
      ? undefined
      : routeChecked(() => validatePhaseResult(p.result, id, steps));

  const retry = validateRetry(p.retry, i);
  const runtime = validateRuntime(p.runtime, `phase ${i}`);

  let produces: string | undefined;
  if (p.produces !== undefined && p.produces !== null) {
    if (typeof p.produces !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(p.produces)) {
      throw new PipelineValidationError(
        `phase ${i}: produces must be a short name of letters, digits, - or _`,
      );
    }
    produces = p.produces;
  }

  return {
    id,
    name: p.name.trim(),
    cwd: p.cwd,
    steps,
    gated,
    ...(needs === undefined ? {} : { needs }),
    ...(result ? { result } : {}),
    ...(retry ? { retry } : {}),
    ...(produces ? { produces } : {}),
    ...(rubric ? { rubric } : {}),
    ...(autoApprove ? { autoApprove } : {}),
    ...(runtime ? { runtime } : {}),
  };
}

const RETRYABLE: readonly string[] = ["spawn", "exit-code", "signal"];

function validateRetry(raw: unknown, i: number) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object")
    throw new PipelineValidationError(`phase ${i}: retry must be an object`);
  const r = raw as Record<string, unknown>;
  const attempts = Number(r.attempts);
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) {
    throw new PipelineValidationError(`phase ${i}: retry.attempts must be an integer 1-10`);
  }
  const backoffSeconds = r.backoffSeconds === undefined ? 30 : Number(r.backoffSeconds);
  if (!Number.isFinite(backoffSeconds) || backoffSeconds < 0 || backoffSeconds > 3600) {
    throw new PipelineValidationError(`phase ${i}: retry.backoffSeconds must be 0-3600`);
  }
  let retryOn: string[] | undefined;
  if (r.retryOn !== undefined) {
    if (!Array.isArray(r.retryOn) || r.retryOn.some((c) => !RETRYABLE.includes(String(c)))) {
      throw new PipelineValidationError(
        `phase ${i}: retry.retryOn must be a list of ${RETRYABLE.join(" | ")}`,
      );
    }
    retryOn = [...new Set(r.retryOn.map(String))];
  }
  return {
    attempts,
    backoffSeconds,
    ...(retryOn ? { retryOn: retryOn as ("spawn" | "exit-code" | "signal")[] } : {}),
  };
}

/**
 * Whole-graph checks: the DAG first (a dangling edge or a cycle is reported as
 * itself), then the routes, which assume every edge names a phase that exists.
 */
function validateGraph(phases: PhaseDef[]): void {
  try {
    validateDag(phases);
  } catch (e) {
    throw new PipelineValidationError(e instanceof DagValidationError ? e.message : String(e));
  }
  routeChecked(() => validateRoutes(phases));
}

export function validatePipelineInput(raw: unknown): PipelineInput {
  if (!raw || typeof raw !== "object") throw new PipelineValidationError("body required");
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string" || !r.name.trim())
    throw new PipelineValidationError("name is required");
  if (!Array.isArray(r.phases) || r.phases.length === 0) {
    throw new PipelineValidationError("pipeline needs at least one phase");
  }
  const phases = r.phases.map((p, i) => validatePhase(p, i));
  // A cycle or a dangling edge is a 400 at authoring time. Without this it is
  // an instance that starts and then simply never finishes, which is how a DAG
  // executor fails when nobody checks.
  validateGraph(phases);
  const trigger = r.trigger == null ? null : validateTrigger(r.trigger, { allowWindowed: true });
  const overlapPolicy = r.overlapPolicy === "allow" ? "allow" : "skip";
  const enabled = r.enabled === undefined ? true : Boolean(r.enabled);
  const input: PipelineInput = { name: r.name.trim(), phases, trigger, enabled, overlapPolicy };
  if (r.model !== undefined && r.model !== null) input.model = validateModel(r.model, "pipeline");
  if (r.reasoningEffort !== undefined && r.reasoningEffort !== null) {
    input.reasoningEffort = validateReasoningEffort(r.reasoningEffort, "pipeline");
  }
  const runtime = validateRuntime(r.runtime, "pipeline");
  if (runtime) input.runtime = runtime;
  return input;
}

export function validatePipelinePatch(raw: unknown): Partial<PipelineInput> {
  if (!raw || typeof raw !== "object") throw new PipelineValidationError("body required");
  const r = raw as Record<string, unknown>;
  const patch: Partial<PipelineInput> = {};
  if ("name" in r) {
    if (typeof r.name !== "string" || !r.name.trim()) {
      throw new PipelineValidationError("name must be a non-empty string");
    }
    patch.name = r.name.trim();
  }
  if ("phases" in r) {
    if (!Array.isArray(r.phases) || r.phases.length === 0) {
      throw new PipelineValidationError("pipeline needs at least one phase");
    }
    patch.phases = r.phases.map((p, i) => validatePhase(p, i));
    // A patched phase list replaces the whole graph, so it gets the whole
    // graph's checks — otherwise routing could only be broken by PUT.
    validateGraph(patch.phases);
  }
  if ("trigger" in r)
    patch.trigger = r.trigger == null ? null : validateTrigger(r.trigger, { allowWindowed: true });
  if ("enabled" in r) patch.enabled = Boolean(r.enabled);
  if ("overlapPolicy" in r) patch.overlapPolicy = r.overlapPolicy === "allow" ? "allow" : "skip";
  if ("model" in r) patch.model = r.model == null ? undefined : validateModel(r.model, "pipeline");
  if ("reasoningEffort" in r) {
    patch.reasoningEffort =
      r.reasoningEffort == null
        ? undefined
        : validateReasoningEffort(r.reasoningEffort, "pipeline");
  }
  if ("runtime" in r) patch.runtime = validateRuntime(r.runtime, "pipeline");
  return patch;
}

export const readPipelines = store.read;
const writePipelines = store.write;

export async function createPipeline(
  input: PipelineInput,
  now: Date,
  id: string,
): Promise<PipelineDefinition> {
  const iso = now.toISOString();
  const def: PipelineDefinition = {
    id,
    name: input.name,
    phases: input.phases,
    trigger: input.trigger,
    enabled: input.enabled ?? true,
    overlapPolicy: input.overlapPolicy ?? "skip",
    ...(input.model ? { model: input.model } : {}),
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(input.runtime ? { runtime: input.runtime } : {}),
    lastStartedAt: null,
    createdAt: iso,
    updatedAt: iso,
  };
  return withStoreLock(async () => {
    const list = await readPipelines();
    list.push(def);
    await writePipelines(list);
    return def;
  });
}

export async function updatePipeline(
  id: string,
  patch: Partial<PipelineInput>,
  now: Date,
): Promise<PipelineDefinition | null> {
  return withStoreLock(async () => {
    const list = await readPipelines();
    const idx = list.findIndex((d) => d.id === id);
    if (idx === -1) return null;
    const merged: PipelineDefinition = {
      ...list[idx],
      ...("name" in patch ? { name: patch.name! } : {}),
      ...("phases" in patch ? { phases: patch.phases! } : {}),
      ...("trigger" in patch ? { trigger: patch.trigger! } : {}),
      ...("enabled" in patch ? { enabled: patch.enabled! } : {}),
      ...("overlapPolicy" in patch ? { overlapPolicy: patch.overlapPolicy! } : {}),
      ...("model" in patch ? { model: patch.model } : {}),
      ...("reasoningEffort" in patch ? { reasoningEffort: patch.reasoningEffort } : {}),
      updatedAt: now.toISOString(),
    };
    // An explicit `runtime: null` clears the override; spreading it would leave
    // a present-and-null key the resolver has to keep stepping over.
    if ("runtime" in patch) {
      if (patch.runtime) merged.runtime = patch.runtime;
      else delete merged.runtime;
    }
    list[idx] = merged;
    await writePipelines(list);
    return merged;
  });
}

export async function deletePipeline(id: string): Promise<boolean> {
  return withStoreLock(async () => {
    const list = await readPipelines();
    const next = list.filter((d) => d.id !== id);
    if (next.length === list.length) return false;
    await writePipelines(next);
    return true;
  });
}

export async function markPipelineStarted(id: string, atISO: string): Promise<void> {
  return withStoreLock(async () => {
    const list = await readPipelines();
    const idx = list.findIndex((d) => d.id === id);
    if (idx === -1) return;
    list[idx] = { ...list[idx], lastStartedAt: atISO };
    await writePipelines(list);
  });
}
