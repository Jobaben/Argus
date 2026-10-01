import type {
  GateDecision,
  GateDecisionPrincipal,
  PipelineDefinition,
  PipelineInstance,
} from "@argus/contracts";
import { decisionEffect } from "../../sources/gateDecisions.js";
import { canonicalDigest } from "../canonical.js";
import { relevantSteps } from "./projection.js";

/**
 * Which gate pauses are H1 items, and what the operator did at one (RFC §Q.2,
 * §Q.5). Pure functions of an instance as read and the gate-decision records
 * as read: nothing here writes, locks or calls.
 */

export interface GateItem {
  instanceId: string;
  phaseId: string;
  attempt: number;
}

export const gateItemKey = (i: GateItem, q: { id: string; version: number }) =>
  `${i.instanceId}|${i.phaseId}#${i.attempt}|${q.id}@${q.version}`;

/** Records naming this exact phase attempt as awaiting approval. */
export function recordsFor(item: GateItem, decisions: readonly GateDecision[]): GateDecision[] {
  return decisions.filter(
    (d) =>
      d.instanceId === item.instanceId &&
      d.phases.some(
        (p) =>
          p.phaseId === item.phaseId &&
          p.attempt === item.attempt &&
          p.status === "awaiting-approval",
      ),
  );
}

export type Eligibility =
  | { ok: true; relevantRuns: string[]; population: "manual" | "auto-approve-declared" }
  | { ok: false; reason: string };

/** Whether the definition the instance runs on declares `autoApprove` on this phase. */
export function populationOf(
  def: PipelineDefinition | undefined,
  phaseId: string,
): "manual" | "auto-approve-declared" {
  return def?.phases.find((p) => p.id === phaseId)?.autoApprove
    ? "auto-approve-declared"
    : "manual";
}

/**
 * Whether the exact attempt is a confirmed ordinary gate pause right now
 * (§Q.2). `decisions` must be the gate-decision records as read *after* the
 * instance, so a decision on this attempt cannot slip between the two reads.
 */
export function gateEligibility(
  inst: PipelineInstance | null,
  item: GateItem,
  def: PipelineDefinition | undefined,
  decisions: readonly GateDecision[],
): Eligibility {
  if (!inst) return { ok: false, reason: "instance-gone" };
  const phase = inst.phases.find((p) => p.id === item.phaseId);
  if (!phase) return { ok: false, reason: "phase-gone" };
  if (phase.attempt !== item.attempt) return { ok: false, reason: "attempt-moved" };
  if (phase.status !== "awaiting-approval") return { ok: false, reason: `phase-${phase.status}` };
  if (phase.pause === "needs-input") return { ok: false, reason: "needs-input" };
  if (phase.pause !== "gate") return { ok: false, reason: "unknown-pause" };
  if (inst.pendingGateOperation) return { ok: false, reason: "pending-operation" };
  if (recordsFor(item, decisions).length > 0) return { ok: false, reason: "prior-decision-record" };
  const steps = relevantSteps(phase);
  if (steps.length === 0) return { ok: false, reason: "no-relevant-steps" };
  if (steps.some((s) => !s.runId || s.status !== "succeeded")) {
    return { ok: false, reason: "relevant-steps-incomplete" };
  }
  return {
    ok: true,
    relevantRuns: steps.map((s) => s.runId as string),
    population: populationOf(def, item.phaseId),
  };
}

// ── References ──────────────────────────────────────────────────────────────

export const REFERENCE_DERIVATION = "applied-operator-gate-decision@1";

/** The operator-action reference, retained as derived (§Q.5). */
export interface OperatorActionReference {
  stream: "operator-action";
  derivation: typeof REFERENCE_DERIVATION;
  value: "approve" | "revise" | "abort";
  label: "sent-back" | "not-sent-back";
  decisionId: string;
  /** sha256 over the canonical JSON of the record as read. */
  recordDigest: string;
  mechanism: "operator";
  channel: string;
  /** Copied as recorded. A session is an account, not proof of a person. */
  principal: GateDecisionPrincipal;
  recordedAt: string;
  effect: "applied";
  /** Other records naming the attempt, none of which took effect. */
  others: Array<{ id: string; decision: string; mechanism: string; effect: string }>;
  /** sha256 over the canonical JSON of every field above. */
  digest: string;
}

export function referenceDigest(ref: Omit<OperatorActionReference, "digest">): string {
  const { stream, derivation, value, label, decisionId, recordDigest, mechanism, channel } = ref;
  return canonicalDigest({
    stream,
    derivation,
    value,
    label,
    decisionId,
    recordDigest,
    mechanism,
    channel,
    principal: ref.principal,
    recordedAt: ref.recordedAt,
    effect: ref.effect,
    others: ref.others,
  }).sha256;
}

export type Settlement =
  | { kind: "wait"; reason: "effect-incomplete" }
  | { kind: "labeled"; reference: OperatorActionReference }
  | { kind: "unlabeled"; reason: string; decisionIds: string[] };

const digestOrNull = (v: unknown): string | null => {
  try {
    return canonicalDigest(v).sha256;
  } catch {
    return null;
  }
};

/**
 * What the operator did at an item whose attempt is no longer eligible. Only
 * an `applied` record with `mechanism: "operator"` becomes a reference;
 * automated, unattributed, incomplete, unapplied, conflicting and unknown
 * records never do, and a missing action is never a negative.
 */
export function settle(
  item: GateItem,
  inst: PipelineInstance | null,
  decisions: readonly GateDecision[],
): Settlement {
  const records = recordsFor(item, decisions);
  const ids = records.map((d) => d.id);
  if (!inst) return { kind: "unlabeled", reason: "instance-gone", decisionIds: ids };
  if (records.length === 0)
    return { kind: "unlabeled", reason: "no-decision-record", decisionIds: [] };
  const withEffect = records.map((d) => ({ d, effect: decisionEffect(d, inst) }));
  if (withEffect.some((r) => r.effect === "incomplete"))
    return { kind: "wait", reason: "effect-incomplete" };
  const applied = withEffect.filter((r) => r.effect === "applied");
  if (applied.length === 0)
    return { kind: "unlabeled", reason: "no-applied-decision", decisionIds: ids };
  if (applied.length > 1)
    return { kind: "unlabeled", reason: "conflicting-records", decisionIds: ids };
  const { d } = applied[0];
  if (d.mechanism === "verdict-auto-approve") {
    return { kind: "unlabeled", reason: "automated-approval", decisionIds: ids };
  }
  if (d.mechanism !== "operator")
    return { kind: "unlabeled", reason: "unattributed", decisionIds: ids };
  const recordDigest = digestOrNull(d);
  if (!recordDigest) return { kind: "unlabeled", reason: "record-not-canonical", decisionIds: ids };
  const base: Omit<OperatorActionReference, "digest"> = {
    stream: "operator-action",
    derivation: REFERENCE_DERIVATION,
    value: d.decision,
    label: d.decision === "approve" ? "not-sent-back" : "sent-back",
    decisionId: d.id,
    recordDigest,
    mechanism: "operator",
    channel: d.channel,
    principal: { ...d.principal },
    recordedAt: d.recordedAt,
    effect: "applied",
    others: withEffect
      .filter((r) => r.d.id !== d.id)
      .slice(0, 5)
      .map((r) => ({
        id: r.d.id,
        decision: r.d.decision,
        mechanism: r.d.mechanism,
        effect: r.effect,
      })),
  };
  return { kind: "labeled", reference: { ...base, digest: referenceDigest(base) } };
}
