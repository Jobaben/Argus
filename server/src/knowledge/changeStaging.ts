import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ChangeProposalRecord, ChangeProposalStatus } from "@argus/contracts";
import { paths } from "../claudeHome.js";
import { atomicWriteJson } from "../sources/atomicWrite.js";
import { KeyedMutex } from "../mutex.js";

/**
 * Where a ChangeProposal lives between the agent writing it and Argus deciding
 * its fate — deliberately *not* in `knowledge.json`, and deliberately its own
 * channel beside the KnowledgeDelta.
 *
 * Every run gets a directory of its own under `argus/change-proposals/`:
 *
 *   <runId>/proposal.json  the one file the agent may write
 *                          (ARGUS_CHANGE_PROPOSAL_FILE)
 *   <runId>/staged.json    Argus's record: identity, the request it answered,
 *                          the rules it was accountable for, the staged delta
 *                          carrying its semantic half, status, the refusal or
 *                          the durable result
 *
 * Its own channel rather than the delta's, for the reason the phase exists: a
 * change proposal is *more* than a semantic mutation. What is preserved, how
 * success will be judged and what is still unknown have no place in a
 * KnowledgeDelta and must not be smuggled into one as claims. The semantic
 * half *is* an ordinary delta, and is staged as one through the existing
 * machinery, so there is still exactly one path by which anything becomes
 * canonical.
 *
 * Per run, like the delta and the verification report, so a retry or a revise
 * writes a fresh path and can never read back — or be credited with — a
 * previous attempt's reasoning. The record survives a restart: a proposal
 * staged before Argus stopped is still staged, and still gated, afterwards.
 *
 * Nothing here decides anything semantic. Reading the agent's file is a plain
 * read (the document is validated by `changeIntent.ts`), and the record's
 * status is whatever the engine tells it.
 */

/** Cap on the agent's document. A proposal larger than this is refused
 *  unread; it is a structured transition, not a design document. */
export const CHANGE_PROPOSAL_FILE_MAX_BYTES = 1024 * 1024;

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const lock = new KeyedMutex();

export function changeProposalDir(runId: string): string {
  return path.join(paths.changeProposalsDir(), runId);
}

/** The path handed to the agent as `ARGUS_CHANGE_PROPOSAL_FILE`. */
export function changeProposalFile(runId: string): string {
  return path.join(changeProposalDir(runId), "proposal.json");
}

/** Argus's record of the run's proposal. */
export function stagedProposalPath(runId: string): string {
  return path.join(changeProposalDir(runId), "staged.json");
}

/** Create the run's proposal directory so the agent can write into it. */
export async function ensureChangeProposalDir(runId: string): Promise<string> {
  const dir = changeProposalDir(runId);
  await mkdir(dir, { recursive: true });
  return dir;
}

export type AgentProposalFile =
  { kind: "none" } | { kind: "document"; text: string } | { kind: "unreadable"; reason: string };

/**
 * The agent's file, as written. `none` when it was never written — which on a
 * change-intent phase is itself a refusal (the proposal *is* the phase's
 * output), decided by the engine rather than here.
 */
export async function readAgentProposal(runId: string): Promise<AgentProposalFile> {
  if (!RUN_ID_RE.test(runId)) return { kind: "none" };
  const file = changeProposalFile(runId);
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    return { kind: "none" };
  }
  if (size > CHANGE_PROPOSAL_FILE_MAX_BYTES) {
    return {
      kind: "unreadable",
      reason: `the change-proposal file is ${size} bytes; the cap is ${CHANGE_PROPOSAL_FILE_MAX_BYTES}`,
    };
  }
  try {
    return { kind: "document", text: await readFile(file, "utf8") };
  } catch (e) {
    return {
      kind: "unreadable",
      reason: `the change-proposal file could not be read: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export async function writeProposalRecord(record: ChangeProposalRecord): Promise<void> {
  await lock.withLock(record.runId, () =>
    atomicWriteJson(stagedProposalPath(record.runId), record),
  );
}

/** The run's staged record, or null when the run staged nothing. */
export async function readProposalRecord(runId: string): Promise<ChangeProposalRecord | null> {
  if (!RUN_ID_RE.test(runId)) return null;
  try {
    return JSON.parse(await readFile(stagedProposalPath(runId), "utf8")) as ChangeProposalRecord;
  } catch {
    return null;
  }
}

/**
 * Move a record to a new status, serialized per run so the engine's paths
 * (intake, commit, retirement) cannot lose each other's writes. A record
 * already in a terminal status other than the requested one is left alone: an
 * `accepted` proposal is never demoted to `superseded` by a later sweep.
 */
export async function updateProposalStatus(
  runId: string,
  status: ChangeProposalStatus,
  patch: Partial<Pick<ChangeProposalRecord, "reason" | "result">> & { at: string },
): Promise<ChangeProposalRecord | null> {
  return lock.withLock(runId, async () => {
    const current = await readProposalRecord(runId);
    if (!current) return null;
    if (current.status !== "staged" && current.status !== status) return current;
    const next: ChangeProposalRecord = {
      ...current,
      status,
      updatedAt: patch.at,
      ...(patch.reason !== undefined ? { reason: patch.reason } : {}),
      ...(patch.result !== undefined ? { result: patch.result } : {}),
    };
    await atomicWriteJson(stagedProposalPath(runId), next);
    return next;
  });
}

/** Every staged record, newest first by `receivedAt`. */
export async function readProposalRecords(): Promise<ChangeProposalRecord[]> {
  let names: string[];
  try {
    names = await readdir(paths.changeProposalsDir());
  } catch {
    return [];
  }
  const records = await Promise.all(names.filter((n) => RUN_ID_RE.test(n)).map(readProposalRecord));
  return records
    .filter((r): r is ChangeProposalRecord => r !== null)
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
}

/** A record by its staging id. */
export async function readProposalRecordById(id: string): Promise<ChangeProposalRecord | null> {
  return (await readProposalRecords()).find((r) => r.id === id) ?? null;
}
