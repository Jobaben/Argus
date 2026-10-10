/**
 * Verdict: quality scoring against a rubric the author writes.
 *
 * Exit code 0 means the process ended. It does not mean the work was any good,
 * and for an agent that is exactly the gap: a run can succeed loudly while
 * producing a summary that misses the point. A rubric lets the author say what
 * "good" means for *this* unit of work, and a bounded judge pass scores each
 * output against it.
 *
 * Opt-in per definition, always. A rubric that nobody wrote is not a rubric,
 * and scoring every run by default would be both expensive and meaningless.
 */

/** One thing the output is judged on. */
export interface RubricCriterion {
  /** Stable slug — scores are keyed by it, so renaming the label keeps history. */
  id: string;
  label: string;
  /** Relative importance in the weighted average. Defaults to 1. */
  weight?: number;
}

export interface Rubric {
  /** What "good" means here, in the author's own words. */
  goal: string;
  criteria: RubricCriterion[];
  /**
   * Below this overall score (0–10) the run is a **quality regression**: it
   * opens an issue even though the process exited fine. Absent = score and
   * trend, but never fail anything.
   */
  minScore?: number;
  /**
   * Optional: judge *how* the agent worked, not only what it produced. Absent
   * (the default) = no trajectory analysis of any kind, and the rubric's
   * digest is exactly what it was before trajectories existed.
   */
  trajectory?: RubricTrajectory;
}

// ── Trajectories ────────────────────────────────────────────────────────────

/**
 * Which record a judgment is. `output` scores the run's final output against
 * the rubric's criteria; `trajectory` describes the path the agent took
 * (deterministic signals, and optionally a judge's scores against the
 * rubric's trajectory criteria). They are never mixed: each has its own
 * current record per run, its own trend, and its own basis in an approval.
 */
export type VerdictKind = "output" | "trajectory";

/**
 * The deterministic trajectory heuristics, computed from Recorder events.
 * Heuristics, not findings: each has known blind spots (HARNESS.md §19), and a
 * zero count means "not observed in what was recorded", never "did not happen".
 */
export type TrajectorySignalKind =
  "repetition" | "errors" | "edit-revert" | "path" | "destructive-command";

export interface TrajectorySignal {
  kind: TrajectorySignalKind;
  /** Occurrences counted by the heuristic. */
  count: number;
  /** Whether the count reaches the heuristic's documented threshold. */
  observed: boolean;
  /** Up to five clipped timeline quotes. Labels and commands, never file contents. */
  examples: string[];
}

export interface TrajectorySignals {
  /** Version of the heuristics that produced these counts. */
  version: number;
  /** `missing` = no transcript to read: no signals were computed. */
  transcript: "present" | "missing";
  /** Recorder events read. */
  events: number;
  /** The recording dropped events; counts may undercount. */
  truncated: boolean;
  signals: TrajectorySignal[];
}

/**
 * An author-configured deterministic check: the signals that, when observed,
 * hold a gate for a person. No model is involved.
 */
export interface TrajectoryCheck {
  holdOn: TrajectorySignalKind[];
}

export interface RubricTrajectory {
  /** Criteria a judge scores the trajectory on. Absent = no trajectory judging. */
  criteria?: RubricCriterion[];
  /** Below this trajectory score (0–10) the run is a trajectory regression. */
  minScore?: number;
  check?: TrajectoryCheck;
}

/** What a `trajectory` verdict carries beyond the shared Verdict fields. */
export interface TrajectoryAssessment {
  signals: TrajectorySignals;
  /** Signals the rubric's check holds on that were observed. Empty = the check passed. */
  held: TrajectorySignalKind[];
  /** Whether a judge was asked (the rubric declares trajectory criteria). */
  judged: boolean;
}

export interface CriterionScore {
  id: string;
  label: string;
  /** 0–10. */
  score: number;
  /** One line on why. */
  note: string;
}

export type VerdictStatus = "ready" | "failed" | "skipped";

/**
 * Where a model-backed judgment came from, as far as Argus knows it.
 *
 * `requestedModel` is what Argus asked the CLI for; `reportedModel` is what the
 * CLI's own result envelope said it used. They are kept apart because they are
 * different claims: an alias such as `haiku` is a request, and the CLI decides
 * what it resolves to. No runtime envelope Argus parses today reports a model,
 * so `reportedModel` is `null` — "not reported", never a copy of the request.
 *
 * Absent entirely on records written before provenance was stamped: unknown,
 * not implied.
 */
export interface AnalysisProvenance {
  /** The agent CLI that answered (`ARGUS_ANALYSIS_RUNTIME`, else the default). */
  runtime: string;
  /** The model argument Argus passed; null = none passed (the CLI's own default). */
  requestedModel: string | null;
  /** The model the CLI reported having used; null = not reported. */
  reportedModel: string | null;
  /** Version of the prompt builder and response parser that produced it. */
  promptVersion: number;
}

export interface Verdict {
  /**
   * `V-…`, minted per judgment. Absent on verdicts written before ids existed.
   * A run may be judged more than once; every judgment is kept, and the newest
   * is the run's current verdict.
   */
  id?: string;
  runId: string;
  scheduleId: string;
  scheduleName: string;
  /** Set for pipeline phase runs. */
  phaseId: string | null;
  status: VerdictStatus;
  at: string;
  /** Weighted overall, 0–10. Null when the pass produced nothing. */
  score: number | null;
  criteria: CriterionScore[];
  summary: string | null;
  /** Score is below the rubric's `minScore`. */
  regression: boolean;
  minScore: number | null;
  costUsd: number | null;
  tokens: number | null;
  durationMs: number | null;
  error: string | null;
  /** Absent on verdicts written before provenance was recorded. */
  provenance?: AnalysisProvenance;
  /**
   * sha256 of the rubric the judge was given (canonical JSON of goal, criteria
   * and weights). An auto-approval requires it to match the rubric the
   * instance's own definition carries, so a verdict produced under a different
   * rubric cannot open a gate.
   */
  rubricDigest?: string;
  /** Absent = `output` (every verdict written before trajectories existed). */
  kind?: VerdictKind;
  /** `trajectory` verdicts only. */
  trajectory?: TrajectoryAssessment;
}

export interface VerdictPoint {
  runId: string;
  at: string;
  score: number;
  regression: boolean;
}

export interface VerdictTrend {
  /** `schedule:<id>` or `phase:<scheduleId>:<phaseId>` — the Watchtower key. */
  key: string;
  scope: "schedule" | "phase";
  name: string;
  /** Oldest → newest. */
  points: VerdictPoint[];
  latest: number | null;
  median: number | null;
  /** Latest minus the median of everything before it. Negative = getting worse. */
  delta: number | null;
  minScore: number | null;
  regressions: number;
}

export interface VerdictReport {
  generatedAt: string;
  trends: VerdictTrend[];
  summary: {
    scored: number;
    regressions: number;
    /** Mean of every trend's latest score, or null when nothing is scored. */
    average: number | null;
  };
  /**
   * Trajectory score history, kept apart from output trends. Absent or empty
   * when no rubric declares trajectory criteria.
   */
  trajectoryTrends?: VerdictTrend[];
}

/** A gate that opens itself when the phase's output scores well enough. */
export interface AutoApprove {
  /** Minimum overall verdict, 0–10, that lets the gate pass unattended. */
  verdict: number;
  /**
   * Minimum trajectory score, 0–10, when the rubric declares trajectory
   * criteria. Absent = the `verdict` bar applies to the trajectory score too.
   */
  trajectory?: number;
}
