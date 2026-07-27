import path from "node:path";
import { paths } from "../claudeHome.js";
import type { AnalysisRunner } from "./analysis.js";
import type { Diagnosis, Incident } from "@argus/contracts";
import type { Run } from "./scheduleTypes.js";

/**
 * Sentinel's diagnostic pass: read-only by construction.
 *
 * "Read-only" here is not a permission setting the model could talk its way
 * past — it is a property of the prompt. Everything the pass is allowed to
 * consider is *inlined* into the request: the incident, its timeline, and the
 * recent runs of whatever it points at. The model is never asked to go and
 * look, so it has nothing to go and look *with*, and the pass cannot touch the
 * repository, the schedule, or the incident it is reasoning about.
 *
 * What comes back is a finding and a **proposal**. Executing the proposal is a
 * separate, human action. An incident-response system that can also change
 * things is an incident-response system that can cause them.
 */

export const CONTEXT_RUNS = 8;
export const PROMPT_MAX_CHARS = 16_000;

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * The diagnostic prompt.
 *
 * The timeline is included because "it escalated twice and nobody
 * acknowledged" is diagnostic information, and the recent runs are included
 * because the difference between "it never started" and "it started and died"
 * is the first thing a human would look at.
 */
export function buildDiagnosePrompt(incident: Incident, context: Run[]): string {
  const timeline = incident.timeline
    .slice(-20)
    .map((e) => `  ${e.at} ${e.kind} (${e.by}): ${clip(e.detail, 200)}`)
    .join("\n");

  const runs = context
    .slice(0, CONTEXT_RUNS)
    .map((r) => {
      const when = r.endedAt ?? r.startedAt ?? r.queuedAt;
      const outcome = r.error
        ? `error: ${clip(r.error, 200)}`
        : clip(r.resultSummary ?? "", 200) || "no result";
      return `  ${when} ${r.status}${r.exitCode != null ? ` (exit ${r.exitCode})` : ""} — ${outcome}`;
    })
    .join("\n");

  const body = `You are diagnosing an operational incident in an agent-scheduling system. You have no tools; everything you may consider is below. Answer only with JSON.

INCIDENT
  title: ${clip(incident.title, 200)}
  source: ${incident.source}
  severity: ${incident.severity}
  opened: ${incident.openedAt}
  current state: ${incident.status}${incident.level > 0 ? ` (escalated to level ${incident.level})` : ""}
  detail: ${clip(incident.detail, 600)}

TIMELINE
${timeline || "  (no events)"}

RECENT RUNS OF THE AFFECTED WORK
${runs || "  (no runs recorded)"}

Answer with a single JSON object and nothing else:
{
  "findings": "one paragraph on the most likely cause, grounded only in what is above",
  "remediation": "the single most useful thing a human could do next, or null if you cannot tell",
  "confidence": a number from 0 to 1
}

Rules: say what the evidence supports and no more. If the evidence is thin,
say so in "findings" and give a low confidence rather than guessing
confidently. Do not propose anything you cannot justify from the timeline or
the runs above.`;

  return body.length > PROMPT_MAX_CHARS ? `${body.slice(0, PROMPT_MAX_CHARS - 1)}…` : body;
}

function asString(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function parseDiagnoseResponse(
  value: unknown,
): { findings: string; remediation: string | null; confidence: number | null } | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const findings = asString(v.findings, 2000);
  if (!findings) return null;
  const raw = typeof v.confidence === "number" ? v.confidence : NaN;
  return {
    findings,
    remediation: asString(v.remediation, 2000),
    confidence: Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : null,
  };
}

export interface DiagnoseDeps {
  runner: AnalysisRunner;
  now: () => Date;
  /** Runs relevant to the incident, newest first. */
  context: (incident: Incident) => Promise<Run[]>;
}

/** Run the diagnostic and return the attachment. Never throws. */
export async function performDiagnosis(incident: Incident, deps: DiagnoseDeps): Promise<Diagnosis> {
  const context = await deps.context(incident);
  const result = await deps.runner.run(
    {
      kind: "diagnose",
      prompt: buildDiagnosePrompt(incident, context),
      cwd: context[0]?.cwd || path.dirname(paths.sentinelFile()),
    },
    parseDiagnoseResponse,
  );

  const base: Diagnosis = {
    at: deps.now().toISOString(),
    status: "failed",
    findings: null,
    remediation: null,
    confidence: null,
    costUsd: result.costUsd,
    tokens: result.tokens,
    error: null,
  };

  if (!result.ok || !result.value) {
    return {
      ...base,
      status: result.failure === "disabled" ? "skipped" : "failed",
      error: result.error ?? "the diagnostic produced nothing",
    };
  }
  return { ...base, status: "ready", ...result.value, error: null };
}
