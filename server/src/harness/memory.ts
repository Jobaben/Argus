/**
 * Pipeline memory: durable, cross-instance notes one pipeline's own runs may
 * read and append to.
 *
 * Externalised state is how long-horizon work survives past any one instance
 * (see docs/HARNESS-RESEARCH.md §2 #6 and §4) — a retry already gets the
 * failing attempt's own reason back (`retryNote`), but nothing before this
 * carried anything from one *instance* to the next. `NOTES.md` is that
 * carrier: one plain-text file per pipeline, off by default, never created
 * until a pipeline opts in (`memory.enabled`) and never deleted by Argus (a
 * DELETE of the pipeline leaves it — see docs/HARNESS.md §13).
 *
 * Everything here is either a pure function (`summarizeInstance`, the
 * trimming) or a narrow, single-purpose bit of file I/O over one path; the
 * engine decides *when* to read, trim or journal, exactly as `workspace.ts`
 * does for worktrees.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { paths } from "../claudeHome.js";
import { safeSegment } from "./invocation.js";
import { utf8SliceSuffix } from "../sources/dag.js";
import type { PipelineInstance } from "../sources/pipelineTypes.js";

/** Default cap for `NOTES.md`, applied when `memory.maxBytes` is absent. */
export const DEFAULT_MEMORY_BYTES = 8 * 1024;

/** The directory `ARGUS_MEMORY_DIR` points at: everything this pipeline's
 *  runs may write notes into. `NOTES.md` is the one file Argus itself reads. */
export function memoryDirFor(pipelineId: string): string {
  return path.join(paths.memoryDir(), safeSegment(pipelineId));
}

export function memoryNotesPath(pipelineId: string): string {
  return path.join(memoryDirFor(pipelineId), "NOTES.md");
}

/** Create the directory (idempotent) so a child process can write into it
 *  from its very first turn, whether or not a previous run left notes. */
export async function ensureMemoryDir(pipelineId: string): Promise<string> {
  const dir = memoryDirFor(pipelineId);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * The text `{{memory}}` interpolates to: the tail of `NOTES.md`, up to
 * `maxBytes`. Empty when the file does not exist yet (a pipeline that just
 * turned memory on, or one whose first instance hasn't run) — never an error,
 * since "nothing written yet" is the ordinary starting state.
 */
export async function readMemoryNotes(pipelineId: string, maxBytes: number): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(memoryNotesPath(pipelineId), "utf8");
  } catch {
    return "";
  }
  return utf8SliceSuffix(raw, maxBytes);
}

/**
 * After an instance settles: if `NOTES.md` has grown past `maxBytes`, trim
 * its head (the oldest content) back down to the cap, on a line boundary, so
 * the file never grows without bound and the newest notes are always what
 * survives. A no-op (returns `false`) when the file is missing or already
 * within the cap — the common case, so most settlements cost one `stat`-ish
 * read and nothing else.
 */
export async function trimMemoryIfNeeded(pipelineId: string, maxBytes: number): Promise<boolean> {
  const file = memoryNotesPath(pipelineId);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return false;
  }
  if (Buffer.byteLength(raw, "utf8") <= maxBytes) return false;
  let tail = utf8SliceSuffix(raw, maxBytes);
  // Land on a line boundary: drop a partial leading line rather than starting
  // the kept notes mid-sentence. If the cap is smaller than the first
  // remaining line, keep the byte-accurate tail rather than trimming to
  // nothing.
  const nl = tail.indexOf("\n");
  if (nl !== -1 && nl < tail.length - 1) tail = tail.slice(nl + 1);
  await writeFile(file, tail, "utf8");
  return true;
}

/** Extract a payload's `reason` field, the same shape `PhaseFailurePayload`
 *  and a plain agent-reported failure both use. */
function reasonOf(payload: unknown): string | null {
  if (payload && typeof payload === "object" && "reason" in payload) {
    const r = (payload as { reason?: unknown }).reason;
    return typeof r === "string" && r.trim() ? r.trim() : null;
  }
  return null;
}

const SETTLED: PipelineInstance["status"][] = ["succeeded", "failed", "aborted"];

/** Is this instance done — one `summarizeInstance` (and `{{previous.instance}}`)
 *  may describe, as opposed to one still in flight? */
export function isSettled(inst: Pick<PipelineInstance, "status">): boolean {
  return SETTLED.includes(inst.status);
}

/**
 * A one-paragraph, plain-text summary of a settled instance: what
 * `{{previous.instance}}` interpolates to. Pure — the caller finds the
 * instance (the most recent settled one of the pipeline, before the current
 * one); this only describes it.
 *
 * Empty string for an instance that has not settled (nothing to summarize
 * yet) so a caller can pass `undefined`/an unsettled instance through
 * unconditionally and get the same "nothing to say" result as having found
 * none at all.
 */
export function summarizeInstance(inst: PipelineInstance): string {
  if (!isSettled(inst)) return "";
  const endedAt = inst.endedAt ?? inst.updatedAt;
  const parts = [`Previous run ${inst.status} (ended ${endedAt})`];

  const failed = inst.phases.find((p) => p.status === "failed");
  if (failed) {
    const reason = reasonOf(failed.payload);
    parts.push(`phase "${failed.name}" failed${reason ? `: ${reason}` : ""}`);
  }

  const withCandidate = inst.phases.find(
    (p) => p.selectedCandidate !== null && p.selectedCandidate !== undefined,
  );
  if (withCandidate) {
    parts.push(
      `phase "${withCandidate.name}" selected candidate ${withCandidate.selectedCandidate}`,
    );
  }

  return `${parts.join("; ")}.`;
}
