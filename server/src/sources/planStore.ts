import type { Plan } from "@argus/contracts";
import { PLAN_TTL_MS } from "./omnibar.js";

/**
 * Pending plans, held in memory only.
 *
 * Not persisted, and that is the design rather than an omission. A plan is a
 * five-minute offer to change something; surviving a restart would let a
 * confirmation land against state nobody has looked at since the server went
 * down. Losing pending plans on restart costs a re-ask and removes a whole
 * class of stale-approval bug.
 *
 * Execution takes a plan **id**, never the intent text, so what runs is the
 * list the user read — the sentence is never re-interpreted at confirm time.
 */

const plans = new Map<string, Plan>();

/** Ceiling on pending plans; each is small, and this bounds a runaway client. */
const MAX_PENDING = 50;

export function rememberPlan(plan: Plan, now: Date): void {
  if (!plan.id || plan.mutations.length === 0) return;
  sweep(now);
  if (plans.size >= MAX_PENDING) {
    // Drop the oldest rather than refusing the newest: the plan a user is
    // looking at right now is the one that matters.
    const oldest = plans.keys().next().value;
    if (oldest) plans.delete(oldest);
  }
  plans.set(plan.id, plan);
}

/** The plan, if it exists and has not expired. Consumed either way. */
export function takePlan(id: string, now: Date): Plan | null {
  sweep(now);
  const plan = plans.get(id);
  if (!plan) return null;
  // Single-use: a confirm button that can be double-clicked into two executions
  // is the same bug as a payment form that can, and has the same fix.
  plans.delete(id);
  return plan;
}

export function pendingCount(): number {
  return plans.size;
}

/** Test seam. */
export function clearPlans(): void {
  plans.clear();
}

function sweep(now: Date): void {
  const cutoff = now.getTime();
  for (const [id, plan] of plans) {
    if (Date.parse(plan.expiresAt) <= cutoff) plans.delete(id);
  }
}

export { PLAN_TTL_MS };
