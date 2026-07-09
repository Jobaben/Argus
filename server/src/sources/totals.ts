import { paths } from "../claudeHome.js";
import { atomicWriteJson } from "./atomicWrite.js";
import { readJson } from "./readJson.js";
import { readRun, patchRun } from "./runs.js";

export interface Totals {
  usd: number;
  tokens: number;
  runsCounted: number;
  since: string;
}

function zero(now: () => Date): Totals {
  return { usd: 0, tokens: 0, runsCounted: 0, since: now().toISOString() };
}

export async function readTotals(now: () => Date = () => new Date()): Promise<Totals> {
  const raw = await readJson<Partial<Totals> | null>(paths.totalsFile(), null);
  if (!raw || typeof raw !== "object") return zero(now);
  return {
    usd: typeof raw.usd === "number" && Number.isFinite(raw.usd) ? raw.usd : 0,
    tokens: typeof raw.tokens === "number" && Number.isFinite(raw.tokens) ? raw.tokens : 0,
    runsCounted:
      typeof raw.runsCounted === "number" && Number.isFinite(raw.runsCounted)
        ? raw.runsCounted
        : 0,
    since: typeof raw.since === "string" ? raw.since : now().toISOString(),
  };
}

/**
 * Fold a run's reported cost into the all-time totals exactly once. Reads the
 * run fresh (not a captured copy) and gates on `countedInTotals`, so it is safe
 * against the several concurrent terminal-write paths: a run counts at most
 * once regardless of how many times its completion is written.
 */
export async function accumulateRun(runId: string, now: () => Date = () => new Date()): Promise<void> {
  const got = await readRun(runId);
  if (!got) return;
  const run = got.run;
  if (run.status === "running") return;
  if (run.countedInTotals === true) return;
  const usd = typeof run.costUsd === "number" ? run.costUsd : null;
  const tokens = typeof run.tokens === "number" ? run.tokens : null;
  if (usd == null && tokens == null) return;

  const current = await readTotals(now);
  const next: Totals = {
    usd: current.usd + (usd ?? 0),
    tokens: current.tokens + (tokens ?? 0),
    runsCounted: current.runsCounted + 1,
    since: current.since,
  };
  await atomicWriteJson(paths.totalsFile(), next);
  await patchRun(runId, { countedInTotals: true });
}

export async function resetTotals(now: () => Date = () => new Date()): Promise<Totals> {
  const fresh = zero(now);
  await atomicWriteJson(paths.totalsFile(), fresh);
  return fresh;
}
