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

/** One run's trajectory judgment, as an automated approval recorded it. */
export interface GateDecisionTrajectoryBasis {
  runId: string;
  stepName: string;
  verdictId: string;
  at: string;
  /** The weighted trajectory rating; null when the rubric declares only a check. */
  score: number | null;
  /** The trajectory bar; null when the rubric declares only a check. */
  bar: number | null;
  /** Signals the check held on (always empty in an approval). */
  held: string[];
  signalsVersion: number;
  runtime: string | null;
  requestedModel: string | null;
  reportedModel: string | null;
  promptVersion: number | null;
  rubricDigest: string;
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
  /**
   * Automated approvals of a phase whose rubric declares a trajectory: the
   * trajectory judgment each relevant run was approved on, kept apart from
   * the output basis. Absent when the rubric declares none.
   */
  trajectoryVerdicts?: GateDecisionTrajectoryBasis[];
  /** Whether the approval carried answers (stored on the phase, not here). */
  answersProvided?: boolean;
  /** A revise note, clipped. It is operator-authored and already reaches the next prompt. */
  note?: string;
  /** Written before the transition is attempted (write-ahead). */
  recordedAt: string;
}

/**
 * A gate decision whose effects are under way, persisted on the instance in
 * the SAME save that links the decision (`gateDecisionIds`) and BEFORE any of
 * its effects — superseding staged records, stopping processes, committing
 * knowledge, settling realizations. Cleared in the save that completes it.
 *
 * While present, nothing else may transition the instance: every engine path
 * that mutates it first completes this operation (idempotently, from what is
 * on disk), so an interrupted revise can never be followed by an approval of
 * the attempt it was discarding, and an interrupted abort can never be
 * followed by the work it was stopping.
 */
export interface PendingGateOperation {
  decisionId: string;
  decision: GateDecisionKind;
  /** Approve / revise: the phase acted on. Null for abort. */
  phaseId: string | null;
  /** Approve / revise: the attempt the decision was about. */
  attempt: number | null;
  /** The runs this operation stops: the revised attempt's, or every run an abort ends. */
  stopRunIds: string[];
  /** Approve only: the answers to apply. */
  answers?: unknown;
  /** Revise only: the operator's note for the next attempt's prompt. */
  note?: string;
  startedAt: string;
}

/**
 * Whether a decision took effect. Derived from the instance, never trusted
 * from the record:
 *
 * - `applied` — the instance links the decision and its operation completed;
 * - `incomplete` — the instance links the decision but its operation has not
 *   completed: some, all or none of its effects may have happened. Argus
 *   completes it before any other transition of the instance (reconcile, or
 *   the next action on it); until then it is reported as exactly this, never
 *   rounded to applied or not-applied;
 * - `not-applied` — the instance exists and does not link it. Because the
 *   link is saved before any effect starts, this means none did: the process
 *   stopped (or the link save failed) between recording and linking;
 * - `unknown` — the instance is gone (pruned), so nothing can say.
 */
export type GateDecisionEffect = "applied" | "incomplete" | "not-applied" | "unknown";

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
