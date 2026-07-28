import { randomUUID } from "node:crypto";
import type {
  AnswerLink,
  MutationKind,
  OmnibarAnswer,
  OmnibarResponse,
  PlannedMutation,
} from "@argus/contracts";
import type { Schedule } from "./scheduleTypes.js";
import type { Issue } from "./issues.js";
import type { PipelineInstance } from "./pipelineTypes.js";
import type { BudgetConfig } from "@argus/contracts";
import type { AnalysisRunner } from "./analysis.js";

/**
 * Compiling an English sentence into an explicit, reviewable list of mutations.
 *
 * The planning pass is the only part of Argus where a model's output influences
 * what the system *does* rather than what it displays, so the trust boundary is
 * drawn as tightly as it can be:
 *
 * - the model may only name verbs from a closed set, checked here;
 * - it may only name targets that were in the catalogue it was given, resolved
 *   here against live state — the label a user reads is always the server's,
 *   never the model's, so a plan cannot describe itself misleadingly;
 * - nothing is applied by this module at all. It produces a `Plan`; a human
 *   confirms it; a separate executor applies it under the same admin gate every
 *   other mutation already requires.
 *
 * The practical consequence is that the worst a confused or adversarial
 * planning pass can achieve is proposing a wrong-but-legal change that a person
 * then reads and rejects.
 */

export type { Plan, PlannedMutation, OmnibarResponse } from "@argus/contracts";

/** How long a preview stays executable. */
export const PLAN_TTL_MS = 5 * 60_000;

/** Mutations per plan. A sentence that means fifty changes is a script. */
export const MAX_MUTATIONS = 25;

/** Characters of intent accepted. */
export const MAX_INTENT_CHARS = 400;

/** Catalogue entries per kind handed to the planner, newest/most relevant first. */
const CATALOGUE_CAP = 60;

const KINDS = new Set<MutationKind>([
  "schedule.disable",
  "schedule.enable",
  "issue.resolve",
  "issue.ignore",
  "instance.abort",
  "budget.setDaily",
  "budget.setMonthly",
]);

export interface OmnibarContext {
  schedules: Schedule[];
  issues: Issue[];
  instances: PipelineInstance[];
  budget: BudgetConfig;
  now: Date;
}

// ── The prompt ──────────────────────────────────────────────────────────────

/**
 * The catalogue: everything the planner is allowed to name.
 *
 * Deliberately small and id-first. A planner given a long prose dump invents
 * plausible ids from the prose; a planner given an explicit table of
 * `id | name | state` either uses one of them or produces something this
 * module drops.
 */
export function buildCatalogue(ctx: OmnibarContext): string {
  const schedules = ctx.schedules
    .slice(0, CATALOGUE_CAP)
    .map((s) => `  ${s.id} | ${s.name} | ${s.enabled === false ? "disabled" : "enabled"}`)
    .join("\n");
  const issues = ctx.issues
    .filter((i) => i.state === "open")
    .slice(0, CATALOGUE_CAP)
    .map((i) => `  ${i.fingerprint} | ${i.title.slice(0, 100)} | ${i.count} occurrences`)
    .join("\n");
  const live = ctx.instances
    .filter((i) => i.status === "running" || i.status === "awaiting-approval")
    .slice(0, CATALOGUE_CAP)
    .map((i) => `  ${i.id} | ${i.pipelineName} | ${i.status}`)
    .join("\n");

  return [
    "SCHEDULES (id | name | state):",
    schedules || "  (none)",
    "",
    "OPEN ISSUES (fingerprint | message | occurrences):",
    issues || "  (none)",
    "",
    "LIVE PIPELINE INSTANCES (id | pipeline | status):",
    live || "  (none)",
    "",
    `BUDGET: daily=${ctx.budget.dailyUsd ?? "none"} monthly=${ctx.budget.monthlyUsd ?? "none"}`,
    `NOW: ${ctx.now.toISOString()}`,
  ].join("\n");
}

export function buildPrompt(intent: string, ctx: OmnibarContext): string {
  return `You are the command compiler for Argus, a control plane for scheduled Claude Code runs.

Turn the user's request into EITHER a plan of mutations OR an answer to a question.
Reply with one JSON object and nothing else.

To change things:
{"mode":"plan","summary":"<one sentence>","mutations":[{"kind":"<kind>","targetId":"<id from the catalogue>","value":<argument or null>}]}

To answer a question about current state:
{"mode":"answer","text":"<two sentences at most>","links":[{"label":"<short>","href":"#/<route>"}]}

Allowed kinds and their value:
  schedule.disable    value: null
  schedule.enable     value: null
  issue.resolve       value: null
  issue.ignore        value: null
  instance.abort      value: null
  budget.setDaily     value: dollars as a number, or null to clear
  budget.setMonthly   value: dollars as a number, or null to clear

Rules:
- targetId MUST be copied exactly from the catalogue below. Never invent one.
- Only include a mutation if the request clearly asks for it. Fewer is better.
- If the request would change nothing, return a plan with an empty mutations list and say why in summary.
- If the request asks for something outside the allowed kinds, return an answer explaining what Argus can do instead.
- Argus cannot schedule a change for later. "until Monday" means disable now; say so in the summary.

CATALOGUE
${buildCatalogue(ctx)}

REQUEST
${intent.slice(0, MAX_INTENT_CHARS)}`;
}

// ── Validation ──────────────────────────────────────────────────────────────

interface RawMutation {
  kind?: unknown;
  targetId?: unknown;
  value?: unknown;
}

const scheduleLabel = (s: Schedule) => s.name || s.id;

/**
 * Resolve one raw mutation against live state, or explain why it was dropped.
 *
 * Everything a reader sees — the label, the before, the after — is computed
 * here from the real record. The model supplies only a verb and an id, which
 * are the two things that can be checked.
 */
export function resolveMutation(
  raw: RawMutation,
  ctx: OmnibarContext,
): { mutation: PlannedMutation } | { dropped: string } {
  const kind = typeof raw.kind === "string" ? (raw.kind as MutationKind) : null;
  if (!kind || !KINDS.has(kind)) {
    return { dropped: `dropped an unsupported action (${String(raw.kind ?? "missing")})` };
  }
  const targetId = typeof raw.targetId === "string" ? raw.targetId.trim() : "";

  switch (kind) {
    case "schedule.disable":
    case "schedule.enable": {
      const s = ctx.schedules.find((x) => x.id === targetId);
      if (!s) return { dropped: `dropped "${kind}": no schedule with id ${targetId || "(none)"}` };
      const wantEnabled = kind === "schedule.enable";
      const isEnabled = s.enabled !== false;
      if (isEnabled === wantEnabled) {
        return {
          dropped: `${scheduleLabel(s)} is already ${wantEnabled ? "enabled" : "disabled"}`,
        };
      }
      return {
        mutation: {
          kind,
          targetId,
          targetLabel: scheduleLabel(s),
          value: null,
          before: isEnabled ? "enabled" : "disabled",
          after: wantEnabled ? "enabled" : "disabled",
        },
      };
    }
    case "issue.resolve":
    case "issue.ignore": {
      const issue = ctx.issues.find((i) => i.fingerprint === targetId);
      if (!issue) return { dropped: `dropped "${kind}": no open issue ${targetId || "(none)"}` };
      const after = kind === "issue.resolve" ? "resolved" : "ignored";
      if (issue.state === after) return { dropped: `that issue is already ${after}` };
      return {
        mutation: {
          kind,
          targetId,
          targetLabel: issue.title.slice(0, 80),
          value: null,
          before: issue.state,
          after,
        },
      };
    }
    case "instance.abort": {
      const inst = ctx.instances.find((i) => i.id === targetId);
      if (!inst) return { dropped: `dropped "abort": no live instance ${targetId || "(none)"}` };
      if (inst.status !== "running" && inst.status !== "awaiting-approval") {
        return { dropped: `${inst.pipelineName} is already ${inst.status}` };
      }
      return {
        mutation: {
          kind,
          targetId,
          targetLabel: inst.pipelineName,
          value: null,
          before: inst.status,
          after: "aborted",
        },
      };
    }
    case "budget.setDaily":
    case "budget.setMonthly": {
      const daily = kind === "budget.setDaily";
      const current = daily ? ctx.budget.dailyUsd : ctx.budget.monthlyUsd;
      let value: number | null;
      if (raw.value === null) value = null;
      else {
        const n = Number(raw.value);
        if (!Number.isFinite(n) || n <= 0) {
          return { dropped: `dropped a budget change: "${String(raw.value)}" is not a limit` };
        }
        value = Math.round(n * 100) / 100;
      }
      if (current === value) {
        return {
          dropped: `the ${daily ? "daily" : "monthly"} limit is already ${describeLimit(value)}`,
        };
      }
      return {
        mutation: {
          kind,
          targetId: daily ? "daily" : "monthly",
          targetLabel: daily ? "Daily budget" : "Monthly budget",
          value,
          before: describeLimit(current),
          after: describeLimit(value),
        },
      };
    }
  }
}

const describeLimit = (v: number | null | undefined): string =>
  v == null ? "no limit" : `$${v.toFixed(2)}`;

function sanitizeLinks(raw: unknown): AnswerLink[] {
  if (!Array.isArray(raw)) return [];
  const out: AnswerLink[] = [];
  for (const item of raw.slice(0, 6)) {
    const r = (item ?? {}) as { label?: unknown; href?: unknown };
    const label = typeof r.label === "string" ? r.label.trim().slice(0, 60) : "";
    const href = typeof r.href === "string" ? r.href.trim() : "";
    // In-app hash routes only. A planner that emits `https://…` is either
    // confused or being used to place a link in front of the user, and neither
    // is a thing this feature needs to support.
    if (!label || !href.startsWith("#/") || href.length > 200) continue;
    out.push({ label, href });
  }
  return out;
}

/** Build the response from a parsed planner payload. Pure. */
export function buildResponse(
  parsed: unknown,
  intent: string,
  ctx: OmnibarContext,
): OmnibarResponse {
  const obj = (parsed ?? {}) as Record<string, unknown>;

  if (obj.mode === "answer") {
    const text = typeof obj.text === "string" ? obj.text.trim().slice(0, 600) : "";
    const answer: OmnibarAnswer = {
      text: text || "No answer came back.",
      links: sanitizeLinks(obj.links),
    };
    return { mode: "answer", plan: null, answer };
  }

  const rawMutations = Array.isArray(obj.mutations) ? obj.mutations.slice(0, MAX_MUTATIONS) : [];
  const mutations: PlannedMutation[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const raw of rawMutations) {
    const resolved = resolveMutation((raw ?? {}) as RawMutation, ctx);
    if ("dropped" in resolved) {
      warnings.push(resolved.dropped);
      continue;
    }
    // The same change twice is not two changes; it is a planner repeating
    // itself, and executing it twice would make the preview a lie about count.
    const key = `${resolved.mutation.kind}:${resolved.mutation.targetId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    mutations.push(resolved.mutation);
  }

  const modelSummary = typeof obj.summary === "string" ? obj.summary.trim().slice(0, 240) : "";
  const summary =
    mutations.length > 0
      ? modelSummary || `${mutations.length} change${mutations.length === 1 ? "" : "s"}`
      : modelSummary || "Nothing to change for that.";

  return {
    mode: "plan",
    answer: null,
    plan: {
      id: randomUUID(),
      status: mutations.length > 0 ? "ready" : "empty",
      intent,
      mutations,
      warnings,
      summary,
      createdAt: ctx.now.toISOString(),
      expiresAt: new Date(ctx.now.getTime() + PLAN_TTL_MS).toISOString(),
    },
  };
}

/** A plan that could not be produced, shaped so the UI has one thing to render. */
export function unavailablePlan(intent: string, summary: string, now: Date): OmnibarResponse {
  return {
    mode: "plan",
    answer: null,
    plan: {
      id: "",
      status: "unavailable",
      intent,
      mutations: [],
      warnings: [],
      summary,
      createdAt: now.toISOString(),
      expiresAt: now.toISOString(),
    },
  };
}

// ── The pass ────────────────────────────────────────────────────────────────

const FAILURE_TEXT: Record<string, string> = {
  disabled: "the planner is off (ARGUS_ANALYSIS=off)",
  "budget-blocked": "the spend hard stop is in force, so no model calls are made",
  busy: "another analysis pass is running — try again in a moment",
  timeout: "the planner took too long",
  "output-cap": "the planner produced too much output",
  "spawn-failed": "the Claude CLI could not be started",
  "no-output": "the planner returned nothing",
  unparseable: "the planner did not return usable JSON",
};

export interface CompileDeps {
  runner: AnalysisRunner;
  cwd: string;
}

/** Run one planning pass and turn it into a response. Never throws. */
export async function compileIntent(
  intent: string,
  ctx: OmnibarContext,
  deps: CompileDeps,
): Promise<OmnibarResponse> {
  const trimmed = intent.trim().slice(0, MAX_INTENT_CHARS);
  if (trimmed.length < 3) {
    return unavailablePlan(trimmed, "Say what you would like Argus to do.", ctx.now);
  }

  const result = await deps.runner.run<Record<string, unknown>>(
    { kind: "plan", prompt: buildPrompt(trimmed, ctx), cwd: deps.cwd },
    (value) => (value && typeof value === "object" ? (value as Record<string, unknown>) : null),
  );

  if (!result.ok || result.value == null) {
    const why = FAILURE_TEXT[result.failure ?? ""] ?? result.error ?? "the planner failed";
    return unavailablePlan(trimmed, `Couldn't plan that — ${why}.`, ctx.now);
  }

  return buildResponse(result.value, trimmed, ctx);
}
