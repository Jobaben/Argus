/** Failed runs grouped by normalized error fingerprint, plus triage state. */

import type { FailureClass } from "./autopsy.js";
import type { RunOutcome, RunStatus } from "./schedules.js";

export type IssueState = "open" | "resolved" | "ignored";

export interface Issue {
  fingerprint: string;
  /** Representative raw error (first line of the newest occurrence). */
  title: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  /** Distinct schedule names affected, most recent first. */
  schedules: string[];
  state: IssueState;
  lastRunId: string;
  /**
   * Every exact-string fingerprint merged into this issue, including its own.
   *
   * Length 1 means plain string grouping — the original behaviour, and what you
   * get whenever similarity clustering finds nothing to merge. Longer means two
   * differently-worded errors were judged to be the same problem.
   */
  members: string[];
  /** Autopsy's failure class, when the members agree on one. */
  failureClass: FailureClass | null;
}

export interface IssueOccurrence {
  runId: string;
  scheduleId: string;
  scheduleName: string;
  at: string;
  status: RunStatus;
  outcome: RunOutcome | null;
  error: string;
}

export type IssuesSummary = Record<IssueState, number>;
