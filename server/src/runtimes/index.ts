/**
 * The runtime registry: one place that answers "which agent CLI runs this?"
 *
 * Resolution is deliberately narrowest-wins — step, then phase, then pipeline
 * (or schedule / launch input), then `ARGUS_AGENT`, then Claude Code. A pipeline
 * can therefore mix runtimes phase by phase: draft with one, review with the
 * other, and the board shows which produced what.
 *
 * Nothing here reads the filesystem or spawns anything, so it is safe to call
 * from validation paths and from the UI's `GET /api/runtimes`.
 */

import { claudeRuntime } from "./claude.js";
import { codexRuntime } from "./codex.js";
import { log } from "../log.js";
import type { AgentRuntime, RunEnvelope } from "./types.js";
import type { AgentRuntimeId } from "@argus/contracts";

export type {
  AgentRuntime,
  AnalysisPlanOptions,
  RunEnvelope,
  RunPlanOptions,
  SpawnPlan,
} from "./types.js";
export { claudeRuntime, DEFAULT_ANALYSIS_MODEL, parseClaudeEnvelope } from "./claude.js";
export { codexRuntime, codexSandbox, parseCodexEnvelope } from "./codex.js";

export const RUNTIMES: Record<AgentRuntimeId, AgentRuntime> = {
  claude: claudeRuntime,
  codex: codexRuntime,
};

export const RUNTIME_IDS: AgentRuntimeId[] = ["claude", "codex"];

/** `"claude"` unless the value is a known id. Never throws — callers on the
 *  read path have to render *something* for a hand-edited JSON file. */
export function isRuntimeId(v: unknown): v is AgentRuntimeId {
  return v === "claude" || v === "codex";
}

/**
 * The process-wide default, from `ARGUS_AGENT`.
 *
 * Claude Code when unset, because every schedule, pipeline and run recorded
 * before runtimes existed was one and an upgrade must not silently re-point
 * them at a different agent.
 */
export function defaultRuntimeId(): AgentRuntimeId {
  const raw = process.env.ARGUS_AGENT?.trim().toLowerCase();
  if (!raw) return "claude";
  if (isRuntimeId(raw)) return raw;
  log.warn("ignoring invalid ARGUS_AGENT", {
    value: raw,
    allowed: RUNTIME_IDS.join(" | "),
    using: "claude",
  });
  return "claude";
}

/** Narrowest-wins resolution over an ordered list of candidate overrides. */
export function resolveRuntimeId(...candidates: (AgentRuntimeId | null | undefined)[]) {
  for (const c of candidates) if (isRuntimeId(c)) return c;
  return defaultRuntimeId();
}

/** The runtime for a resolved id, falling back to the default for anything
 *  unrecognized (a hand-edited record, or a downgrade from a newer Argus). */
export function runtimeFor(id: AgentRuntimeId | null | undefined): AgentRuntime {
  return RUNTIMES[isRuntimeId(id) ? id : defaultRuntimeId()];
}

/**
 * Parse a run's captured output without being told which CLI produced it.
 *
 * Used by the paths that read a log back long after the spawn — the boot
 * backfill and the adopted-run finalizer — where the run record's `runtime` is
 * the authority but may be absent on records written before runtimes existed.
 * Trying the named runtime first and the others after means an old Claude run
 * and a new Codex run both parse, and a mislabelled one still does.
 */
export function parseEnvelopeFor(id: AgentRuntimeId | null | undefined, text: string): RunEnvelope {
  const primary = runtimeFor(id);
  const first = primary.parseEnvelope(text);
  if (first.result !== null || first.tokens !== null || first.isError !== null) return first;
  for (const other of RUNTIME_IDS) {
    if (other === primary.id) continue;
    const alt = RUNTIMES[other].parseEnvelope(text);
    if (alt.result !== null || alt.tokens !== null || alt.isError !== null) return alt;
  }
  return first;
}
