import { existsSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { paths } from "../claudeHome.js";
import { nextFireAfter, parseHHMM } from "./nextFire.js";
import { createJsonArrayStore } from "./jsonArrayStore.js";
import { RubricValidationError, validateRubric } from "./verdict.js";
import { isRuntimeId, runtimeIdList } from "../runtimes/index.js";
import type { Schedule, Trigger } from "./scheduleTypes.js";
import type { AgentRuntimeId, ReasoningEffort, Rubric } from "@argus/contracts";

/** Same shape as a session token (auth.ts): 256 bits, URL-safe. Shared with
 *  pipelines.ts so both hook tokens are minted the same way. */
export function mintHookToken(): string {
  return randomBytes(32).toString("base64url");
}

// The crash-safe, mutex-serialized single-file store lives in one shared place.
const store = createJsonArrayStore<Schedule>({
  file: paths.schedulesFile,
  label: "schedules.json",
});
const withStoreLock = store.withLock;

export class ScheduleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleValidationError";
  }
}

export interface ScheduleInput {
  name: string;
  prompt: string;
  cwd: string;
  trigger: Trigger;
  enabled?: boolean;
  overlapPolicy?: "skip" | "allow";
  catchUp?: boolean;
  /** Null clears an existing rubric; absent leaves it untouched on a PATCH. */
  rubric?: Rubric | null;
  /** Null clears the override (back to the server default); absent leaves it alone. */
  runtime?: AgentRuntimeId | null;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
}

// Same rule as the pipeline validator: identifier characters only, plus the `/`
// OpenCode needs to address a model as `<provider>/<model>`.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const REASONING_EFFORTS = new Set<ReasoningEffort>(["minimal", "low", "medium", "high", "xhigh"]);

function modelOrThrow(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string" || !MODEL_RE.test(raw.trim())) {
    throw new ScheduleValidationError("model must be a valid non-empty model identifier");
  }
  return raw.trim();
}

function reasoningEffortOrThrow(raw: unknown): ReasoningEffort | null {
  if (raw === null || raw === undefined) return null;
  if (!REASONING_EFFORTS.has(raw as ReasoningEffort)) {
    throw new ScheduleValidationError(
      `reasoningEffort must be ${[...REASONING_EFFORTS].join(" | ")}`,
    );
  }
  return raw as ReasoningEffort;
}

/** `null` is the documented way to clear an override; anything else must name a
 *  known runtime, so a typo is a 400 rather than a silent fall-back. */
function runtimeOrThrow(raw: unknown): AgentRuntimeId | null {
  if (raw === null || raw === undefined) return null;
  if (!isRuntimeId(raw)) throw new ScheduleValidationError(`runtime must be ${runtimeIdList()}`);
  return raw;
}

/** Rubric errors surface as schedule validation errors, so the route's existing
 *  400 mapping covers them rather than escaping as a 500. */
function rubricOrThrow(raw: unknown): Rubric | undefined {
  try {
    return validateRubric(raw);
  } catch (e) {
    throw new ScheduleValidationError(e instanceof RubricValidationError ? e.message : String(e));
  }
}

const hhmmToMin = (s: string): number => {
  const [h, m] = parseHHMM(s);
  return h * 60 + m;
};

export function validateTrigger(t: unknown, opts?: { allowWindowed?: boolean }): Trigger {
  if (!t || typeof t !== "object") throw new ScheduleValidationError("trigger is required");
  const trig = t as Trigger;
  if (trig.kind === "interval") {
    if (!Number.isFinite(trig.everyMinutes) || (trig.everyMinutes ?? 0) < 1) {
      throw new ScheduleValidationError("interval trigger needs everyMinutes >= 1");
    }
    return { kind: "interval", everyMinutes: Math.floor(trig.everyMinutes as number) };
  }
  if (trig.kind === "daily" || trig.kind === "weekly") {
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(trig.time ?? "")) {
      throw new ScheduleValidationError(`${trig.kind} trigger needs time "HH:MM"`);
    }
    if (trig.kind === "weekly" && !(Number(trig.weekday) >= 0 && Number(trig.weekday) <= 6)) {
      throw new ScheduleValidationError("weekly trigger needs weekday 0-6");
    }
    return trig.kind === "weekly"
      ? { kind: "weekly", time: trig.time, weekday: Number(trig.weekday) }
      : { kind: "daily", time: trig.time };
  }
  if (trig.kind === "windowed") {
    if (!opts?.allowWindowed) {
      throw new ScheduleValidationError("windowed trigger is only available for pipelines");
    }
    const hhmm = /^([01]?\d|2[0-3]):[0-5]\d$/;
    if (!hhmm.test(trig.startTime ?? "") || !hhmm.test(trig.endTime ?? "")) {
      throw new ScheduleValidationError('windowed trigger needs startTime/endTime "HH:MM"');
    }
    if (hhmmToMin(trig.startTime as string) === hhmmToMin(trig.endTime as string)) {
      throw new ScheduleValidationError("windowed trigger needs endTime different from startTime");
    }
    if (!Number.isFinite(trig.everyMinutes) || (trig.everyMinutes ?? 0) < 1) {
      throw new ScheduleValidationError("windowed trigger needs everyMinutes >= 1");
    }
    let weekdays: number[] | undefined;
    if (trig.weekdays !== undefined) {
      if (
        !Array.isArray(trig.weekdays) ||
        trig.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)
      ) {
        throw new ScheduleValidationError("windowed trigger weekdays must be integers 0-6");
      }
      weekdays = [...new Set(trig.weekdays)].sort((a, b) => a - b);
    }
    return {
      kind: "windowed",
      startTime: trig.startTime,
      endTime: trig.endTime,
      everyMinutes: Math.floor(trig.everyMinutes as number),
      ...(weekdays && weekdays.length ? { weekdays } : {}),
    };
  }
  if (trig.kind === "webhook") {
    // No cadence fields at all: firing is a POST to the hook route, not the
    // scheduler tick. Reject a stray cadence field rather than silently
    // dropping it, so an author who half-edited a trigger finds out at save
    // time instead of wondering why "every 60 min" was ignored.
    const stray = (
      ["everyMinutes", "time", "weekday", "startTime", "endTime", "weekdays"] as const
    ).find((k) => trig[k] !== undefined);
    if (stray) {
      throw new ScheduleValidationError(`webhook trigger does not take ${stray}`);
    }
    return { kind: "webhook" };
  }
  if (trig.kind === "after") {
    if (typeof trig.pipelineId !== "string" || !trig.pipelineId.trim()) {
      throw new ScheduleValidationError("after trigger needs pipelineId");
    }
    if (trig.on !== "succeeded" && trig.on !== "failed" && trig.on !== "any") {
      throw new ScheduleValidationError('after trigger needs on: "succeeded" | "failed" | "any"');
    }
    // Existence, self-chain and direct-cycle checks are done by the caller
    // (createPipeline/updatePipeline, createSchedule/updateSchedule), which
    // already holds the other definitions this pure validator has no IO to read.
    return { kind: "after", pipelineId: trig.pipelineId.trim(), on: trig.on };
  }
  throw new ScheduleValidationError(
    "trigger.kind must be interval|daily|weekly|windowed|webhook|after",
  );
}

export function validateInput(raw: unknown): ScheduleInput {
  if (!raw || typeof raw !== "object") throw new ScheduleValidationError("body required");
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string" || !r.name.trim()) {
    throw new ScheduleValidationError("name is required");
  }
  if (typeof r.prompt !== "string" || !r.prompt.trim()) {
    throw new ScheduleValidationError("prompt is required");
  }
  if (typeof r.cwd !== "string" || !r.cwd.trim()) {
    throw new ScheduleValidationError("cwd is required");
  }
  if (!existsSync(r.cwd) || !statSync(r.cwd).isDirectory()) {
    throw new ScheduleValidationError(`cwd does not exist: ${r.cwd}`);
  }
  const trigger = validateTrigger(r.trigger);
  const overlapPolicy = r.overlapPolicy === "allow" ? "allow" : "skip";
  const enabled = r.enabled === undefined ? true : Boolean(r.enabled);
  return {
    name: r.name.trim(),
    prompt: r.prompt.trim(),
    cwd: r.cwd,
    trigger,
    enabled,
    overlapPolicy,
    catchUp: Boolean(r.catchUp),
    ...(r.rubric === undefined ? {} : { rubric: rubricOrThrow(r.rubric) ?? null }),
    ...(r.runtime === undefined ? {} : { runtime: runtimeOrThrow(r.runtime) }),
    ...(r.model === undefined ? {} : { model: modelOrThrow(r.model) }),
    ...(r.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: reasoningEffortOrThrow(r.reasoningEffort) }),
  };
}

export function validatePatch(raw: unknown): Partial<ScheduleInput> {
  if (!raw || typeof raw !== "object") throw new ScheduleValidationError("body required");
  const r = raw as Record<string, unknown>;
  const patch: Partial<ScheduleInput> = {};
  if ("name" in r) {
    if (typeof r.name !== "string" || !r.name.trim()) {
      throw new ScheduleValidationError("name must be a non-empty string");
    }
    patch.name = r.name.trim();
  }
  if ("prompt" in r) {
    if (typeof r.prompt !== "string" || !r.prompt.trim()) {
      throw new ScheduleValidationError("prompt must be a non-empty string");
    }
    patch.prompt = r.prompt.trim();
  }
  if ("cwd" in r) {
    if (
      typeof r.cwd !== "string" ||
      !r.cwd.trim() ||
      !existsSync(r.cwd) ||
      !statSync(r.cwd).isDirectory()
    ) {
      throw new ScheduleValidationError(`cwd does not exist: ${String(r.cwd)}`);
    }
    patch.cwd = r.cwd;
  }
  if ("trigger" in r) patch.trigger = validateTrigger(r.trigger);
  if ("enabled" in r) patch.enabled = Boolean(r.enabled);
  if ("overlapPolicy" in r) patch.overlapPolicy = r.overlapPolicy === "allow" ? "allow" : "skip";
  if ("catchUp" in r) patch.catchUp = Boolean(r.catchUp);
  if ("rubric" in r) patch.rubric = rubricOrThrow(r.rubric) ?? null;
  if ("runtime" in r) patch.runtime = runtimeOrThrow(r.runtime);
  if ("model" in r) patch.model = modelOrThrow(r.model);
  if ("reasoningEffort" in r) patch.reasoningEffort = reasoningEffortOrThrow(r.reasoningEffort);
  return patch;
}

export const readSchedules = store.read;
const writeSchedules = store.write;

/**
 * `after.pipelineId` must name a pipeline that exists. Only pipelines may be a
 * chain's source (schedules cannot chain off other schedules), so this is the
 * one existence check both a pipeline and a schedule saving an `after`
 * trigger need. A dynamic import, not a static one: `pipelines.ts` imports
 * `validateTrigger` from this module, and a static import back would make the
 * two modules circularly dependent at load time.
 */
async function assertAfterSourceExists(trigger: Trigger): Promise<void> {
  if (trigger.kind !== "after") return;
  const { readPipelines } = await import("./pipelines.js");
  const exists = (await readPipelines()).some((p) => p.id === trigger.pipelineId);
  if (!exists) {
    throw new ScheduleValidationError(
      `after trigger names an unknown pipeline: ${trigger.pipelineId}`,
    );
  }
}

export async function readSchedulesWithNext(
  now: Date,
): Promise<(Schedule & { nextRun: string | null })[]> {
  const list = await readSchedules();
  return list.map((s) => {
    const anchor = new Date(s.lastRunAt ?? s.createdAt);
    const next = s.enabled ? nextFireAfter(s.trigger, anchor, now) : null;
    return { ...s, nextRun: next ? next.toISOString() : null };
  });
}

export async function createSchedule(
  input: ScheduleInput,
  now: Date,
  id: string,
): Promise<Schedule> {
  await assertAfterSourceExists(input.trigger);
  const iso = now.toISOString();
  const schedule: Schedule = {
    id,
    name: input.name,
    prompt: input.prompt,
    cwd: input.cwd,
    trigger: input.trigger,
    enabled: input.enabled ?? true,
    overlapPolicy: input.overlapPolicy ?? "skip",
    catchUp: input.catchUp ?? false,
    ...(input.rubric ? { rubric: input.rubric } : {}),
    ...(input.runtime ? { runtime: input.runtime } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    // Minted on first save of a webhook trigger; rotated only via the
    // dedicated endpoint, never by an ordinary edit.
    ...(input.trigger.kind === "webhook" ? { hookToken: mintHookToken() } : {}),
    createdAt: iso,
    updatedAt: iso,
    lastRunAt: null,
    lastRunId: null,
  };
  return withStoreLock(async () => {
    const list = await readSchedules();
    list.push(schedule);
    await writeSchedules(list);
    return schedule;
  });
}

export async function updateSchedule(
  id: string,
  patch: Partial<ScheduleInput>,
  now: Date,
): Promise<Schedule | null> {
  if (patch.trigger) await assertAfterSourceExists(patch.trigger);
  return withStoreLock(async () => {
    const list = await readSchedules();
    const idx = list.findIndex((s) => s.id === id);
    if (idx === -1) return null;
    const merged: Schedule = {
      ...list[idx],
      ...("name" in patch ? { name: patch.name! } : {}),
      ...("prompt" in patch ? { prompt: patch.prompt! } : {}),
      ...("cwd" in patch ? { cwd: patch.cwd! } : {}),
      ...("trigger" in patch ? { trigger: patch.trigger! } : {}),
      ...("enabled" in patch ? { enabled: patch.enabled! } : {}),
      ...("overlapPolicy" in patch ? { overlapPolicy: patch.overlapPolicy! } : {}),
      ...("catchUp" in patch ? { catchUp: patch.catchUp! } : {}),
      updatedAt: now.toISOString(),
    };
    // Mint a hook token the first time this schedule's trigger becomes
    // "webhook"; keep whatever token it already had otherwise (edits must not
    // silently break a URL someone has already wired up elsewhere).
    if (merged.trigger.kind === "webhook" && !merged.hookToken) {
      merged.hookToken = mintHookToken();
    }
    // `rubric: null` is the documented way to remove one, and spreading a null
    // would leave the key present-and-null on disk rather than gone.
    if ("rubric" in patch) {
      if (patch.rubric) merged.rubric = patch.rubric;
      else delete merged.rubric;
    }
    // Same shape as the rubric: null removes the key rather than leaving a
    // present-and-null override on disk for the resolver to step over.
    if ("runtime" in patch) {
      if (patch.runtime) merged.runtime = patch.runtime;
      else delete merged.runtime;
    }
    if ("model" in patch) {
      if (patch.model) merged.model = patch.model;
      else delete merged.model;
    }
    if ("reasoningEffort" in patch) {
      if (patch.reasoningEffort) merged.reasoningEffort = patch.reasoningEffort;
      else delete merged.reasoningEffort;
    }
    list[idx] = merged;
    await writeSchedules(list);
    return merged;
  });
}

export async function deleteSchedule(id: string): Promise<boolean> {
  return withStoreLock(async () => {
    const list = await readSchedules();
    const next = list.filter((s) => s.id !== id);
    if (next.length === list.length) return false;
    await writeSchedules(next);
    return true;
  });
}

export async function markScheduleRan(id: string, runId: string, atISO: string): Promise<void> {
  return withStoreLock(async () => {
    const list = await readSchedules();
    const idx = list.findIndex((s) => s.id === id);
    if (idx === -1) return;
    list[idx] = { ...list[idx], lastRunAt: atISO, lastRunId: runId };
    await writeSchedules(list);
  });
}

/**
 * Mints a fresh `hookToken`, invalidating whatever URL/token combination was
 * handed out before. Only reachable via `POST /api/schedules/:id/hook-token/rotate`
 * — an ordinary save never regenerates a working hook.
 */
export async function rotateScheduleHookToken(id: string, now: Date): Promise<Schedule | null> {
  return withStoreLock(async () => {
    const list = await readSchedules();
    const idx = list.findIndex((s) => s.id === id);
    if (idx === -1) return null;
    if (list[idx].trigger.kind !== "webhook") {
      throw new ScheduleValidationError("schedule does not have a webhook trigger");
    }
    const merged: Schedule = {
      ...list[idx],
      hookToken: mintHookToken(),
      updatedAt: now.toISOString(),
    };
    list[idx] = merged;
    await writeSchedules(list);
    return merged;
  });
}
