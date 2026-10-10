import type { PhaseFailureClass, PhaseProgress, PipelineInstance } from "./pipelineTypes.js";
import type { Run } from "./scheduleTypes.js";
import type { PhaseReliability, PipelineReliability } from "@argus/contracts";

export type { PhaseReliability, PipelineReliability } from "@argus/contracts";

/**
 * Reliability: how often a pipeline's phases pass on the first try, and where
 * they lose attempts when they don't.
 *
 * Binary pass/fail hides "lucky passes" — AgentLens found 0.5–23% of passing
 * agent trajectories only passed after a retry the harness quietly absorbed.
 * Argus already grades a run's *output* (Verdict) and its *shape against its
 * own history* (Watchtower); this derivation grades the pipeline's own retry
 * loop, over a trailing window, from the instance record alone.
 *
 * **The "first attempt" rule.** `PhaseProgress.attempt` starts at 1 and is
 * bumped by exactly two things: an automatic retry (`applyRetry`) and a human
 * revise (`applyRevise`) — see `pipelineTransitions.ts`'s shared
 * `restartPhase`. Both reset the phase's steps and re-run it, so there is no
 * way to reach `attempt > 1` without one of them having happened. That makes
 * `attempt === 1` at the phase's *final* status exact and sufficient evidence
 * that it neither retried nor was revised — `PhaseProgress.retries` (which
 * only counts the automatic half) is checked too, defensively, but can never
 * disagree with `attempt` in practice. A phase that reached `succeeded` with
 * `attempt > 1` is a lucky pass: whatever the board shows, it did not pass
 * clean.
 *
 * **What "ran" means.** A phase not yet reached (`pending`) or skipped by a
 * conditional route (`skipped`) says nothing about this phase's own
 * reliability, so it is excluded from that phase's `instances` count
 * entirely — counting it as neither a pass nor a failure would be counting a
 * fact that never happened. `succeeded` / `failed` / `aborted` all count as
 * "ran"; an instance aborted mid-phase is neither a pass nor a classified
 * failure (Argus stopped it — the phase did not fail on its own), so it
 * contributes to `instances` and `meanAttempts` but not to
 * `firstAttemptPass` / `luckyPass` / `failed`.
 *
 * **Only the final attempt's cost and duration are visible.** `restartPhase`
 * replaces `steps` wholesale on every retry or revise, so a phase that failed
 * twice before succeeding keeps no record, on the instance, of what those
 * first two attempts cost — only the winning attempt's steps remain. The
 * `meanCostUsd` / `meanDurationMs` figures here are therefore a floor on a
 * lucky phase's true spend, not the whole retry chain's. Ledger's per-run
 * totals are the source of truth for total spend; this derivation reports
 * pipeline reliability, not full cost accounting.
 *
 * The whole derivation is pure — `(pipelineId, instances, now, windowDays) →
 * PipelineReliability` — precisely so the rule above is exercised directly in
 * tests rather than trusted from a rendered card.
 */

const DAY_MS = 86_400_000;

/** UTC calendar day, `YYYY-MM-DD`. */
function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

/** The moment an instance settled — when it stopped changing. Falls back to
 *  `updatedAt` for the (should-never-happen) case of a terminal status with
 *  no `endedAt`, rather than dropping the instance from the window. */
function settledAt(inst: PipelineInstance): string {
  return inst.endedAt ?? inst.updatedAt;
}

function isSettled(inst: PipelineInstance): boolean {
  return inst.status === "succeeded" || inst.status === "failed" || inst.status === "aborted";
}

/** A phase not reached, or skipped by a route, ran nowhere. */
function phaseRan(p: PhaseProgress): boolean {
  return p.status === "succeeded" || p.status === "failed" || p.status === "aborted";
}

/** See the module header: `attempt` alone already proves this; `retries` is
 *  checked too because the contract names it explicitly. */
function isLuckyPass(p: PhaseProgress): boolean {
  return p.attempt > 1 || (p.retries ?? 0) > 0;
}

function failureClassOf(payload: unknown): PhaseFailureClass | null {
  if (!payload || typeof payload !== "object") return null;
  const fc = (payload as { failureClass?: unknown }).failureClass;
  return typeof fc === "string" ? (fc as PhaseFailureClass) : null;
}

/** Sum a numeric step field over a phase's current steps; null when none of
 *  them reported one (rather than a misleading 0). */
function sumStepMetric(p: PhaseProgress, key: "durationMs" | "costUsd"): number | null {
  let sum = 0;
  let any = false;
  for (const s of p.steps) {
    const v = s[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      sum += v;
      any = true;
    }
  }
  return any ? sum : null;
}

function mean(sum: number, count: number): number | null {
  return count > 0 ? sum / count : null;
}

/** Every distinct phase id seen in `settled`, named from its most recently
 *  seen instance (a renamed phase should not be reported under its old
 *  name), in the order it was first seen scanning newest-first. */
function phaseRoster(settled: PipelineInstance[]): { id: string; name: string }[] {
  const order: string[] = [];
  const name = new Map<string, string>();
  for (const inst of settled) {
    for (const p of inst.phases) {
      if (!name.has(p.id)) order.push(p.id);
      name.set(p.id, p.name);
    }
  }
  return order.map((id) => ({ id, name: name.get(id) ?? id }));
}

function derivePhase(id: string, name: string, settled: PipelineInstance[]): PhaseReliability {
  let ran = 0;
  let firstAttemptPass = 0;
  let luckyPass = 0;
  let failed = 0;
  let attemptSum = 0;
  let verificationFails = 0;
  let stalls = 0;
  let durationSum = 0;
  let durationCount = 0;
  let costSum = 0;
  let costCount = 0;
  const failureClasses: Partial<Record<PhaseFailureClass, number>> = {};

  for (const inst of settled) {
    const p = inst.phases.find((ph) => ph.id === id);
    if (!p || !phaseRan(p)) continue;
    ran += 1;
    attemptSum += p.attempt;

    const dur = sumStepMetric(p, "durationMs");
    if (dur !== null) {
      durationSum += dur;
      durationCount += 1;
    }
    const cost = sumStepMetric(p, "costUsd");
    if (cost !== null) {
      costSum += cost;
      costCount += 1;
    }

    if (p.status === "succeeded") {
      if (isLuckyPass(p)) luckyPass += 1;
      else firstAttemptPass += 1;
    } else if (p.status === "failed") {
      failed += 1;
      const fc = failureClassOf(p.payload);
      if (fc) {
        failureClasses[fc] = (failureClasses[fc] ?? 0) + 1;
        if (fc === "verification") verificationFails += 1;
        if (fc === "timeout") stalls += 1;
      }
    }
    // aborted: counted in `ran` and `meanAttempts` only — see module header.
  }

  return {
    phaseId: id,
    name,
    instances: ran,
    firstAttemptPass,
    luckyPass,
    failed,
    meanAttempts: mean(attemptSum, ran),
    failureClasses,
    verificationFailRate: ran > 0 ? verificationFails / ran : null,
    stalls,
    meanDurationMs: mean(durationSum, durationCount),
    meanCostUsd: mean(costSum, costCount),
  };
}

/** Every phase that ran in this instance passed on its first attempt. Used
 *  only for instances that already succeeded — a phase not reached is not a
 *  counterexample. */
function cleanFirstAttempt(inst: PipelineInstance): boolean {
  return inst.phases.filter(phaseRan).every((p) => p.attempt === 1 && (p.retries ?? 0) === 0);
}

function hasLuckyPhase(inst: PipelineInstance): boolean {
  return inst.phases.filter(phaseRan).some(isLuckyPass);
}

function trendDays(now: Date, windowDays: number): string[] {
  const days: string[] = [];
  for (let i = windowDays - 1; i >= 0; i -= 1) {
    days.push(dayKey(new Date(now.getTime() - i * DAY_MS).toISOString()));
  }
  return days;
}

/** `(pipelineId, instances, now, windowDays) → PipelineReliability`. See the
 *  module header for the "first attempt" rule and what "ran" means. */
export function deriveReliability(
  pipelineId: string,
  instances: PipelineInstance[],
  now: Date,
  windowDays = 30,
): PipelineReliability {
  const floor = now.getTime() - Math.max(0, windowDays) * DAY_MS;
  const settled = instances.filter((i) => {
    if (i.pipelineId !== pipelineId || !isSettled(i)) return false;
    const at = Date.parse(settledAt(i));
    return Number.isFinite(at) && at >= floor && at <= now.getTime();
  });

  const succeeded = settled.filter((i) => i.status === "succeeded");
  const failed = settled.filter((i) => i.status === "failed").length;
  const aborted = settled.filter((i) => i.status === "aborted").length;
  const cleanCount = settled.filter((i) => i.status === "succeeded" && cleanFirstAttempt(i)).length;
  const luckyCount = succeeded.filter(hasLuckyPhase).length;

  const roster = phaseRoster(settled);
  const phases = roster.map(({ id, name }) => derivePhase(id, name, settled));

  const byDay = new Map<string, { succeeded: number; failed: number }>();
  for (const inst of settled) {
    if (inst.status !== "succeeded" && inst.status !== "failed") continue;
    const key = dayKey(settledAt(inst));
    const bucket = byDay.get(key) ?? { succeeded: 0, failed: 0 };
    if (inst.status === "succeeded") bucket.succeeded += 1;
    else bucket.failed += 1;
    byDay.set(key, bucket);
  }
  const trend = trendDays(now, windowDays).map((day) => ({
    day,
    succeeded: byDay.get(day)?.succeeded ?? 0,
    failed: byDay.get(day)?.failed ?? 0,
  }));

  return {
    pipelineId,
    windowDays,
    instances: settled.length,
    succeeded: succeeded.length,
    failed,
    aborted,
    firstAttemptSuccessRate: settled.length > 0 ? cleanCount / settled.length : null,
    luckyPassRate: succeeded.length > 0 ? luckyCount / succeeded.length : null,
    phases,
    trend,
    computedAt: now.toISOString(),
  };
}

/**
 * Join each step's reported cost and duration in from the run store, for
 * instances read straight off disk (where `StepProgress.costUsd` /
 * `durationMs` are unset — the engine records them on the `Run`, not on the
 * instance; `/api/overview` does the same join for the board). Pure and
 * non-mutating: existing values on a step win, so an already-enriched
 * instance (as `buildOverview` produces) passes through unchanged.
 */
export function withStepMetrics(instances: PipelineInstance[], runs: Run[]): PipelineInstance[] {
  const byRunId = new Map(runs.map((r) => [r.id, r]));
  return instances.map((inst) => ({
    ...inst,
    phases: inst.phases.map((p) => ({
      ...p,
      steps: p.steps.map((s) => {
        const run = s.runId ? byRunId.get(s.runId) : undefined;
        if (!run) return s;
        return {
          ...s,
          costUsd: s.costUsd ?? run.costUsd ?? null,
          durationMs: s.durationMs ?? run.durationMs ?? null,
        };
      }),
    })),
  }));
}
