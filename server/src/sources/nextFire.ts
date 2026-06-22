import type { Schedule, Trigger } from "./scheduleTypes.js";

export function parseHHMM(time: string | undefined): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time ?? "");
  if (!m) return [0, 0];
  const h = Math.min(23, Math.max(0, Number(m[1])));
  const mi = Math.min(59, Math.max(0, Number(m[2])));
  return [h, mi];
}

function atTime(ref: Date, h: number, mi: number): Date {
  return new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), h, mi, 0, 0);
}

/** The most recent scheduled instant at or before `now`, or null if none. */
export function previousFireTime(
  trigger: Trigger,
  anchor: Date,
  now: Date,
): Date | null {
  if (trigger.kind === "interval") {
    const step = (trigger.everyMinutes ?? 0) * 60000;
    if (step <= 0) return null;
    const elapsed = now.getTime() - anchor.getTime();
    if (elapsed < step) return null;
    const k = Math.floor(elapsed / step);
    return new Date(anchor.getTime() + k * step);
  }
  const [h, mi] = parseHHMM(trigger.time);
  if (trigger.kind === "daily") {
    const cand = atTime(now, h, mi);
    if (cand.getTime() <= now.getTime()) return cand;
    const y = new Date(cand);
    y.setDate(y.getDate() - 1);
    return y;
  }
  // weekly
  const wd = trigger.weekday ?? 0;
  const cand = atTime(now, h, mi);
  const back = (now.getDay() - wd + 7) % 7;
  const occ = new Date(cand);
  occ.setDate(occ.getDate() - back);
  if (occ.getTime() > now.getTime()) occ.setDate(occ.getDate() - 7);
  return occ;
}

/** The next scheduled instant strictly after `from`. */
export function nextFireTime(trigger: Trigger, from: Date): Date | null {
  if (trigger.kind === "interval") {
    const step = (trigger.everyMinutes ?? 0) * 60000;
    if (step <= 0) return null;
    return new Date(from.getTime() + step);
  }
  const [h, mi] = parseHHMM(trigger.time);
  if (trigger.kind === "daily") {
    const cand = atTime(from, h, mi);
    if (cand.getTime() > from.getTime()) return cand;
    const n = new Date(cand);
    n.setDate(n.getDate() + 1);
    return n;
  }
  const wd = trigger.weekday ?? 0;
  const cand = atTime(from, h, mi);
  const fwd = (wd - from.getDay() + 7) % 7;
  const occ = new Date(cand);
  occ.setDate(occ.getDate() + fwd);
  if (occ.getTime() <= from.getTime()) occ.setDate(occ.getDate() + 7);
  return occ;
}

/** The next fire strictly after `now`, given an interval anchor for cadence. */
export function nextFireAfter(
  trigger: Trigger,
  anchor: Date,
  now: Date,
): Date | null {
  if (trigger.kind === "interval") {
    const step = (trigger.everyMinutes ?? 0) * 60000;
    if (step <= 0) return null;
    if (now.getTime() < anchor.getTime()) {
      return new Date(anchor.getTime() + step);
    }
    const k = Math.floor((now.getTime() - anchor.getTime()) / step) + 1;
    return new Date(anchor.getTime() + k * step);
  }
  return nextFireTime(trigger, now);
}

export function graceMsFor(tickMs: number): number {
  return Math.max(2 * tickMs, 5 * 60000);
}

/** Whether this schedule is due to fire at `now` (within the grace window). */
export function shouldFire(
  schedule: Schedule,
  now: Date,
  graceMs: number,
): boolean {
  if (!schedule.enabled) return false;
  const anchor = new Date(schedule.lastRunAt ?? schedule.createdAt);
  const prev = previousFireTime(schedule.trigger, anchor, now);
  if (!prev) return false;
  if (schedule.lastRunAt && new Date(schedule.lastRunAt).getTime() >= prev.getTime()) {
    return false;
  }
  return now.getTime() - prev.getTime() <= graceMs;
}
