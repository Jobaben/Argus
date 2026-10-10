import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { AcceptanceVerificationRecord, AcceptanceVerificationStatus } from "@argus/contracts";
import { paths } from "../claudeHome.js";
import { atomicWriteJson } from "../sources/atomicWrite.js";
import { KeyedMutex } from "../mutex.js";

/**
 * Where an acceptance-verification proposal lives between the agent writing it
 * and Argus deciding its fate (Phase 8) — deliberately *not* in
 * `knowledge.json`, and deliberately its own directory beside the
 * rule-verification one.
 *
 * Every run gets a directory of its own under `argus/acceptance-verifications/`:
 *
 *   <runId>/acceptance.json  the one file the agent may write
 *                            (ARGUS_ACCEPTANCE_VERIFICATION_FILE)
 *   <runId>/staged.json      Argus's record: identity, the accepted proposal it
 *                            answers, every criterion it is accountable for,
 *                            the repository state it examined, status, the
 *                            validated report, the refusal or the durable
 *                            result
 *
 * Its own channel rather than the rule-verification one, for the reason the
 * dimension exists: a criterion result is bound to `CP-12/AC-1` and a rule
 * result to a `ClaimRef`, and a phase that answers both writes both files. One
 * file would have made "every rule holds and AC-3 is violated" — the exact
 * state a realization must refuse to call complete — expressible only by
 * conflating two vocabularies.
 *
 * Per run, like every other staging store, so a retry, a revise or a
 * remediation writes a fresh path and can never be credited with a previous
 * attempt's conclusions.
 *
 * Nothing here decides anything semantic. Reading the agent's file is a plain
 * read (the document is validated by `acceptance.ts`), and the record's status
 * is whatever the engine tells it.
 */

/** Cap on the agent's document. A list of outcomes and references, not a log. */
export const ACCEPTANCE_FILE_MAX_BYTES = 1024 * 1024;

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const lock = new KeyedMutex();

export function acceptanceDir(runId: string): string {
  return path.join(paths.acceptanceVerificationsDir(), runId);
}

/** The path handed to the agent as `ARGUS_ACCEPTANCE_VERIFICATION_FILE`. */
export function acceptanceVerificationFile(runId: string): string {
  return path.join(acceptanceDir(runId), "acceptance.json");
}

/** Argus's record of the run's proposal. */
export function stagedAcceptancePath(runId: string): string {
  return path.join(acceptanceDir(runId), "staged.json");
}

/** Create the run's acceptance directory so the agent can write into it. */
export async function ensureAcceptanceDir(runId: string): Promise<string> {
  const dir = acceptanceDir(runId);
  await mkdir(dir, { recursive: true });
  return dir;
}

export type AgentAcceptanceFile =
  { kind: "none" } | { kind: "document"; text: string } | { kind: "unreadable"; reason: string };

/**
 * The agent's file, as written. `none` when it was never written — which on an
 * acceptance phase with required criteria is itself a refusal, decided by the
 * engine rather than here.
 */
export async function readAgentAcceptance(runId: string): Promise<AgentAcceptanceFile> {
  if (!RUN_ID_RE.test(runId)) return { kind: "none" };
  const file = acceptanceVerificationFile(runId);
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    return { kind: "none" };
  }
  if (size > ACCEPTANCE_FILE_MAX_BYTES) {
    return {
      kind: "unreadable",
      reason: `the acceptance-verification file is ${size} bytes; the cap is ${ACCEPTANCE_FILE_MAX_BYTES}`,
    };
  }
  try {
    return { kind: "document", text: await readFile(file, "utf8") };
  } catch (e) {
    return {
      kind: "unreadable",
      reason: `the acceptance-verification file could not be read: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export async function writeAcceptanceRecord(record: AcceptanceVerificationRecord): Promise<void> {
  await lock.withLock(record.runId, () =>
    atomicWriteJson(stagedAcceptancePath(record.runId), record),
  );
}

/** The run's staged record, or null when the run staged nothing. */
export async function readAcceptanceRecord(
  runId: string,
): Promise<AcceptanceVerificationRecord | null> {
  if (!RUN_ID_RE.test(runId)) return null;
  try {
    return JSON.parse(
      await readFile(stagedAcceptancePath(runId), "utf8"),
    ) as AcceptanceVerificationRecord;
  } catch {
    return null;
  }
}

/**
 * Move a record to a new status, serialized per run so the engine's paths
 * (intake, commit, retirement) cannot lose each other's writes. A record
 * already in a terminal status other than the requested one is left alone.
 */
export async function updateAcceptanceStatus(
  runId: string,
  status: AcceptanceVerificationStatus,
  patch: Partial<Pick<AcceptanceVerificationRecord, "reason" | "result">> & { at: string },
): Promise<AcceptanceVerificationRecord | null> {
  return lock.withLock(runId, async () => {
    const current = await readAcceptanceRecord(runId);
    if (!current) return null;
    if (current.status !== "staged" && current.status !== status) return current;
    const next: AcceptanceVerificationRecord = {
      ...current,
      status,
      updatedAt: patch.at,
      ...(patch.reason !== undefined ? { reason: patch.reason } : {}),
      ...(patch.result !== undefined ? { result: patch.result } : {}),
    };
    await atomicWriteJson(stagedAcceptancePath(runId), next);
    return next;
  });
}

/** Every staged record, newest first by `receivedAt`. */
export async function readAcceptanceRecords(): Promise<AcceptanceVerificationRecord[]> {
  let names: string[];
  try {
    names = await readdir(paths.acceptanceVerificationsDir());
  } catch {
    return [];
  }
  const records = await Promise.all(
    names.filter((n) => RUN_ID_RE.test(n)).map(readAcceptanceRecord),
  );
  return records
    .filter((r): r is AcceptanceVerificationRecord => r !== null)
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
}

/** A record by its staging id. */
export async function readAcceptanceRecordById(
  id: string,
): Promise<AcceptanceVerificationRecord | null> {
  return (await readAcceptanceRecords()).find((r) => r.id === id) ?? null;
}
