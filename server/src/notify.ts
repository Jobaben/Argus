import type { Run } from "./sources/scheduleTypes.js";
import type { PipelineInstance } from "./sources/pipelineTypes.js";

/**
 * Unattended runs are the whole point of Argus (overnight `claude -p`), so a
 * failure the user only discovers by opening the dashboard is a real gap. When
 * ARGUS_WEBHOOK_URL is set, a compact JSON payload is POSTed on every failure —
 * wire it to Slack, a mail relay, or a desktop-notifier bridge.
 *
 * The payload builders are pure so they can be asserted without a network.
 */
export interface FailurePayload {
  event: "run.failed" | "pipeline.failed";
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
