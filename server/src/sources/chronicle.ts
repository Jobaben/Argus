import type { Agent } from "./types.js";
import type { Run } from "./scheduleTypes.js";
import type { SessionSummary } from "./sessions.js";

/**
 * The Chronicle is Argus's cross-source timeline: every scheduler run,
 * background agent, and interactive session becomes a time span, grouped into
 * swimlanes and packed into non-overlapping rows, ready for the web timeline
 * to render with pure percentage math.
 */

export type ChronicleKind = "run" | "agent" | "session";
export type ChronicleStatus = "working" | "done" | "failed" | "queued" | "idle";

export interface ChronicleSpan {
  id: string;
  kind: ChronicleKind;
  label: string;
  status: ChronicleStatus;
  startedAt: string;
  /** Null while the work is still in flight — the client draws it to "now". */
  endedAt: string | null;
  /** Hash-route deep link into the relevant Argus view, when one exists. */
  href: string | null;
  detail: string | null;
  costUsd: number | null;
  tokens: number | null;
}

export interface ChronicleGroup {
  key: string;
  label: string;
  kind: ChronicleKind;
  /** Spans packed into rows such that spans within a row never overlap. */
  rows: ChronicleSpan[][];
}

export interface Chronicle {
  windowStart: string;
  windowEnd: string;
  groups: ChronicleGroup[];
  totals: {
    spans: number;
    active: number;
    failed: number;
    costUsd: number | null;
    tokens: number | null;
  };
}

/** A session with no event in this long is considered closed, not in flight. */
const SESSION_ACTIVE_MS = 2 * 60_000;

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

function runStatus(run: Run): ChronicleStatus {
  if (run.outcome === "failed" || run.outcome === "blocked") return "failed";
  switch (run.status) {
    case "running":
      return "working";
    case "succeeded":
      return "done";
    case "failed":
      return "failed";
    default:
      return "idle"; // skipped / interrupted / cancelled
  }
}

function agentStatus(agent: Agent): ChronicleStatus {
  switch (agent.status) {
    case "working":
    case "done":
    case "failed":
    case "queued":
      return agent.status;
    default:
      return "idle"; // idle / stopped / unknown
  }
}

function sessionHref(project: string, id: string): string {
  return `#/sessions/${encodeURIComponent(project)}/${encodeURIComponent(id)}`;
}

function runSpan(run: Run): ChronicleSpan | null {
  const startedAt = run.startedAt ?? run.queuedAt;
  if (ms(startedAt) == null) return null;
  return {
    id: `run:${run.id}`,
    kind: "run",
    label: run.scheduleName || run.prompt.slice(0, 60) || run.id,
    status: runStatus(run),
    startedAt,
    endedAt: run.status === "running" ? null : (run.endedAt ?? startedAt),
    href: run.project && run.sessionId ? sessionHref(run.project, run.sessionId) : "#/schedules",
    detail: run.resultSummary ?? run.error,
    costUsd: run.costUsd ?? null,
    tokens: run.tokens ?? null,
  };
}

function agentSpan(agent: Agent): ChronicleSpan | null {
  const startedAt = agent.createdAt;
  if (startedAt == null || ms(startedAt) == null) return null;
  const inFlight = (agent.status === "working" || agent.status === "queued") && agent.live;
  let endedAt: string | null = null;
  if (!inFlight) {
    endedAt = agent.firstTerminalAt ?? agent.updatedAt ?? startedAt;
    if (ms(endedAt) == null) endedAt = startedAt;
  }
  return {
    id: `agent:${agent.short}`,
    kind: "agent",
    label: agent.name,
    status: agentStatus(agent),
    startedAt,
    endedAt,
    href: `#/agent/${encodeURIComponent(agent.short)}`,
    detail: agent.detail ?? agent.result,
    costUsd: null,
    tokens: null,
  };
}

function sessionSpan(session: SessionSummary, now: Date): ChronicleSpan | null {
  const start = ms(session.firstActivity);
  if (start == null || session.firstActivity == null) return null;
  const last = ms(session.lastActivity) ?? start;
  const active = now.getTime() - last <= SESSION_ACTIVE_MS;
  return {
    id: `session:${session.project}:${session.id}`,
    kind: "session",
    label: session.title,
    status: active ? "working" : "done",
    startedAt: session.firstActivity,
    endedAt: active ? null : (session.lastActivity ?? session.firstActivity),
    href: sessionHref(session.project, session.id),
    detail: session.model,
    costUsd: null,
    tokens: null,
  };
}

/** Effective end for overlap math: in-flight spans occupy through "now". */
function endMs(span: ChronicleSpan, nowMs: number): number {
  return span.endedAt == null ? nowMs : (ms(span.endedAt) ?? nowMs);
}

function overlapsWindow(span: ChronicleSpan, startMs: number, nowMs: number): boolean {
  const s = ms(span.startedAt);
  if (s == null) return false;
  return s <= nowMs && endMs(span, nowMs) >= startMs;
}

/**
 * Greedy row packing: spans sorted by start each land in the first row whose
 * last span has already ended. Overlapping spans therefore stack into extra
 * rows instead of drawing on top of each other.
 */
export function packRows(spans: ChronicleSpan[], nowMs: number): ChronicleSpan[][] {
  const sorted = [...spans].sort(
    (a, b) => (ms(a.startedAt) ?? 0) - (ms(b.startedAt) ?? 0) || a.id.localeCompare(b.id),
  );
  const rows: ChronicleSpan[][] = [];
  const rowEnds: number[] = [];
  for (const span of sorted) {
    const start = ms(span.startedAt) ?? 0;
    const end = endMs(span, nowMs);
    const row = rowEnds.findIndex((e) => e <= start);
    if (row === -1) {
      rows.push([span]);
      rowEnds.push(end);
    } else {
      rows[row].push(span);
      rowEnds[row] = Math.max(rowEnds[row], end);
    }
  }
  return rows;
}

function groupLatest(group: ChronicleGroup, nowMs: number): number {
  let latest = 0;
  for (const row of group.rows) {
    for (const span of row) latest = Math.max(latest, endMs(span, nowMs));
  }
  return latest;
}

function hasActive(group: ChronicleGroup): boolean {
  return group.rows.some((row) => row.some((s) => s.endedAt == null));
}

export interface ChronicleInput {
  runs: Run[];
  agents: Agent[];
  sessions: SessionSummary[];
}

export function buildChronicle(input: ChronicleInput, now: Date, windowMs: number): Chronicle {
  const nowMs = now.getTime();
  const startMs = nowMs - windowMs;

  const spans: {
    groupKey: string;
    groupLabel: string;
    kind: ChronicleKind;
    span: ChronicleSpan;
  }[] = [];

  for (const run of input.runs) {
    const span = runSpan(run);
    if (span && overlapsWindow(span, startMs, nowMs)) {
      spans.push({
        groupKey: `run:${run.scheduleId}`,
        groupLabel: run.scheduleName || "Scheduler",
        kind: "run",
        span,
      });
    }
  }
  for (const agent of input.agents) {
    const span = agentSpan(agent);
    if (span && overlapsWindow(span, startMs, nowMs)) {
      spans.push({ groupKey: "agents", groupLabel: "Background agents", kind: "agent", span });
    }
  }
  for (const session of input.sessions) {
    const span = sessionSpan(session, now);
    if (span && overlapsWindow(span, startMs, nowMs)) {
      spans.push({
        groupKey: `session:${session.project}`,
        groupLabel: session.projectLabel,
        kind: "session",
        span,
      });
    }
  }

  const byGroup = new Map<string, { label: string; kind: ChronicleKind; spans: ChronicleSpan[] }>();
  for (const { groupKey, groupLabel, kind, span } of spans) {
    const group = byGroup.get(groupKey);
    if (group) group.spans.push(span);
    else byGroup.set(groupKey, { label: groupLabel, kind, spans: [span] });
  }

  const groups: ChronicleGroup[] = [...byGroup.entries()].map(([key, g]) => ({
    key,
    label: g.label,
    kind: g.kind,
    rows: packRows(g.spans, nowMs),
  }));

  // Attention-first ordering: groups with in-flight work on top, then by most
  // recent activity so a dormant project sinks below the busy ones.
  groups.sort((a, b) => {
    const activeDelta = Number(hasActive(b)) - Number(hasActive(a));
    if (activeDelta !== 0) return activeDelta;
    const latestDelta = groupLatest(b, nowMs) - groupLatest(a, nowMs);
    if (latestDelta !== 0) return latestDelta;
    return a.label.localeCompare(b.label);
  });

  let active = 0;
  let failed = 0;
  let costUsd: number | null = null;
  let tokens: number | null = null;
  for (const { span } of spans) {
    if (span.endedAt == null) active++;
    if (span.status === "failed") failed++;
    if (typeof span.costUsd === "number") costUsd = (costUsd ?? 0) + span.costUsd;
    if (typeof span.tokens === "number") tokens = (tokens ?? 0) + span.tokens;
  }

  return {
    windowStart: new Date(startMs).toISOString(),
    windowEnd: now.toISOString(),
    groups,
    totals: { spans: spans.length, active, failed, costUsd, tokens },
  };
}
