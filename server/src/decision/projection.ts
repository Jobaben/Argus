import type {
  DecisionProjection,
  DecisionSubject,
  DefinitionRef,
  PipelineInstance,
  RepositoryStateRef,
  Run,
  SnapshotContent,
  StoredSnapshot,
} from "@argus/contracts";
import type { KnowledgeLedger } from "../knowledge/kernel.js";
import { canonicalDigest, CanonicalJsonError } from "./canonical.js";

/**
 * Projections: how Argus builds the typed, bounded, redacted input an
 * assessment evaluates (RFC §F.2, §O.3).
 *
 * A builder reads **only** through `DecisionSources` — never the filesystem
 * directly — so the tests can hand it fixtures, and so "the source is gone"
 * is a first-class answer (`unavailable`) instead of an empty body that
 * would hash like a real one.
 */

/** Read-only access to the records projections and currency checks read. Null = unavailable. */
export interface DecisionSources {
  readRun(runId: string): Promise<Run | null>;
  /** The run's transcript lines; null when it has a session whose transcript is unavailable. */
  readTranscript(run: Run): Promise<unknown[] | null>;
  readInstance(instanceId: string): Promise<PipelineInstance | null>;
  readLedger(): Promise<KnowledgeLedger | null>;
  /** The repository state Argus can observe now for this subject; null = cannot tell. */
  repositoryState(
    subject: DecisionSubject,
    recorded: RepositoryStateRef,
  ): Promise<RepositoryStateRef | null>;
}

/** What a builder produces before sealing: everything except the projection stamp. */
export type ProjectedContent = Omit<SnapshotContent, "format" | "formatVersion" | "projection">;

export type BuildResult =
  | { ok: true; snapshot: StoredSnapshot }
  | {
      ok: false;
      reason: "source-unavailable" | "subject-mismatch" | "too-large" | "not-canonical";
      detail: string;
    };

export interface ProjectionBuilder {
  id: string;
  version: number;
  project(
    def: DecisionProjection,
    subject: DecisionSubject,
    sources: DecisionSources,
  ): Promise<
    | { ok: true; content: ProjectedContent }
    | { ok: false; reason: "source-unavailable" | "subject-mismatch"; detail: string }
  >;
}

/**
 * Seal projected content into a stored snapshot: stamp the projection, take
 * the canonical bytes, and hash and count exactly those bytes. Refuses (never
 * coerces) content that is not canonical JSON, and content over the
 * projection's own ceiling.
 */
export function sealSnapshot(
  projection: DefinitionRef,
  def: DecisionProjection,
  projected: ProjectedContent,
): BuildResult {
  const content: SnapshotContent = {
    format: "argus.decision-snapshot",
    formatVersion: 1,
    projection: { id: projection.id, version: projection.version, digest: projection.digest },
    ...projected,
  };
  let sealed: { text: string; sha256: string; bytes: number };
  try {
    sealed = canonicalDigest(content);
  } catch (e) {
    if (e instanceof CanonicalJsonError) {
      return { ok: false, reason: "not-canonical", detail: e.message };
    }
    throw e;
  }
  if (sealed.bytes > def.maxBytes) {
    return {
      ok: false,
      reason: "too-large",
      detail: `snapshot is ${sealed.bytes} bytes, over ${def.id}@${def.version}'s ${def.maxBytes}`,
    };
  }
  return {
    ok: true,
    snapshot: { sha256: sealed.sha256, bytes: sealed.bytes, content: JSON.parse(sealed.text) },
  };
}

export async function buildSnapshot(
  builder: ProjectionBuilder,
  projection: DefinitionRef,
  def: DecisionProjection,
  subject: DecisionSubject,
  sources: DecisionSources,
): Promise<BuildResult> {
  if (builder.id !== def.id || builder.version !== def.version) {
    return { ok: false, reason: "subject-mismatch", detail: "builder does not match projection" };
  }
  if (subject.kind !== def.subject) {
    return {
      ok: false,
      reason: "subject-mismatch",
      detail: `${def.id}@${def.version} projects a ${def.subject}, not a ${subject.kind}`,
    };
  }
  const projected = await builder.project(def, subject, sources);
  if (!projected.ok) return projected;
  return sealSnapshot(projection, def, projected.content);
}
