/**
 * Sentinel: incidents, escalation, and a diagnostic that proposes but never acts.
 *
 * Monitors, Issues and Watchtower each raise a *signal*. None of them holds the
 * state that makes a signal answerable: who saw it, when it was acknowledged,
 * whether it escalated, what was found, and what would fix it. An incident is
 * that state — one object per ongoing problem, which assembles its own timeline
 * as the problem develops.
 *
 * The AI-native part is bounded on purpose. Sentinel can dispatch a **read-only**
 * diagnostic agent, whose findings and proposed remediation attach to the
 * incident. Execution of that remediation is always a human's click. An
 * incident-response system that can also change things is an incident-response
 * system that can cause them.
 */

/** What raised the incident. */
export type IncidentSource = "monitor-down" | "monitor-failing" | "issue-regression" | "anomaly";

export type IncidentStatus = "open" | "acknowledged" | "resolved";

export type IncidentSeverity = "warning" | "critical";

export type IncidentEventKind =
  | "opened"
  | "escalated"
  | "acknowledged"
  | "diagnosed"
  | "note"
  | "resolved"
  | "reopened"
  | "suppressed";

export interface IncidentEvent {
  at: string;
  kind: IncidentEventKind;
  detail: string;
  /** `sentinel` for automatic transitions, `user:<name>` for human ones. */
  by: string;
}

export type DiagnosisStatus = "ready" | "failed" | "skipped";

export interface Diagnosis {
  at: string;
  status: DiagnosisStatus;
  /** What the read-only pass found, in prose. */
  findings: string | null;
  /**
   * What it proposes doing about it. **Never executed automatically** — this is
   * a suggestion attached to an incident, and running it is a human's decision.
   */
  remediation: string | null;
  confidence: number | null;
  costUsd: number | null;
  tokens: number | null;
  error: string | null;
}

export interface Incident {
  /** Stable and derived from `key`, so the same condition never opens twice. */
  id: string;
  /** The condition's identity: `monitor:<scheduleId>`, `issue:<fingerprint>`, … */
  key: string;
  source: IncidentSource;
  severity: IncidentSeverity;
  title: string;
  detail: string;
  status: IncidentStatus;
  openedAt: string;
  updatedAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  resolvedAt: string | null;
  /** How far up the escalation policy this has climbed. 0 = the first level. */
  level: number;
  /** When the next escalation is due; null once acknowledged or fully climbed. */
  nextEscalationAt: string | null;
  timeline: IncidentEvent[];
  diagnosis: Diagnosis | null;
  /** Whatever the source condition points at, for deep links. */
  scheduleId: string | null;
  runId: string | null;
  fingerprint: string | null;
}

export interface EscalationLevel {
  /** Minutes after the previous level (or opening) before this one fires. */
  afterMinutes: number;
  /** What this level means to the operator — "page me", "email the team". */
  label: string;
}

/** Local-clock window, "HH:MM" each. An end before the start wraps midnight. */
export interface QuietHours {
  start: string;
  end: string;
}

export interface SentinelPolicy {
  enabled: boolean;
  levels: EscalationLevel[];
  quietHours: QuietHours | null;
  /** Critical incidents notify even inside quiet hours. */
  quietHoursOverrideCritical: boolean;
  /** Dispatch the read-only diagnostic automatically when an incident opens. */
  autoDiagnose: boolean;
}

export interface SentinelSummary {
  open: number;
  acknowledged: number;
  resolved: number;
  critical: number;
}

export interface SentinelState {
  generatedAt: string;
  policy: SentinelPolicy;
  incidents: Incident[];
  summary: SentinelSummary;
  /** True right now, so the UI can say "notifications are quiet until 07:00". */
  inQuietHours: boolean;
}

/** A transition worth telling someone about. */
export type IncidentAlertEvent =
  "incident.opened" | "incident.escalated" | "incident.acknowledged" | "incident.resolved";

export interface IncidentAlert {
  event: IncidentAlertEvent;
  incidentId: string;
  key: string;
  title: string;
  detail: string;
  severity: IncidentSeverity;
  at: string;
  /** Quiet hours held this back from the bell; it is still in the timeline. */
  suppressed: boolean;
}
