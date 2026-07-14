import type { Run } from "./sources/scheduleTypes.js";
import type { PipelineInstance } from "./sources/pipelineTypes.js";
import type { MonitorAlert } from "./sources/monitorAlerts.js";
import type { BudgetAlert } from "./sources/budgetAlerts.js";

/**
 * Unattended runs are the whole point of Argus (overnight `claude -p`), so a
 * failure the user only discovers by opening the dashboard is a real gap. When
 * ARGUS_WEBHOOK_URL is set, a compact JSON payload is POSTed on every failure —
 * wire it to Slack, a mail relay, or a desktop-notifier bridge.
 *
 * The payload builders are pure so they can be asserted without a network.
 */
export interface FailurePayload {
  event: "run.failed" | "pipeline.failed" | MonitorAlert["event"] | BudgetAlert["event"];
  at: string;
  title: string;
  detail: string;
  id: string;
}

export function buildRunFailurePayload(run: Run, at: string): FailurePayload {
  return {
    event: "run.failed",
    at,
    title: `Run failed: ${run.scheduleName}`,
    detail: run.error ?? `exit code ${run.exitCode ?? "unknown"}`,
    id: run.id,
  };
}

export function buildPipelineFailurePayload(inst: PipelineInstance, at: string): FailurePayload {
  const phase = inst.phases[inst.currentPhaseIndex];
  return {
    event: "pipeline.failed",
    at,
    title: `Pipeline failed: ${inst.pipelineName}`,
    detail: phase ? `phase "${phase.name}" did not complete` : "pipeline did not complete",
    id: inst.id,
  };
}

const MONITOR_TITLES: Record<MonitorAlert["event"], string> = {
  "monitor.down": "Monitor down",
  "monitor.failing": "Monitor failing",
  "monitor.recovered": "Monitor recovered",
};

export function buildMonitorAlertPayload(alert: MonitorAlert): FailurePayload {
  return {
    event: alert.event,
    at: alert.at,
    title: `${MONITOR_TITLES[alert.event]}: ${alert.name}`,
    detail: alert.detail,
    id: alert.scheduleId,
  };
}

const BUDGET_TITLES: Record<BudgetAlert["event"], string> = {
  "budget.warning": "Budget warning",
  "budget.exceeded": "Budget exceeded",
  "budget.cleared": "Budget back under limit",
};

export function buildBudgetAlertPayload(alert: BudgetAlert): FailurePayload {
  return {
    event: alert.event,
    at: alert.at,
    title: BUDGET_TITLES[alert.event],
    detail: alert.detail,
    id: "budget",
  };
}

/** Fire-and-forget POST to the configured webhook. Never throws. */
export async function postWebhook(url: string | null, payload: FailurePayload): Promise<void> {
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error("[argus] failure webhook POST failed:", e instanceof Error ? e.message : e);
  }
}
