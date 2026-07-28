import type { ExecuteResult, ExecuteStatus, Plan, PlannedMutation } from "@argus/contracts";
import { resolveMutation, type OmnibarContext } from "./sources/omnibar.js";
import { log } from "./log.js";

/**
 * Applying a confirmed plan — all of it, or none of it.
 *
 * Argus's state lives in several independent JSON files, so a genuine
 * cross-file transaction is not available and pretending otherwise would be the
 * dishonest move. What is available, and is what this implements, is a
 * **compensating transaction**:
 *
 * 1. Re-validate every mutation against live state. If any one no longer
 *    applies, nothing is attempted — the plan the user read is no longer the
 *    plan that would run, and a partly-true preview is worse than a refusal.
 * 2. Apply in order, recording the inverse of each success.
 * 3. If one fails, replay the inverses in reverse order.
 *
 * That yields four honest outcomes rather than one vague one, and the fourth is
 * the point: when a rollback *itself* fails the system really is part-changed,
 * and the result says `partial` and names exactly what is in effect. Folding
 * that into a generic error would be the single most expensive lie this feature
 * could tell.
 *
 * Step 1 is also what makes the confirm step meaningful. Between preview and
 * confirm a schedule can be disabled by hand, an instance can finish, a budget
 * can be edited in another tab. Re-checking means the confirmation applies to
 * the state the user was shown.
 */

/** Everything the executor is allowed to do, injected so it is testable. */
export interface ExecutorDeps {
  setScheduleEnabled: (id: string, enabled: boolean) => Promise<void>;
  setIssueState: (fingerprint: string, state: "open" | "resolved" | "ignored") => Promise<void>;
  abortInstance: (id: string) => Promise<void>;
  setBudget: (patch: { dailyUsd?: number | null; monthlyUsd?: number | null }) => Promise<void>;
}

function apply(m: PlannedMutation, deps: ExecutorDeps): Promise<void> {
  switch (m.kind) {
    case "schedule.disable":
      return deps.setScheduleEnabled(m.targetId, false);
    case "schedule.enable":
      return deps.setScheduleEnabled(m.targetId, true);
    case "issue.resolve":
      return deps.setIssueState(m.targetId, "resolved");
    case "issue.ignore":
      return deps.setIssueState(m.targetId, "ignored");
    case "instance.abort":
      return deps.abortInstance(m.targetId);
    case "budget.setDaily":
      return deps.setBudget({ dailyUsd: m.value as number | null });
    case "budget.setMonthly":
      return deps.setBudget({ monthlyUsd: m.value as number | null });
  }
}

/**
 * How to undo one mutation.
 *
 * Deliberately *not* another `PlannedMutation`: restoring an issue to `open`
 * has no forward verb, because reopening is not something a plan is allowed to
 * propose. Modelling inverses as their own small union keeps the plan vocabulary
 * closed without pretending the undo vocabulary is the same one.
 */
export type Inverse =
  | { do: "schedule.setEnabled"; id: string; enabled: boolean }
  | { do: "issue.setState"; id: string; state: "open" | "resolved" | "ignored" }
  | { do: "budget.set"; window: "daily" | "monthly"; usd: number | null };

/**
 * The inverse of a mutation, or null when there isn't one.
 *
 * `instance.abort` has no inverse: a killed process does not come back, and
 * offering a fake one would make a rollback report claim more than happened.
 * A plan containing an abort is therefore only ever rolled back *up to* the
 * abort — which is exactly what the `partial` status exists to describe.
 */
export function inverseOf(m: PlannedMutation): Inverse | null {
  switch (m.kind) {
    case "schedule.disable":
      return { do: "schedule.setEnabled", id: m.targetId, enabled: true };
    case "schedule.enable":
      return { do: "schedule.setEnabled", id: m.targetId, enabled: false };
    case "issue.resolve":
    case "issue.ignore":
      // `before` is the state the issue actually had, read from live state at
      // plan time — so undoing restores that, not a guess at "probably open".
      return {
        do: "issue.setState",
        id: m.targetId,
        state: m.before === "resolved" ? "resolved" : m.before === "ignored" ? "ignored" : "open",
      };
    case "budget.setDaily":
      return { do: "budget.set", window: "daily", usd: parseLimit(m.before) };
    case "budget.setMonthly":
      return { do: "budget.set", window: "monthly", usd: parseLimit(m.before) };
    case "instance.abort":
      return null;
  }
}

/** "$12.00" / "no limit" back into the number the budget patch wants. */
export function parseLimit(text: string): number | null {
  const n = Number(text.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function result(
  status: ExecuteStatus,
  summary: string,
  over: Partial<ExecuteResult> = {},
): ExecuteResult {
  return { status, applied: [], reversed: [], error: null, summary, ...over };
}

export async function executePlan(
  plan: Plan,
  ctx: OmnibarContext,
  deps: ExecutorDeps,
): Promise<ExecuteResult> {
  if (plan.mutations.length === 0) {
    return result("applied", "Nothing to do.");
  }

  // Step 1. Every mutation must still be exactly what the preview promised.
  for (const m of plan.mutations) {
    const check = resolveMutation({ kind: m.kind, targetId: m.targetId, value: m.value }, ctx);
    if ("dropped" in check) {
      return result(
        "stale",
        `Nothing was changed — ${check.dropped}. Ask again to get a fresh plan.`,
      );
    }
    if (check.mutation.before !== m.before) {
      return result(
        "stale",
        `Nothing was changed — ${m.targetLabel} is now "${check.mutation.before}", not "${m.before}" as previewed. Ask again to get a fresh plan.`,
      );
    }
  }

  const done: PlannedMutation[] = [];
  for (const m of plan.mutations) {
    try {
      await apply(m, deps);
      done.push(m);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      const { reversed, failures } = await rollback(done, deps);
      if (failures.length > 0) {
        log.error("omnibar rollback incomplete", { error, failures });
        const stillApplied = done.filter((d) => !reversed.includes(d));
        return result(
          "partial",
          `"${m.targetLabel}" failed, and ${failures.length} change${failures.length === 1 ? "" : "s"} could not be reversed. ${stillApplied.length} change${stillApplied.length === 1 ? " is" : "s are"} still in effect — check them by hand.`,
          { applied: stillApplied, reversed, error },
        );
      }
      return result(
        "rolled-back",
        `"${m.targetLabel}" failed, so the other ${reversed.length} change${reversed.length === 1 ? " was" : "s were"} undone. Nothing is in effect.`,
        { reversed, error },
      );
    }
  }

  return result("applied", `${done.length} change${done.length === 1 ? "" : "s"} applied.`, {
    applied: done,
  });
}

async function rollback(
  done: PlannedMutation[],
  deps: ExecutorDeps,
): Promise<{ reversed: PlannedMutation[]; failures: string[] }> {
  const reversed: PlannedMutation[] = [];
  const failures: string[] = [];
  // Reverse order: later mutations may depend on earlier ones having landed.
  for (const m of [...done].reverse()) {
    const inverse = inverseOf(m);
    if (!inverse) {
      failures.push(`${m.targetLabel}: ${m.kind} cannot be undone`);
      continue;
    }
    try {
      await applyInverse(inverse, deps);
      reversed.push(m);
    } catch (e) {
      failures.push(`${m.targetLabel}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { reversed, failures };
}

function applyInverse(inverse: Inverse, deps: ExecutorDeps): Promise<void> {
  switch (inverse.do) {
    case "schedule.setEnabled":
      return deps.setScheduleEnabled(inverse.id, inverse.enabled);
    case "issue.setState":
      return deps.setIssueState(inverse.id, inverse.state);
    case "budget.set":
      return deps.setBudget(
        inverse.window === "daily" ? { dailyUsd: inverse.usd } : { monthlyUsd: inverse.usd },
      );
  }
}
