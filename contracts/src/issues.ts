/** Failed runs grouped by normalized error fingerprint, plus triage state. */

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
