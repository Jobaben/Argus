import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { RuleVerificationRecord, RuleVerificationStatus } from "@argus/contracts";
import { paths } from "../claudeHome.js";
import { atomicWriteJson } from "../sources/atomicWrite.js";
import { KeyedMutex } from "../mutex.js";

/**
 * Where a rule-verification proposal lives between the agent writing it and
 * Argus deciding its fate — deliberately *not* in `knowledge.json`, and
 * deliberately not in the KnowledgeDelta directory either.
 *
 * Every run gets a directory of its own under `argus/rule-verifications/`:
 *
 *   <runId>/verification.json  the one file the agent may write
 *                              (ARGUS_RULE_VERIFICATION_FILE)
 *   <runId>/staged.json        Argus's record: identity, provenance, the rules
 *                              it was accountable for, status, the validated
 *                              report, the refusal or the durable result
 *
 * A separate channel from the KnowledgeDelta, for the reason the whole phase
 * exists: a conformance result is not a knowledge mutation. Sharing the delta
 * file would have invited an agent to express "the code violates this rule" as
 * opposing evidence on the rule, which is precisely the contamination Phase 6
 * forbids. Two files, two vocabularies, no way to confuse them.
 *
 * Per run, like the delta and the result file, so a retry or a revise writes a
 * fresh path and can never read back — or be credited with — a previous
 * attempt's conclusions. The record is written with the same atomic writer as
 * every other Argus JSON file and survives a restart: a proposal staged before
 * Argus stopped is still staged afterwards.
 *
 * Nothing here decides anything semantic. Reading the agent's file is a plain
 * read (the document is validated by `ruleVerification.ts`), and the record's
 * status is whatever the engine tells it.
 */

/** Cap on the agent's document. A proposal larger than this is refused
 *  unread; it is a list of outcomes and references, not a test log. */
export const VERIFICATION_FILE_MAX_BYTES = 1024 * 1024;

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const lock = new KeyedMutex();

export function ruleVerificationDir(runId: string): string {
  return path.join(paths.ruleVerificationsDir(), runId);
}

/** The path handed to the agent as `ARGUS_RULE_VERIFICATION_FILE`. */
export function ruleVerificationFile(runId: string): string {
  return path.join(ruleVerificationDir(runId), "verification.json");
}

/** Argus's record of the run's proposal. */
export function stagedVerificationPath(runId: string): string {
  return path.join(ruleVerificationDir(runId), "staged.json");
}

/** Create the run's verification directory so the agent can write into it. */
export async function ensureRuleVerificationDir(runId: string): Promise<string> {
  const dir = ruleVerificationDir(runId);
  await mkdir(dir, { recursive: true });
  return dir;
}

export type AgentVerificationFile =
  { kind: "none" } | { kind: "document"; text: string } | { kind: "unreadable"; reason: string };

/**
 * The agent's file, as written. `none` when it was never written — which on a
 * verification phase with selected rules is itself a refusal (silent omission
 * is the one thing completeness forbids), decided by the engine rather than
 * here.
 */
export async function readAgentVerification(runId: string): Promise<AgentVerificationFile> {
  if (!RUN_ID_RE.test(runId)) return { kind: "none" };
  const file = ruleVerificationFile(runId);
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    return { kind: "none" };
  }
  if (size > VERIFICATION_FILE_MAX_BYTES) {
    return {
      kind: "unreadable",
      reason: `the rule-verification file is ${size} bytes; the cap is ${VERIFICATION_FILE_MAX_BYTES}`,
    };
  }
  try {
    return { kind: "document", text: await readFile(file, "utf8") };
  } catch (e) {
    return {
      kind: "unreadable",
      reason: `the rule-verification file could not be read: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export async function writeVerificationRecord(record: RuleVerificationRecord): Promise<void> {
  await lock.withLock(record.runId, () =>
    atomicWriteJson(stagedVerificationPath(record.runId), record),
  );
}

/** The run's staged record, or null when the run staged nothing. */
export async function readVerificationRecord(
  runId: string,
): Promise<RuleVerificationRecord | null> {
  if (!RUN_ID_RE.test(runId)) return null;
  try {
    return JSON.parse(
      await readFile(stagedVerificationPath(runId), "utf8"),
    ) as RuleVerificationRecord;
  } catch {
    return null;
  }
}

/**
 * Move a record to a new status, serialized per run so the engine's paths
 * (intake, commit, retirement) cannot lose each other's writes. A record
 * already in a terminal status other than the requested one is left alone: an
 * `applied` verification is never demoted to `superseded` by a later sweep.
 */
export async function updateVerificationStatus(
  runId: string,
  status: RuleVerificationStatus,
  patch: Partial<Pick<RuleVerificationRecord, "reason" | "result">> & { at: string },
): Promise<RuleVerificationRecord | null> {
  return lock.withLock(runId, async () => {
    const current = await readVerificationRecord(runId);
    if (!current) return null;
    if (current.status !== "staged" && current.status !== status) return current;
    const next: RuleVerificationRecord = {
      ...current,
      status,
      updatedAt: patch.at,
      ...(patch.reason !== undefined ? { reason: patch.reason } : {}),
      ...(patch.result !== undefined ? { result: patch.result } : {}),
    };
    await atomicWriteJson(stagedVerificationPath(runId), next);
    return next;
  });
}

/** Every staged record, newest first by `receivedAt`. */
export async function readVerificationRecords(): Promise<RuleVerificationRecord[]> {
  let names: string[];
  try {
    names = await readdir(paths.ruleVerificationsDir());
  } catch {
    return [];
  }
  const records = await Promise.all(
    names.filter((n) => RUN_ID_RE.test(n)).map(readVerificationRecord),
  );
  return records
    .filter((r): r is RuleVerificationRecord => r !== null)
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
}

/** A record by its staging id. */
export async function readVerificationRecordById(
  id: string,
): Promise<RuleVerificationRecord | null> {
  return (await readVerificationRecords()).find((r) => r.id === id) ?? null;
}
