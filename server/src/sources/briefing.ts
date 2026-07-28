import { paths } from "../claudeHome.js";
import { atomicWriteJson } from "./atomicWrite.js";
import { readJson } from "./readJson.js";
import { isFailure } from "./issues.js";
import type { Issue } from "./issues.js";
import type { MonitorHealth } from "./monitors.js";
import type { PipelineInstance } from "./pipelineTypes.js";
import type { Run, RunStatus } from "./scheduleTypes.js";
import type { Anomaly, AttentionItem, Briefing } from "@argus/contracts";

/**
 * Briefing: the "while you were away" digest. Argus's whole point is
 * unattended runs, so the first screen after time away should answer two
 * questions without a tab tour: what needs me right now (state-now attention
 * items), and what happened since I last caught up (a windowed digest).
 * Everything is a derivation over already-read state; the only persisted
 * state is the acknowledgement timestamp in Argus-owned briefing.json.
 */

export type { AttentionItem, AttentionKind, Briefing, BriefingWindow } from "@argus/contracts";

export interface BriefingInput {
  runs: Run[];
  monitors: MonitorHealth[];
  issues: Issue[];
  instances: PipelineInstance[];
  /** Recent Watchtower anomalies. Optional so callers that predate Watchtower
   *  — and every existing test — keep working with an empty list. */
  anomalies?: Anomaly[];
}

/** A long-abandoned ack must not scan unbounded history or render a useless
 *  "3 weeks ago" digest. */
export const WINDOW_CAP_MS = 7 * 24 * 3_600_000;
const DEFAULT_WINDOW_MS = 24 * 3_600_000;
export const LIST_CAP = 10;

export function clampSince(ackAt: string | null, now: Date): Date {
  const floor = now.getTime() - WINDOW_CAP_MS;
  const ack = ackAt ? Date.parse(ackAt) : NaN;
  const since = Number.isFinite(ack) ? ack : now.getTime() - DEFAULT_WINDOW_MS;
  return new Date(Math.max(since, floor));
}

/** The moment a run counts against the window: when it produced its outcome,
 *  falling back to start/queue for still-running or never-started runs. */
function runMoment(run: Run): number {
  return Date.parse(run.endedAt ?? run.startedAt ?? run.queuedAt);
}

function emptyByStatus(): Record<RunStatus, number> {
  return { running: 0, succeeded: 0, failed: 0, skipped: 0, interrupted: 0, cancelled: 0 };
}

function waitingGateName(inst: PipelineInstance): string {
  return inst.phases.find((p) => p.status === "awaiting-approval")?.name ?? "gate";
}

function buildAttention(input: BriefingInput): AttentionItem[] {
  const down: AttentionItem[] = [];
  const failing: AttentionItem[] = [];
  for (const m of input.monitors) {
    if (m.status !== "down" && m.status !== "failing") continue;
    const item: AttentionItem = {
      kind: m.status === "down" ? "monitor-down" : "monitor-failing",
      id: m.scheduleId,
      title: m.name,
      detail: m.status === "down" ? "expected a run, none arrived" : "last completed run failed",
      at: m.status === "down" ? m.expectedAt : m.lastRunAt,
    };
    (m.status === "down" ? down : failing).push(item);
  }

  const gates: AttentionItem[] = input.instances
    .filter((i) => i.status === "awaiting-approval")
    .map((i) => ({
      kind: "gate-waiting",
      id: i.id,
      title: `${i.pipelineName} is waiting for you`,
      detail: `phase "${waitingGateName(i)}" needs approval`,
      at: i.updatedAt,
    }));

  const openIssues: AttentionItem[] = input.issues
    .filter((i) => i.state === "open")
    .map((i) => ({
      kind: "issue-open",
      id: i.fingerprint,
      title: i.title,
      detail: `${i.count}× across ${i.schedules.join(", ")}`,
      at: i.lastSeen,
    }));

  // Only *critical* anomalies claim attention. A warn-level anomaly is worth
  // reading in the digest; waking someone for "1.6× median duration" is how a
  // briefing badge stops meaning anything.
  const anomalies: AttentionItem[] = (input.anomalies ?? [])
    .filter((a) => a.severity === "critical")
    .map((a) => ({
      kind: "anomaly" as const,
      id: a.id,
      title: a.name,
      detail: a.detail,
      at: a.at,
    }));

  return [...down, ...gates, ...failing, ...anomalies, ...openIssues];
}

export function buildBriefing(input: BriefingInput, since: Date, now: Date): Briefing {
  const sinceMs = since.getTime();
  const windowRuns = input.runs.filter((r) => runMoment(r) >= sinceMs);

  const byStatus = emptyByStatus();
  let costUsd = 0;
  let tokens = 0;
  for (const r of windowRuns) {
    byStatus[r.status]++;
    costUsd += r.costUsd ?? 0;
    tokens += r.tokens ?? 0;
  }

  const failures = windowRuns
    .filter((r) => r.status !== "running" && isFailure(r))
    .sort((a, b) => runMoment(b) - runMoment(a))
    .slice(0, LIST_CAP);

  const newIssues = input.issues
    .filter((i) => Date.parse(i.firstSeen) >= sinceMs)
    .sort((a, b) => b.firstSeen.localeCompare(a.firstSeen))
    .slice(0, LIST_CAP);

  const finishedPipelines = input.instances
    .filter((i) => i.endedAt != null && Date.parse(i.endedAt) >= sinceMs)
    .sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? ""))
    .slice(0, LIST_CAP);

  const windowAnomalies = (input.anomalies ?? [])
    .filter((a) => Date.parse(a.at) >= sinceMs)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, LIST_CAP);

  const attention = buildAttention(input);

  return {
    since: since.toISOString(),
    generatedAt: now.toISOString(),
    attention,
    attentionCount: attention.length,
    window: {
      totalRuns: windowRuns.length,
      byStatus,
      costUsd,
      tokens,
      failures,
      newIssues,
      finishedPipelines,
      anomalies: windowAnomalies,
    },
  };
}

// ── Ack persistence (Argus-owned briefing.json) ─────────────────────────────

interface BriefingAckFile {
  ackAt?: string;
}

export async function readBriefingAck(): Promise<string | null> {
  const raw = await readJson<BriefingAckFile>(paths.briefingFile(), {});
  return typeof raw?.ackAt === "string" && Number.isFinite(Date.parse(raw.ackAt))
    ? raw.ackAt
    : null;
}

export async function writeBriefingAck(ackAt: Date): Promise<string> {
  const iso = ackAt.toISOString();
  await atomicWriteJson(paths.briefingFile(), { ackAt: iso });
  return iso;
}
