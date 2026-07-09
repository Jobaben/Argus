import { existsSync, statSync } from "node:fs";
import { paths } from "../claudeHome.js";
import { nextFireAfter, parseHHMM } from "./nextFire.js";
import { createJsonArrayStore } from "./jsonArrayStore.js";
import type { Schedule, Trigger } from "./scheduleTypes.js";

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
  throw new ScheduleValidationError("trigger.kind must be interval|daily|weekly|windowed");
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
  return patch;
}

export const readSchedules = store.read;
const writeSchedules = store.write;

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
  const iso = now.toISOString();
  const schedule: Schedule = {
    id,
    name: input.name,
    prompt: input.prompt,
    cwd: input.cwd,
    trigger: input.trigger,
    enabled: input.enabled ?? true,
    overlapPolicy: input.overlapPolicy ?? "skip",
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
      updatedAt: now.toISOString(),
    };
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
