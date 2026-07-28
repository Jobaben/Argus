/**
 * The WebSocket frame contract.
 *
 * Two kinds of frame travel over `/ws`:
 *
 * - **Change pings** (`*:changed`) are deliberately payload-free. They mean
 *   "this domain moved, re-fetch it" — the server stays the single source of
 *   truth and a pushed body can never diverge from a fresh `GET`.
 * - **Payload frames** carry data the client cannot re-derive from a GET: an
 *   alert transition (which exists only at the instant it happens) and run
 *   activity (a tail delta, not a resource).
 *
 * Before this union both ends typed frames as `unknown` and matched on string
 * literals, so a renamed event silently stopped waking the view that needed it.
 */

import type { ActivityEvent } from "./agents.js";
import type { BudgetState } from "./budget.js";
import type { MonitorStatus } from "./monitors.js";
import type { Anomaly } from "./watchtower.js";
import type { IncidentAlert } from "./sentinel.js";

/** Every payload-free "re-fetch this domain" ping. */
export type LiveChangeEvent =
  | "agents:changed"
  | "schedules:changed"
  | "pipelines:changed"
  | "issues:changed"
  | "briefing:changed"
  | "budget:changed"
  | "totals:changed"
  | "inventory:changed"
  | "sessions:changed"
  | "watchtower:changed"
  | "sentinel:changed"
  | "fleet:changed";

export type MonitorAlertEvent = "monitor.down" | "monitor.failing" | "monitor.recovered";

export interface MonitorAlert {
  event: MonitorAlertEvent;
  scheduleId: string;
  name: string;
  status: MonitorStatus;
  at: string;
  detail: string;
}

export type BudgetAlertEvent = "budget.warning" | "budget.exceeded" | "budget.cleared";

export interface BudgetAlert {
  event: BudgetAlertEvent;
  state: BudgetState;
  at: string;
  detail: string;
}

export interface LiveChangeFrame {
  type: LiveChangeEvent;
}

export interface RunActivityFrame {
  type: "run:activity";
  runId: string;
  instanceId?: string;
  events: ActivityEvent[];
}

export interface MonitorAlertFrame {
  type: "monitors:alert";
  alert: MonitorAlert;
}

export interface BudgetAlertFrame {
  type: "budget:alert";
  alert: BudgetAlert;
}

/** An anomaly exists only at the instant it is first observed — the report it
 *  came from can be re-fetched, but "this just happened" cannot. */
export interface AnomalyAlertFrame {
  type: "watchtower:anomaly";
  anomaly: Anomaly;
}

/** An incident transition. Like the other alert frames, it describes a moment
 *  rather than a state — the incident itself is re-fetchable, "it just
 *  escalated" is not. */
export interface IncidentAlertFrame {
  type: "sentinel:alert";
  alert: IncidentAlert;
}

export type LiveFrame =
  | LiveChangeFrame
  | RunActivityFrame
  | MonitorAlertFrame
  | BudgetAlertFrame
  | AnomalyAlertFrame
  | IncidentAlertFrame;

export type LiveFrameType = LiveFrame["type"];
