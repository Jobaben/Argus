import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { paths } from "../claudeHome.js";
import { nextFireAfter } from "./nextFire.js";
import type { Schedule, Trigger } from "./scheduleTypes.js";

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

function validateTrigger(t: unknown): Trigger {
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
  throw new ScheduleValidationError("trigger.kind must be interval|daily|weekly");
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
  return { name: r.name.trim(), prompt: r.prompt.trim(), cwd: r.cwd, trigger, enabled, overlapPolicy };
}

/** Reads the raw file; returns { ok, list } so writers can refuse on corruption. */
async function readRaw(): Promise<{ ok: boolean; list: Schedule[] }> {
  let text: string;
  try {
    text = await readFile(paths.schedulesFile(), "utf8");
  } catch {
    return { ok: true, list: [] }; // missing file = empty, writable
  }
  try {
    const parsed = JSON.parse(text) as Schedule[];
    return { ok: true, list: Array.isArray(parsed) ? parsed : [] };
  } catch {
    return { ok: false, list: [] }; // present but corrupt = do not overwrite
  }
}

export async function readSchedules(): Promise<Schedule[]> {
  return (await readRaw()).list;
}

async function writeSchedules(list: Schedule[]): Promise<void> {
  const current = await readRaw();
  if (!current.ok) {
    throw new Error("schedules.json could not be parsed; refusing to overwrite it");
  }
  await mkdir(paths.argus(), { recursive: true });
  const file = paths.schedulesFile();
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(list, null, 2), "utf8");
  await rename(tmp, file);
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
  const list = await readSchedules();
  list.push(schedule);
  await writeSchedules(list);
  return schedule;
}

export async function updateSchedule(
  id: string,
  patch: Partial<ScheduleInput>,
  now: Date,
): Promise<Schedule | null> {
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
}

export async function deleteSchedule(id: string): Promise<boolean> {
  const list = await readSchedules();
  const next = list.filter((s) => s.id !== id);
  if (next.length === list.length) return false;
  await writeSchedules(next);
  return true;
}

export async function markScheduleRan(
  id: string,
  runId: string,
  atISO: string,
): Promise<void> {
  const list = await readSchedules();
  const idx = list.findIndex((s) => s.id === id);
  if (idx === -1) return;
  list[idx] = { ...list[idx], lastRunAt: atISO, lastRunId: runId };
  await writeSchedules(list);
}
