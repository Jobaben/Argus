/**
 * Completion: deciding whether a run's own report of success may be accepted.
 *
 * Pure — no I/O, no clock of its own — so the engine's signal path and its
 * run-record recovery path share one reading of the agent's words, and the
 * stop hook's copy of the classifier (hooks/argus-signal.mjs, which must stay
 * a dependency-free script) can be checked against it over one fixture corpus.
 *
 * What a marker is, and is not. `ARGUS_OUTCOME: succeeded` is something the
 * agent wrote. Requiring it makes "the process stopped" and "the agent says it
 * finished" two different facts, which is the whole point; it never makes the
 * agent's claim true. Checks, the declared result, the gate and the knowledge
 * commit stay separate authorities, and nothing here speaks for them.
 */
import type {
  CompletionMarkerPolicy,
  OutcomeMarkerKind,
  PhaseDef,
  PipelineDefinition,
  RetryableClass,
  SignalCompletionMeta,
  StepCompletion,
} from "../sources/pipelineTypes.js";

/** Every marker occurrence, anywhere in the message, in any case — the same
 *  reading the stop hook has always used for `failed`/`blocked`. A marker's
 *  position is not a security property (the agent wrote all of it); what
 *  matters is that two different conclusions are never guessed into one. */
const MARKER_RE = /\bARGUS_OUTCOME:\s*(succeeded|failed|blocked)\b/gi;

export interface MarkerClassification {
  kind: OutcomeMarkerKind;
  /** Every distinct conclusion found, in first-seen order. */
  found: Array<"succeeded" | "failed" | "blocked">;
  /** For `failed`/`blocked`: the trailing text of the last such marker line,
   *  as `"<kind>: <text>"` (or just the kind). Null otherwise. */
  reason: string | null;
}

/**
 * Classify the outcome marker(s) in a run's final message.
 *
 * - none at all → `missing`;
 * - more than one distinct conclusion → `conflicting` (repeating the same one
 *   is harmless: models often recap before the required last line);
 * - otherwise the one conclusion.
 */
export function classifyOutcomeMarker(message: string | null | undefined): MarkerClassification {
  const text = typeof message === "string" ? message : "";
  const matches = [...text.matchAll(MARKER_RE)];
  const found: Array<"succeeded" | "failed" | "blocked"> = [];
  for (const m of matches) {
    const kind = m[1].toLowerCase() as "succeeded" | "failed" | "blocked";
    if (!found.includes(kind)) found.push(kind);
  }
  if (found.length === 0) return { kind: "missing", found, reason: null };
  if (found.length > 1) return { kind: "conflicting", found, reason: null };
  const kind = found[0];
  if (kind === "succeeded") return { kind, found, reason: null };
  // The reason is the rest of the last marker's line. Read separately from
  // the match, so a trailing capture can never swallow a second marker on the
  // same line (an echoed instruction naming both outcomes is `conflicting`).
  const last = matches[matches.length - 1];
  const after = text.slice((last.index ?? 0) + last[0].length);
  const tail = after
    .split(/\r?\n/, 1)[0]
    .replace(/^[\s:–—-]+/, "")
    .trim();
  return { kind, found, reason: tail ? `${kind}: ${tail}` : kind };
}

/** The keys a stop payload may name the agent's closing words under — the
 *  same list, in the same order, as the hook's `lastMessage`. */
const MESSAGE_KEYS = ["last_assistant_message", "last_agent_message", "last_message"] as const;

/**
 * The final message a signal's payload carries, or null when it carries none
 * (a raw-text payload, a caller that sent no message). Null is not an empty
 * message: it means Argus was not told what the agent said.
 */
export function completionMessageOf(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  for (const key of MESSAGE_KEYS) {
    if (typeof record[key] === "string") return record[key] as string;
  }
  return null;
}

/** Narrowest wins: the phase's policy, else the pipeline's, else `required`. */
export function resolveCompletionPolicy(
  def: Pick<PipelineDefinition, "completion">,
  phaseDef: Pick<PhaseDef, "completion"> | undefined,
): CompletionMarkerPolicy {
  return phaseDef?.completion?.marker ?? def.completion?.marker ?? "required";
}

const MARKER_KINDS: readonly OutcomeMarkerKind[] = [
  "succeeded",
  "failed",
  "blocked",
  "missing",
  "conflicting",
];

/**
 * Validate a signal's hook metadata. `null` = none was sent (a hook older
 * than version 2); `"malformed"` = something was sent that is not the shape
 * a hook writes, which is recorded rather than trusted or silently dropped.
 */
export function parseHookMeta(raw: unknown): SignalCompletionMeta | null | "malformed" {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return "malformed";
  const r = raw as Record<string, unknown>;
  const version = r.hookVersion;
  const marker = r.marker;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return "malformed";
  if (typeof marker !== "string" || !MARKER_KINDS.includes(marker as OutcomeMarkerKind)) {
    return "malformed";
  }
  return { hookVersion: version, marker: marker as OutcomeMarkerKind };
}

export interface CompletionInput {
  /** The signal's type. `needs-input` never reaches this decision. */
  signal: "completed" | "failed";
  source: StepCompletion["source"];
  policy: CompletionMarkerPolicy;
  /** The final message Argus received, or null when it was not given one. */
  message: string | null;
  /** The signal's hook metadata, unvalidated. Ignored on the run-record path. */
  hookMeta?: unknown;
  at: string;
}

export type CompletionDecision =
  | { accept: true; record: StepCompletion }
  | {
      accept: false;
      record: StepCompletion;
      /** The class a refused completion fails under. Absent for an agent's own
       *  failure report, which keeps the class its caller already assigns. */
      failureClass?: RetryableClass;
      reason: string;
    };

const REQUIRED_MARKER = "`ARGUS_OUTCOME: succeeded`";

/**
 * Decide one run's completion from what Argus itself read.
 *
 * On a `completed` signal:
 * - `succeeded` → accepted under either policy;
 * - `missing` → refused as `unverified` under `required`, accepted (and
 *   recorded as markerless) under `lenient`;
 * - `conflicting` → refused as `unverified` under either policy;
 * - `failed`/`blocked` → refused under either policy, as `signal`: the agent
 *   said it did not succeed, and a completion type does not overrule that;
 * - the hook's own reading disagreeing with Argus's → refused as
 *   `unverified` under `required` (two readings of one message that differ is
 *   exactly the ambiguity the policy exists to refuse); recorded, and decided
 *   on the message alone, under `lenient`.
 *
 * A `failed` signal is the agent's own failure report: it is recorded, never
 * second-guessed into a success.
 */
export function decideCompletion(input: CompletionInput): CompletionDecision {
  const classified = classifyOutcomeMarker(input.message);
  const marker = classified.kind;
  const base: StepCompletion = {
    signal: input.signal,
    source: input.source,
    policy: input.policy,
    marker,
    verdict: "accepted",
    at: input.at,
  };
  if (input.source === "signal") {
    const meta = parseHookMeta(input.hookMeta);
    if (meta === "malformed") base.hook = { version: null, marker: null, agrees: false };
    else if (meta) {
      base.hook = {
        version: meta.hookVersion,
        marker: meta.marker,
        agrees: meta.marker === marker,
      };
    }
  }

  if (input.signal === "failed") {
    return {
      accept: false,
      record: { ...base, verdict: "reported-failure" },
      reason: classified.reason ?? "the agent reported failure",
    };
  }

  const refuse = (failureClass: RetryableClass, reason: string): CompletionDecision => ({
    accept: false,
    record: { ...base, verdict: "refused", reason },
    failureClass,
    reason,
  });
  const where = input.message === null ? "the completion carried no final message" : null;

  if (marker === "failed" || marker === "blocked") {
    return refuse(
      "signal",
      `completion refused: the final message reports ${classified.reason ?? marker}`,
    );
  }
  if (marker === "conflicting") {
    return refuse(
      "unverified",
      `completion refused as unverified: the final message carries conflicting ARGUS_OUTCOME markers (${classified.found.join(", ")}); it must end with exactly one, ${REQUIRED_MARKER}`,
    );
  }
  if (base.hook && !base.hook.agrees && input.policy === "required") {
    const said = base.hook.marker ?? "malformed metadata";
    return refuse(
      "unverified",
      `completion refused as unverified: the stop hook reported marker "${said}" but Argus read "${marker}" in the final message it delivered`,
    );
  }
  if (marker === "missing") {
    if (input.policy === "lenient") return { accept: true, record: base };
    return refuse(
      "unverified",
      `completion refused as unverified: ${where ?? "the final message has no ARGUS_OUTCOME marker"}; this phase requires ${REQUIRED_MARKER} (declare completion.marker "lenient" to accept a markerless completion)`,
    );
  }
  return { accept: true, record: base };
}

/**
 * Per-run completion across a phase's current steps, derived from what each
 * step recorded — never stamped from whichever signal arrived last. A step
 * with no record (it has not reported, or it was recorded before completion
 * provenance existed) counts as `unknown`, not as a success.
 */
export interface PhaseCompletionSummary {
  runs: number;
  markers: Partial<Record<OutcomeMarkerKind | "unknown", number>>;
  /** Every current step reported, and every report carried `succeeded`. */
  allSucceededMarkers: boolean;
}

export function summarizePhaseCompletion(
  steps: ReadonlyArray<{ completion?: StepCompletion }>,
): PhaseCompletionSummary {
  const markers: PhaseCompletionSummary["markers"] = {};
  for (const step of steps) {
    const key = step.completion?.marker ?? "unknown";
    markers[key] = (markers[key] ?? 0) + 1;
  }
  return {
    runs: steps.length,
    markers,
    allSucceededMarkers:
      steps.length > 0 && steps.every((s) => s.completion?.marker === "succeeded"),
  };
}
