/** "While you were away": state-now attention items plus a windowed digest. */

import type { Issue } from "./issues.js";
import type { PipelineInstance } from "./pipelines.js";
import type { Run, RunStatus } from "./schedules.js";
import type { Anomaly } from "./watchtower.js";

export type AttentionKind =
  "monitor-down" | "gate-waiting" | "monitor-failing" | "issue-open" | "anomaly";

export interface AttentionItem {
  kind: AttentionKind;
  id: string;
  title: string;
  detail: string;
  at: string | null;
}

export interface BriefingWindow {
  totalRuns: number;
  byStatus: Record<RunStatus, number>;
  costUsd: number;
  tokens: number;
  failures: Run[];
  newIssues: Issue[];
  finishedPipelines: PipelineInstance[];
  /** Runs that left their learned envelope in the window, newest first. */
  anomalies: Anomaly[];
}

export interface Briefing {
  since: string;
  generatedAt: string;
  attention: AttentionItem[];
  attentionCount: number;
  window: BriefingWindow;
}
