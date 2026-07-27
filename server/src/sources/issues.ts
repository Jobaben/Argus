import { createHash } from "node:crypto";
import { paths } from "../claudeHome.js";
import { createJsonArrayStore } from "./jsonArrayStore.js";
import type { Run } from "./scheduleTypes.js";
import type { FailureClass, Issue, IssueOccurrence, IssueState } from "@argus/contracts";

/**
 * Issues: Sentry-style grouping of failed runs. Twenty failures with the same
 * root cause read as one issue with a count, not twenty rows. Issues are a
 * pure derivation over the runs on disk; the only persisted state is triage
 * (resolve/ignore), in Argus-owned issues.json.
 */

export type { Issue, IssueOccurrence, IssuesSummary, IssueState } from "@argus/contracts";

/** Triage as persisted in Argus-owned issues.json — on-disk only, never served. */
export interface TriageRecord {
  fingerprint: string;
  state: "resolved" | "ignored";
  at: string;
  /** lastSeen at the moment of triage — a newer failure means regression. */
  lastSeenAtTriage: string;
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

/** The 16-hex group id for an already-chosen error message. */
export function fingerprintText(error: string): string {
  return createHash("sha256").update(normalizeError(error)).digest("hex").slice(0, 16);
}

export function fingerprintOf(run: Run): string {
  return fingerprintText(rawError(run));
}

const runAt = (r: Run): string => r.endedAt ?? r.startedAt ?? r.queuedAt;

function stateFor(triage: TriageRecord | undefined, lastSeen: string): IssueState {
  if (!triage) return "open";
  if (triage.state === "ignored") return "ignored";
  // Resolved sticks until a newer failure arrives — Sentry's regression rule.
  return lastSeen > triage.lastSeenAtTriage ? "open" : "resolved";
}

// ── Similarity clustering ───────────────────────────────────────────────────
//
// Exact-string fingerprinting collapses "timeout after 42s" and "timeout after
// 7s" — the digits are normalized away — but not "npm install failed: ETIMEDOUT"
// and "dependency install timed out". Those are one problem and two rows, and a
// reader triaging them has to notice the connection themselves.
//
// The upgrade is a *similarity* pass over the string groups, not a replacement
// for them. Two things drive it, in order of how much they can be trusted:
//
//   1. **Autopsy's failure class**, when both sides have one. It is the closest
//      thing to a semantic label Argus has, and it is a closed taxonomy, so it
//      is comparable. Different known classes never merge, however similar the
//      words: "permission-denied" and "rate-limit" can read almost identically
//      and are not the same problem.
//   2. **Token overlap** (Jaccard) of the normalized messages, which is what
//      catches shared vocabulary once the digits and ids are gone.
//
// Merging *groups* rather than runs keeps this O(g²) in the number of distinct
// error strings, which is small, and makes the fallback exact: with no autopsies
// and no overlap, the output is byte-for-byte what string grouping produced.

/** Overlap required to merge when both sides carry the same failure class. */
export const CLASSED_SIMILARITY = 0.5;
/** Overlap required with no class agreement to lean on. Higher, deliberately:
 *  words alone are weaker evidence than words plus a matching diagnosis. */
export const UNCLASSED_SIMILARITY = 0.7;

/** Tokens too short or too generic to carry meaning in an error message. */
const STOP_TOKENS = new Set([
  "the",
  "and",
  "for",
  "with",
  "error",
  "failed",
  "failure",
  "exception",
  "code",
  "not",
  "was",
  "has",
]);

/** The comparable content of a normalized error: distinct meaningful tokens. */
export function errorTokens(normalized: string): Set<string> {
  const out = new Set<string>();
  for (const token of normalized.split(/[^a-z0-9]+/)) {
    if (token.length < 3) continue;
    if (STOP_TOKENS.has(token)) continue;
    out.add(token);
  }
  return out;
}

/** |A ∩ B| / |A ∪ B|. Two empty sets are dissimilar, not identical — an error
 *  with no meaningful tokens tells us nothing, so it must not swallow others. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / (a.size + b.size - shared);
}

interface StringGroup {
  fingerprint: string;
  runs: Run[];
  tokens: Set<string>;
  failureClass: FailureClass | null;
}

/** Whether two string groups describe the same underlying problem. */
export function shouldMerge(a: StringGroup, b: StringGroup): boolean {
  if (a.failureClass && b.failureClass && a.failureClass !== b.failureClass) return false;
  const similarity = jaccard(a.tokens, b.tokens);
  const bothClassed = a.failureClass != null && a.failureClass === b.failureClass;
  return similarity >= (bothClassed ? CLASSED_SIMILARITY : UNCLASSED_SIMILARITY);
}

/** The one class the members agree on, or null when they disagree or none has one. */
function agreedClass(groups: StringGroup[]): FailureClass | null {
  const classes = new Set(groups.map((g) => g.failureClass).filter((c): c is FailureClass => !!c));
  return classes.size === 1 ? [...classes][0] : null;
}

export interface IssueOptions {
  /** Autopsy failure class per run id. Absent = pure string grouping. */
  classes?: Map<string, FailureClass>;
  /**
   * Runs whose Verdict fell below the author's bar, with the message to group
   * them under.
   *
   * A quality regression is a failure of the *work* even though the process
   * exited fine, so it belongs in the same triage surface as a crash rather
   * than in a parallel list nobody checks. Absent = only process failures.
   */
  verdicts?: Map<string, string>;
}

/** The error text a run is grouped under, preferring a quality regression's
 *  message over the process error (there usually isn't one). */
function errorFor(run: Run, verdicts?: Map<string, string>): string {
  return verdicts?.get(run.id) ?? rawError(run);
}

/** Whether a run belongs in Issues at all: it crashed, or it missed the bar. */
function isIssueWorthy(run: Run, verdicts?: Map<string, string>): boolean {
  return isFailure(run) || verdicts?.has(run.id) === true;
}

/** Group failures into issues. `runs` in readRuns order (newest first). */
export function buildIssues(runs: Run[], triage: TriageRecord[], opts: IssueOptions = {}): Issue[] {
  const byFp = new Map<string, Run[]>();
  for (const r of runs) {
    if (!isIssueWorthy(r, opts.verdicts)) continue;
    const fp = fingerprintText(errorFor(r, opts.verdicts));
    const list = byFp.get(fp);
    if (list) list.push(r);
    else byFp.set(fp, [r]);
  }

  // Fingerprint order, not insertion order: clustering is greedy, so a stable
  // iteration order is what makes the output deterministic across reads.
  const groups: StringGroup[] = [...byFp.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([fingerprint, group]) => ({
      fingerprint,
      runs: group,
      tokens: errorTokens(normalizeError(errorFor(group[0], opts.verdicts))),
      failureClass: dominantClass(group, opts.classes),
    }));

  const clusters: StringGroup[][] = [];
  for (const group of groups) {
    const home = clusters.find((c) => c.some((member) => shouldMerge(member, group)));
    if (home) home.push(group);
    else clusters.push([group]);
  }

  const triageByFp = new Map(triage.map((t) => [t.fingerprint, t]));
  const issues: Issue[] = [];
  for (const cluster of clusters) {
    // Lexicographically smallest member id, so the cluster's identity — and
    // therefore its triage record — survives new members arriving or the
    // largest member ageing out.
    const members = cluster.map((g) => g.fingerprint).sort();
    const fingerprint = members[0];
    const all = cluster.flatMap((g) => g.runs).sort((a, b) => runAt(b).localeCompare(runAt(a)));
    const newest = all[0];
    const oldest = all[all.length - 1];
    const lastSeen = runAt(newest);
    issues.push({
      fingerprint,
      title: errorFor(newest, opts.verdicts).split("\n")[0].slice(0, 300),
      count: all.length,
      firstSeen: runAt(oldest),
      lastSeen,
      schedules: [...new Set(all.map((r) => r.scheduleName))],
      state: stateFor(triageByFp.get(fingerprint), lastSeen),
      lastRunId: newest.id,
      members,
      failureClass: agreedClass(cluster),
    });
  }
  const rank: Record<IssueState, number> = { open: 0, ignored: 1, resolved: 2 };
  issues.sort((a, b) => rank[a.state] - rank[b.state] || b.lastSeen.localeCompare(a.lastSeen));
  return issues;
}

/** The class most of a string group's runs were diagnosed with, if any. */
function dominantClass(
  group: Run[],
  classes: Map<string, FailureClass> | undefined,
): FailureClass | null {
  if (!classes || classes.size === 0) return null;
  const tally = new Map<FailureClass, number>();
  for (const r of group) {
    const c = classes.get(r.id);
    if (c) tally.set(c, (tally.get(c) ?? 0) + 1);
  }
  let best: FailureClass | null = null;
  let bestCount = 0;
  // Ties resolve by class name so the result never depends on Map order.
  for (const [c, n] of [...tally].sort(([a], [b]) => a.localeCompare(b))) {
    if (n > bestCount) {
      best = c;
      bestCount = n;
    }
  }
  return best;
}

/** Occurrences of one issue, newest first, capped. Accepts the issue's whole
 *  member set so a clustered issue lists every occurrence, not just the ones
 *  that happen to share its representative fingerprint. */
export function issueOccurrences(
  runs: Run[],
  fingerprints: string | readonly string[],
  opts: IssueOptions = {},
): IssueOccurrence[] {
  const wanted = new Set(typeof fingerprints === "string" ? [fingerprints] : fingerprints);
  return runs
    .filter(
      (r) =>
        isIssueWorthy(r, opts.verdicts) && wanted.has(fingerprintText(errorFor(r, opts.verdicts))),
    )
    .slice(0, OCCURRENCE_CAP)
    .map((r) => ({
      runId: r.id,
      scheduleId: r.scheduleId,
      scheduleName: r.scheduleName,
      at: runAt(r),
      status: r.status,
      outcome: r.outcome ?? null,
      error: errorFor(r, opts.verdicts).slice(0, 500),
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
