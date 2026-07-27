import { appendFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { paths } from "../claudeHome.js";
import { log } from "../log.js";

/**
 * The instance journal: an append-only record of everything that happened to a
 * pipeline run.
 *
 * The instance file is the *state*; it is rewritten in place, so it can tell
 * you a phase failed but never that it failed, retried, failed again and was
 * revised. The journal is the history, and it exists for three jobs:
 *
 * - **Crash resume.** After an unclean stop, the instance file is whatever the
 *   last atomic write left. The journal says what was in flight at that moment,
 *   which is the difference between "resume this phase" and "guess".
 * - **Explaining a run afterwards.** A retry that eventually succeeded looks,
 *   in the instance file, exactly like a run that succeeded first time.
 * - **Not being the source of truth.** Nothing reads the journal to decide what
 *   to do next. It is evidence, and a corrupt or missing journal costs you the
 *   history, never the pipeline.
 *
 * Append-only and per-instance, so writes never contend and a torn last line
 * (the only failure mode of an append) costs exactly one record.
 */

export type JournalKind =
  | "instance.started"
  | "phase.started"
  | "step.spawned"
  | "phase.signalled"
  | "phase.succeeded"
  | "phase.failed"
  | "phase.retry-scheduled"
  | "phase.retrying"
  | "phase.revised"
  | "phase.approved"
  | "instance.ended";

export interface JournalEntry {
  at: string;
  kind: JournalKind;
  phaseId?: string;
  runId?: string;
  detail?: string;
  /** Attempt number for phase-level entries. */
  attempt?: number;
}

/** Entries returned by a read. A journal longer than this has its head dropped. */
export const JOURNAL_READ_CAP = 500;

/** Past this size the file is rotated away rather than grown without bound. */
export const JOURNAL_MAX_BYTES = 512 * 1024;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function journalPath(instanceId: string): string | null {
  if (!ID_RE.test(instanceId)) return null;
  const base = path.join(paths.argus(), "journals");
  const file = path.resolve(base, `${instanceId}.jsonl`);
  // Belt and braces alongside the id check: the resolved path must still be a
  // direct child of the journals directory.
  return path.dirname(file) === path.resolve(base) ? file : null;
}

/**
 * Append one entry. Never throws: a journal write failing must not fail the
 * pipeline transition it was recording, because the transition is the part that
 * matters and the journal is the part that does not.
 */
export async function journal(instanceId: string, entry: JournalEntry): Promise<void> {
  const file = journalPath(instanceId);
  if (!file) return;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    // Rotate rather than truncate-in-place: a reader mid-read keeps a coherent
    // file, and the most recent history is the history worth keeping.
    try {
      if ((await stat(file)).size > JOURNAL_MAX_BYTES) await rm(file, { force: true });
    } catch {
      /* no file yet */
    }
    await appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (e) {
    log.error("journal append failed", { instanceId, err: e });
  }
}

/** The instance's history, oldest first, capped. Malformed lines are skipped. */
export async function readJournal(instanceId: string): Promise<JournalEntry[]> {
  const file = journalPath(instanceId);
  if (!file) return [];
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return [];
  }
  const out: JournalEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as JournalEntry;
      if (parsed && typeof parsed.at === "string" && typeof parsed.kind === "string") {
        out.push(parsed);
      }
    } catch {
      // A torn final line is the expected failure mode of an append; skip it.
    }
  }
  return out.slice(-JOURNAL_READ_CAP);
}

/** Drop an instance's journal, for when its instance record is pruned. */
export async function forgetJournal(instanceId: string): Promise<void> {
  const file = journalPath(instanceId);
  if (!file) return;
  await rm(file, { force: true }).catch(() => {});
}
