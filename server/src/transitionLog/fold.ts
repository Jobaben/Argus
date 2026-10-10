/**
 * Records, replay and integrity for the transition log — all pure.
 *
 * A record is one checksummed line (the Decision Journal's envelope, reused:
 * `decision/storage.ts`), at most {@link TRANSITION_RECORD_MAX_BYTES}. The fold
 * replays records from a baseline; the integrity comparison says, in one of a
 * closed set of words, how a saved instance and its log relate — without ever
 * repairing either.
 */
import { canonicalJson, sha256Hex, SHA256_RE } from "../durable/canonical.js";
import { encodeLine } from "../durable/envelope.js";
import {
  applyOps,
  diffProjection,
  formatPath,
  projectInstance,
  projectionDigest,
  ReplayError,
} from "./projection.js";
import type {
  TransitionIntegrityReport,
  TransitionIntegrityStatus,
  TransitionRecord,
} from "@argus/contracts";

/** The envelope `kind` every transition line carries. */
export const TRANSITION_KIND = "transition";
/** A single record's encoded line may not exceed this. */
export const TRANSITION_RECORD_MAX_BYTES = 16 * 1024;
/** A log may not grow past this; it is never pruned to make room. */
export const TRANSITION_LOG_MAX_BYTES = 4 * 1024 * 1024;
/** Bound on the list of unattributed status changes kept on one record. */
const UNATTRIBUTED_MAX = 20;
const DETAIL_MAX = 200;

/**
 * The encoded line for a record, made to fit. When the changes (or the
 * baseline) would push it past the limit they are replaced by an `oversize`
 * marker naming their size and digest, so the sequence stays whole and the
 * replay can say exactly where it had to stop. Event details are clipped and
 * the unattributed list bounded first, because those are never what a replay
 * needs.
 */
export function encodeTransition(record: TransitionRecord): {
  text: string;
  record: TransitionRecord;
  oversized: boolean;
} {
  const bounded: TransitionRecord = {
    ...record,
    events: record.events.map((e) =>
      e.detail && e.detail.length > DETAIL_MAX
        ? { ...e, detail: `${e.detail.slice(0, DETAIL_MAX - 1)}…` }
        : e,
    ),
    ...(record.unattributed
      ? { unattributed: record.unattributed.slice(0, UNATTRIBUTED_MAX) }
      : {}),
  };
  let line = encodeLine(TRANSITION_KIND, bounded);
  if (Buffer.byteLength(line.text, "utf8") <= TRANSITION_RECORD_MAX_BYTES) {
    return { text: line.text, record: bounded, oversized: false };
  }
  const heavy = bounded.baseline !== undefined ? bounded.baseline : (bounded.changes ?? []);
  const heavyText = canonicalJson(heavy);
  const slim: TransitionRecord = { ...bounded };
  delete slim.baseline;
  delete slim.changes;
  slim.oversize = {
    bytes: Buffer.byteLength(heavyText, "utf8"),
    sha256: sha256Hex(heavyText),
  };
  line = encodeLine(TRANSITION_KIND, slim);
  return { text: line.text, record: slim, oversized: true };
}

function isInt(v: unknown, min: number): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= min;
}

/** Shape check for a record read back off disk. Readers tolerate anything;
 *  only a record that passes this is replayed. */
export function isTransitionRecord(v: unknown, instanceId: string): v is TransitionRecord {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  if (r.schema !== 1 || !isInt(r.seq, 1)) return false;
  if (r.instanceId !== instanceId || typeof r.at !== "string" || typeof r.source !== "string") {
    return false;
  }
  if (!Array.isArray(r.events) || !Array.isArray(r.effects)) return false;
  if (typeof r.stateSha256 !== "string" || !SHA256_RE.test(r.stateSha256)) return false;
  if (r.changes !== undefined && !Array.isArray(r.changes)) return false;
  if (r.baseline !== undefined && (!r.baseline || typeof r.baseline !== "object")) return false;
  return true;
}

export interface LogReading {
  records: TransitionRecord[];
  /** 1-based line numbers that failed their checksum or did not parse, and
   *  were not a recovered torn write. */
  corruptLines: number[];
  /** Lines that parsed and verified but are not a valid record for this instance. */
  invalidLines: number[];
  /** Bytes of an unacknowledged final fragment (a write that died mid-line). */
  tornTail: number;
  /** Whether the file exists at all. */
  present: boolean;
}

export interface FoldResult {
  state: unknown | null;
  /** The last sequence number folded in. */
  seq: number | null;
  coverage: "full" | "from-baseline" | "none";
  findings: string[];
  /** Where the fold stopped short of `uptoSeq` (or the end), and why. */
  stopped?: { seq: number; reason: "gap" | "oversize" | "replay" | "no-baseline" };
}

/**
 * Replay records into a projection. Begins at the first record that carries
 * a baseline; a later baseline re-anchors the replay (it is how the log
 * resumes after a stretch it could not write). Stops — and says why — at a
 * gap in the sequence, at a record whose changes did not fit, or at a record
 * whose replayed state does not hash to what it recorded.
 */
export function foldTransitions(
  records: readonly TransitionRecord[],
  uptoSeq: number | null = null,
): FoldResult {
  const findings: string[] = [];
  let state: unknown = null;
  let seq: number | null = null;
  let coverage: FoldResult["coverage"] = "none";
  for (const record of records) {
    if (uptoSeq !== null && record.seq > uptoSeq) break;
    if (record.baseline !== undefined) {
      if (seq !== null && record.seq !== seq + 1) {
        findings.push(
          `records ${seq + 1}–${record.seq - 1} are absent; replay resumes from the baseline at ${record.seq}`,
        );
      }
      state = structuredClone(record.baseline);
      seq = record.seq;
      if (coverage === "none") {
        coverage = record.events.some((e) => e.kind === "init") ? "full" : "from-baseline";
      } else {
        coverage = "from-baseline";
      }
      if (projectionDigest(state) !== record.stateSha256) {
        findings.push(`the baseline at ${record.seq} does not hash to the state it records`);
        return {
          state: null,
          seq: null,
          coverage: "none",
          findings,
          stopped: { seq: record.seq, reason: "replay" },
        };
      }
      continue;
    }
    if (seq === null) {
      findings.push(`the log does not begin with a baseline (first record is ${record.seq})`);
      return {
        state: null,
        seq: null,
        coverage,
        findings,
        stopped: { seq: record.seq, reason: "no-baseline" },
      };
    }
    if (record.seq !== seq + 1) {
      findings.push(`sequence jumps from ${seq} to ${record.seq}`);
      return { state, seq, coverage, findings, stopped: { seq: record.seq, reason: "gap" } };
    }
    if (record.oversize || !record.changes) {
      findings.push(
        `record ${record.seq} was too large to keep its changes (${record.oversize?.bytes ?? "?"} bytes); replay stops before it`,
      );
      return { state, seq, coverage, findings, stopped: { seq: record.seq, reason: "oversize" } };
    }
    let next: unknown;
    try {
      next = applyOps(state, record.changes);
    } catch (e) {
      findings.push(
        `record ${record.seq} cannot be applied: ${e instanceof ReplayError ? e.message : String(e)}`,
      );
      return { state, seq, coverage, findings, stopped: { seq: record.seq, reason: "replay" } };
    }
    if (projectionDigest(next) !== record.stateSha256) {
      findings.push(`replaying record ${record.seq} does not reproduce the state it records`);
      return { state, seq, coverage, findings, stopped: { seq: record.seq, reason: "replay" } };
    }
    state = next;
    seq = record.seq;
  }
  return { state, seq, coverage, findings };
}

/** Priority when several statuses apply: the one a reader must act on first. */
const PRIORITY: TransitionIntegrityStatus[] = [
  "corrupt",
  "missing",
  "gap",
  "degraded",
  "disagreement",
  "behind",
  "ahead",
  "partial",
  "consistent",
  "untracked",
];

/**
 * How a saved instance and its transition log relate. Never repairs either:
 * a log ahead of the instance is a proposal the instance never committed, a
 * disagreement is reported with the first path where they differ, and an
 * instance whose log could not be written says so through `degradedFrom`.
 */
export function compareIntegrity(
  instanceId: string,
  instance: unknown | null,
  log: LogReading,
): TransitionIntegrityReport {
  const findings: string[] = [];
  const statuses = new Set<TransitionIntegrityStatus>();
  const tl =
    instance && typeof instance === "object"
      ? (
          instance as {
            transitionLog?: { seq?: unknown; degradedFrom?: unknown; capped?: unknown };
          }
        ).transitionLog
      : undefined;
  const instanceSeq = tl && isInt(tl.seq, 0) ? tl.seq : null;
  const degradedFrom = tl && isInt(tl.degradedFrom, 1) ? tl.degradedFrom : null;
  const logSeq = log.records.length > 0 ? log.records[log.records.length - 1].seq : null;

  if (log.corruptLines.length > 0) {
    statuses.add("corrupt");
    findings.push(`lines ${log.corruptLines.join(", ")} failed their checksum or did not parse`);
  }
  if (log.invalidLines.length > 0) {
    statuses.add("corrupt");
    findings.push(`lines ${log.invalidLines.join(", ")} are not valid records for this instance`);
  }
  if (log.tornTail > 0) {
    findings.push(`the log ends in a ${log.tornTail}-byte fragment of an unacknowledged write`);
  }
  if (tl?.capped)
    findings.push("the log reached its size limit; later transitions were not recorded");
  if (degradedFrom !== null) {
    statuses.add("degraded");
    findings.push(`records from ${degradedFrom} could not be written when they happened`);
  }

  if (!instance) {
    findings.push("there is no saved instance to compare against");
    return report("corrupt");
  }
  if (instanceSeq === null) {
    if (log.records.length === 0) {
      if (!log.present) return report(statuses.size > 0 ? pick() : "untracked");
      statuses.add("corrupt");
      findings.push("the log exists but holds no readable record");
      return report(pick());
    }
    // A log the instance never acknowledged: everything in it is proposed.
    statuses.add("ahead");
    findings.push(
      `the log holds records up to ${logSeq}, and the saved instance acknowledges none`,
    );
    return report(pick());
  }
  if (log.records.length === 0) {
    if (degradedFrom === null || degradedFrom > 1) {
      statuses.add("missing");
      findings.push(`the instance is at transition ${instanceSeq} but its log has no records`);
    }
    return report(pick());
  }

  const fold = foldTransitions(log.records, instanceSeq);
  findings.push(...fold.findings);
  if (fold.stopped?.reason === "gap" && degradedFrom === null) statuses.add("gap");
  if (fold.stopped?.reason === "replay") statuses.add("corrupt");
  if (fold.stopped?.reason === "oversize" || fold.stopped?.reason === "no-baseline") {
    statuses.add("partial");
  }
  if (logSeq !== null && logSeq > instanceSeq) {
    statuses.add("ahead");
    findings.push(
      `records ${instanceSeq + 1}–${logSeq} are past the saved instance: proposed, never committed`,
    );
  }
  if (fold.seq === instanceSeq && fold.state !== null) {
    const saved = projectInstance(instance);
    if (projectionDigest(saved) !== projectionDigest(fold.state)) {
      statuses.add("disagreement");
      const first = diffProjection(fold.state, saved)[0];
      findings.push(
        `the replayed state differs from the saved instance at ${first ? formatPath(first.path) : "/"}`,
      );
      return report(pick(), first ? formatPath(first.path) : "/", fold);
    }
    if (fold.coverage === "from-baseline") {
      statuses.add("partial");
      findings.push("the log begins at a baseline written after the instance existed");
    }
    if (statuses.size === 0) statuses.add("consistent");
  } else if (fold.seq === null || fold.seq < instanceSeq) {
    if (logSeq !== null && logSeq < instanceSeq && degradedFrom === null) {
      statuses.add("behind");
      findings.push(
        `the saved instance is at ${instanceSeq}, past the end of the log at ${logSeq}`,
      );
    } else if (degradedFrom === null && statuses.size === 0) {
      statuses.add("gap");
    }
  }
  return report(pick(), undefined, fold);

  function pick(): TransitionIntegrityStatus {
    return PRIORITY.find((s) => statuses.has(s)) ?? "consistent";
  }
  function report(
    status: TransitionIntegrityStatus,
    firstDivergence?: string,
    fold?: FoldResult,
  ): TransitionIntegrityReport {
    return {
      instanceId,
      status,
      coverage: fold?.coverage ?? "none",
      instanceSeq,
      logSeq,
      replayedTo: fold?.seq ?? null,
      findings,
      ...(firstDivergence ? { firstDivergence } : {}),
    };
  }
}
