/**
 * Gate decisions: the durable record of who, or what, approved, revised or
 * aborted a pipeline gate.
 *
 * A gate is the acceptance condition for everything a phase staged — its
 * KnowledgeDelta, its rule verifications, its change proposal — so "who opened
 * this gate?" is the provenance question behind every canonical record a gated
 * phase produced. Before this record existed the answer was not written
 * anywhere: a human click and a Verdict auto-approval left the same instance
 * state behind.
 *
 * Three things are kept apart on purpose, because each one alone can be
 * mistaken for the others:
 *
 * - **mechanism** — what produced the decision: an operator's request, or an
 *   automated rule (a Verdict score clearing an author's bar);
 * - **channel** — how the request reached the engine;
 * - **principal** — who, as far as the server itself established it. Never a
 *   value a client supplied: the HTTP route reads it from the authenticated
 *   session, and a request body cannot set it.
 *
 * What this record does NOT establish is also explicit. A `session` principal
 * says an authenticated account made the request — not that a human, rather
 * than a process holding that account's session or credentials, did. See
 * `docs/rfc/2026-09-29-decision-plane.md` § Phase 0 trust limits.
 */

export type GateDecisionKind = "approve" | "revise" | "abort";

/**
 * - `operator` — an admin-authenticated request (HTTP, CLI via HTTP, Omnibar).
 * - `verdict-auto-approve` — the Verdict watcher, because every judged step of
 *   the attempt cleared the phase's `autoApprove` bar.
 * - `unspecified` — an in-process caller that did not say (tests, embedders).
 *   Recorded as such rather than guessed.
 */
export type GateDecisionMechanism = "operator" | "verdict-auto-approve" | "unspecified";

export type GateDecisionChannel = "http" | "omnibar" | "verdict-watcher" | "in-process";

export type GateDecisionPrincipal =
  /** The authenticated session the request carried, resolved server-side. */
  | { kind: "session"; username: string; role: string }
  /** An Argus component acting on its own rule. */
  | { kind: "system"; component: "verdict-watcher" }
  /** Nothing was established. Never upgraded to a guess. */
  | { kind: "unknown" };

/** The exact judgment an automated approval rested on — copied, so pruning the
 *  verdict store later cannot erase the explanation. */
export interface GateDecisionVerdictBasis {
  runId: string;
  stepName: string;
  /** Null for a verdict written before verdicts carried ids. */
  verdictId: string | null;
  at: string;
  /** The weighted rubric rating, 0–10. A rating, not a probability. */
  score: number;
  /** The `autoApprove.verdict` bar it was compared against. */
  bar: number;
  runtime: string | null;
  requestedModel: string | null;
  reportedModel: string | null;
  promptVersion: number | null;
  rubricDigest: string | null;
}

export interface GateDecisionPhaseRef {
  phaseId: string;
  attempt: number;
  /** The phase's status when the decision was taken. */
  status: string;
  /** The runs of that attempt the decision was about. */
  runIds: string[];
}

export interface GateDecision {
  /** `GD-…`, minted. One record per decision submitted to the engine. */
  id: string;
  instanceId: string;
  pipelineId: string;
  decision: GateDecisionKind;
  mechanism: GateDecisionMechanism;
  channel: GateDecisionChannel;
  principal: GateDecisionPrincipal;
  /**
   * The phase attempt(s) the decision acted on: exactly one for approve and
   * revise; every non-terminal phase for abort.
   */
  phases: GateDecisionPhaseRef[];
  /** Automated approvals only. */
  verdicts?: GateDecisionVerdictBasis[];
  /** Whether the approval carried answers (stored on the phase, not here). */
  answersProvided?: boolean;
  /** A revise note, clipped. It is operator-authored and already reaches the next prompt. */
  note?: string;
  /** Written before the transition is attempted (write-ahead). */
  recordedAt: string;
}

/**
 * Whether a decision took effect. Derived, never trusted from the record:
 *
 * - `applied` — the instance lists the decision among `gateDecisionIds`;
 * - `not-applied` — the instance exists and does not list it (the process
 *   stopped between writing the record and saving the transition, and the
 *   gate was later decided by a different record, or is still waiting);
 * - `unknown` — the instance is gone (pruned), so nothing can say.
 */
export type GateDecisionEffect = "applied" | "not-applied" | "unknown";

export interface GateDecisionView extends GateDecision {
  effect: GateDecisionEffect;
}

/** `GET /api/instances/:id/gate-decisions`. */
export interface GateDecisionsResponse {
  instanceId: string;
  decisions: GateDecisionView[];
  /**
   * Gated phases that are past their gate with no decision on record — they
   * were decided before decisions were recorded. Their provenance is unknown
   * and is reported as such, never inferred.
   */
  undocumented: Array<{ phaseId: string; attempt: number; status: string }>;
}
