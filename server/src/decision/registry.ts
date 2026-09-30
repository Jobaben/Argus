import type {
  AnswerSpace,
  DecisionProjection,
  DecisionQuestion,
  DefinitionRef,
} from "@argus/contracts";
import { canonicalDigest } from "./canonical.js";

/**
 * The immutable, versioned question and projection registry (RFC §F.2, §O.4).
 *
 * - **Immutable.** A registered definition is deep-copied and frozen; callers
 *   cannot edit it afterwards, and lookups hand back the frozen copy.
 * - **Versioned, with history.** Every version stays registered, so an
 *   assessment written against v1 can still be interpreted after v2 exists.
 *   "Latest" is the highest version, never the most recently registered.
 * - **Conflicts are refused.** Registering an `id@version` again with a
 *   different definition (by canonical digest) throws; the identical
 *   definition is an idempotent no-op.
 * - **No consumers in Phase 1.** A question that declares a consumer is
 *   refused: nothing may read an assessment as a policy input yet.
 *
 * Each definition's digest (sha256 of its canonical JSON) is what an
 * assessment records next to the version, so a definition edited in code
 * without a version bump is detectable rather than silently "the same".
 */

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

const SLUG_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object") {
    for (const child of Object.values(v)) deepFreeze(child);
    Object.freeze(v);
  }
  return v;
}

function checkVersion(kind: string, id: string, version: number): void {
  if (!SLUG_RE.test(id)) throw new RegistryError(`${kind} id "${id}" is not a slug`);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new RegistryError(`${kind} ${id}: version must be a positive integer`);
  }
}

function checkAnswerSpace(q: DecisionQuestion): void {
  const space: AnswerSpace = q.answers;
  const where = `question ${q.id}@${q.version}`;
  if (space.shape === "binary") return;
  if (space.shape !== "choice" && space.shape !== "scale") {
    throw new RegistryError(`${where}: unknown answer shape`);
  }
  if (
    typeof space.sumTolerance !== "number" ||
    !Number.isFinite(space.sumTolerance) ||
    space.sumTolerance < 0 ||
    space.sumTolerance >= 0.5
  ) {
    throw new RegistryError(`${where}: sumTolerance must be finite and in [0, 0.5)`);
  }
  const keys =
    space.shape === "choice"
      ? space.options.map((o) => {
          if (!SLUG_RE.test(o.id))
            throw new RegistryError(`${where}: option "${o.id}" is not a slug`);
          if (typeof o.label !== "string" || !o.label) {
            throw new RegistryError(`${where}: option "${o.id}" has no label`);
          }
          return o.id;
        })
      : space.points.map((p) => {
          if (typeof p.value !== "number" || !Number.isFinite(p.value) || Object.is(p.value, -0)) {
            throw new RegistryError(`${where}: scale point ${String(p.value)} is not finite`);
          }
          return String(p.value);
        });
  if (keys.length < 2)
    throw new RegistryError(`${where}: a closed space needs two or more answers`);
  if (new Set(keys).size !== keys.length) throw new RegistryError(`${where}: duplicate answers`);
}

function checkQuestion(q: DecisionQuestion): void {
  checkVersion("question", q.id, q.version);
  if (typeof q.text !== "string" || !q.text.trim()) {
    throw new RegistryError(`question ${q.id}@${q.version}: no text`);
  }
  checkAnswerSpace(q);
  checkVersion("projection", q.projection.id, q.projection.version);
  if (!Array.isArray(q.consumers) || q.consumers.length > 0) {
    throw new RegistryError(
      `question ${q.id}@${q.version}: Phase 1 questions declare no consumers (got ${JSON.stringify(q.consumers)})`,
    );
  }
}

function checkProjection(p: DecisionProjection): void {
  checkVersion("projection", p.id, p.version);
  if (!Number.isSafeInteger(p.maxBytes) || p.maxBytes < 1) {
    throw new RegistryError(`projection ${p.id}@${p.version}: maxBytes must be a positive integer`);
  }
}

interface Entry<T> {
  def: T;
  digest: string;
}

export interface DecisionRegistry {
  registerQuestion(q: DecisionQuestion): DefinitionRef;
  registerProjection(p: DecisionProjection): DefinitionRef;
  /** A specific version, historical or current; null when never registered. */
  question(id: string, version: number): { def: DecisionQuestion; ref: DefinitionRef } | null;
  latestQuestion(id: string): { def: DecisionQuestion; ref: DefinitionRef } | null;
  projection(id: string, version: number): { def: DecisionProjection; ref: DefinitionRef } | null;
  /** Every registered question version, sorted by id then version. */
  questions(): DefinitionRef[];
}

export function createRegistry(): DecisionRegistry {
  const questions = new Map<string, Map<number, Entry<DecisionQuestion>>>();
  const projections = new Map<string, Map<number, Entry<DecisionProjection>>>();

  function register<T extends { id: string; version: number }>(
    kind: string,
    table: Map<string, Map<number, Entry<T>>>,
    def: T,
  ): DefinitionRef {
    // Canonicalising first also refuses anything that is not plain JSON.
    const { text, sha256 } = canonicalDigest(def);
    const versions = table.get(def.id) ?? new Map<number, Entry<T>>();
    const existing = versions.get(def.version);
    if (existing) {
      if (existing.digest !== sha256) {
        throw new RegistryError(
          `${kind} ${def.id}@${def.version} is already registered with a different definition`,
        );
      }
      return { id: def.id, version: def.version, digest: sha256 };
    }
    versions.set(def.version, { def: deepFreeze(JSON.parse(text) as T), digest: sha256 });
    table.set(def.id, versions);
    return { id: def.id, version: def.version, digest: sha256 };
  }

  function lookup<T extends { id: string; version: number }>(
    table: Map<string, Map<number, Entry<T>>>,
    id: string,
    version: number,
  ): { def: T; ref: DefinitionRef } | null {
    const e = table.get(id)?.get(version);
    return e ? { def: e.def, ref: { id, version, digest: e.digest } } : null;
  }

  return {
    registerQuestion(q) {
      checkQuestion(q);
      const projection = lookup(projections, q.projection.id, q.projection.version);
      if (!projection) {
        throw new RegistryError(
          `question ${q.id}@${q.version}: projection ${q.projection.id}@${q.projection.version} is not registered`,
        );
      }
      if (projection.def.subject !== q.subject) {
        throw new RegistryError(
          `question ${q.id}@${q.version} is about a ${q.subject}, but its projection builds a ${projection.def.subject}`,
        );
      }
      return register("question", questions, q);
    },
    registerProjection(p) {
      checkProjection(p);
      return register("projection", projections, p);
    },
    question: (id, version) => lookup(questions, id, version),
    latestQuestion(id) {
      const versions = questions.get(id);
      if (!versions || versions.size === 0) return null;
      return lookup(questions, id, Math.max(...versions.keys()));
    },
    projection: (id, version) => lookup(projections, id, version),
    questions() {
      const out: DefinitionRef[] = [];
      for (const id of [...questions.keys()].sort()) {
        const versions = questions.get(id)!;
        for (const v of [...versions.keys()].sort((a, b) => a - b)) {
          out.push({ id, version: v, digest: versions.get(v)!.digest });
        }
      }
      return out;
    },
  };
}
