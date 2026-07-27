/**
 * The wire shapes the UI consumes, re-exported from `@argus/contracts`.
 *
 * This file used to hold a hand-maintained *copy* of every server DTO, which
 * nothing forced to stay in sync. It is now a thin barrel so the existing
 * `./types` import path keeps working while the declarations live in exactly
 * one place — a server-side field change now fails `npm run typecheck` here
 * instead of silently diverging.
 *
 * UI-only types (`DsStatus`, the overview row model, …) stay in `src/ds`.
 */

export type {
  // Agents
  Agent,
  AgentStatus,
  DaemonSnapshot,
  DaemonWorker,
  TimelineEntry,
  ActivityEvent,
  // Schedules and runs
  Trigger,
  TriggerKind,
  Schedule,
  ScheduleWithNext,
  ScheduleInput,
  Run,
  RunStatus,
  RunOutcome,
  LaunchInput,
  // Pipelines
  PhaseStep,
  PhaseDef,
  PipelineDefinition,
  PipelineInput,
  PipelineInstance,
  PipelineSignal,
  InstanceStatus,
  PhaseStatus,
  PhaseProgress,
  PhaseFailurePayload,
  StepStatus,
  StepProgress,
  SignalType,
  OverviewCost,
  OverviewEntry,
  // Monitors
  MonitorStatus,
  MonitorHealth,
  MonitorsSummary,
  Heartbeat,
  // Issues
  Issue,
  IssueOccurrence,
  IssueState,
  IssuesSummary,
  // Budget
  BudgetConfig,
  BudgetState,
  BudgetStatus,
  BudgetWindow,
  BudgetDay,
  BudgetResponse,
  // Chronicle
  Chronicle,
  ChronicleGroup,
  ChronicleKind,
  ChronicleSpan,
  ChronicleStatus,
  // Briefing
  Briefing,
  BriefingWindow,
  AttentionItem,
  AttentionKind,
  // Insight
  Situation,
  SituationCounts,
  NextFire,
  ThroughputBucket,
  // Watchtower
  Anomaly,
  AnomalyDirection,
  AnomalyMetric,
  AnomalySeverity,
  Baseline,
  BaselineScope,
  MetricBaseline,
  WatchtowerReport,
  WatchtowerSummary,
  // Flight Recorder
  Recording,
  RecorderEvent,
  RecorderEventKind,
  RecorderLane,
  RecorderLaneSummary,
  RecorderTotals,
  RecorderUnavailable,
  // Command palette
  PaletteEntry,
  PaletteIndex,
  PaletteKind,
  PaletteSeverity,
  // Live protocol
  LiveFrame,
  LiveFrameType,
  LiveChangeEvent,
  MonitorAlert,
  MonitorAlertEvent,
  BudgetAlert,
  BudgetAlertEvent,
} from "@argus/contracts";
