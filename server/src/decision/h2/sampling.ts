import type { AnswerSpace, DefinitionRef, ObservationSource, Run } from "@argus/contracts";
import { canonicalDigest, sha256Hex } from "../canonical.js";
import { observeTermination, terminationObservations } from "../observations.js";

/**
 * Who is eligible for which H2 question, who is sampled, and the reference a
 * probe item carries (RFC §P.2, §P.3, §P.6).
 *
 * Everything here is a pure function of a run record and the definitions it
 * is handed. The sampling draw never reads the run's outcome: it hashes the
 * seed, the question and the run id, so selection cannot lean towards a
 * termination class.
 */

/** The H2 question versions collection asks by default. */
export const H2_QUESTIONS = {
  residual: { id: "run.failure-cause.residual", version: 1 },
  probe: { id: "run.termination-probe", version: 1 },
} as const;

export const SAMPLING_METHOD = "sha256-prefix-52@1";
export const RESIDUAL_ELIGIBILITY = "unsuccessful-with-observed-ended-normally-or-deadline@2";
export const PROBE_ELIGIBILITY = "observed-termination-in-answer-space@2";
export const EXCLUSION_RULES = [
  "ended-before-collection-start@1",
  "runtime-not-supported@2",
  "missed-window@1",
] as const;
export const REFERENCE_DERIVATION = "observe-termination@1";

/** The draw: the first 52 bits of the hash, as a number in [0, 1). */
export function sampleUnit(
  seed: string,
  q: { id: string; version: number },
  runId: string,
): number {
  const hex = sha256Hex(`${seed}|${q.id}@${q.version}|${runId}`).slice(0, 13);
  return parseInt(hex, 16) / 2 ** 52;
}

export function isSelected(
  seed: string,
  q: { id: string; version: number },
  runId: string,
  rate: number,
): boolean {
  return sampleUnit(seed, q, runId) < rate;
}

export const runMoment = (r: Run): number => (r.endedAt ? Date.parse(r.endedAt) : NaN);

export type Consideration =
  { kind: "not-yet" } | { kind: "outside" } | { kind: "consider"; missedWindow: boolean };

/**
 * Whether a run enters the population now. `not-yet` is revisited on a later
 * check; `outside` never enters (it ended before collection started, or has
 * no usable end time).
 */
export function considerRun(
  run: Run,
  startMs: number,
  nowMs: number,
  window: { minAgeMs: number; maxAgeMs: number },
): Consideration {
  if (run.status === "running") return { kind: "not-yet" };
  const ended = runMoment(run);
  if (!Number.isFinite(ended) || ended < startMs) return { kind: "outside" };
  const age = nowMs - ended;
  if (age < window.minAgeMs) return { kind: "not-yet" };
  return { kind: "consider", missedWindow: age > window.maxAgeMs };
}

/** The observed termination class, or the precise reason it cannot be derived. */
export function terminationStratum(run: Run): { stratum: string; notDerivable: string | null } {
  const o = observeTermination(run);
  if (o.ok) return { stratum: o.value, notDerivable: null };
  let token = "unrecognised";
  if (run.termination === "killed") token = "killed";
  else if (run.status === "interrupted") token = "interrupted";
  else if (run.status === "cancelled" || run.status === "skipped") token = run.status;
  else if (run.status === "running") token = "running";
  else if (!run.startedAt) token = "no-start";
  return { stratum: "not-derivable", notDerivable: token };
}

/** The Autopsy definition of failure, without `interrupted` (§P.2). */
export function isUnsuccessful(run: Run): boolean {
  return run.status === "failed" || run.outcome === "failed" || run.outcome === "blocked";
}

const unsupported = (run: Run) => !["claude", "codex"].includes(run.runtime ?? "claude");

export type Eligibility = { ok: true } | { ok: false; reason: string };

export function residualEligibility(run: Run): Eligibility {
  if (unsupported(run)) return { ok: false, reason: "runtime-not-supported" };
  // Derivability first: an interrupted or cancelled run is not "successful",
  // it is a run whose ending Argus did not observe.
  const t = terminationStratum(run);
  if (t.notDerivable) return { ok: false, reason: `termination-not-derivable:${t.notDerivable}` };
  if (!isUnsuccessful(run)) return { ok: false, reason: "successful" };
  if (t.stratum === "never-ran") return { ok: false, reason: "never-ran" };
  if (t.stratum !== "ended-normally" && t.stratum !== "deadline") {
    return { ok: false, reason: `termination-${t.stratum}` };
  }
  return { ok: true };
}

/** Option ids of a closed choice space; empty for any other shape. */
export function optionIds(space: AnswerSpace): string[] {
  return space.shape === "choice" ? space.options.map((o) => o.id) : [];
}

export function probeEligibility(run: Run, space: AnswerSpace): Eligibility {
  if (unsupported(run)) return { ok: false, reason: "runtime-not-supported" };
  const t = terminationStratum(run);
  if (t.notDerivable) return { ok: false, reason: `termination-not-derivable:${t.notDerivable}` };
  if (!optionIds(space).includes(t.stratum)) {
    return { ok: false, reason: "construction-error:label-outside-answer-space" };
  }
  return { ok: true };
}

// ── Retained observations and references ────────────────────────────────────

export interface RetainedObservation {
  source: ObservationSource;
  observedAt: string;
}

/**
 * The reference a probe item was scored against, retained as it was derived
 * (§P.6). It lives in the collection ledger, never in a snapshot.
 */
export interface ProbeReference {
  stream: "observed-termination";
  label: string;
  /** The question whose answer space the label was validated against. */
  answerSpace: DefinitionRef;
  observation: RetainedObservation;
  derivation: string;
  /** sha256 over the canonical JSON of every field above. */
  digest: string;
}

export function referenceDigest(ref: Omit<ProbeReference, "digest">): string {
  return canonicalDigest({
    stream: ref.stream,
    label: ref.label,
    answerSpace: ref.answerSpace,
    observation: ref.observation,
    derivation: ref.derivation,
  }).sha256;
}

/** The observation behind a run's termination class, with the digest of the record as read. */
export function retainedObservation(run: Run): RetainedObservation | null {
  const [o] = terminationObservations([run]);
  return o ? { source: o.source, observedAt: o.observedAt } : null;
}

export type ReferenceResult =
  | { ok: true; reference: ProbeReference }
  | { ok: false; reason: "not-derivable" | "construction-error"; detail: string };

/** Derive and validate the probe reference for a run, against the question actually asked. */
export function probeReference(
  run: Run,
  question: { ref: DefinitionRef; answers: AnswerSpace },
): ReferenceResult {
  const o = observeTermination(run);
  const observation = retainedObservation(run);
  if (!o.ok || !observation) {
    return { ok: false, reason: "not-derivable", detail: o.ok ? "no stable digest" : o.reason };
  }
  if (!optionIds(question.answers).includes(o.value)) {
    return {
      ok: false,
      reason: "construction-error",
      detail: `label "${o.value}" is not an option of ${question.ref.id}@${question.ref.version}`,
    };
  }
  const base = {
    stream: "observed-termination" as const,
    label: o.value,
    answerSpace: { ...question.ref },
    observation,
    derivation: REFERENCE_DERIVATION,
  };
  return { ok: true, reference: { ...base, digest: referenceDigest(base) } };
}
