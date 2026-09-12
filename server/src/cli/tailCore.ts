/**
 * The pure half of `argus tail` — the terminal frontend for an Argus you
 * cannot open a browser to.
 *
 * The web dashboard shows *state*: cards that are the current truth, redrawn
 * on every `*:changed` ping. A terminal — and the agent relaying it into a
 * chat on a phone — needs *narrative*: what is running, what just changed,
 * what it is doing right now, each as one line that still means something on
 * its own. So this module holds two things and nothing that touches a socket:
 *
 * - **Snapshot**: the opening picture, rendered from the same reads the
 *   dashboard makes (`/api/overview`, `/api/runs`, `/api/agents`,
 *   `/api/insight`, `/api/runs/:id/activity`).
 * - **Tracker**: turns the payload-free change pings into concrete lines by
 *   diffing consecutive reads — "run X started", "phase build succeeded",
 *   "pipeline waiting for approval" — and formats the payload frames
 *   (`run:activity`, alerts) that need no diff.
 *
 * Every line exists in two renderings: text for a human or an agent to read,
 * and one JSON object per line (`--json`) for anything that wants to parse it.
 * The same `TailLine` feeds both, so the two can never say different things.
 */

import type {
  ActivityEvent,
  Agent,
  Anomaly,
  BudgetAlert,
  IncidentAlert,
  LiveFrame,
  MonitorAlert,
  OverviewEntry,
  PipelineInstance,
  Run,
  Situation,
} from "@argus/contracts";

// ── Options ──────────────────────────────────────────────────────────────────

export interface TailOptions {
  url: string;
  token: string | null;
  /** How long to follow after the snapshot, in ms. 0 = snapshot only; null = forever. */
  forMs: number | null;
  untilIdle: boolean;
  /** How far back the snapshot's "recent" section reaches, in ms. */
  sinceMs: number;
  json: boolean;
  /** Retained activity lines to show per running step in the snapshot. */
  context: number;
  snapshot: boolean;
  installSkill: boolean;
}

export type ParsedArgs =
  { kind: "run"; options: TailOptions } | { kind: "help" } | { kind: "error"; message: string };

/** The window used when stdout is not a terminal — an agent's Bash call, a
 *  pipe — so the command always returns on its own. */
export const DEFAULT_PIPED_WINDOW_MS = 60_000;
export const DEFAULT_SINCE_MS = 30 * 60_000;
export const DEFAULT_CONTEXT_LINES = 3;

export const TAIL_HELP = `argus tail — stream what Argus is doing, as text

Usage: argus tail [options]

Prints a snapshot (what is running, what is waiting on you, what just
finished), then follows the live feed for a bounded window and exits with a
one-line summary. Built for a terminal you cannot see and for an agent that
relays it: every line stands on its own.

Options:
  --for <duration>    how long to follow after the snapshot: 90s, 5m, 1h.
                      0 = snapshot only. Default: 60s when piped, forever on
                      a terminal (Ctrl-C to stop).
  --until-idle        stop as soon as nothing is running any more
  --since <duration>  how far back "recent" reaches in the snapshot (default 30m)
  --context <n>       recent activity lines per running step in the snapshot
                      (default 3; 0 hides them)
  --no-snapshot       skip the opening snapshot; only stream what happens next
  --json              one JSON object per line instead of text
  --url <base>        Argus base URL (default http://127.0.0.1:$ARGUS_PORT or 7777)
  --token <token>     bearer token (default $ARGUS_TOKEN)
  --install-skill     install the "argus-tail" Claude Code skill into
                      $ARGUS_CLAUDE_HOME/skills (default ~/.claude/skills) and exit
  --help              show this help

Exit status: 0 when the window ended (or Ctrl-C), 1 when Argus could not be
reached or refused the credentials.`;

const DURATION_RE = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i;

/** "90s" → 90000, "5m" → 300000, "1h", "0". A bare number is seconds. */
export function parseDuration(raw: string): number | null {
  const m = DURATION_RE.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  const unit = (m[2] ?? "s").toLowerCase();
  const mult =
    unit === "ms"
      ? 1
      : unit === "s"
        ? 1000
        : unit === "m"
          ? 60_000
          : unit === "h"
            ? 3_600_000
            : 86_400_000;
  return Math.round(n * mult);
}

export function defaultUrl(env: NodeJS.ProcessEnv): string {
  const port = Number(env.ARGUS_PORT || "");
  return `http://127.0.0.1:${Number.isInteger(port) && port > 0 ? port : 7777}`;
}

export function parseTailArgs(
  argv: string[],
  env: NodeJS.ProcessEnv,
  stdoutIsTTY: boolean,
): ParsedArgs {
  const options: TailOptions = {
    url: defaultUrl(env),
    token: env.ARGUS_TOKEN?.trim() || null,
    forMs: stdoutIsTTY ? null : DEFAULT_PIPED_WINDOW_MS,
    untilIdle: false,
    sinceMs: DEFAULT_SINCE_MS,
    json: false,
    context: DEFAULT_CONTEXT_LINES,
    snapshot: true,
    installSkill: false,
  };
  const value = (i: number, flag: string): string | { error: string } => {
    const arg = argv[i];
    if (arg.includes("=")) return arg.slice(arg.indexOf("=") + 1);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) return { error: `${flag} needs a value` };
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    const takesValue = ["--for", "--since", "--context", "--url", "--token"].includes(flag);
    let v: string | { error: string } = "";
    if (takesValue) {
      v = value(i, flag);
      if (typeof v !== "string") return { kind: "error", message: v.error };
      if (!arg.includes("=")) i++;
    }
    switch (flag) {
      case "--help":
      case "-h":
        return { kind: "help" };
      case "--json":
        options.json = true;
        break;
      case "--until-idle":
        options.untilIdle = true;
        break;
      case "--no-snapshot":
        options.snapshot = false;
        break;
      case "--install-skill":
        options.installSkill = true;
        break;
      case "--for": {
        const ms = parseDuration(v as string);
        if (ms === null)
          return { kind: "error", message: `--for needs a duration like 90s, 5m or 0, got "${v}"` };
        options.forMs = ms;
        break;
      }
      case "--since": {
        const ms = parseDuration(v as string);
        if (ms === null)
          return { kind: "error", message: `--since needs a duration like 30m or 2h, got "${v}"` };
        options.sinceMs = ms;
        break;
      }
      case "--context": {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0)
          return { kind: "error", message: `--context needs a whole number, got "${v}"` };
        options.context = n;
        break;
      }
      case "--url": {
        try {
          const u = new URL(v as string);
          if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("scheme");
          options.url = u.origin;
        } catch {
          return { kind: "error", message: `--url needs an http(s) base URL, got "${v}"` };
        }
        break;
      }
      case "--token":
        options.token = (v as string).trim() || null;
        break;
      default:
        return { kind: "error", message: `unknown option "${arg}" (try argus tail --help)` };
    }
  }
  return { kind: "run", options };
}

// ── Lines ────────────────────────────────────────────────────────────────────

export type TailLineKind =
  | "tail.start"
  | "tail.end"
  | "tail.error"
  | "tail.reconnect"
  | "snapshot.summary"
  | "snapshot.running"
  | "snapshot.activity"
  | "snapshot.gate"
  | "snapshot.agent"
  | "snapshot.recent"
  | "snapshot.next"
  | "snapshot.idle"
  | "activity"
  | "run.started"
  | "run.ended"
  | "pipeline.started"
  | "pipeline.gate"
  | "pipeline.resumed"
  | "pipeline.ended"
  | "phase.changed"
  | "agent.changed"
  | "alert.monitor"
  | "alert.budget"
  | "alert.anomaly"
  | "alert.incident";

/**
 * One line of output. `text` is the whole human rendering minus the timestamp;
 * the optional fields are the structured facts behind it for `--json`.
 */
export interface TailLine {
  at: string;
  kind: TailLineKind;
  text: string;
  /** Indentation level in text mode (activity under its step, etc.). */
  indent?: number;
  runId?: string;
  instanceId?: string;
  phaseId?: string;
  status?: string;
  label?: string;
  detail?: string;
  [extra: string]: unknown;
}

const ICON: Record<TailLineKind, string> = {
  "tail.start": "👁",
  "tail.end": "──",
  "tail.error": "!!",
  "tail.reconnect": "↻",
  "snapshot.summary": "▣",
  "snapshot.running": "▶",
  "snapshot.activity": "·",
  "snapshot.gate": "⏸",
  "snapshot.agent": "●",
  "snapshot.recent": "·",
  "snapshot.next": "⏲",
  "snapshot.idle": "○",
  activity: "·",
  "run.started": "▶",
  "run.ended": "■",
  "pipeline.started": "▶",
  "pipeline.gate": "⏸",
  "pipeline.resumed": "▶",
  "pipeline.ended": "■",
  "phase.changed": "→",
  "agent.changed": "●",
  "alert.monitor": "⚠",
  "alert.budget": "$",
  "alert.anomaly": "↯",
  "alert.incident": "🔥",
};

/** Activity events get a glyph per kind so a tool call reads apart from prose. */
const ACTIVITY_ICON: Record<ActivityEvent["kind"], string> = {
  init: "○",
  tool: "⚙",
  text: "💬",
  done: "■",
};

const OUTCOME_ICON: Record<string, string> = {
  succeeded: "✓",
  failed: "✗",
  cancelled: "⊘",
  interrupted: "⊘",
  skipped: "↷",
  aborted: "⊘",
};

/** Local wall-clock `HH:MM:SS`, which is what someone reading a terminal on
 *  the same machine expects; the ISO instant stays in the JSON rendering. */
export function clock(at: string, seconds = true): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return seconds ? `${hh}:${mm}:${ss}` : `${hh}:${mm}`;
}

export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

export function formatUsd(v: number): string {
  if (v === 0) return "$0.00";
  return v >= 0.01 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`;
}

/** Whitespace (newlines included) collapsed to one line, ellipsized. */
export function clip(s: string, max = 160): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** The first non-blank line, clipped — for prose where the opening line is
 *  the summary and the rest is detail (an agent's result). */
export function firstLine(s: string, max = 120): string {
  const line = s.split("\n").find((l) => l.trim()) ?? "";
  return clip(line, max);
}

/** The text rendering of one line: `HH:MM:SS <icon> <text>`, indented. */
export function renderText(line: TailLine): string {
  const icon = line.kind === "activity" || line.kind === "snapshot.activity" ? "" : ICON[line.kind];
  const pad = "  ".repeat(line.indent ?? 0);
  return `${clock(line.at)} ${pad}${icon ? `${icon} ` : ""}${line.text}`.trimEnd();
}

export function renderJson(line: TailLine): string {
  const { indent: _indent, ...rest } = line;
  return JSON.stringify(rest);
}

export function render(line: TailLine, json: boolean): string {
  return json ? renderJson(line) : renderText(line);
}

// ── Labels ───────────────────────────────────────────────────────────────────

const TERMINAL_RUN = new Set(["succeeded", "failed", "skipped", "interrupted", "cancelled"]);
const TERMINAL_INSTANCE = new Set(["succeeded", "failed", "aborted"]);

/** Which instances an overview entry puts on the board: every concurrent one,
 *  or the lone latest. Deduplicated by id. */
export function boardInstances(entries: OverviewEntry[]): PipelineInstance[] {
  const seen = new Map<string, PipelineInstance>();
  for (const e of entries) {
    for (const a of e.active) seen.set(a.instance.id, a.instance);
    if (e.latest && !seen.has(e.latest.id)) seen.set(e.latest.id, e.latest);
  }
  return [...seen.values()];
}

/** `runId → "Pipeline › phase › step"` for every step run the board knows. */
export function stepLabels(instances: PipelineInstance[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const inst of instances) {
    for (const phase of inst.phases) {
      for (const step of phase.steps) {
        if (!step.runId) continue;
        const tail = phase.steps.length > 1 ? ` › ${step.name}` : "";
        out.set(step.runId, `${inst.pipelineName} › ${phase.name}${tail}`);
      }
    }
  }
  return out;
}

function runtimeTag(runtime: string | null | undefined): string {
  return runtime && runtime !== "claude" ? ` (${runtime})` : "";
}

function firstString(v: unknown, keys: string[]): string | null {
  if (typeof v === "string") return v;
  if (!v || typeof v !== "object") return null;
  for (const k of keys) {
    const got = (v as Record<string, unknown>)[k];
    if (typeof got === "string" && got.trim()) return got;
  }
  return null;
}

function costTag(run: Run): string {
  const parts: string[] = [];
  if (typeof run.costUsd === "number") {
    parts.push(`${run.runtime === "codex" ? "~" : ""}${formatUsd(run.costUsd)}`);
  }
  if (typeof run.tokens === "number") parts.push(`${run.tokens.toLocaleString("en-US")} tok`);
  return parts.length ? ` · ${parts.join(" · ")}` : "";
}

/** `✓ Nightly triage succeeded in 3m 04s · $0.12` / `✗ … failed: exit 1 — reason`. */
function endedText(run: Run, label: string): string {
  const icon = OUTCOME_ICON[run.status] ?? "■";
  const dur = run.durationMs != null ? ` in ${formatMs(run.durationMs)}` : "";
  let why = "";
  if (run.status === "failed") {
    const reason =
      run.error?.trim() ||
      (run.termination === "timed-out"
        ? "timed out"
        : run.exitCode != null
          ? `exit ${run.exitCode}`
          : "");
    if (reason) why = `: ${clip(reason, 140)}`;
  } else if (run.status === "succeeded" && run.outcome && run.outcome !== "succeeded") {
    why = ` (reported ${run.outcome})`;
  }
  const summary =
    run.status === "succeeded" && run.resultSummary?.trim()
      ? ` — ${firstLine(run.resultSummary, 120)}`
      : "";
  return `${icon} ${label}${runtimeTag(run.runtime)} ${run.status}${dur}${why}${costTag(run)}${summary}`;
}

// ── Snapshot ─────────────────────────────────────────────────────────────────

export interface SnapshotInput {
  now: Date;
  url: string;
  version: string | null;
  runs: Run[];
  overview: OverviewEntry[];
  agents: Agent[];
  situation: Situation | null;
  /** Retained activity per running step run, from `/api/runs/:id/activity`. */
  activity: Map<string, ActivityEvent[]>;
  sinceMs: number;
  context: number;
}

/** The opening picture, as lines. Pure: every read has already happened. */
export function buildSnapshot(input: SnapshotInput): TailLine[] {
  const { now, runs, overview, agents } = input;
  const at = now.toISOString();
  const instances = boardInstances(overview);
  const labels = stepLabels(instances);
  const labelOf = (r: Run) => labels.get(r.id) ?? r.scheduleName;
  const lines: TailLine[] = [];

  const running = runs.filter((r) => r.status === "running");
  const gates = instances.filter((i) => i.status === "awaiting-approval");
  const liveAgents = agents.filter(
    (a) => a.live || a.status === "working" || a.status === "queued",
  );

  const bits = [
    `${running.length} running`,
    gates.length ? `${gates.length} waiting for approval` : null,
    liveAgents.length
      ? `${liveAgents.length} background agent${liveAgents.length === 1 ? "" : "s"}`
      : null,
  ].filter((b): b is string => b !== null);
  const counts = input.situation?.counts;
  if (counts) {
    if (counts.monitorsDown)
      bits.push(`${counts.monitorsDown} monitor${counts.monitorsDown === 1 ? "" : "s"} down`);
    if (counts.monitorsFailing) bits.push(`${counts.monitorsFailing} failing`);
    if (counts.openIssues)
      bits.push(`${counts.openIssues} open issue${counts.openIssues === 1 ? "" : "s"}`);
  }
  const spend = input.situation?.spend;
  const spendTag =
    spend && typeof spend.today.spentUsd === "number"
      ? ` · ${formatUsd(spend.today.spentUsd)} today${spend.state === "warning" || spend.state === "exceeded" ? ` (budget ${spend.state})` : ""}`
      : "";
  lines.push({
    at,
    kind: "snapshot.summary",
    text: `Argus${input.version ? ` ${input.version}` : ""} at ${input.url} — ${bits.join(" · ")}${spendTag}`,
    version: input.version,
    running: running.length,
    gates: gates.length,
    agents: liveAgents.length,
  });

  // Running, longest-running first so the one you are probably waiting on tops.
  running.sort((a, b) => (a.startedAt ?? a.queuedAt).localeCompare(b.startedAt ?? b.queuedAt));
  for (const run of running) {
    const started = run.startedAt ?? run.queuedAt;
    const elapsed = formatMs(now.getTime() - new Date(started).getTime());
    const events = input.activity.get(run.id) ?? [];
    const last = events[events.length - 1];
    const doing = last ? ` · ${ACTIVITY_ICON[last.kind]} ${last.label}` : "";
    const deadline =
      run.deadlineAt && new Date(run.deadlineAt).getTime() > now.getTime()
        ? ` · ${formatMs(new Date(run.deadlineAt).getTime() - now.getTime())} left`
        : "";
    lines.push({
      at,
      kind: "snapshot.running",
      text: `${labelOf(run)}${runtimeTag(run.runtime)} · running ${elapsed}${deadline}${doing}`,
      runId: run.id,
      instanceId: run.instanceId,
      label: labelOf(run),
      status: "running",
      startedAt: started,
      elapsedMs: now.getTime() - new Date(started).getTime(),
      currentActivity: last?.label ?? null,
    });
    if (input.context > 0 && events.length > 1) {
      for (const ev of events.slice(-input.context)) {
        lines.push({
          at: ev.at,
          kind: "snapshot.activity",
          text: `${ACTIVITY_ICON[ev.kind]} ${ev.label}`,
          indent: 1,
          runId: run.id,
          label: ev.label,
          activityKind: ev.kind,
        });
      }
    }
  }

  for (const inst of gates) {
    const phase = inst.phases.find((p) => p.status === "awaiting-approval");
    const since = new Date(inst.updatedAt).getTime();
    const note = firstString(phase?.payload, ["summary", "reason", "message", "text"]);
    lines.push({
      at,
      kind: "snapshot.gate",
      text: `${inst.pipelineName} · waiting for approval at "${phase?.name ?? "?"}" for ${formatMs(now.getTime() - since)}${note ? ` — ${clip(note, 140)}` : ""}`,
      instanceId: inst.id,
      phaseId: phase?.id,
      label: inst.pipelineName,
      status: "awaiting-approval",
      detail: note ?? undefined,
    });
  }

  for (const a of liveAgents) {
    const detail = a.detail?.trim() || a.tempo?.trim() || "";
    lines.push({
      at,
      kind: "snapshot.agent",
      text: `agent ${a.name} · ${a.status}${detail ? ` · ${clip(detail, 120)}` : ""}`,
      agent: a.short,
      label: a.name,
      status: a.status,
    });
  }

  const sinceIso = new Date(now.getTime() - input.sinceMs).toISOString();
  const recent = runs
    .filter((r) => TERMINAL_RUN.has(r.status) && (r.endedAt ?? "") >= sinceIso)
    .sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? ""))
    .slice(0, 12);
  for (const run of recent) {
    lines.push({
      at: run.endedAt ?? at,
      kind: "snapshot.recent",
      text: endedText(run, labelOf(run)),
      runId: run.id,
      instanceId: run.instanceId,
      label: labelOf(run),
      status: run.status,
      durationMs: run.durationMs,
      costUsd: run.costUsd ?? null,
      error: run.error ?? null,
    });
  }
  for (const inst of instances) {
    if (!TERMINAL_INSTANCE.has(inst.status) || (inst.endedAt ?? "") < sinceIso) continue;
    lines.push({
      at: inst.endedAt ?? at,
      kind: "snapshot.recent",
      text: `${OUTCOME_ICON[inst.status] ?? "■"} pipeline ${inst.pipelineName} ${inst.status}${failedPhaseNote(inst)}`,
      instanceId: inst.id,
      label: inst.pipelineName,
      status: inst.status,
    });
  }

  const next = input.situation?.nextFire;
  if (next) {
    const inMs = new Date(next.at).getTime() - now.getTime();
    lines.push({
      at,
      kind: "snapshot.next",
      text: `next: ${next.kind} "${next.name}" ${inMs > 0 ? `in ${formatMs(inMs)}` : "due now"} (${clock(next.at, false)})`,
      label: next.name,
      nextAt: next.at,
      nextKind: next.kind,
    });
  }

  if (running.length === 0 && gates.length === 0 && liveAgents.length === 0) {
    lines.push({
      at,
      kind: "snapshot.idle",
      text: recent.length
        ? "idle — nothing running right now"
        : `idle — nothing running, and nothing finished in the last ${formatMs(input.sinceMs)}`,
    });
  }
  return lines;
}

function failedPhaseNote(inst: PipelineInstance): string {
  if (inst.status !== "failed") return "";
  const phase = inst.phases.find((p) => p.status === "failed");
  if (!phase) return "";
  const reason = firstString(phase.payload, ["reason"]);
  return ` at "${phase.name}"${reason ? `: ${clip(reason, 120)}` : ""}`;
}

// ── Tracker: pings → lines ───────────────────────────────────────────────────

interface InstanceMemo {
  status: PipelineInstance["status"];
  pipelineName: string;
  phases: Map<string, { name: string; status: string; attempt: number }>;
}

/**
 * Remembers the last read of each domain and reports the difference as lines.
 * The first read of a domain primes it silently — the snapshot already said
 * what the world looked like — and every later read narrates what moved.
 */
export class Tracker {
  private runs = new Map<string, Run>();
  private instances = new Map<string, InstanceMemo>();
  private agents = new Map<string, { name: string; status: string }>();
  private labels = new Map<string, string>();
  private primed = { runs: false, instances: false, agents: false };

  constructor(private readonly now: () => Date) {}

  /** A step run's board label, else its schedule/launch name, else its id. */
  labelFor(runId: string): string {
    return this.labels.get(runId) ?? this.runs.get(runId)?.scheduleName ?? runId.slice(0, 8);
  }

  /** True when nothing the tracker knows of is still in flight. */
  isIdle(): boolean {
    for (const r of this.runs.values()) if (r.status === "running") return false;
    for (const i of this.instances.values()) if (i.status === "running") return false;
    return true;
  }

  runningCount(): number {
    let n = 0;
    for (const r of this.runs.values()) if (r.status === "running") n++;
    return n;
  }

  applyRuns(runs: Run[]): TailLine[] {
    const lines: TailLine[] = [];
    const prime = !this.primed.runs;
    this.primed.runs = true;
    const nowIso = this.now().toISOString();
    for (const run of runs) {
      const before = this.runs.get(run.id);
      this.runs.set(run.id, run);
      if (prime) continue;
      const label = this.labelFor(run.id);
      if (!before) {
        if (run.status === "running") lines.push(this.startedLine(run, label, nowIso));
        else if (TERMINAL_RUN.has(run.status)) lines.push(this.endedLine(run, label, nowIso));
        continue;
      }
      if (before.status === run.status) continue;
      if (run.status === "running") lines.push(this.startedLine(run, label, nowIso));
      else if (TERMINAL_RUN.has(run.status)) lines.push(this.endedLine(run, label, nowIso));
    }
    return lines;
  }

  private startedLine(run: Run, label: string, nowIso: string): TailLine {
    return {
      at: run.startedAt ?? nowIso,
      kind: "run.started",
      text: `${label}${runtimeTag(run.runtime)} started${run.trigger === "manual" ? " (manual)" : ""}${run.model ? ` · ${run.model}` : ""}`,
      runId: run.id,
      instanceId: run.instanceId,
      label,
      status: "running",
    };
  }

  private endedLine(run: Run, label: string, nowIso: string): TailLine {
    return {
      at: run.endedAt ?? nowIso,
      kind: "run.ended",
      text: endedText(run, label),
      runId: run.id,
      instanceId: run.instanceId,
      label,
      status: run.status,
      durationMs: run.durationMs,
      costUsd: run.costUsd ?? null,
      error: run.error ?? null,
      resultSummary: run.resultSummary ?? null,
    };
  }

  applyOverview(entries: OverviewEntry[]): TailLine[] {
    const lines: TailLine[] = [];
    const prime = !this.primed.instances;
    this.primed.instances = true;
    const instances = boardInstances(entries);
    // Labels first, so a run line emitted later in the same refresh already
    // has its board name.
    for (const [id, label] of stepLabels(instances)) this.labels.set(id, label);
    const nowIso = this.now().toISOString();
    for (const inst of instances) {
      const before = this.instances.get(inst.id);
      const memo: InstanceMemo = {
        status: inst.status,
        pipelineName: inst.pipelineName,
        phases: new Map(
          inst.phases.map((p) => [p.id, { name: p.name, status: p.status, attempt: p.attempt }]),
        ),
      };
      this.instances.set(inst.id, memo);
      if (prime) continue;
      const at = inst.updatedAt || nowIso;
      if (!before) {
        if (inst.status === "running") {
          lines.push({
            at: inst.createdAt || at,
            kind: "pipeline.started",
            text: `pipeline ${inst.pipelineName} started${inst.trigger === "manual" ? " (manual)" : ""}`,
            instanceId: inst.id,
            label: inst.pipelineName,
            status: "running",
          });
        } else if (inst.status === "awaiting-approval") {
          lines.push(this.gateLine(inst, at));
        } else if (TERMINAL_INSTANCE.has(inst.status)) {
          lines.push(this.instanceEndedLine(inst, at));
        }
        continue;
      }
      // Phase transitions before the instance's own, so "phase failed" is
      // read before "pipeline failed" — cause, then effect.
      for (const phase of inst.phases) {
        const prev = before.phases.get(phase.id);
        const changed = !prev || prev.status !== phase.status || prev.attempt !== phase.attempt;
        if (!changed) continue;
        if (phase.status === "pending") continue;
        if (phase.status === "awaiting-approval") continue; // said by the gate line below
        const retry =
          prev && prev.attempt !== phase.attempt && phase.status === "running"
            ? ` (attempt ${phase.attempt})`
            : "";
        const reason = phase.status === "failed" ? firstString(phase.payload, ["reason"]) : null;
        lines.push({
          at,
          kind: "phase.changed",
          text: `${inst.pipelineName} › ${phase.name} ${phase.status === "running" ? "started" : phase.status}${retry}${reason ? `: ${clip(reason, 140)}` : ""}`,
          instanceId: inst.id,
          phaseId: phase.id,
          label: `${inst.pipelineName} › ${phase.name}`,
          status: phase.status,
          attempt: phase.attempt,
          detail: reason ?? undefined,
        });
      }
      if (before.status !== inst.status) {
        if (inst.status === "awaiting-approval") lines.push(this.gateLine(inst, at));
        else if (inst.status === "running")
          lines.push({
            at,
            kind: "pipeline.resumed",
            text: `pipeline ${inst.pipelineName} resumed`,
            instanceId: inst.id,
            label: inst.pipelineName,
            status: "running",
          });
        else if (TERMINAL_INSTANCE.has(inst.status)) lines.push(this.instanceEndedLine(inst, at));
      }
    }
    return lines;
  }

  private gateLine(inst: PipelineInstance, at: string): TailLine {
    const phase = inst.phases.find((p) => p.status === "awaiting-approval");
    const note = firstString(phase?.payload, ["summary", "reason", "message", "text"]);
    return {
      at,
      kind: "pipeline.gate",
      text: `pipeline ${inst.pipelineName} is waiting for approval at "${phase?.name ?? "?"}"${note ? ` — ${clip(note, 140)}` : ""}`,
      instanceId: inst.id,
      phaseId: phase?.id,
      label: inst.pipelineName,
      status: "awaiting-approval",
      detail: note ?? undefined,
    };
  }

  private instanceEndedLine(inst: PipelineInstance, at: string): TailLine {
    return {
      at: inst.endedAt ?? at,
      kind: "pipeline.ended",
      text: `${OUTCOME_ICON[inst.status] ?? "■"} pipeline ${inst.pipelineName} ${inst.status}${failedPhaseNote(inst)}`,
      instanceId: inst.id,
      label: inst.pipelineName,
      status: inst.status,
    };
  }

  applyAgents(agents: Agent[]): TailLine[] {
    const lines: TailLine[] = [];
    const prime = !this.primed.agents;
    this.primed.agents = true;
    const nowIso = this.now().toISOString();
    for (const a of agents) {
      const before = this.agents.get(a.short);
      this.agents.set(a.short, { name: a.name, status: a.status });
      if (prime) continue;
      if (before && before.status === a.status) continue;
      if (!before && a.status !== "working" && a.status !== "queued") continue;
      const detail = (a.status === "done" || a.status === "failed" ? a.result : a.detail)?.trim();
      const icon = OUTCOME_ICON[a.status === "done" ? "succeeded" : a.status] ?? "";
      lines.push({
        at: a.updatedAt ?? nowIso,
        kind: "agent.changed",
        text: `${icon ? `${icon} ` : ""}agent ${a.name} ${before ? `${before.status} → ${a.status}` : a.status}${detail ? ` · ${clip(detail, 120)}` : ""}`,
        agent: a.short,
        label: a.name,
        status: a.status,
        detail: detail || undefined,
      });
    }
    return lines;
  }

  /** The payload frames need no diff — one line each, straight off the wire. */
  applyFrame(frame: LiveFrame): TailLine[] {
    switch (frame.type) {
      case "run:activity": {
        const label = this.labelFor(frame.runId);
        return frame.events.map((ev) => ({
          at: ev.at,
          kind: "activity" as const,
          text: `${ACTIVITY_ICON[ev.kind] ?? "·"} ${label} · ${ev.label}`,
          runId: frame.runId,
          instanceId: frame.instanceId,
          label,
          activityKind: ev.kind,
          detail: ev.label,
        }));
      }
      case "monitors:alert":
        return [monitorLine(frame.alert)];
      case "budget:alert":
        return [budgetLine(frame.alert)];
      case "watchtower:anomaly":
        return [anomalyLine(frame.anomaly)];
      case "sentinel:alert":
        return [incidentLine(frame.alert)];
      default:
        return [];
    }
  }
}

function monitorLine(alert: MonitorAlert): TailLine {
  const verb =
    alert.event === "monitor.down"
      ? "is down"
      : alert.event === "monitor.failing"
        ? "is failing"
        : "recovered";
  return {
    at: alert.at,
    kind: "alert.monitor",
    text: `monitor "${alert.name}" ${verb} — ${clip(alert.detail, 140)}`,
    scheduleId: alert.scheduleId,
    label: alert.name,
    status: alert.status,
    event: alert.event,
    detail: alert.detail,
  };
}

function budgetLine(alert: BudgetAlert): TailLine {
  const verb =
    alert.event === "budget.exceeded"
      ? "exceeded"
      : alert.event === "budget.warning"
        ? "warning"
        : "back under its limit";
  return {
    at: alert.at,
    kind: "alert.budget",
    text: `budget ${verb} — ${clip(alert.detail, 140)}`,
    status: alert.state,
    event: alert.event,
    detail: alert.detail,
  };
}

function anomalyLine(anomaly: Anomaly): TailLine {
  return {
    at: anomaly.at,
    kind: "alert.anomaly",
    text: `${anomaly.severity} anomaly on "${anomaly.name}" — ${clip(anomaly.detail, 140)}`,
    runId: anomaly.runId,
    scheduleId: anomaly.scheduleId,
    label: anomaly.name,
    status: anomaly.severity,
    metric: anomaly.metric,
    detail: anomaly.detail,
  };
}

function incidentLine(alert: IncidentAlert): TailLine {
  const verb = alert.event.replace("incident.", "");
  return {
    at: alert.at,
    kind: "alert.incident",
    text: `incident ${verb} (${alert.severity}): ${alert.title}${alert.detail ? ` — ${clip(alert.detail, 140)}` : ""}`,
    incidentId: alert.incidentId,
    label: alert.title,
    status: alert.severity,
    event: alert.event,
    detail: alert.detail,
  };
}

// ── Frames off the wire ──────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Parses one socket message; null means "not a frame this client acts on".
 *  Mirrors the web client's validation so a torn payload is dropped, not
 *  printed as `undefined`. */
export function parseFrame(data: string): LiveFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string") return null;
  switch (parsed.type) {
    case "run:activity":
      return typeof parsed.runId === "string" &&
        Array.isArray(parsed.events) &&
        parsed.events.every(
          (e) => isRecord(e) && typeof e.at === "string" && typeof e.label === "string",
        )
        ? (parsed as unknown as LiveFrame)
        : null;
    case "monitors:alert":
    case "budget:alert":
    case "sentinel:alert":
      return isRecord(parsed.alert) && typeof parsed.alert.event === "string"
        ? (parsed as unknown as LiveFrame)
        : null;
    case "watchtower:anomaly":
      return isRecord(parsed.anomaly) && typeof parsed.anomaly.id === "string"
        ? (parsed as unknown as LiveFrame)
        : null;
    default:
      return parsed.type.endsWith(":changed") ? (parsed as unknown as LiveFrame) : null;
  }
}

/** Which reads a change ping should trigger. Unlisted pings (sessions,
 *  inventory, totals, …) move nothing the tail narrates. */
export function refreshFor(type: string): { runs: boolean; overview: boolean; agents: boolean } {
  switch (type) {
    case "schedules:changed":
      // Run records live in the Argus dir the schedules watcher covers, and a
      // step run's record moves the board too — read both.
      return { runs: true, overview: true, agents: false };
    case "pipelines:changed":
      return { runs: true, overview: true, agents: false };
    case "agents:changed":
      return { runs: false, overview: false, agents: true };
    default:
      return { runs: false, overview: false, agents: false };
  }
}

/** The closing line: why the tail stopped and what it leaves behind. */
export function endLine(input: {
  now: Date;
  reason: "window" | "idle" | "interrupted" | "snapshot";
  elapsedMs: number;
  events: number;
  running: number;
  json: boolean;
}): TailLine {
  const why =
    input.reason === "window"
      ? `followed for ${formatMs(input.elapsedMs)}`
      : input.reason === "idle"
        ? `idle after ${formatMs(input.elapsedMs)}`
        : input.reason === "interrupted"
          ? `stopped after ${formatMs(input.elapsedMs)}`
          : "snapshot only";
  const still = input.running > 0 ? `${input.running} still running` : "nothing running";
  const hint = input.reason === "window" ? " · run `argus tail` again to keep following" : "";
  return {
    at: input.now.toISOString(),
    kind: "tail.end",
    text: `${why} · ${input.events} event${input.events === 1 ? "" : "s"} · ${still}${input.json ? "" : hint}`,
    reason: input.reason,
    elapsedMs: input.elapsedMs,
    events: input.events,
    running: input.running,
  };
}
