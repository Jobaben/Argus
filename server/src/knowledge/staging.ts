import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { KnowledgeDeltaRecord, KnowledgeDeltaStatus } from "@argus/contracts";
import { paths } from "../claudeHome.js";
import { atomicWriteJson } from "../sources/atomicWrite.js";
import { KeyedMutex } from "../mutex.js";

/**
 * Where a KnowledgeDelta lives between the agent writing it and Argus deciding
 * its fate — deliberately *not* in `knowledge.json`.
 *
 * Every run gets a directory of its own under `argus/knowledge-deltas/`:
 *
 *   <runId>/delta.json    the one file the agent may write (ARGUS_KNOWLEDGE_DELTA_FILE)
 *   <runId>/staged.json   Argus's record: identity, provenance, status, the
 *                         validated proposal, the refusal or the apply result
 *
 * Per run, like the result file and the invocation directory, so a retry or a
 * revise writes a fresh path and can never read back — or be credited with —
 * a previous attempt's proposal. The record is written with the same atomic
 * writer as every other Argus JSON file and survives a restart: a delta staged
 * before Argus stopped is still staged afterwards, and the engine's reconcile
 * pass finds it exactly where the phase's `knowledge.status: "pending"` says
 * it should.
 *
 * Nothing here decides anything semantic. Reading the agent's file is a plain
 * read (the document is validated by `delta.ts`), and the record's status is
 * whatever the engine tells it.
 */

/** Cap on the agent's document. A proposal larger than this is refused
 *  unread; it is a JSON document of claims, not a transcript. */
export const DELTA_FILE_MAX_BYTES = 1024 * 1024;
/** How much of an unparseable document the rejected record keeps, for a
 *  person diagnosing what the agent actually wrote. */
export const REJECTED_RAW_TAIL_CHARS = 2000;

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const lock = new KeyedMutex();

export function knowledgeDeltaDir(runId: string): string {
  return path.join(paths.knowledgeDeltasDir(), runId);
}

/** The path handed to the agent as `ARGUS_KNOWLEDGE_DELTA_FILE`. */
export function knowledgeDeltaFile(runId: string): string {
  return path.join(knowledgeDeltaDir(runId), "delta.json");
}

/** Argus's record of the run's delta. */
export function stagedDeltaPath(runId: string): string {
  return path.join(knowledgeDeltaDir(runId), "staged.json");
}

/** Create the run's delta directory so the agent can write into it. */
export async function ensureKnowledgeDeltaDir(runId: string): Promise<string> {
  const dir = knowledgeDeltaDir(runId);
  await mkdir(dir, { recursive: true });
  return dir;
}

export type AgentDeltaFile =
  { kind: "none" } | { kind: "document"; text: string } | { kind: "unreadable"; reason: string };

/**
 * The agent's file, as written. `none` when it was never written (the common
 * case — most steps propose no knowledge); `unreadable` for a file that
 * exists but cannot be read as text or exceeds the cap. Parsing and
 * validation are `delta.ts`'s business.
 */
export async function readAgentDelta(runId: string): Promise<AgentDeltaFile> {
  if (!RUN_ID_RE.test(runId)) return { kind: "none" };
  const file = knowledgeDeltaFile(runId);
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    return { kind: "none" };
  }
  if (size > DELTA_FILE_MAX_BYTES) {
    return {
      kind: "unreadable",
      reason: `the KnowledgeDelta file is ${size} bytes; the cap is ${DELTA_FILE_MAX_BYTES}`,
    };
  }
  try {
    return { kind: "document", text: await readFile(file, "utf8") };
  } catch (e) {
    return {
      kind: "unreadable",
      reason: `the KnowledgeDelta file could not be read: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export async function writeDeltaRecord(record: KnowledgeDeltaRecord): Promise<void> {
  await lock.withLock(record.runId, () => atomicWriteJson(stagedDeltaPath(record.runId), record));
}

/** The run's staged record, or null when the run staged nothing. */
export async function readDeltaRecord(runId: string): Promise<KnowledgeDeltaRecord | null> {
  if (!RUN_ID_RE.test(runId)) return null;
  try {
    return JSON.parse(await readFile(stagedDeltaPath(runId), "utf8")) as KnowledgeDeltaRecord;
  } catch {
    return null;
  }
}

/**
 * Move a record to a new status, serialized per run so the engine's paths
 * (intake, commit, retirement) cannot lose each other's writes. Returns the
 * record as written, or null when the run has none. A record already in a
 * terminal status other than the requested one is left alone: an `applied`
 * delta is never demoted to `superseded` by a later sweep.
 */
export async function updateDeltaStatus(
  runId: string,
  status: KnowledgeDeltaStatus,
  patch: Partial<Pick<KnowledgeDeltaRecord, "reason" | "result">> & { at: string },
): Promise<KnowledgeDeltaRecord | null> {
  return lock.withLock(runId, async () => {
    const current = await readDeltaRecord(runId);
    if (!current) return null;
    if (current.status !== "staged" && current.status !== status) return current;
    const next: KnowledgeDeltaRecord = {
      ...current,
      status,
      updatedAt: patch.at,
      ...(patch.reason !== undefined ? { reason: patch.reason } : {}),
      ...(patch.result !== undefined ? { result: patch.result } : {}),
    };
    await atomicWriteJson(stagedDeltaPath(runId), next);
    return next;
  });
}

/** Every staged record, newest first by `receivedAt`. A scan — volumes are
 *  per run and pruned with the runs. */
export async function readDeltaRecords(): Promise<KnowledgeDeltaRecord[]> {
  let names: string[];
  try {
    names = await readdir(paths.knowledgeDeltasDir());
  } catch {
    return [];
  }
  const records = await Promise.all(names.filter((n) => RUN_ID_RE.test(n)).map(readDeltaRecord));
  return records
    .filter((r): r is KnowledgeDeltaRecord => r !== null)
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
}

/** A record by its delta id. */
export async function readDeltaRecordById(id: string): Promise<KnowledgeDeltaRecord | null> {
  return (await readDeltaRecords()).find((r) => r.id === id) ?? null;
}
