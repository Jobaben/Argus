import type {
  DecisionObservation,
  GateDecision,
  ObservedTerminationClass,
  Run,
} from "@argus/contracts";
import { canonicalDigest } from "./canonical.js";

/**
 * Observations, derived read-only from existing durable records (RFC §O.1).
 *
 * Nothing here writes. An observation is what Argus's own records say
 * happened; it is never an assessment and no provider produces one. The
 * streams stay separate: operator actions, observed terminations, and — in
 * the contract only — review findings and later outcomes, which no durable
 * source holds yet and which are therefore never derived.
 */

export type TerminationObservation =
  { ok: true; value: ObservedTerminationClass } | { ok: false; reason: string };

/**
 * The observed termination class of a finished run, from its record.
 *
 * `timed-out` / `stalled` → `deadline`; `spawn-failed` → `never-ran`; a
 * process that exited on its own → `ended-normally`. Everything else is not
 * derivable and says why — notably a run `interrupted` by a restart, which
 * did run and so is not `never-ran` (a correction to §H.2), and an Argus
 * abort (`killed`), which is not in the probe's answer space.
 */
export function observeTermination(run: Run): TerminationObservation {
  if (run.status === "running") return { ok: false, reason: "the run has not finished" };
  switch (run.termination) {
    case "timed-out":
    case "stalled":
      return { ok: true, value: "deadline" };
    case "spawn-failed":
      return { ok: true, value: "never-ran" };
    case "killed":
      return { ok: false, reason: "killed by Argus (an abort or cancel), not a termination class" };
    case "exited":
    case undefined:
      break;
    default:
      return { ok: false, reason: `unrecognised termination "${String(run.termination)}"` };
  }
  if (run.status === "interrupted") {
    return {
      ok: false,
      reason: "interrupted by a restart while it ran; how it would have ended is unknown",
    };
  }
  if (run.status === "cancelled" || run.status === "skipped") {
    return { ok: false, reason: `the run was ${run.status}` };
  }
  if (!run.startedAt) return { ok: false, reason: "the run records no start" };
  return { ok: true, value: "ended-normally" };
}

function digestOf(record: unknown): string | null {
  try {
    return canonicalDigest(record).sha256;
  } catch {
    // A record that is not canonical JSON (it parsed from disk, so this is
    // essentially unreachable) has no stable digest; it is not observed.
    return null;
  }
}

/** Observed terminations for finished runs whose record states one. */
export function terminationObservations(runs: readonly Run[]): DecisionObservation[] {
  const out: DecisionObservation[] = [];
  for (const run of runs) {
    const observed = observeTermination(run);
    if (!observed.ok) continue;
    const recordDigest = digestOf(run);
    if (!recordDigest) continue;
    out.push({
      kind: "observed-termination",
      subject: { kind: "run", runId: run.id },
      value: observed.value,
      source: { store: "runs", recordId: run.id, recordDigest },
      observedAt: run.endedAt ?? run.startedAt ?? run.queuedAt,
    });
  }
  return out;
}

/**
 * Operator actions from the gate-decision log. Only `mechanism: "operator"`
 * records count: an automated approval is not a human action, and an
 * `unspecified` in-process caller is not known to be one. One observation per
 * phase the decision names; the principal is copied as recorded, never
 * upgraded.
 */
export function operatorActionObservations(
  decisions: readonly GateDecision[],
): DecisionObservation[] {
  const out: DecisionObservation[] = [];
  for (const d of decisions) {
    if (d.mechanism !== "operator") continue;
    const recordDigest = digestOf(d);
    if (!recordDigest) continue;
    for (const p of d.phases) {
      out.push({
        kind: "operator-action",
        subject: {
          kind: "phase-attempt",
          instanceId: d.instanceId,
          phaseId: p.phaseId,
          attempt: p.attempt,
        },
        value: d.decision,
        principal: d.principal,
        source: { store: "gate-decisions", recordId: d.id, recordDigest },
        observedAt: d.recordedAt,
      });
    }
  }
  return out;
}
