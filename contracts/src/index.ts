/**
 * The Argus wire contract — every DTO that crosses the HTTP/WebSocket boundary,
 * declared once and imported by both `@argus/server` and `@argus/web`.
 *
 * Re-exports are spelled out with `export type` rather than `export *` on
 * purpose: a star re-export cannot be erased at compile time (the compiler
 * can't prove the names are all types), which would make this package emit a
 * real runtime module. `scripts/check-contracts-runtime.mjs` enforces that.
 * See README.md for the rest of the rules.
 */

export type {
  ActivityEvent,
  Agent,
  AgentStatus,
  DaemonSnapshot,
  DaemonWorker,
  TimelineEntry,
} from "./agents.js";

export type {
  AgentRuntimeCapabilities,
  AgentRuntimeId,
  AgentRuntimeInfo,
  RuntimesResponse,
} from "./runtimes.js";

export type {
  LaunchInput,
  Run,
  RunOutcome,
  RunStatus,
  Schedule,
  ScheduleInput,
  ScheduleWithNext,
  Trigger,
  TriggerKind,
} from "./schedules.js";

export type {
  InstanceStatus,
  OverviewCost,
  OverviewEntry,
  PhaseDef,
  PhaseFailurePayload,
  RetryableClass,
  RetryPolicy,
  PhaseProgress,
  PhaseStatus,
  PhaseStep,
  PipelineDefinition,
  PipelineInput,
  PipelineInstance,
  PipelineSignal,
  SignalType,
  StepProgress,
  StepStatus,
} from "./pipelines.js";

export type { Heartbeat, MonitorHealth, MonitorsSummary, MonitorStatus } from "./monitors.js";

export type { Issue, IssueOccurrence, IssuesSummary, IssueState } from "./issues.js";

export type {
  BudgetConfig,
  BudgetDay,
  BudgetResponse,
  BudgetState,
  BudgetStatus,
  BudgetWindow,
} from "./budget.js";

export type {
  Chronicle,
  ChronicleGroup,
  ChronicleKind,
  ChronicleSpan,
  ChronicleStatus,
} from "./chronicle.js";

export type { AttentionItem, AttentionKind, Briefing, BriefingWindow } from "./briefing.js";

export type {
  NextFire,
  NextFireKind,
  Situation,
  SituationCounts,
  ThroughputBucket,
} from "./insight.js";

export type { PaletteEntry, PaletteIndex, PaletteKind, PaletteSeverity } from "./palette.js";

export type {
  RecorderEvent,
  RecorderEventKind,
  RecorderLane,
  RecorderLaneSummary,
  RecorderTotals,
  RecorderUnavailable,
  Recording,
} from "./recorder.js";

export type {
  Activity,
  CronDiskHint,
  CronStatus,
  DailyStat,
  Inventory,
  InventoryItem,
  ModelStat,
  PeakHour,
  PluginItem,
  Project,
  SearchResult,
  SearchResponse,
  SessionDetail,
  SessionMessage,
  SessionSummary,
  SessionTail,
  StatsResult,
  Task,
} from "./catalog.js";

export type {
  AuthStatus,
  HealthResponse,
  PrereqResult,
  PrereqStatus,
  Role,
  Totals,
  UserStatus,
  UserSummary,
} from "./admin.js";

export type {
  Attribution,
  BudgetAction,
  BudgetEnforcement,
  BudgetLadderStep,
  CostDimension,
  CostSlice,
  Forecast,
  LedgerReport,
  WhatIfRequest,
  WhatIfResult,
} from "./ledger.js";

export type {
  Diagnosis,
  DiagnosisStatus,
  EscalationLevel,
  Incident,
  IncidentAlert,
  IncidentAlertEvent,
  IncidentEvent,
  IncidentEventKind,
  IncidentSeverity,
  IncidentSource,
  IncidentStatus,
  QuietHours,
  SentinelPolicy,
  SentinelState,
  SentinelSummary,
} from "./sentinel.js";

export type {
  AutoApprove,
  CriterionScore,
  Rubric,
  RubricCriterion,
  Verdict,
  VerdictPoint,
  VerdictReport,
  VerdictStatus,
  VerdictTrend,
} from "./verdict.js";

export type {
  Autopsy,
  AutopsyResponse,
  AutopsySpan,
  AutopsyStatus,
  FailureClass,
} from "./autopsy.js";

export type {
  Anomaly,
  AnomalyDirection,
  AnomalyEvent,
  AnomalyMetric,
  AnomalySeverity,
  Baseline,
  BaselineScope,
  MetricBaseline,
  WatchtowerReport,
  WatchtowerSummary,
} from "./watchtower.js";

export type {
  AnomalyAlertFrame,
  IncidentAlertFrame,
  BudgetAlert,
  BudgetAlertEvent,
  BudgetAlertFrame,
  LiveChangeEvent,
  LiveChangeFrame,
  LiveFrame,
  LiveFrameType,
  MonitorAlert,
  MonitorAlertEvent,
  MonitorAlertFrame,
  RunActivityFrame,
} from "./live.js";

export type {
  VaultHitKind,
  VaultIngestResult,
  VaultQuarter,
  VaultQuartersReport,
  VaultRowCounts,
  VaultSearchHit,
  VaultSearchResponse,
  VaultStatus,
  VaultUnavailableReason,
} from "./vault.js";

export type {
  AnswerLink,
  ExecuteResult,
  ExecuteStatus,
  MutationKind,
  OmnibarAnswer,
  OmnibarMode,
  OmnibarResponse,
  Plan,
  PlanStatus,
  PlannedMutation,
} from "./omnibar.js";

export type {
  FleetMachine,
  FleetTotals,
  FleetView,
  MachineFacets,
  MachineSummary,
  PeerBudget,
  PeerIssue,
  PeerPipeline,
  PeerRun,
  PairingCode,
  Peer,
  PeerInput,
  PeerStatus,
} from "./constellation.js";
