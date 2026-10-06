/**
 * How the pipeline engine saves an instance (Hardening Item 1).
 *
 * Every save is a transition commit, in this order:
 *
 *   1. append the transition record to the instance's log and fsync it —
 *      sequence, source, the events of the pure transitions that ran, the
 *      projection's changes since the last commit, the effects now owed;
 *   2. publish the instance durably, carrying `transitionLog.seq` — the
 *      commit point;
 *   3. only then does the caller execute effects (launch, check, stop, commit).
 *
 * A record whose instance never got published (a crash between 1 and 2) is a
 * proposal, not a fact: the next commit re-anchors the log with a baseline,
 * and recovery reads owed effects from the saved instance alone.
 *
 * Attribution. The engine reads an instance for mutation through
 * {@link InstancePersistence.capture}, which snapshots it (projection and
 * pipeline status view). Pure transitions return events; the engine hands them
 * over with {@link InstancePersistence.noteResult}. At commit, every pipeline
 * status change between the snapshot and the instance being saved must be
 * accounted for by an event about that phase (or, for the instance status, by
 * any event). One that is not is a forgotten transition: it is written on the
 * record as `unattributed` and reported — never relabelled as a trustworthy
 * replay.
 *
 * Degradation. A log that cannot be written (an I/O error, or the size cap)
 * does not stop the instance: the save proceeds and the instance records
 * `degradedFrom` (and `capped`), so sequence accounting stays honest. It does
 * not grant anything either: gate decisions keep their own write-ahead
 * record, knowledge its own commit, and nothing here decides permission.
 */
import type { PipelineInstance, TransitionEvent, TransitionSource } from "@argus/contracts";
import type { InstanceTransitionLogState, TransitionRecord } from "@argus/contracts";
import {
  diffProjection,
  projectInstance,
  projectionDigest,
  changedStatusKeys,
  statusView,
  type Projection,
} from "../transitionLog/projection.js";
import { owedEffects } from "../transitionLog/effects.js";
import type { AppendOutcome } from "../transitionLog/store.js";
import type { LogReading } from "../transitionLog/fold.js";
import type { TransitionResult } from "../pipelineTransitions.js";

interface Entry {
  projection: Projection | null;
  status: Record<string, string>;
  source: TransitionSource;
}

export interface PersistenceDeps {
  now: () => Date;
  /** Durable instance publication (`writeInstance`). */
  publish: (inst: PipelineInstance) => Promise<void>;
  /** The instance as last published, for a save with no captured snapshot. */
  readSaved: (instanceId: string) => Promise<PipelineInstance | null>;
  append: (record: TransitionRecord) => Promise<AppendOutcome>;
  readLog: (instanceId: string) => Promise<LogReading>;
  /** Told about status changes no event accounted for. */
  onUnattributed: (instanceId: string, changes: string[]) => void;
  /** Told when the log could not be written. */
  onDegraded: (instanceId: string, outcome: Exclude<AppendOutcome, { ok: true }>) => void;
}

export interface CommitResult {
  seq: number;
  logged: boolean;
  unattributed: string[];
}

export interface InstancePersistence {
  /** Snapshot an instance the engine has just read for mutation. */
  capture(inst: PipelineInstance, source: TransitionSource): PipelineInstance;
  /** Mark an instance that has never been saved: its first commit is its
   *  initial baseline. */
  fresh(inst: PipelineInstance, source: TransitionSource): PipelineInstance;
  /** Record events against the instance they changed. */
  note(inst: PipelineInstance, events: readonly TransitionEvent[] | undefined): void;
  /** {@link note} a transition result's events, and hand the result back. */
  noteResult<R extends Pick<TransitionResult, "instance" | "events">>(res: R): R;
  /** Append, publish, and re-snapshot. Throws only when publication fails. */
  commit(inst: PipelineInstance): Promise<CommitResult>;
}

/** Status-view keys a set of events accounts for. */
function attributed(key: string, events: readonly TransitionEvent[]): boolean {
  if (events.length === 0) return false;
  // An instance's first transition accounts for every field it starts with.
  if (events.some((e) => e.kind === "init")) return true;
  if (key === "status") return true;
  if (key === "gateOperation") {
    return events.some((e) => e.kind === "gate-linked" || e.kind === "gate-completed");
  }
  const m = /^(?:phase|step):(.+?)(?:#\d+)?$/.exec(key);
  if (!m) return false;
  const phaseId = m[1];
  return events.some((e) => e.phaseId === phaseId || e.kind === "abort" || e.kind === "init");
}

export function createInstancePersistence(deps: PersistenceDeps): InstancePersistence {
  const entries = new WeakMap<PipelineInstance, Entry>();
  const pending = new WeakMap<PipelineInstance, TransitionEvent[]>();
  /** The last sequence number this process knows the log holds, per instance. */
  const logEnd = new Map<string, number>();

  function capture(inst: PipelineInstance, source: TransitionSource): PipelineInstance {
    entries.set(inst, { projection: projectInstance(inst), status: statusView(inst), source });
    pending.delete(inst);
    return inst;
  }

  function note(inst: PipelineInstance, events: readonly TransitionEvent[] | undefined): void {
    if (!events || events.length === 0) return;
    pending.set(inst, [...(pending.get(inst) ?? []), ...events]);
  }

  async function knownLogEnd(instanceId: string): Promise<number> {
    const known = logEnd.get(instanceId);
    if (known !== undefined) return known;
    const reading = await deps.readLog(instanceId).catch(() => null);
    const last = reading?.records.length ? reading.records[reading.records.length - 1].seq : 0;
    logEnd.set(instanceId, last);
    return last;
  }

  async function commit(inst: PipelineInstance): Promise<CommitResult> {
    let entry = entries.get(inst);
    if (!entry) {
      // Saved without a snapshot: compare against what is published now.
      const saved = await deps.readSaved(inst.id);
      entry = saved
        ? { projection: projectInstance(saved), status: statusView(saved), source: "engine" }
        : { projection: null, status: {}, source: "engine" };
    }
    const events = pending.get(inst) ?? [];
    const after = projectInstance(inst);
    const afterStatus = statusView(inst);
    const changes = entry.projection ? diffProjection(entry.projection, after) : null;
    const prev: InstanceTransitionLogState | undefined = inst.transitionLog;
    const prevSeq = prev?.seq ?? 0;

    if (changes && changes.length === 0 && events.length === 0) {
      // Nothing to record: the save still happens, exactly as it used to.
      await deps.publish(inst);
      return { seq: prevSeq, logged: false, unattributed: [] };
    }

    const before = entry.status;
    const unattributed = changedStatusKeys(before, afterStatus)
      .filter((key) => !attributed(key, events))
      .map((key) => `${key}: ${before[key] ?? "(none)"} → ${afterStatus[key] ?? "(none)"}`);
    const end = await knownLogEnd(inst.id);
    const seq = Math.max(prevSeq, end) + 1;
    // A baseline starts (or restarts) a replay chain: the instance's first
    // record; an instance that predates the log; and any record after which
    // the log and the saved instance disagree about where the chain stands
    // (an uncommitted record past the instance, or records never written).
    const baseline = entry.projection === null || prevSeq === 0 || end !== prevSeq;
    const record: TransitionRecord = {
      schema: 1,
      seq,
      instanceId: inst.id,
      at: deps.now().toISOString(),
      source: entry.source,
      ...firstSubject(events),
      events:
        baseline && !events.some((e) => e.kind === "init")
          ? [{ kind: "baseline", detail: baselineReason(entry, prevSeq, end) }, ...events]
          : events,
      ...(baseline ? { baseline: after } : { changes: changes ?? [] }),
      effects: owedEffects(inst),
      ...(unattributed.length > 0 ? { unattributed } : {}),
      stateSha256: projectionDigest(after),
    };

    let next: InstanceTransitionLogState;
    let logged = false;
    if (prev?.capped) {
      next = { seq, capped: true, degradedFrom: prev.degradedFrom ?? seq };
    } else {
      const outcome = await deps.append(record);
      if (outcome.ok) {
        logged = true;
        logEnd.set(inst.id, seq);
        next = {
          seq,
          ...(prev?.degradedFrom !== undefined ? { degradedFrom: prev.degradedFrom } : {}),
        };
      } else {
        deps.onDegraded(inst.id, outcome);
        next = {
          seq,
          degradedFrom: prev?.degradedFrom ?? seq,
          ...(outcome.reason === "capped" ? { capped: true } : {}),
        };
      }
    }

    inst.transitionLog = next;
    try {
      await deps.publish(inst);
    } catch (e) {
      // Unpublished: the in-memory instance goes back to what disk says. The
      // record (if appended) stays in the log as an uncommitted proposal.
      if (prev) inst.transitionLog = prev;
      else delete inst.transitionLog;
      throw e;
    }
    entries.set(inst, { projection: after, status: afterStatus, source: entry.source });
    pending.delete(inst);
    if (unattributed.length > 0) deps.onUnattributed(inst.id, unattributed);
    return { seq, logged, unattributed };
  }

  return {
    capture,
    fresh(inst, source) {
      entries.set(inst, { projection: null, status: {}, source });
      pending.delete(inst);
      return inst;
    },
    note,
    noteResult(res) {
      note(res.instance, res.events);
      return res;
    },
    commit,
  };
}

function firstSubject(events: readonly TransitionEvent[]): {
  phaseId?: string;
  attempt?: number;
  runId?: string;
} {
  const e = events.find((x) => x.phaseId !== undefined);
  if (!e) return {};
  return {
    phaseId: e.phaseId,
    ...(e.attempt !== undefined ? { attempt: e.attempt } : {}),
    ...(e.runId !== undefined ? { runId: e.runId } : {}),
  };
}

function baselineReason(entry: Entry, prevSeq: number, end: number): string {
  if (entry.projection === null) return "no earlier state";
  if (prevSeq === 0) return "the instance predates its transition log";
  if (end > prevSeq) return `records ${prevSeq + 1}–${end} were never committed`;
  return `records after ${end} were never written`;
}
