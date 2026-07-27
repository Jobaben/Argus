import type { BudgetWindow } from "../types";

/**
 * Where the month's spend is heading.
 *
 * The Budget page could tell you what you had spent and what your ceiling was,
 * and left the only question that matters — "am I going to hit it?" — as mental
 * arithmetic over a 30-bar chart. This is that arithmetic, done once, in a pure
 * function with tests, because a wrong projection is worse than none.
 */

export interface MonthProjection {
  /** Mean spend per elapsed day, today included. */
  perDayUsd: number;
  /** Month total at the current mean rate. */
  projectedUsd: number;
  /** Days in this calendar month. */
  daysInMonth: number;
  /** Elapsed days including today. */
  daysElapsed: number;
  /**
   * Local calendar day the limit is projected to be crossed, or null when there
   * is no limit, the rate is zero, or the crossing falls outside this month.
   */
  exhaustsOn: Date | null;
  /** True when the projected total exceeds the limit. */
  overLimit: boolean;
}

function daysInMonth(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
}

/**
 * Null when there is nothing honest to say: the month is not underway, or no
 * spend has been recorded, and a projection from zero data is a guess dressed as
 * a number.
 *
 * The rate is a mean over elapsed days rather than a fit over the ledger. It is
 * the assumption a reader will make anyway ("I've spent $40 in 8 days"), which
 * makes it the one they can check — and unlike a trend line it cannot invent a
 * dramatic curve out of two noisy days.
 */
export function projectMonth(month: BudgetWindow, now: Date = new Date()): MonthProjection | null {
  const daysElapsed = now.getDate();
  const total = daysInMonth(now);
  if (month.spentUsd <= 0) return null;

  const perDayUsd = month.spentUsd / daysElapsed;
  const projectedUsd = perDayUsd * total;
  const limit = month.limitUsd;

  let exhaustsOn: Date | null = null;
  if (limit != null && limit > 0 && perDayUsd > 0) {
    // The first day on which cumulative spend would reach the limit. Ceil, not
    // round: the limit is crossed *during* that day, so naming the day before it
    // would be early by a day and wrong in the reassuring direction.
    const dayReached = Math.ceil(limit / perDayUsd);
    if (dayReached <= total) {
      exhaustsOn = new Date(now.getFullYear(), now.getMonth(), Math.max(1, dayReached));
    }
  }

  return {
    perDayUsd,
    projectedUsd,
    daysInMonth: total,
    daysElapsed,
    exhaustsOn,
    overLimit: limit != null && projectedUsd > limit,
  };
}
