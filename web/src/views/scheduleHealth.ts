import type { Run, ScheduleWithNext } from "../types";

/**
 * The derived answers the Scheduler view needs, as pure functions over the two
 * collections it already loads.
 *
 * The view used to have neither: it rendered a flat list of cards, so "three of
 * my four schedules have been failing since Tuesday" was something you found by
 * reading four cards and comparing timestamps by hand. Everything here is a
 * derivation — no new endpoint, no new persisted state — and it lives outside
 * the component so the precedence rules ("what does this schedule's row *say*?")
 * are testable without a DOM.
 */

/** What a single run concluded, collapsing six statuses into the four that change a decision. */
export type RunVerdict = "running" | "success" | "failure" | "inconclusive";

/**
 * A work-level failure signal outranks the exit code, matching `runDsStatus` and
 * the server's throughput histogram: a run that exited 0 but signalled `failed`
 * is a failure everywhere in Argus or nowhere.
 *
 * `skipped`, `interrupted` and `cancelled` are deliberately neither. They say
 * something about the machine, not about the work, and counting them as failures
 * would make an overlap-skipping schedule look broken.
 */
export function runVerdict(run: Run): RunVerdict {
  if (run.status === "running") return "running";
  if (run.outcome === "failed" || run.outcome === "blocked" || run.status === "failed") {
    return "failure";
  }
  if (run.status === "succeeded") return "success";
  return "inconclusive";
}

/** The single word a schedule's row leads with. */
export type ScheduleState = "paused" | "failing" | "running" | "healthy" | "unproven";

export interface ScheduleHealth {
  /** This schedule's runs, newest first — the same order the API returns. */
  runs: Run[];
  running: Run[];
  /** Newest run that reached a verdict, or null if none ever has. */
  lastConclusive: Run | null;
  /** Failures at the head of the conclusive history; 0 when the last one passed. */
  consecutiveFailures: number;
  conclusive: number;
  failures: number;
  state: ScheduleState;
}

/**
 * Precedence, most-decisive first: a paused schedule will not fire at all, and
 * that outranks anything its history says; a failing one needs attention whether
 * or not a fresh attempt is in flight (the running pulse is shown separately, so
 * nothing is hidden); then live, then proven, then never-run.
 */
function verdictState(
  enabled: boolean,
  running: number,
  consecutiveFailures: number,
  conclusive: number,
): ScheduleState {
  if (!enabled) return "paused";
  if (consecutiveFailures > 0) return "failing";
  if (running > 0) return "running";
  return conclusive > 0 ? "healthy" : "unproven";
}

export function scheduleHealth(schedule: ScheduleWithNext, runs: Run[]): ScheduleHealth {
  const mine = runs.filter((r) => r.scheduleId === schedule.id);
  const running = mine.filter((r) => runVerdict(r) === "running");
  const conclusive = mine.filter((r) => {
    const v = runVerdict(r);
    return v === "success" || v === "failure";
  });
  let consecutiveFailures = 0;
  for (const run of conclusive) {
    if (runVerdict(run) !== "failure") break;
    consecutiveFailures += 1;
  }
  return {
    runs: mine,
    running,
    lastConclusive: conclusive[0] ?? null,
    consecutiveFailures,
    conclusive: conclusive.length,
    failures: conclusive.filter((r) => runVerdict(r) === "failure").length,
    state: verdictState(schedule.enabled, running.length, consecutiveFailures, conclusive.length),
  };
}

/** Groups every schedule's health in one pass, so N cards cost one traversal. */
export function scheduleHealthById(
  schedules: ScheduleWithNext[],
  runs: Run[],
): Map<string, ScheduleHealth> {
  const byId = new Map<string, Run[]>();
  for (const run of runs) {
    const list = byId.get(run.scheduleId);
    if (list) list.push(run);
    else byId.set(run.scheduleId, [run]);
  }
  return new Map(schedules.map((s) => [s.id, scheduleHealth(s, byId.get(s.id) ?? [])] as const));
}

export interface NextFiring {
  schedule: ScheduleWithNext;
  at: string;
}

export interface SchedulerSummary {
  total: number;
  paused: number;
  failing: number;
  running: number;
  /** Enabled schedules that have never produced a verdict. */
  unproven: number;
  /** The soonest firing among enabled schedules, or null when nothing is armed. */
  nextFiring: NextFiring | null;
  /** Conclusive runs in the last 24h and how many of them failed. */
  recentRuns: number;
  recentFailures: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** When a run's verdict became known — the instant that decides its 24h bucket. */
function concludedAt(run: Run): number {
  const iso = run.endedAt ?? run.startedAt ?? run.queuedAt;
  const at = new Date(iso).getTime();
  return Number.isNaN(at) ? 0 : at;
}

export function summarizeSchedules(
  schedules: ScheduleWithNext[],
  runs: Run[],
  now: number,
  health: Map<string, ScheduleHealth> = scheduleHealthById(schedules, runs),
): SchedulerSummary {
  let paused = 0;
  let failing = 0;
  let running = 0;
  let unproven = 0;
  let nextFiring: NextFiring | null = null;

  for (const schedule of schedules) {
    switch (health.get(schedule.id)?.state) {
      case "paused":
        paused += 1;
        break;
      case "failing":
        failing += 1;
        break;
      case "running":
        running += 1;
        break;
      case "unproven":
        unproven += 1;
        break;
    }
    // A disabled schedule keeps a computed `nextRun`, but it is not going to
    // fire — promising it in the header would be a lie the row contradicts.
    if (!schedule.enabled || !schedule.nextRun) continue;
    const at = new Date(schedule.nextRun).getTime();
    if (Number.isNaN(at)) continue;
    if (!nextFiring || at < new Date(nextFiring.at).getTime()) {
      nextFiring = { schedule, at: schedule.nextRun };
    }
  }

  // Counted across all schedules rather than per card: "how much did the
  // scheduler actually do today" is a property of the scheduler.
  const since = now - DAY_MS;
  let recentRuns = 0;
  let recentFailures = 0;
  for (const run of runs) {
    const verdict = runVerdict(run);
    if (verdict !== "success" && verdict !== "failure") continue;
    if (concludedAt(run) < since) continue;
    recentRuns += 1;
    if (verdict === "failure") recentFailures += 1;
  }

  return {
    total: schedules.length,
    paused,
    failing,
    running,
    unproven,
    nextFiring,
    recentRuns,
    recentFailures,
  };
}
