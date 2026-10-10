/**
 * The per-instance transition log (Hardening Item 1).
 *
 * Every saved pipeline instance is the *current* state. This log is the
 * sequence of transitions that produced it — each one a numbered record of
 * which pure transitions ran, what they changed in a projection of the
 * instance, and which side effects (launches, checks, stops, commits) they
 * owed. A pure fold over the log reproduces the projection, and comparing that
 * fold to the saved instance says whether the two agree.
 *
 * It is a diagnostic and recovery record, not an authority:
 * - the saved instance is what Argus acts on; a log record *ahead* of it is a
 *   transition that was proposed but never committed, and nothing it owed is
 *   executed on the log's word alone;
 * - gate decisions keep their own write-ahead file (`gate-decisions.jsonl`)
 *   and commit point; Knowledge Ledger writes keep theirs;
 * - it is separate from the observational instance journal, which may be
 *   pruned at a size cap, and from the Decision Journal.
 *
 * Types only — every shape here erases at compile time.
 */

/** A JSON path into an instance projection: object keys and array indices. */
export type ProjectionPath = Array<string | number>;

/** One change to the projection. Arrays whose length changes are replaced whole. */
export type ProjectionOp =
  { op: "set"; path: ProjectionPath; value: unknown } | { op: "delete"; path: ProjectionPath };

/**
 * A value the projection keeps only by digest: the instance's definition
 * snapshot, its trigger payload, and any agent-supplied value or long string
 * too large for a transition record. The saved instance holds the value
 * itself; a fold reproduces the digest, which is what integrity compares.
 */
export interface ElidedValue {
  $elided: string;
  bytes: number;
}

/** Why the engine moved the instance: the operation it was carrying out. */
export type TransitionSource =
  | "start"
  | "launch"
  | "signal"
  | "reconcile"
  | "deadline"
  | "verification"
  | "candidate-verification"
  | "retry"
  | "operator"
  | "verdict-watcher"
  | "gate-recovery"
  | "engine";

/**
 * The pure transitions that ran inside one recorded transition, in order.
 * Nested transitions (a signal that settles the graph, an approval that
 * commits knowledge) each contribute their own event; the engine collects
 * them from return values, never from shared mutable state.
 */
export type TransitionEventKind =
  | "init"
  | "baseline"
  | "signal"
  | "step-failed"
  | "completion-recorded"
  | "settle"
  | "route-decided"
  | "phase-skipped"
  | "phase-started"
  | "phase-paused"
  | "phase-succeeded"
  | "phase-failed"
  | "failure-classified"
  | "instance-status"
  | "launch-planned"
  | "verification-started"
  | "verification-applied"
  | "candidate-verification-applied"
  | "candidate-selected"
  | "candidates-exhausted"
  | "knowledge-pending"
  | "knowledge-committed"
  | "retry-scheduled"
  | "retry-started"
  | "remediation"
  | "unlaunchable"
  | "approve"
  | "revise"
  | "abort"
  | "gate-linked"
  | "gate-completed"
  | "candidate-tree-removed"
  | "sidecar-updated"
  | "engine-update";

export interface TransitionEvent {
  kind: TransitionEventKind;
  phaseId?: string;
  attempt?: number;
  runId?: string;
  /** A short, bounded account of what the event decided. */
  detail?: string;
}

/**
 * A side effect a transition owes once the instance that records it is
 * published. Owed, not performed: recovery executes one only when the
 * *saved* instance still calls for it.
 */
export type OwedEffect =
  | { kind: "launch"; phaseId: string; attempt: number }
  | { kind: "verify"; phaseId: string; attempt: number; candidate?: number }
  | { kind: "stop"; runIds: string[]; reason: string }
  | { kind: "commit-knowledge"; phaseId: string; attempt: number }
  | { kind: "gate-operation"; decisionId: string };

/** One line of `transitions/<instanceId>.jsonl`, inside the checksummed envelope. */
export interface TransitionRecord {
  schema: 1;
  /** 1-based and contiguous per instance. */
  seq: number;
  instanceId: string;
  at: string;
  source: TransitionSource;
  /** The phase attempt this transition is about, when it is about one. */
  phaseId?: string;
  attempt?: number;
  runId?: string;
  events: TransitionEvent[];
  /**
   * The full projection this record starts a replay from: on the first
   * record of an instance created with the log, and on the first record
   * written for an instance that predates it (its state then is known only
   * from the instance file, so the replay is partial).
   */
  baseline?: unknown;
  /** The projection's changes from the previous state to this one. */
  changes?: ProjectionOp[];
  /**
   * Set instead of `changes` (or `baseline`) when they would not fit a
   * record: the replay cannot pass this record, and says so.
   */
  oversize?: { bytes: number; sha256: string };
  effects: OwedEffect[];
  /**
   * Pipeline status changes the engine made that no declared transition
   * accounted for. Recorded so a forgotten transition is visible as such,
   * never relabelled as a trustworthy replay.
   */
  unattributed?: string[];
  /** SHA-256 of the canonical projection after this record. */
  stateSha256: string;
}

/**
 * What a saved instance says about its log. `seq` is the last transition the
 * saved state embodies; `degradedFrom` is the first sequence number whose
 * record could not be written (the log is incomplete from there on, and the
 * instance went on regardless); `capped` is set once the log reached its size
 * limit — it is never pruned to make room.
 */
export interface InstanceTransitionLogState {
  seq: number;
  degradedFrom?: number;
  capped?: boolean;
}

export type TransitionIntegrityStatus =
  /** No log, and the instance never claimed one (it predates the log and has not moved since). */
  | "untracked"
  /** The fold of the log equals the saved instance. */
  | "consistent"
  /**
   * What the log covers agrees with the saved instance, but it does not cover
   * all of it: the log begins at a baseline written after the instance
   * existed (it predates the log), or the replay had to stop at a record too
   * large to keep its changes.
   */
  | "partial"
  /** The instance claims a log that is not there. */
  | "missing"
  /** Records the instance claims could not be written; the replay stops at the gap. */
  | "degraded"
  /** The log has records past the saved instance: proposed, never committed. */
  | "ahead"
  /** The saved instance is past the end of the log. */
  | "behind"
  /** Sequence numbers in the log are not contiguous. */
  | "gap"
  /** The fold and the saved instance differ. */
  | "disagreement"
  /** A line failed its checksum or did not parse, and was not a torn write. */
  | "corrupt";

export interface TransitionIntegrityReport {
  instanceId: string;
  status: TransitionIntegrityStatus;
  /** `full` — replayed from the instance's first transition; `from-baseline`
   *  — from a baseline written after the instance existed; `none`. */
  coverage: "full" | "from-baseline" | "none";
  instanceSeq: number | null;
  logSeq: number | null;
  /** The sequence number the fold reached. */
  replayedTo: number | null;
  /** Every problem found, in plain words. More than one may apply. */
  findings: string[];
  /** The first projection path where fold and instance differ. */
  firstDivergence?: string;
}
