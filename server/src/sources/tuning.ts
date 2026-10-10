import path from "node:path";
import { paths } from "../claudeHome.js";
import { createJsonArrayStore } from "./jsonArrayStore.js";
import { resolveRuntimeId, runtimeFor, RUNTIME_IDS } from "../runtimes/index.js";
import type { AnalysisRunner } from "./analysis.js";
import type {
  AgentRuntimeId,
  PhaseDef,
  PhaseStep,
  PhaseTuning,
  PipelineDefinition,
  ReasoningEffort,
  TuningField,
  TuningInheritedFrom,
  TuningProposal,
  TuningReport,
  TuningScope,
} from "@argus/contracts";

/**
 * Tuning: one bounded model pass per phase, asking whether the phase's
 * settings fit the work its steps describe — and everything around that pass
 * that has to be pure enough to test.
 *
 * Same three-part split as Autopsy, for the same reasons. **Prompt
 * construction** is where a 40-step phase becomes an oversized request, so it
 * is capped. **Validation** is where a model's confident nonsense becomes a
 * stored proposal, so every field is re-derived from the definition and the
 * runtime roster rather than trusted. **Persistence** is capped and pruned.
 *
 * Two rules are structural rather than prompted. A step's prompt is *input* to
 * the pass and never output: the response schema has no field for it, and the
 * parser drops any field outside the closed {@link TuningField} set. And "no
 * change" is the expected answer — an empty proposal list is a `ready` result,
 * and a proposal equal to the current value is dropped, so pressing Analyze
 * cannot by itself manufacture a diff.
 */

export type {
  PhaseTuning,
  PhaseTuningStatus,
  TuningField,
  TuningProposal,
  TuningReport,
  TuningStatus,
} from "@argus/contracts";

/** Reports retained across every pipeline. One per press, newest first. */
export const TUNING_KEEP = 50;

/** Hard ceiling on one phase's prompt. Trimmed, never sent oversized. */
export const PROMPT_MAX_CHARS = 24_000;

/** Per-step prompt budget inside the pass's prompt. */
export const STEP_PROMPT_CAP = 3_000;

/** Proposals kept per phase; anything past this is a model listing settings,
 *  not tuning them. */
export const MAX_PROPOSALS_PER_PHASE = 20;

/** A `running` report older than this belongs to a server that restarted
 *  mid-pass; a new press may replace it. */
export const TUNING_STALE_MS = 15 * 60_000;

export const TUNING_FIELDS: readonly TuningField[] = [
  "model",
  "reasoningEffort",
  "timeoutSeconds",
  "maxTurns",
];
const FIELD_SET = new Set<string>(TUNING_FIELDS);
/** The subset a phase-scoped proposal may name: `PhaseDef` has no model. */
const PHASE_FIELDS = new Set<string>(["timeoutSeconds", "maxTurns"]);

const TIMEOUT_MIN = 1;
const TIMEOUT_MAX = 86_400;
const MAX_TURNS_MIN = 1;
const MAX_TURNS_MAX = 1000;
const REASON_MAX = 400;
const SUMMARY_MAX = 300;

// ── Store ───────────────────────────────────────────────────────────────────

const store = createJsonArrayStore<TuningReport>({
  file: paths.tuningFile,
  label: "tuning.json",
});

export const readTuningReports = store.read;

/** The newest report for one pipeline, or null. */
export async function readTuningReport(pipelineId: string): Promise<TuningReport | null> {
  return (await store.read()).find((r) => r.pipelineId === pipelineId) ?? null;
}

/** Rename attempts before a persist gives up. See {@link writeTuningReport}. */
const WRITE_ATTEMPTS = 6;
const WRITE_BACKOFF_MS = 25;

function isTransientFsError(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

/**
 * Upsert by report id, newest-first, pruned to {@link TUNING_KEEP}.
 *
 * Retried on a transient rename failure. A pass persists after every phase
 * and the drawer re-reads on every ping, so on Windows — where a file open
 * for reading cannot be renamed over — the writer and the reader collide far
 * more often here than for a store that writes once. Losing a whole pass to
 * one such collision is the wrong trade; a short retry is not.
 */
export async function writeTuningReport(report: TuningReport): Promise<TuningReport> {
  return store.withLock(async () => {
    const list = await store.read();
    const next = [report, ...list.filter((r) => r.id !== report.id)];
    next.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const pruned = next.slice(0, TUNING_KEEP);
    for (let attempt = 1; ; attempt++) {
      try {
        await store.write(pruned);
        return report;
      } catch (e) {
        if (attempt >= WRITE_ATTEMPTS || !isTransientFsError(e)) throw e;
        await new Promise((r) => setTimeout(r, WRITE_BACKOFF_MS * attempt));
      }
    }
  });
}

// ── Resolution ──────────────────────────────────────────────────────────────

export interface ResolvedSetting {
  value: string | number | null;
  inheritedFrom: TuningInheritedFrom;
}

export type ResolvedStepSettings = Record<TuningField, ResolvedSetting>;

/** Model aliases and effort values per runtime, from the runtime seam. */
export type RuntimeCatalogue = Record<
  AgentRuntimeId,
  { models: string[]; efforts: ReasoningEffort[] }
>;

export function buildRuntimeCatalogue(): RuntimeCatalogue {
  const out = {} as RuntimeCatalogue;
  for (const id of RUNTIME_IDS) {
    const rt = runtimeFor(id);
    out[id] = { models: rt.models(), efforts: rt.reasoningEfforts() };
  }
  return out;
}

export function resolveStepRuntime(
  def: PipelineDefinition,
  phase: PhaseDef,
  step: PhaseStep,
): AgentRuntimeId {
  return resolveRuntimeId(step.runtime, phase.runtime, def.runtime);
}

function pick(layers: [TuningInheritedFrom, string | number | undefined][]): ResolvedSetting {
  for (const [from, v] of layers) {
    if (v !== undefined && v !== null) return { value: v, inheritedFrom: from };
  }
  return { value: null, inheritedFrom: "cli" };
}

/**
 * The value each tunable setting has *today* for one step, and which level
 * supplies it. Narrowest wins, matching how the engine launches the step;
 * `cli` means nothing sets it and the agent CLI's own default applies.
 */
export function resolveStepSettings(
  def: PipelineDefinition,
  phase: PhaseDef,
  step: PhaseStep,
): ResolvedStepSettings {
  return {
    model: pick([
      ["step", step.model],
      ["pipeline", def.model],
    ]),
    reasoningEffort: pick([
      ["step", step.reasoningEffort],
      ["pipeline", def.reasoningEffort],
    ]),
    timeoutSeconds: pick([
      ["step", step.timeoutSeconds],
      ["phase", phase.timeoutSeconds],
    ]),
    maxTurns: pick([
      ["step", step.capabilities?.maxTurns],
      ["phase", phase.capabilities?.maxTurns],
      ["pipeline", def.capabilities?.maxTurns],
    ]),
  };
}

/** A phase's own defaults for the two fields a phase can carry. */
export function resolvePhaseSettings(
  def: PipelineDefinition,
  phase: PhaseDef,
): Pick<ResolvedStepSettings, "timeoutSeconds" | "maxTurns"> {
  return {
    timeoutSeconds: pick([["phase", phase.timeoutSeconds]]),
    maxTurns: pick([
      ["phase", phase.capabilities?.maxTurns],
      ["pipeline", def.capabilities?.maxTurns],
    ]),
  };
}

// ── Prompt ──────────────────────────────────────────────────────────────────

function clipLine(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function clipBlock(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function renderSetting(s: ResolvedSetting): string {
  return s.value === null
    ? `(unset, from ${s.inheritedFrom})`
    : `${s.value} (from ${s.inheritedFrom})`;
}

/**
 * The tuning prompt for one phase.
 *
 * Everything is inline — the pass needs no tools and cannot look at the
 * repository — and every step prompt is quoted under a READ-ONLY heading. The
 * heading is documentation; the guarantee is that the schema below has no
 * field a prompt could travel back in. The rules lean hard on "propose
 * nothing": a pass that is asked to optimise will otherwise find something to
 * optimise every time.
 */
export function buildTuningPrompt(
  def: PipelineDefinition,
  phase: PhaseDef,
  catalogue: RuntimeCatalogue,
): string {
  const phaseSettings = resolvePhaseSettings(def, phase);
  const needs = (phase.needs ?? []).map((n) => (typeof n === "string" ? n : n.phase)).join(", ");

  const steps = phase.steps
    .map((step, i) => {
      const rt = resolveStepRuntime(def, phase, step);
      const settings = resolveStepSettings(def, phase, step);
      const roster = catalogue[rt] ?? { models: [], efforts: [] };
      const models = roster.models.length
        ? roster.models.join(", ")
        : "(free text; the runtime publishes no aliases)";
      const efforts = roster.efforts.length
        ? roster.efforts.join(", ")
        : "none — this runtime has no effort setting";
      return [
        `STEP ${i + 1} "${clipLine(step.name, 120)}"`,
        "  PROMPT (READ-ONLY — you may not change this, only read it to judge the work):",
        clipBlock(step.prompt, STEP_PROMPT_CAP),
        `  runtime: ${rt}`,
        `  model: ${renderSetting(settings.model)}`,
        `  reasoningEffort: ${renderSetting(settings.reasoningEffort)}`,
        `  timeoutSeconds: ${renderSetting(settings.timeoutSeconds)}`,
        `  maxTurns: ${renderSetting(settings.maxTurns)}`,
        `  allowed models: ${models}`,
        `  allowed reasoning efforts: ${efforts}`,
      ].join("\n");
    })
    .join("\n\n");

  const body = `You are reviewing whether one phase of an automated agent pipeline is configured to fit the work its steps describe. Answer only with JSON.

PIPELINE
  name: ${clipLine(def.name, 200)}
  phases: ${def.phases.length}

PHASE
  id: ${phase.id}
  name: ${clipLine(phase.name, 200)}
  gated: ${phase.gated ? "yes (a human reviews before the next phase)" : "no"}
  needs: ${needs || "(previous phase)"}
  steps: ${phase.steps.length}
  timeoutSeconds: ${renderSetting(phaseSettings.timeoutSeconds)}
  maxTurns: ${renderSetting(phaseSettings.maxTurns)}

${steps}

Answer with a single JSON object and nothing else:
{
  "summary": "one sentence on how well this phase's settings fit its work",
  "proposals": [
    {
      "scope": "step" | "phase",
      "step": "<exact step name, or null when scope is phase>",
      "field": "model" | "reasoningEffort" | "timeoutSeconds" | "maxTurns",
      "value": <a string for model/reasoningEffort, an integer for the others>,
      "reason": "one sentence naming the words in the prompt that led you here"
    }
  ]
}

Rules:
- "proposals": [] is a correct and expected answer. Most phases are already configured appropriately; say so in the summary and propose nothing rather than manufacturing a change.
- Propose a change only when the current setting is a concrete mismatch for the work the step's prompt describes — a trivial rename on the flagship model, a multi-file refactor on the smallest model, a long build with no timeout headroom. Say which words in the prompt led you there.
- Never propose a value equal to the current one.
- Only name a model from that step's "allowed models" list.
- Do not propose reasoningEffort for a step whose runtime lists no efforts.
- You cannot change any prompt. There is no field for it.
- For scope "phase", only "timeoutSeconds" and "maxTurns" are valid fields.`;

  return body.length > PROMPT_MAX_CHARS ? `${body.slice(0, PROMPT_MAX_CHARS - 1)}…` : body;
}

// ── Validation ──────────────────────────────────────────────────────────────

export interface ParseContext {
  def: PipelineDefinition;
  phase: PhaseDef;
  catalogue: RuntimeCatalogue;
}

export interface ParsedTuning {
  summary: string | null;
  proposals: TuningProposal[];
  unchanged: string[];
  warnings: string[];
}

interface Target {
  stepName: string | null;
  stepIndex: number | null;
  rt: AgentRuntimeId;
  current: ResolvedSetting;
}

function asString(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function asInt(v: unknown, min: number, max: number): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

function render(v: string | number | null): string {
  return v === null ? "unset" : String(v);
}

/**
 * Turn a model's JSON into validated proposals, or null when it isn't the
 * shape asked for.
 *
 * Nothing the model says about the definition is trusted: step names must
 * match exactly, fields must be in the closed set (so a `"field": "prompt"`
 * is dropped, not stored), models must be on the resolved runtime's roster,
 * efforts must exist for that runtime, integers must be inside the same
 * bounds the authoring validator enforces. A proposal equal to the current
 * value is dropped silently — it is the model agreeing, not proposing.
 */
export function parseTuningResponse(value: unknown, ctx: ParseContext): ParsedTuning | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.proposals)) return null;

  const { def, phase, catalogue } = ctx;
  const warnings: string[] = [];
  const proposals: TuningProposal[] = [];
  const phaseSettings = resolvePhaseSettings(def, phase);

  const byName = new Map<
    string,
    { index: number; rt: AgentRuntimeId; settings: ResolvedStepSettings }
  >();
  phase.steps.forEach((step, index) => {
    byName.set(step.name, {
      index,
      rt: resolveStepRuntime(def, phase, step),
      settings: resolveStepSettings(def, phase, step),
    });
  });

  for (const raw of v.proposals) {
    if (!raw || typeof raw !== "object") {
      warnings.push("dropped a proposal that was not an object");
      continue;
    }
    const p = raw as Record<string, unknown>;
    const scope = p.scope;
    if (scope !== "phase" && scope !== "step") {
      warnings.push(`dropped a proposal with unknown scope ${JSON.stringify(scope)}`);
      continue;
    }
    const field = typeof p.field === "string" ? p.field : "";
    if (!FIELD_SET.has(field)) {
      warnings.push(
        `dropped a proposal for "${clipLine(field || "(missing)", 40)}": not a tunable setting`,
      );
      continue;
    }
    const tf = field as TuningField;
    const reason = asString(p.reason, REASON_MAX);
    if (!reason) {
      warnings.push(`dropped a ${tf} proposal with no reason`);
      continue;
    }

    let target: Target;
    if (scope === "phase") {
      if (!PHASE_FIELDS.has(tf)) {
        warnings.push(`dropped a phase-level ${tf} proposal: a phase has no ${tf} of its own`);
        continue;
      }
      target = {
        stepName: null,
        stepIndex: null,
        rt: resolveRuntimeId(phase.runtime, def.runtime),
        current: phaseSettings[tf as "timeoutSeconds" | "maxTurns"],
      };
    } else {
      const name = typeof p.step === "string" ? p.step : "";
      const hit = byName.get(name);
      if (!hit) {
        warnings.push(
          `dropped a ${tf} proposal for unknown step ${JSON.stringify(clipLine(name || "(missing)", 60))}`,
        );
        continue;
      }
      target = { stepName: name, stepIndex: hit.index, rt: hit.rt, current: hit.settings[tf] };
    }

    const roster = catalogue[target.rt] ?? { models: [], efforts: [] };
    let proposed: string | number;
    if (tf === "model") {
      const m = asString(p.value, 200);
      if (!m || !roster.models.includes(m)) {
        warnings.push(
          `dropped model ${JSON.stringify(m ?? p.value)}: not in the ${target.rt} roster`,
        );
        continue;
      }
      proposed = m;
    } else if (tf === "reasoningEffort") {
      if (roster.efforts.length === 0) {
        warnings.push(`dropped a reasoningEffort proposal: ${target.rt} has no effort setting`);
        continue;
      }
      const e = asString(p.value, 20);
      if (!e || !(roster.efforts as string[]).includes(e)) {
        warnings.push(
          `dropped reasoningEffort ${JSON.stringify(e ?? p.value)}: not one of ${roster.efforts.join("|")}`,
        );
        continue;
      }
      proposed = e;
    } else if (tf === "timeoutSeconds") {
      const n = asInt(p.value, TIMEOUT_MIN, TIMEOUT_MAX);
      if (n === null) {
        warnings.push(
          `dropped timeoutSeconds ${JSON.stringify(p.value)}: must be an integer ${TIMEOUT_MIN}-${TIMEOUT_MAX}`,
        );
        continue;
      }
      proposed = n;
    } else {
      const n = asInt(p.value, MAX_TURNS_MIN, MAX_TURNS_MAX);
      if (n === null) {
        warnings.push(
          `dropped maxTurns ${JSON.stringify(p.value)}: must be an integer ${MAX_TURNS_MIN}-${MAX_TURNS_MAX}`,
        );
        continue;
      }
      proposed = n;
    }

    // The model agreeing with the current value is not a proposal.
    if (proposed === target.current.value) continue;

    if (proposals.length >= MAX_PROPOSALS_PER_PHASE) {
      warnings.push(`dropped a ${tf} proposal: more than ${MAX_PROPOSALS_PER_PHASE} for one phase`);
      continue;
    }
    proposals.push({
      phaseId: phase.id,
      phaseName: phase.name,
      scope: scope as TuningScope,
      stepName: target.stepName,
      stepIndex: target.stepIndex,
      field: tf,
      current: target.current.value,
      proposed,
      inheritedFrom: target.current.inheritedFrom,
      before: render(target.current.value),
      after: render(proposed),
      reason,
    });
  }

  const proposedSteps = new Set(
    proposals.map((p) => p.stepName).filter((n): n is string => n !== null),
  );
  const unchanged = phase.steps.map((s) => s.name).filter((n) => !proposedSteps.has(n));

  return { summary: asString(v.summary, SUMMARY_MAX), proposals, unchanged, warnings };
}

// ── The pass ────────────────────────────────────────────────────────────────

export interface TuningDeps {
  runner: AnalysisRunner;
  now: () => Date;
  /** Called after every persisted change so the UI can re-fetch. */
  onProgress: (report: TuningReport) => Promise<void>;
}

function emptyPhase(phase: PhaseDef): PhaseTuning {
  return {
    phaseId: phase.id,
    phaseName: phase.name,
    status: "pending",
    summary: null,
    proposals: [],
    unchanged: [],
    warnings: [],
    costUsd: null,
    tokens: null,
    durationMs: null,
    error: null,
  };
}

/** A fresh `running` report with every phase pending. Persisted by the route
 *  before the pass starts so a second press sees it. */
export function seedTuningReport(def: PipelineDefinition, id: string, now: Date): TuningReport {
  return {
    id,
    pipelineId: def.id,
    pipelineName: def.name,
    status: "running",
    startedAt: now.toISOString(),
    endedAt: null,
    phasesDone: 0,
    phasesTotal: def.phases.length,
    phases: def.phases.map(emptyPhase),
    costUsd: null,
    tokens: null,
    error: null,
  };
}

function addNullable(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

/**
 * Run one pass per phase, **sequentially**, persisting after each.
 *
 * Sequential on purpose: the shared analysis runner admits one pass at a time
 * and refuses the rest rather than queueing, so firing every phase at once
 * would produce one answer and N−1 "busy" failures. Each phase still gets its
 * own dedicated pass with its own prompt; only the scheduling is serial.
 *
 * A disabled or budget-blocked runner skips every remaining phase — running
 * four more passes for four identical refusals burns time for nothing. Any
 * other failure marks that phase and carries on; a re-press is the retry.
 */
export async function performPipelineTuning(
  def: PipelineDefinition,
  seed: TuningReport,
  deps: TuningDeps,
): Promise<TuningReport> {
  const catalogue = buildRuntimeCatalogue();
  let report: TuningReport = seed;

  const persist = async (next: TuningReport) => {
    report = next;
    await writeTuningReport(report);
    await deps.onProgress(report);
  };
  const withPhase = (i: number, patch: Partial<PhaseTuning>, rest: Partial<TuningReport> = {}) => ({
    ...report,
    ...rest,
    phases: report.phases.map((p, j) => (j === i ? { ...p, ...patch } : p)),
  });

  await persist(report);

  let haltedBy: string | null = null;
  for (let i = 0; i < def.phases.length; i++) {
    const phase = def.phases[i];

    if (haltedBy) {
      await persist(withPhase(i, { status: "skipped", error: haltedBy }, { phasesDone: i + 1 }));
      continue;
    }

    await persist(withPhase(i, { status: "running" }));

    const result = await deps.runner.run(
      {
        kind: "tune",
        prompt: buildTuningPrompt(def, phase, catalogue),
        // The pass reads nothing from disk, but the CLI needs a real directory;
        // the phase's cwd may not exist yet, so fall back to the Argus dir.
        cwd: phase.cwd || path.dirname(paths.tuningFile()),
      },
      (value) => parseTuningResponse(value, { def, phase, catalogue }),
    );

    const spent = { costUsd: result.costUsd, tokens: result.tokens, durationMs: result.durationMs };
    const totals = {
      costUsd: addNullable(report.costUsd, result.costUsd),
      tokens: addNullable(report.tokens, result.tokens),
      phasesDone: i + 1,
    };

    if (result.ok && result.value) {
      await persist(
        withPhase(
          i,
          {
            ...spent,
            status: "ready",
            summary: result.value.summary,
            proposals: result.value.proposals,
            unchanged: result.value.unchanged,
            warnings: result.value.warnings,
            error: null,
          },
          totals,
        ),
      );
      continue;
    }

    const error = result.error ?? "the tuning pass produced nothing";
    if (result.failure === "disabled" || result.failure === "budget-blocked") {
      haltedBy = error;
      await persist(withPhase(i, { ...spent, status: "skipped", error }, totals));
      continue;
    }
    await persist(withPhase(i, { ...spent, status: "failed", error }, totals));
  }

  const anyReady = report.phases.some((p) => p.status === "ready");
  const status = anyReady ? "ready" : haltedBy ? "skipped" : "failed";
  await persist({
    ...report,
    status,
    endedAt: deps.now().toISOString(),
    error:
      status === "ready" ? null : (haltedBy ?? report.phases.find((p) => p.error)?.error ?? null),
  });
  return report;
}

/** Whether a stored `running` report is still plausibly in flight. */
export function isTuningInFlight(report: TuningReport | null, now: Date): boolean {
  if (!report || report.status !== "running") return false;
  return now.getTime() - Date.parse(report.startedAt) < TUNING_STALE_MS;
}
