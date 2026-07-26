import type { PaletteEntry, PaletteIndex, PaletteSeverity, Trigger } from "@argus/contracts";
import type { Agent } from "./types.js";
import type { Issue } from "./issues.js";
import type { MonitorHealth } from "./monitors.js";
import type { PipelineDefinition, PipelineInstance } from "./pipelineTypes.js";
import type { Project } from "./projects.js";
import type { ScheduleWithNext } from "./scheduleTypes.js";
import type { SessionSummary } from "./sessions.js";

export type { PaletteEntry, PaletteIndex, PaletteKind, PaletteSeverity } from "@argus/contracts";

/** Recent transcripts are the long tail here; enough to find "the one from this
 *  morning" without turning the index into a transcript list. */
const SESSION_LIMIT = 25;

/**
 * A compact trigger phrasing for a one-line palette subtitle.
 *
 * Deliberately not the same wording as the Scheduler view's summary: that one
 * has a full row to explain a schedule ("every 120 min, 09:00–18:00, Mon, Tue"),
 * this one shares a line with a name and a badge and has to stay glanceable
 * ("every 2h"). Two registers, two functions.
 */
export function describeTrigger(trigger: Trigger | null): string {
  if (trigger === null) return "manual";
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  switch (trigger.kind) {
    case "interval":
      return `every ${humanMinutes(trigger.everyMinutes)}`;
    case "daily":
      return `daily ${trigger.time ?? "—"}`;
    case "weekly":
      return `${days[trigger.weekday ?? 0]} ${trigger.time ?? "—"}`;
    case "windowed":
      return `every ${humanMinutes(trigger.everyMinutes)} ${trigger.startTime ?? "—"}–${
        trigger.endTime ?? "—"
      }`;
  }
}

function humanMinutes(minutes: number | undefined): string {
  if (!minutes || minutes <= 0) return "—";
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

const MONITOR_SEVERITY: Record<MonitorHealth["status"], PaletteSeverity> = {
  down: "error",
  failing: "error",
  late: "warn",
  pending: "info",
  paused: "none",
  up: "none",
};

const INSTANCE_BADGE: Record<PipelineInstance["status"], { badge: string; sev: PaletteSeverity }> =
  {
    running: { badge: "running", sev: "info" },
    "awaiting-approval": { badge: "needs approval", sev: "warn" },
    failed: { badge: "failed", sev: "error" },
    succeeded: { badge: "done", sev: "none" },
    aborted: { badge: "stopped", sev: "none" },
  };

const AGENT_SEVERITY: Record<Agent["status"], PaletteSeverity> = {
  working: "info",
  failed: "error",
  done: "none",
  idle: "none",
  queued: "info",
  stopped: "none",
  unknown: "none",
};

export interface PaletteInput {
  pipelines: PipelineDefinition[];
  /** Newest instance per pipeline id, for the live badge and gate action. */
  latestByPipeline: Map<string, PipelineInstance>;
  schedules: ScheduleWithNext[];
  monitors: MonitorHealth[];
  issues: Issue[];
  agents: Agent[];
  projects: Project[];
  sessions: SessionSummary[];
}

/** The phase currently blocking on a human, if this instance has one. */
function waitingGate(inst: PipelineInstance | undefined): string | null {
  if (!inst || inst.status !== "awaiting-approval") return null;
  return inst.id;
}

/**
 * Builds the palette index.
 *
 * Ordering is the index's only editorial act, and it matters: with an empty
 * query the palette shows this list as-is, so the things most likely to need
 * you (pipelines and their gates, then schedules and monitors) come before the
 * long tail of projects and transcripts. Ranking takes over the moment the user
 * types.
 */
export function buildPalette(input: PaletteInput, now: Date): PaletteIndex {
  const entries: PaletteEntry[] = [];

  for (const def of input.pipelines) {
    const latest = input.latestByPipeline.get(def.id);
    const status = latest ? INSTANCE_BADGE[latest.status] : null;
    const gate = waitingGate(latest);
    entries.push({
      kind: "pipeline",
      id: def.id,
      title: def.name,
      subtitle: `${def.phases.length} phase${def.phases.length === 1 ? "" : "s"} · ${describeTrigger(
        def.trigger,
      )}`,
      href: "#/command",
      badge: status?.badge ?? null,
      severity: status?.sev ?? "none",
      keywords: [def.id, "pipeline", ...def.phases.map((p) => p.name)],
      ...(gate ? { gateInstanceId: gate } : {}),
    });
  }

  for (const schedule of input.schedules) {
    entries.push({
      kind: "schedule",
      id: schedule.id,
      title: schedule.name,
      subtitle: `${describeTrigger(schedule.trigger)}${schedule.enabled ? "" : " · disabled"}`,
      href: "#/schedules",
      badge: schedule.enabled ? null : "paused",
      severity: "none",
      keywords: [schedule.id, "schedule", "cron", schedule.cwd],
      runnableScheduleId: schedule.id,
    });
  }

  for (const monitor of input.monitors) {
    // A healthy monitor is already represented by its schedule row; only a
    // monitor that wants attention earns its own entry, so the index does not
    // list every schedule twice.
    if (monitor.status === "up" || monitor.status === "paused") continue;
    entries.push({
      kind: "monitor",
      id: monitor.scheduleId,
      title: monitor.name,
      subtitle:
        monitor.uptimePct === null
          ? "no completed runs yet"
          : `${monitor.uptimePct.toFixed(0)}% uptime`,
      href: "#/monitors",
      badge: monitor.status,
      severity: MONITOR_SEVERITY[monitor.status],
      keywords: [monitor.scheduleId, "monitor", "health", "uptime"],
    });
  }

  for (const issue of input.issues) {
    if (issue.state !== "open") continue;
    entries.push({
      kind: "issue",
      id: issue.fingerprint,
      title: issue.title,
      subtitle: `${issue.count}× · ${issue.schedules.join(", ")}`,
      href: "#/issues",
      badge: `${issue.count}×`,
      severity: "error",
      keywords: [issue.fingerprint, "issue", "failure", "error", ...issue.schedules],
    });
  }

  for (const agent of input.agents) {
    entries.push({
      kind: "agent",
      id: agent.short,
      title: agent.name,
      subtitle: agent.detail ?? agent.cwd ?? null,
      href: `#/agent/${encodeURIComponent(agent.short)}`,
      badge: agent.live ? "live" : agent.status === "unknown" ? null : agent.status,
      severity: agent.live ? "info" : AGENT_SEVERITY[agent.status],
      keywords: [agent.short, "agent", "job", ...(agent.cwd ? [agent.cwd] : [])],
    });
  }

  for (const project of input.projects) {
    entries.push({
      kind: "project",
      id: project.id,
      title: project.label,
      subtitle: `${project.sessionCount} session${project.sessionCount === 1 ? "" : "s"}`,
      href: "#/projects",
      badge: null,
      severity: "none",
      keywords: [project.id, "project", "repo"],
    });
  }

  for (const session of input.sessions.slice(0, SESSION_LIMIT)) {
    entries.push({
      kind: "session",
      id: session.id,
      title: session.title,
      subtitle: session.projectLabel,
      // Matches the Sessions view's deep link: #/sessions/:project/:id.
      href: `#/sessions/${encodeURIComponent(session.project)}/${encodeURIComponent(session.id)}`,
      badge: null,
      severity: "none",
      keywords: [session.id, "session", "transcript", session.project],
    });
  }

  return { generatedAt: now.toISOString(), entries };
}
