/**
 * The instance projection a transition log records and replays.
 *
 * A transition record has to fit in a small, bounded line, and an instance
 * does not: its definition snapshot carries every prompt, a webhook trigger
 * payload may be 64 KiB, and an agent's closing message lands in a phase's
 * payload verbatim. So the log does not try to reproduce the instance byte for
 * byte. It reproduces a *projection* of it, in which those values are kept by
 * digest — `{ $elided: sha256, bytes }` — and everything that is pipeline state
 * (statuses, attempts, run ids, retry times, gate links, completion and signal
 * provenance, staged-record ids) is kept as it is.
 *
 * That is what replay can honestly promise: the fold of a log equals the
 * projection of the instance it describes, and a mismatch in an elided value
 * still shows up as a different digest. It cannot rebuild an agent's message
 * from the log, and does not pretend to.
 *
 * Pure: no I/O, no clock.
 */
import { canonicalJson, sha256Hex } from "../durable/canonical.js";
import type { ElidedValue, ProjectionOp, ProjectionPath } from "@argus/contracts";

/** Always kept by digest: large, immutable for the instance's life, and held
 *  in full by the instance file itself. */
const ALWAYS_ELIDED = new Set(["definition", "triggerPayload"]);

/** Keys whose values are agent- or operator-supplied documents: kept by
 *  digest once their canonical form exceeds {@link OPAQUE_MAX_BYTES}. */
const OPAQUE_KEYS = new Set(["payload", "result", "answers", "value", "artifacts"]);
export const OPAQUE_MAX_BYTES = 1024;
/** Any string longer than this (check output, an error, a reason) is kept by digest. */
export const STRING_MAX_CHARS = 512;

/** Fields of the instance that describe the log rather than the pipeline. */
const NOT_PROJECTED = new Set(["transitionLog"]);

export type Projection = Record<string, unknown>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function isElided(v: unknown): v is ElidedValue {
  return (
    isPlainObject(v) &&
    typeof v.$elided === "string" &&
    typeof v.bytes === "number" &&
    Object.keys(v).length === 2
  );
}

/** Canonical bytes of a JSON value; a value canonical JSON refuses (deeper
 *  than 64 levels, say) falls back to plain JSON under a distinct prefix, so
 *  it still has a stable digest rather than breaking the log. */
function bytesOf(v: unknown): string {
  try {
    return canonicalJson(v);
  } catch {
    return `noncanonical:${JSON.stringify(v)}`;
  }
}

export function elide(v: unknown): ElidedValue {
  const text = bytesOf(v);
  return { $elided: sha256Hex(text), bytes: Buffer.byteLength(text, "utf8") };
}

/** `depth` 1 = a field of the instance itself. */
function project(v: unknown, key: string | number | null, depth: number): unknown {
  if (depth === 1 && typeof key === "string" && ALWAYS_ELIDED.has(key)) return elide(v);
  if (typeof key === "string" && OPAQUE_KEYS.has(key) && v !== null && v !== undefined) {
    if (Buffer.byteLength(bytesOf(v), "utf8") > OPAQUE_MAX_BYTES) return elide(v);
  }
  if (typeof v === "string") return v.length > STRING_MAX_CHARS ? elide(v) : v;
  if (Array.isArray(v)) return v.map((x, i) => project(x, i, depth + 1));
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (depth === 0 && NOT_PROJECTED.has(k)) continue;
      out[k] = project(x, k, depth + 1);
    }
    return out;
  }
  return v;
}

/**
 * The projection of an instance, as it is published: computed from its JSON
 * form, so `undefined` properties vanish exactly as they do on disk.
 */
export function projectInstance(inst: unknown): Projection {
  const json = JSON.parse(JSON.stringify(inst)) as unknown;
  if (!isPlainObject(json)) throw new Error("an instance must be a JSON object");
  return project(json, null, 0) as Projection;
}

/** SHA-256 of a projection's canonical form. */
export function projectionDigest(p: unknown): string {
  return sha256Hex(bytesOf(p));
}

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((x, i) => equal(x, b[i]));
  }
  if (isPlainObject(a)) {
    if (!isPlainObject(b)) return false;
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && equal(a[k], b[k]));
  }
  return false;
}

/**
 * The changes from one projection to another. Objects are compared key by
 * key; an array keeps its elements' identities only while its length does
 * (a phase list never changes length; a step list is replaced whole when an
 * attempt restarts, and is recorded that way). Deterministic: keys in
 * sorted order, deletions before additions.
 */
export function diffProjection(before: unknown, after: unknown): ProjectionOp[] {
  const ops: ProjectionOp[] = [];
  walk(before, after, [], ops);
  return ops;
}

function walk(a: unknown, b: unknown, path: ProjectionPath, ops: ProjectionOp[]): void {
  if (equal(a, b)) return;
  if (isPlainObject(a) && isPlainObject(b) && !isElided(a) && !isElided(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const k of keys) if (!(k in b)) ops.push({ op: "delete", path: [...path, k] });
    for (const k of keys) {
      if (!(k in b)) continue;
      if (!(k in a)) ops.push({ op: "set", path: [...path, k], value: b[k] });
      else walk(a[k], b[k], [...path, k], ops);
    }
    return;
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    for (let i = 0; i < a.length; i++) walk(a[i], b[i], [...path, i], ops);
    return;
  }
  ops.push({ op: "set", path, value: b });
}

export class ReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayError";
  }
}

/** Apply changes to a copy of a projection. Strict: a change whose parent
 *  does not exist is an error, never an implicit creation. */
export function applyOps(state: unknown, ops: readonly ProjectionOp[]): unknown {
  let root = structuredClone(state);
  for (const op of ops) {
    if (op.path.length === 0) {
      if (op.op === "delete") throw new ReplayError("cannot delete the whole projection");
      root = structuredClone(op.value);
      continue;
    }
    let parent: unknown = root;
    for (const seg of op.path.slice(0, -1)) {
      if (Array.isArray(parent) && typeof seg === "number" && seg >= 0 && seg < parent.length) {
        parent = parent[seg];
      } else if (isPlainObject(parent) && typeof seg === "string" && seg in parent) {
        parent = parent[seg];
      } else {
        throw new ReplayError(`no ${formatPath(op.path)}: missing parent at "${String(seg)}"`);
      }
    }
    const last = op.path[op.path.length - 1];
    if (Array.isArray(parent) && typeof last === "number") {
      if (op.op === "delete" || last < 0 || last >= parent.length) {
        throw new ReplayError(`cannot ${op.op} array element ${formatPath(op.path)}`);
      }
      parent[last] = structuredClone(op.value);
    } else if (isPlainObject(parent) && typeof last === "string") {
      if (op.op === "delete") {
        if (!(last in parent)) throw new ReplayError(`nothing to delete at ${formatPath(op.path)}`);
        delete parent[last];
      } else {
        parent[last] = structuredClone(op.value);
      }
    } else {
      throw new ReplayError(`cannot ${op.op} ${formatPath(op.path)}`);
    }
  }
  return root;
}

export function formatPath(path: ProjectionPath): string {
  return path.length === 0
    ? "/"
    : path.map((p) => `/${String(p).replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
}

/**
 * A pure view of every pipeline *status* field of an instance — the instance
 * status, each phase's status, attempt, pause and retry time, each step's run
 * id and status, and the gate operation in flight. These are the fields a
 * transition must account for; a run record's status, a verification report's
 * status or a Verdict's are not pipeline state and are deliberately absent.
 */
export function statusView(inst: {
  status?: unknown;
  pendingGateOperation?: { decisionId?: unknown } | null;
  phases?: Array<{
    id: string;
    status?: unknown;
    attempt?: unknown;
    pause?: unknown;
    retryAt?: unknown;
    steps?: Array<{ runId?: unknown; status?: unknown }>;
  }>;
}): Record<string, string> {
  const view: Record<string, string> = {
    status: String(inst.status),
    gateOperation: String(inst.pendingGateOperation?.decisionId ?? "none"),
  };
  for (const p of inst.phases ?? []) {
    view[`phase:${p.id}`] = [p.status, p.attempt, p.pause ?? "-", p.retryAt ?? "-"].join("|");
    (p.steps ?? []).forEach((s, i) => {
      view[`step:${p.id}#${i}`] = `${String(s.runId ?? "-")}|${String(s.status)}`;
    });
  }
  return view;
}

/** The keys of two status views whose values differ, sorted. */
export function changedStatusKeys(
  before: Record<string, string>,
  after: Record<string, string>,
): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort()
    .filter((k) => before[k] !== after[k]);
}

/** Keys of a status view that differ between two views. */
export function statusChanges(
  before: Record<string, string>,
  after: Record<string, string>,
): string[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys
    .filter((k) => before[k] !== after[k])
    .map((k) => `${k}: ${before[k] ?? "(none)"} → ${after[k] ?? "(none)"}`);
}
