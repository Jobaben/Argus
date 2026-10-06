/**
 * Per-instance transition-log storage: `argus/transitions/<instanceId>.jsonl`.
 *
 * No new writer: every append goes through the Decision Journal's proven
 * primitives — the checksummed line envelope, write-every-byte with short-write
 * detection, fsync, and the torn-tail fence that keeps a fragment left by a
 * crash mid-append from ever reading as a record (`decision/storage.ts`).
 *
 * Bounded, never pruned: a record over 16 KiB keeps its sequence number but
 * not its changes (`encodeTransition`), and once the file would pass 4 MiB
 * appends stop — the caller records that on the instance — rather than
 * deleting history to make room. The file is deleted only with its instance
 * (`pruneInstances`).
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import { paths } from "../claudeHome.js";
import { KeyedMutex } from "../mutex.js";
import { appendLines, parseLines, readText, TORN_MARKER, tornPrefix } from "../durable/envelope.js";
import { defaultWrite, type WriteFn } from "../durable/io.js";
import {
  encodeTransition,
  isTransitionRecord,
  TRANSITION_KIND,
  TRANSITION_LOG_MAX_BYTES,
  type LogReading,
} from "./fold.js";
import type { TransitionRecord } from "@argus/contracts";

const INSTANCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** The log's path, rebuilt from a validated id — never from text in a file. */
export function transitionLogPath(instanceId: string): string {
  if (!INSTANCE_ID_RE.test(instanceId)) throw new Error(`invalid instance id "${instanceId}"`);
  return path.join(paths.transitionsDir(), `${instanceId}.jsonl`);
}

const lock = new KeyedMutex();

export type AppendOutcome =
  | { ok: true; bytes: number; oversized: boolean }
  | { ok: false; reason: "capped"; bytes: number }
  | { ok: false; reason: "error"; error: unknown };

export interface AppendDeps {
  /** The write seam, for short- and failed-write injection. */
  write?: WriteFn;
  /** Overrides the size cap (tests). */
  maxBytes?: number;
}

/**
 * Append one record and fsync it. Never throws: a log that could not be
 * written is reported to the caller, which decides — and records on the
 * instance — what that means. A refused append (the cap) writes nothing.
 */
export async function appendTransitionRecord(
  record: TransitionRecord,
  deps: AppendDeps = {},
): Promise<AppendOutcome> {
  try {
    const file = transitionLogPath(record.instanceId);
    return await lock.withLock(record.instanceId, async () => {
      const encoded = encodeTransition(record);
      const prefix = await tornPrefix(file, record.at);
      const size = await stat(file).then(
        (s) => s.size,
        () => 0,
      );
      const bytes = Buffer.byteLength(prefix + encoded.text, "utf8");
      if (size + bytes > (deps.maxBytes ?? TRANSITION_LOG_MAX_BYTES)) {
        return { ok: false as const, reason: "capped" as const, bytes };
      }
      const written = await appendLines(file, prefix, [encoded.text], deps.write ?? defaultWrite);
      return { ok: true as const, bytes: written, oversized: encoded.oversized };
    });
  } catch (error) {
    return { ok: false, reason: "error", error };
  }
}

/**
 * Read an instance's log, tolerating anything: a missing file, torn
 * fragments, lines that fail their checksum, records for the wrong instance.
 * What could not be used is counted, never silently dropped.
 */
export async function readTransitionLog(instanceId: string): Promise<LogReading> {
  const text = await readText(transitionLogPath(instanceId));
  if (text === null) {
    return { records: [], corruptLines: [], invalidLines: [], tornTail: 0, present: false };
  }
  const parsed = parseLines(text);
  const records: TransitionRecord[] = [];
  const corruptLines: number[] = [];
  const invalidLines: number[] = [];
  for (const line of parsed.lines) {
    if (!line.ok) {
      if (!parsed.recoveredTorn.has(line.line)) corruptLines.push(line.line);
      continue;
    }
    if (line.kind === TORN_MARKER) continue;
    if (line.kind !== TRANSITION_KIND || !isTransitionRecord(line.body, instanceId)) {
      invalidLines.push(line.line);
      continue;
    }
    records.push(line.body);
  }
  return { records, corruptLines, invalidLines, tornTail: parsed.tornTail, present: true };
}
