import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { paths } from "../claudeHome.js";
import { validateTrigger } from "./schedules.js";
import { atomicWriteJson } from "./atomicWrite.js";
import { KeyedMutex } from "../mutex.js";
import type { PhaseDef, PhaseStep, PipelineDefinition } from "./pipelineTypes.js";
import type { Trigger } from "./scheduleTypes.js";

// Serializes the whole-file read-modify-write cycle (see schedules.ts).
const storeLock = new KeyedMutex();
const withStoreLock = <T>(fn: () => Promise<T>) => storeLock.withLock("pipelines", fn);

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
}

// Model names are passed as a `--model <value>` argv pair to `claude`. Reject
// anything that could be mistaken for a flag (leading dash) or smuggle shell
// metacharacters on the win32 shell:true path — only plain identifier chars.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function validateModel(raw: unknown, ctx: string): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new PipelineValidationError(`${ctx}: model must be a non-empty string`);
  }
  const model = raw.trim();
  if (!MODEL_RE.test(model)) {
    throw new PipelineValidationError(
      `${ctx}: model "${model}" is not a valid model identifier`,
    );
  }
  return model;
}

function validateStep(raw: unknown, ctx: string): PhaseStep {
  if (!raw || typeof raw !== "object") throw new PipelineValidationError(`${ctx}: step must be an object`);
  const s = raw as Record<string, unknown>;
  if (typeof s.name !== "string" || !s.name.trim()) throw new PipelineValidationError(`${ctx}: step name is required`);
  if (typeof s.prompt !== "string" || !s.prompt.trim()) throw new PipelineValidationError(`${ctx}: step prompt is required`);
  const step: PhaseStep = { name: s.name.trim(), prompt: s.prompt.trim() };
  if (s.model !== undefined && s.model !== null) step.model = validateModel(s.model, `${ctx}: step`);
  return step;
}

function validatePhase(raw: unknown, i: number): PhaseDef {
  if (!raw || typeof raw !== "object") throw new PipelineValidationError(`phase ${i} must be an object`);
  const p = raw as Record<string, unknown>;
  if (typeof p.id !== "string" || !p.id.trim()) throw new PipelineValidationError(`phase ${i}: id is required`);
  if (typeof p.name !== "string" || !p.name.trim()) throw new PipelineValidationError(`phase ${i}: name is required`);
  if (typeof p.cwd !== "string" || !p.cwd.trim() || !existsSync(p.cwd) || !statSync(p.cwd).isDirectory()) {
    throw new PipelineValidationError(`phase ${i}: cwd does not exist: ${String(p.cwd)}`);
  }
  if (!Array.isArray(p.steps) || p.steps.length === 0) {
    throw new PipelineValidationError(`phase ${i}: needs at least one step`);
  }
  const steps = p.steps.map((s) => validateStep(s, `phase ${i}`));
  return { id: p.id.trim(), name: p.name.trim(), cwd: p.cwd, steps, gated: Boolean(p.gated) };
}

export function validatePipelineInput(raw: unknown): PipelineInput {
  if (!raw || typeof raw !== "object") throw new PipelineValidationError("body required");
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string" || !r.name.trim()) throw new PipelineValidationError("name is required");
  if (!Array.isArray(r.phases) || r.phases.length === 0) {
    throw new PipelineValidationError("pipeline needs at least one phase");
  }
  const phases = r.phases.map((p, i) => validatePhase(p, i));
  const trigger = r.trigger == null ? null : validateTrigger(r.trigger, { allowWindowed: true });
  const overlapPolicy = r.overlapPolicy === "allow" ? "allow" : "skip";
  const enabled = r.enabled === undefined ? true : Boolean(r.enabled);
  const input: PipelineInput = { name: r.name.trim(), phases, trigger, enabled, overlapPolicy };
  if (r.model !== undefined && r.model !== null) input.model = validateModel(r.model, "pipeline");
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
  }
  if ("trigger" in r) patch.trigger = r.trigger == null ? null : validateTrigger(r.trigger, { allowWindowed: true });
  if ("enabled" in r) patch.enabled = Boolean(r.enabled);
  if ("overlapPolicy" in r) patch.overlapPolicy = r.overlapPolicy === "allow" ? "allow" : "skip";
  if ("model" in r) patch.model = r.model == null ? undefined : validateModel(r.model, "pipeline");
  return patch;
}

async function readRaw(): Promise<{ ok: boolean; list: PipelineDefinition[] }> {
  let text: string;
  try {
    text = await readFile(paths.pipelinesFile(), "utf8");
  } catch {
    return { ok: true, list: [] };
  }
  try {
    const parsed = JSON.parse(text) as PipelineDefinition[];
    return { ok: true, list: Array.isArray(parsed) ? parsed : [] };
  } catch {
    return { ok: false, list: [] };
  }
}

export async function readPipelines(): Promise<PipelineDefinition[]> {
  return (await readRaw()).list;
}

async function writePipelines(list: PipelineDefinition[]): Promise<void> {
  const current = await readRaw();
  if (!current.ok) throw new Error("pipelines.json could not be parsed; refusing to overwrite it");
  await atomicWriteJson(paths.pipelinesFile(), list);
}

export async function createPipeline(input: PipelineInput, now: Date, id: string): Promise<PipelineDefinition> {
  const iso = now.toISOString();
  const def: PipelineDefinition = {
    id,
    name: input.name,
    phases: input.phases,
    trigger: input.trigger,
    enabled: input.enabled ?? true,
    overlapPolicy: input.overlapPolicy ?? "skip",
    ...(input.model ? { model: input.model } : {}),
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
      updatedAt: now.toISOString(),
    };
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
