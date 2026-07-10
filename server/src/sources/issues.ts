import { createHash } from "node:crypto";
import { paths } from "../claudeHome.js";
import { createJsonArrayStore } from "./jsonArrayStore.js";
import type { Run } from "./scheduleTypes.js";

/**
 * Issues: Sentry-style grouping of failed runs. Twenty failures with the same
 * root cause read as one issue with a count, not twenty rows. Issues are a
 * pure derivation over the runs on disk; the only persisted state is triage
 * (resolve/ignore), in Argus-owned issues.json.
 */

export type IssueState = "open" | "resolved" | "ignored";

export interface TriageRecord {
  fingerprint: string;
  state: "resolved" | "ignored";
  at: string;
  /** lastSeen at the moment of triage — a newer failure means regression. */
  lastSeenAtTriage: string;
}

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
  status: Run["status"];
  outcome: Run["outcome"] | null;
  error: string;
}

export const OCCURRENCE_CAP = 50;

const FINGERPRINT_RE = /^[0-9a-f]{16}$/;

const store = createJsonArrayStore<TriageRecord>({
  file: paths.issuesFile,
  label: "issues.json",
});

/** A failure worth grouping: hard-failed, killed mid-flight, or work-level
 *  failed/blocked. Cancelled is user intent, not a defect. */
export function isFailure(run: Run): boolean {
  return (
    run.status === "failed" ||
    run.status === "interrupted" ||
    run.outcome === "failed" ||
    run.outcome === "blocked"
  );
}

function rawError(run: Run): string {
  if (run.error?.trim()) return run.error.trim();
  if ((run.outcome === "failed" || run.outcome === "blocked") && run.resultSummary?.trim()) {
    return run.resultSummary.trim();
  }
  if (run.exitCode !== null && run.exitCode !== 0) return `exit code ${run.exitCode}`;
  return "unknown failure";
}

/** Collapse the variable parts of an error message so "timeout after 42s" and
 *  "timeout after 7s" land in the same group. */
export function normalizeError(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "#")
    .replace(/\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}[0-9:.z+-]*/g, "#")
    .replace(/\b[0-9a-f]{7,}\b/g, "#")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

export function fingerprintOf(run: Run): string {
  return createHash("sha256")
    .update(normalizeError(rawError(run)))
    .digest("hex")
    .slice(0, 16);
}

const runAt = (r: Run): string => r.endedAt ?? r.startedAt ?? r.queuedAt;

function stateFor(triage: TriageRecord | undefined, lastSeen: string): IssueState {
  if (!triage) return "open";
  if (triage.state === "ignored") return "ignored";
  // Resolved sticks until a newer failure arrives — Sentry's regression rule.
  return lastSeen > triage.lastSeenAtTriage ? "open" : "resolved";
}

/** Group failures into issues. `runs` in readRuns order (newest first). */
export function buildIssues(runs: Run[], triage: TriageRecord[]): Issue[] {
  const byFp = new Map<string, Run[]>();
  for (const r of runs) {
    if (!isFailure(r)) continue;
    const fp = fingerprintOf(r);
    const list = byFp.get(fp);
    if (list) list.push(r);
    else byFp.set(fp, [r]);
  }
  const triageByFp = new Map(triage.map((t) => [t.fingerprint, t]));
  const issues: Issue[] = [];
  for (const [fingerprint, group] of byFp) {
    const newest = group[0];
    const oldest = group[group.length - 1];
    const schedules = [...new Set(group.map((r) => r.scheduleName))];
    const lastSeen = runAt(newest);
    issues.push({
      fingerprint,
      title: rawError(newest).split("\n")[0].slice(0, 300),
      count: group.length,
      firstSeen: runAt(oldest),
      lastSeen,
      schedules,
      state: stateFor(triageByFp.get(fingerprint), lastSeen),
      lastRunId: newest.id,
    });
  }
  const rank: Record<IssueState, number> = { open: 0, ignored: 1, resolved: 2 };
  issues.sort((a, b) => rank[a.state] - rank[b.state] || b.lastSeen.localeCompare(a.lastSeen));
  return issues;
}

/** Occurrences of one issue, newest first, capped. */
export function issueOccurrences(runs: Run[], fingerprint: string): IssueOccurrence[] {
  return runs
    .filter((r) => isFailure(r) && fingerprintOf(r) === fingerprint)
    .slice(0, OCCURRENCE_CAP)
    .map((r) => ({
      runId: r.id,
      scheduleId: r.scheduleId,
      scheduleName: r.scheduleName,
      at: runAt(r),
      status: r.status,
      outcome: r.outcome ?? null,
      error: rawError(r).slice(0, 500),
    }));
}

export class IssueValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IssueValidationError";
  }
}

function assertFingerprint(fp: string): void {
  if (!FINGERPRINT_RE.test(fp)) throw new IssueValidationError("invalid fingerprint");
}

export const readTriage = store.read;

/** Mark an issue resolved or ignored. `lastSeen` anchors regression detection. */
export async function setTriage(
  fingerprint: string,
  state: "resolved" | "ignored",
  lastSeen: string,
  now: Date,
): Promise<TriageRecord> {
  assertFingerprint(fingerprint);
  const record: TriageRecord = {
    fingerprint,
    state,
    at: now.toISOString(),
    lastSeenAtTriage: lastSeen,
  };
  return store.withLock(async () => {
    const list = await store.read();
    const next = list.filter((t) => t.fingerprint !== fingerprint);
    next.push(record);
    await store.write(next);
    return record;
  });
}

/** Reopen: drop the triage record so the issue derives back to open. */
export async function clearTriage(fingerprint: string): Promise<boolean> {
  assertFingerprint(fingerprint);
  return store.withLock(async () => {
    const list = await store.read();
    const next = list.filter((t) => t.fingerprint !== fingerprint);
    if (next.length === list.length) return false;
    await store.write(next);
    return true;
  });
}
