/**
 * Gated artifact review — the read side of a human gate.
 *
 * A gated phase parks at `awaiting-approval` with whatever files its agent left
 * in the attempt's artifact directory (`PhaseProgress.artifactDir`). Nothing
 * here is stored: the review is derived, per read, from the instance record and
 * a directory listing, so there is no second copy of the gate to drift.
 *
 * Every read is defensive. The directory is agent-writable and may hold
 * anything — thousands of files, symlinks out of the tree, binaries, a path
 * that resolves outside the directory — and none of that may turn into a
 * thrown error on the review route. A missing directory lists as empty.
 *
 * This module never writes. Approve and revise are engine transitions; the
 * viewer is read-only by design.
 */

import { open, readdir, lstat } from "node:fs/promises";
import path from "node:path";
import type { KnowledgeDeltaPreview } from "@argus/contracts";
import type {
  PhaseArtifact,
  PhaseArtifactContent,
  PhaseProgress,
  PhaseReview,
  PipelineDefinition,
  PipelineInstance,
} from "./pipelineTypes.js";
import { readDeltaRecord } from "../knowledge/staging.js";
import { readLedger } from "../knowledge/store.js";
import { checkDiscoveryDelta, previewKnowledgeDelta } from "../knowledge/discovery.js";
import { readInvocation } from "./runs.js";

/** Most files one review lists; past this the listing is `truncated`. */
export const ARTIFACT_LIST_CAP = 200;
/** Deepest directory nesting the listing descends into (the root is 0). */
export const ARTIFACT_LIST_DEPTH = 5;
/** Most bytes the viewer is handed for one file. */
export const ARTIFACT_READ_CAP = 512 * 1024;
/** Bytes sampled from each listed file to decide whether it is text. */
const TEXT_SAMPLE_BYTES = 8 * 1024;

/**
 * Resolve `rel` under `dir`, or null when it is absolute, empty, or escapes the
 * directory. Mirrors the containment rule the artifact checks apply.
 */
export function resolveArtifactPath(dir: string, rel: string): string | null {
  if (!rel || path.isAbsolute(rel) || path.posix.isAbsolute(rel) || rel.includes("\0")) return null;
  const resolved = path.resolve(dir, rel);
  const back = path.relative(dir, resolved);
  if (back === "" || back.startsWith("..") || path.isAbsolute(back)) return null;
  return resolved;
}

/** Backslashes to slashes and `.`/`..` segments collapsed, so a check's path
 *  and a listed path compare equal however they were spelled. */
function normalizeRel(rel: string): string {
  return path.posix.normalize(rel.replace(/\\/g, "/")).replace(/^\.\//, "");
}

/** UTF-8 without a NUL byte. A decoder in fatal mode rejects invalid bytes;
 *  `stream: true` forgives a multi-byte sequence cut off by the sample end. */
function looksLikeText(sample: Buffer): boolean {
  if (sample.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample, { stream: true });
    return true;
  } catch {
    return false;
  }
}

async function readHead(file: string, max: number): Promise<Buffer> {
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(max);
    const { bytesRead } = await fh.read(buf, 0, max, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/**
 * Every regular file under `dir`, sorted by path, to the depth and count caps.
 * Symlinks are skipped: the directory is agent-writable, and a link to a file
 * elsewhere is not an artifact the phase produced.
 */
export async function listPhaseArtifacts(
  dir: string | null | undefined,
  requiredPaths: readonly string[],
): Promise<{ artifacts: PhaseArtifact[]; truncated: boolean }> {
  if (!dir) return { artifacts: [], truncated: false };
  const root = dir;
  const required = new Set(requiredPaths.map(normalizeRel));
  const files: { rel: string; abs: string }[] = [];
  let truncated = false;

  async function walk(sub: string, depth: number): Promise<void> {
    if (truncated) return;
    let names: string[];
    try {
      names = (await readdir(path.join(root, sub))).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (files.length >= ARTIFACT_LIST_CAP) {
        truncated = true;
        return;
      }
      const rel = sub ? `${sub}/${name}` : name;
      const abs = path.join(root, rel);
      let st;
      try {
        st = await lstat(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (depth < ARTIFACT_LIST_DEPTH) await walk(rel, depth + 1);
      } else if (st.isFile()) {
        files.push({ rel, abs });
      }
    }
  }
  await walk("", 0);

  const artifacts: PhaseArtifact[] = [];
  for (const { rel, abs } of files) {
    try {
      const st = await lstat(abs);
      const sample = st.size === 0 ? Buffer.alloc(0) : await readHead(abs, TEXT_SAMPLE_BYTES);
      artifacts.push({
        path: rel,
        bytes: st.size,
        modifiedAt: st.mtime.toISOString(),
        required: required.has(rel),
        text: looksLikeText(sample),
      });
    } catch {
      // Removed between the walk and the stat: not an artifact any more.
    }
  }
  return { artifacts, truncated };
}

/** One file's head for the viewer, or null when it is absent or not a regular file. */
export async function readPhaseArtifact(
  dir: string | null | undefined,
  rel: string,
): Promise<PhaseArtifactContent | null> {
  if (!dir) return null;
  const abs = resolveArtifactPath(dir, rel);
  if (abs === null) return null;
  let st;
  try {
    st = await lstat(abs);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  const truncated = st.size > ARTIFACT_READ_CAP;
  const head = st.size === 0 ? Buffer.alloc(0) : await readHead(abs, ARTIFACT_READ_CAP);
  const text = looksLikeText(head.subarray(0, TEXT_SAMPLE_BYTES));
  const base = {
    path: normalizeRel(rel),
    bytes: st.size,
    modifiedAt: st.mtime.toISOString(),
    text,
    truncated,
  };
  if (!text) return base;
  return {
    ...base,
    // Not fatal: a bad byte past the sample renders as U+FFFD rather than
    // failing the whole view. `stream` on a clipped read drops the partial
    // trailing sequence instead of showing a replacement character.
    content: new TextDecoder("utf-8", { fatal: false }).decode(head, { stream: truncated }),
  };
}

export type ReviewResult =
  { ok: true; review: PhaseReview } | { ok: false; code: 404 | 409; error: string };

/**
 * The review for one paused phase. `def` is the definition the instance runs
 * against — its snapshot when it has one — and supplies which paths its
 * `kind: "artifact"` checks required.
 */
export async function buildPhaseReview(
  inst: PipelineInstance,
  phaseId: string,
  def: PipelineDefinition | undefined,
): Promise<ReviewResult> {
  const phase = inst.phases.find((p) => p.id === phaseId);
  if (!phase) return { ok: false, code: 404, error: `unknown phase "${phaseId}"` };
  if (phase.status !== "awaiting-approval" && phase.status !== "failed") {
    return {
      ok: false,
      code: 409,
      error: `phase "${phaseId}" is ${phase.status}, not waiting on you`,
    };
  }
  const phaseDef = def?.phases.find((p) => p.id === phaseId);
  const requiredPaths = (phaseDef?.checks ?? [])
    .filter((c) => c.kind === "artifact")
    .map((c) => c.path);
  const { artifacts, truncated } = await listPhaseArtifacts(phase.artifactDir, requiredPaths);
  const knowledge = await previewStagedKnowledge(phase, phaseDef);
  const review: PhaseReview = {
    instanceId: inst.id,
    phaseId,
    phaseName: phase.name,
    pipelineName: inst.pipelineName,
    status: phase.status,
    attempt: phase.attempt,
    canApprove: phase.status === "awaiting-approval",
    payload: phase.payload ?? null,
    ...(phase.result === undefined ? {} : { result: phase.result }),
    ...(phase.verification === undefined ? {} : { verification: phase.verification }),
    artifactDir: phase.artifactDir ?? null,
    artifacts,
    ...(truncated ? { truncated } : {}),
    ...(knowledge.length ? { knowledge } : {}),
    ...(phase.discovery ? { discovery: phase.discovery } : {}),
  };
  return { ok: true, review };
}

/**
 * The candidate knowledge this attempt staged, as the gate shows it
 * (Phase 5 §review surface).
 *
 * A gated discovery phase's real output is a KnowledgeDelta, not a file. Left
 * to the artifact listing, a reviewer's only way to see what rules an agent
 * proposed would be to open the transcript — which is exactly the failure
 * mode the Knowledge Ledger exists to remove. So the staged deltas of *this
 * attempt* are projected into the review: the proposed rules, the evidence
 * under each one, what a revision would replace, and every deterministic
 * warning.
 *
 * Three properties, all deliberate:
 *
 * - **Nothing here is canonical.** The preview is a read model of a staged
 *   proposal; approving is what makes it real, and a proposed claim is shown
 *   as `local:<label>` precisely so nobody reads a canonical id into it.
 * - **This attempt only.** A record staged for an earlier attempt (revised,
 *   retried) is skipped: it can never become canonical, and showing it beside
 *   the live candidates would invite approving the wrong thing.
 * - **It never fails the review.** A ledger that cannot be read, a record
 *   that has been pruned — the review still renders, with whatever it could
 *   gather. A gate that 500s because a preview could not be built would be a
 *   worse outcome than a gate with no preview.
 */
async function previewStagedKnowledge(
  phase: PhaseProgress,
  phaseDef: PipelineDefinition["phases"][number] | undefined,
): Promise<KnowledgeDeltaPreview[]> {
  const steps = phase.steps.filter((s) => s.runId && s.knowledgeDelta);
  if (steps.length === 0) return [];
  let ledger = null;
  try {
    ledger = await readLedger();
  } catch {
    ledger = null;
  }
  const out: KnowledgeDeltaPreview[] = [];
  for (const step of steps) {
    const record = await readDeltaRecord(step.runId!);
    if (!record?.delta || record.attempt !== phase.attempt) continue;
    let warnings;
    if (phaseDef?.discovery) {
      const invocation = await readInvocation(step.runId!);
      const verdict = await checkDiscoveryDelta(
        record.delta,
        ledger,
        {
          policy: phaseDef.discovery,
          repoRoot: invocation?.workspace?.path ?? invocation?.cwd ?? phaseDef.cwd ?? null,
          gitHead: invocation?.gitHead ?? null,
        },
        record.supplied,
      );
      warnings = verdict.warnings;
    }
    out.push(previewKnowledgeDelta(record, ledger, warnings));
  }
  return out;
}
