import path from "node:path";
import type { DecisionAssessment, StoredSnapshot } from "@argus/contracts";
import { KeyedMutex } from "../mutex.js";
import { canonicalJson, sha256Hex, SHA256_RE } from "./canonical.js";
import {
  appendLines,
  encodeLine,
  layout,
  list,
  parseLines,
  publishFile,
  readBytes,
  readText,
  removeFile,
  segmentId,
  segmentSeq,
  syncDir,
  TORN_MARKER,
  tornPrefix,
  type FaultHook,
  type Layout,
  type Store,
} from "./storage.js";
import { mkdir, open } from "node:fs/promises";

/**
 * The Decision Journal: append-only, segmented, with retained
 * content-addressed snapshots, a manifest, explicit archival and explicit,
 * tombstoned deletion (RFC §F.3–§F.4, §O.2–§O.3).
 *
 * It is a separate store. It is not `gate-decisions.jsonl`, not
 * `knowledge.json` and not the Vault, and nothing in the ledger reads it.
 *
 * **Concurrency.** Every operation runs under one in-process `KeyedMutex`
 * keyed by the resolved root. This is the repository's own primitive, and
 * the same discipline `gate-decisions.jsonl` uses. The guarantee therefore
 * assumes one writing process, the Argus server. Two writing processes are
 * not excluded.
 *
 * **Caches.** Each journal object caches what it last loaded from disk. A
 * per-root epoch, bumped by every mutation, invalidates the other objects in
 * the process, and a failed operation invalidates the object's own cache. The
 * next operation then reloads from disk and runs recovery, exactly as a
 * restarted process would.
 *
 * **What is demonstrated.** Deterministic fault injection (`fault`) and fresh
 * readers show *logical* recovery at every step boundary below. They do not
 * show power-loss durability, and they do not show protection against a
 * same-OS-user process editing the files.
 */

export interface JournalLimits {
  segmentMaxBytes: number;
  segmentMaxAgeMs: number;
  snapshotMaxBytes: number;
  /** Active segments + active snapshots. The manifest is outside it (§O.2). */
  activeMaxBytes: number;
}

export const DEFAULT_JOURNAL_LIMITS: Readonly<JournalLimits> = Object.freeze({
  segmentMaxBytes: 4 * 1024 * 1024,
  segmentMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
  snapshotMaxBytes: 256 * 1024,
  activeMaxBytes: 64 * 1024 * 1024,
});

export type JournalErrorCode =
  | "active-storage-full"
  | "snapshot-too-large"
  | "record-too-large"
  | "invalid"
  | "conflict"
  | "unknown-segment"
  | "not-archived"
  | "unreadable-references";

export class JournalError extends Error {
  constructor(
    readonly code: JournalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "JournalError";
  }
}

export const ASSESSMENT_ID_RE = /^DA-[A-Za-z0-9_-]{6,80}$/;

// ── Read model ──────────────────────────────────────────────────────────────

export interface JournalEntry {
  segment: string;
  line: number;
  digest: string;
  assessment: DecisionAssessment;
}

export type JournalNoticeKind =
  | "torn-tail"
  | "recovered-torn-write"
  | "corrupt-line"
  | "malformed-record"
  | "missing-header"
  | "duplicate"
  | "conflict"
  | "copy-mismatch"
  | "deletion-incomplete"
  | "unexpected-file"
  | "manifest-damage";

export interface JournalNotice {
  kind: JournalNoticeKind;
  segment?: string;
  line?: number;
  detail: string;
}

export interface JournalGap {
  segment: string;
  reason: "deleted" | "missing";
  /** From the tombstone, when deleted. */
  records: number | null;
  firstAt: string | null;
  lastAt: string | null;
}

export interface SegmentView {
  segment: string;
  /** Where the copy that was read lives. Physical, so replay never reports it. */
  store: Store;
  sealed: boolean;
  records: number;
}

export interface JournalView {
  segments: SegmentView[];
  entries: JournalEntry[];
  gaps: JournalGap[];
  notices: JournalNotice[];
}

export type SnapshotLookup =
  | { status: "retained"; snapshot: StoredSnapshot; store: Store }
  | { status: "unavailable" }
  | { status: "corrupt"; detail: string };

// ── Manifest ────────────────────────────────────────────────────────────────

interface SealEntry {
  segment: string;
  records: number;
  bytes: number;
  sha256: string;
  firstAt: string | null;
  lastAt: string | null;
  reason: "size" | "age" | "archive" | "recovered";
  at: string;
}

interface Tombstone {
  segment: string;
  sha256: string;
  records: number;
  firstAt: string | null;
  lastAt: string | null;
  deletedSnapshots: string[];
  retainedSnapshots: string[];
  operator: string;
  reason: string;
  at: string;
}

interface Manifest {
  seals: Map<string, SealEntry>;
  archived: Set<string>;
  tombstones: Map<string, Tombstone>;
  notices: JournalNotice[];
  bytes: number;
}

async function readManifest(l: Layout): Promise<Manifest> {
  const m: Manifest = {
    seals: new Map(),
    archived: new Set(),
    tombstones: new Map(),
    notices: [],
    bytes: 0,
  };
  const text = await readText(l.manifestPath());
  if (text === null) return m;
  m.bytes = Buffer.byteLength(text, "utf8");
  const parsed = parseLines(text);
  for (const line of parsed.lines) {
    if (!line.ok) {
      if (!parsed.recoveredTorn.has(line.line)) {
        m.notices.push({ kind: "manifest-damage", line: line.line, detail: line.problem });
      }
      continue;
    }
    if (line.kind === TORN_MARKER || line.kind === "snapshots-archived") continue;
    const b = line.body as Record<string, unknown>;
    const seg = typeof b?.segment === "string" && segmentSeq(b.segment) ? b.segment : null;
    if (!seg) {
      m.notices.push({ kind: "manifest-damage", line: line.line, detail: "no segment id" });
      continue;
    }
    if (line.kind === "seal") m.seals.set(seg, b as unknown as SealEntry);
    else if (line.kind === "archive") m.archived.add(seg);
    else if (line.kind === "tombstone") m.tombstones.set(seg, b as unknown as Tombstone);
    else m.notices.push({ kind: "manifest-damage", line: line.line, detail: `kind ${line.kind}` });
  }
  if (parsed.tornTail > 0) {
    m.notices.push({
      kind: "manifest-damage",
      detail: `torn final line (${parsed.tornTail} bytes)`,
    });
  }
  return m;
}

// ── Segment parsing ─────────────────────────────────────────────────────────

function isAssessment(v: unknown): v is DecisionAssessment {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  const q = a.question as Record<string, unknown> | undefined;
  const s = a.snapshot as Record<string, unknown> | undefined;
  const p = a.provider as Record<string, unknown> | undefined;
  const o = a.outcome as Record<string, unknown> | undefined;
  return (
    typeof a.id === "string" &&
    ASSESSMENT_ID_RE.test(a.id) &&
    !!q &&
    typeof q.id === "string" &&
    typeof q.version === "number" &&
    typeof q.digest === "string" &&
    !!s &&
    typeof s.sha256 === "string" &&
    SHA256_RE.test(s.sha256) &&
    typeof s.bytes === "number" &&
    !!p &&
    typeof p.provider === "string" &&
    !!o &&
    typeof o.status === "string" &&
    !!a.subject &&
    typeof a.createdAt === "string" &&
    typeof a.sample === "number"
  );
}

interface ParsedSegment {
  entries: JournalEntry[];
  notices: JournalNotice[];
  openedAt: string | null;
  refs: Set<string>;
  /** Unreadable interior lines: they might reference a snapshot. */
  corrupt: number;
  tornTail: number;
  firstAt: string | null;
  lastAt: string | null;
}

function parseSegment(id: string, text: string): ParsedSegment {
  const parsed = parseLines(text);
  const out: ParsedSegment = {
    entries: [],
    notices: [],
    openedAt: null,
    refs: new Set(),
    corrupt: 0,
    tornTail: parsed.tornTail,
    firstAt: null,
    lastAt: null,
  };
  let first = true;
  for (const line of parsed.lines) {
    if (!line.ok) {
      if (parsed.recoveredTorn.has(line.line)) {
        out.notices.push({
          kind: "recovered-torn-write",
          segment: id,
          line: line.line,
          detail: "an interrupted write, followed by a torn marker",
        });
      } else {
        out.corrupt++;
        out.notices.push({
          kind: "corrupt-line",
          segment: id,
          line: line.line,
          detail: line.problem,
        });
      }
      first = false;
      continue;
    }
    if (line.kind === "segment-open") {
      const b = line.body as { segment?: unknown; openedAt?: unknown };
      if (first && b.segment === id && typeof b.openedAt === "string") out.openedAt = b.openedAt;
      else {
        out.notices.push({
          kind: "malformed-record",
          segment: id,
          line: line.line,
          detail: "misplaced header",
        });
      }
    } else if (line.kind === "assessment") {
      if (!isAssessment(line.body)) {
        out.corrupt++;
        out.notices.push({
          kind: "malformed-record",
          segment: id,
          line: line.line,
          detail: "not an assessment",
        });
      } else {
        const a = line.body;
        out.entries.push({ segment: id, line: line.line, digest: line.digest, assessment: a });
        out.refs.add(a.snapshot.sha256);
        if (!out.firstAt || a.createdAt < out.firstAt) out.firstAt = a.createdAt;
        if (!out.lastAt || a.createdAt > out.lastAt) out.lastAt = a.createdAt;
      }
    } else if (line.kind !== TORN_MARKER) {
      out.notices.push({
        kind: "malformed-record",
        segment: id,
        line: line.line,
        detail: `kind ${line.kind}`,
      });
    }
    first = false;
  }
  if (out.openedAt === null) {
    out.notices.push({ kind: "missing-header", segment: id, detail: "no segment-open header" });
  }
  if (parsed.tornTail > 0) {
    out.notices.push({
      kind: "torn-tail",
      segment: id,
      detail: `${parsed.tornTail} bytes after the last newline: an unacknowledged write`,
    });
  }
  return out;
}

// ── State ───────────────────────────────────────────────────────────────────

interface ActiveSegment {
  id: string;
  seq: number;
  bytes: number;
  sealed: boolean;
  openedAt: string | null;
  refs: Set<string>;
  endsMidLine: boolean;
}

interface State {
  epoch: number;
  active: Map<string, ActiveSegment>;
  archiveSegments: Set<string>;
  activeSnapshots: Map<string, number>;
  archiveSnapshots: Set<string>;
  /** Assessment id → record digest, over active segments. */
  ids: Map<string, { digest: string; segment: string }>;
  activeBytes: number;
  maxSeq: number;
}

const locks = new KeyedMutex();
const epochs = new Map<string, number>();

export interface JournalOptions {
  root: string;
  limits?: Partial<JournalLimits>;
  now?: () => Date;
  /** Called at each step boundary; throwing simulates the process failing there. */
  fault?: FaultHook;
}

export interface AppendResult {
  status: "appended" | "duplicate";
  segment: string;
}

export interface ArchiveResult {
  segments: string[];
  snapshots: string[];
  skipped: Array<{ segment: string; reason: string }>;
}

export interface DeleteResult {
  segment: string;
  deletedSnapshots: string[];
  retainedSnapshots: string[];
}

export interface Usage {
  activeBytes: number;
  limits: JournalLimits;
  manifestBytes: number;
  activeSegments: number;
  activeSnapshots: number;
}

export class DecisionJournal {
  readonly layout: Layout;
  readonly limits: JournalLimits;
  private readonly now: () => Date;
  private readonly fault: FaultHook;
  private state: State | null = null;

  constructor(opts: JournalOptions) {
    this.layout = layout(opts.root);
    this.limits = { ...DEFAULT_JOURNAL_LIMITS, ...opts.limits };
    for (const [k, v] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(v) || v < 1)
        throw new Error(`journal limit ${k} must be a positive integer`);
    }
    if (this.limits.snapshotMaxBytes > this.limits.activeMaxBytes) {
      throw new Error("snapshotMaxBytes cannot exceed activeMaxBytes");
    }
    this.now = opts.now ?? (() => new Date());
    this.fault = opts.fault ?? (() => {});
  }

  private key(): string {
    return this.layout.root;
  }

  /** Run a mutation under the lock, on recovered state; any failure drops the cache. */
  private async mutate<T>(fn: (s: State) => Promise<T>): Promise<T> {
    return locks.withLock(this.key(), async () => {
      try {
        const s = await this.recovered();
        const out = await fn(s);
        return out;
      } catch (e) {
        this.state = null;
        throw e;
      } finally {
        const next = (epochs.get(this.key()) ?? 0) + 1;
        epochs.set(this.key(), next);
        if (this.state) this.state.epoch = next;
      }
    });
  }

  private async recovered(): Promise<State> {
    const epoch = epochs.get(this.key()) ?? 0;
    if (this.state && this.state.epoch === epoch) return this.state;
    this.state = null;
    this.state = await this.recover(epoch);
    return this.state;
  }

  // ── Recovery ──────────────────────────────────────────────────────────────

  /**
   * Load state from disk, completing any interrupted operation first:
   * never-published temp files are removed; a tombstoned deletion is
   * finished; a segment or snapshot copied into the archive whose copy
   * verifies has its active copy removed; unsealed segments below the newest
   * are sealed. Nothing is truncated, and no record is rewritten.
   */
  private async recover(epoch: number): Promise<State> {
    const l = this.layout;
    for (const store of ["active", "archive"] as const) {
      for (const tmp of (await list(l, store)).temps) await removeFile(tmp);
    }
    const manifest = await readManifest(l);

    for (const t of manifest.tombstones.values()) await this.completeDeletion(t);

    let act = await list(l, "active");
    let arc = await list(l, "archive");

    for (const [id] of act.segments) {
      if (!arc.segments.has(id)) continue;
      const seal = manifest.seals.get(id);
      const copy = await readBytes(l.segmentPath("archive", id));
      if (seal && copy && sha256Hex(copy) === seal.sha256) {
        if (!manifest.archived.has(id))
          await this.appendManifest("archive", {
            segment: id,
            sha256: seal.sha256,
            at: this.iso(),
          });
        await removeFile(l.segmentPath("active", id));
      }
    }
    for (const [sha] of act.snapshots) {
      if (!arc.snapshots.has(sha)) continue;
      const copy = await readBytes(l.snapshotPath("archive", sha));
      if (copy && sha256Hex(copy) === sha) await removeFile(l.snapshotPath("active", sha));
    }
    act = await list(l, "active");
    arc = await list(l, "archive");

    const state: State = {
      epoch,
      active: new Map(),
      archiveSegments: new Set(arc.segments.keys()),
      activeSnapshots: new Map(act.snapshots),
      archiveSnapshots: new Set(arc.snapshots.keys()),
      ids: new Map(),
      activeBytes: 0,
      maxSeq: 0,
    };
    const seqs = [
      ...act.segments.keys(),
      ...arc.segments.keys(),
      ...manifest.seals.keys(),
      ...manifest.tombstones.keys(),
    ].map((id) => segmentSeq(id) ?? 0);
    state.maxSeq = Math.max(0, ...seqs);

    const ordered = [...act.segments.keys()].sort();
    for (const id of ordered) {
      const text = (await readText(l.segmentPath("active", id))) ?? "";
      const parsed = parseSegment(id, text);
      const seg: ActiveSegment = {
        id,
        seq: segmentSeq(id)!,
        bytes: Buffer.byteLength(text, "utf8"),
        sealed: manifest.seals.has(id),
        openedAt: parsed.openedAt,
        refs: parsed.refs,
        endsMidLine: text.length > 0 && !text.endsWith("\n"),
      };
      state.active.set(id, seg);
      for (const e of parsed.entries) {
        if (!state.ids.has(e.assessment.id))
          state.ids.set(e.assessment.id, { digest: e.digest, segment: id });
      }
    }
    // Only the newest active segment may be open; seal any older one left
    // unsealed by an interrupted rotation.
    const newest = ordered.at(-1);
    for (const id of ordered) {
      const seg = state.active.get(id)!;
      if (!seg.sealed && id !== newest) await this.seal(seg, "recovered");
    }
    state.activeBytes = sumActive(state);
    return state;
  }

  private async completeDeletion(t: Tombstone): Promise<void> {
    const l = this.layout;
    const present = await readBytes(l.segmentPath("archive", t.segment));
    const snapshotsLeft = await Promise.all(
      t.deletedSnapshots
        .filter((s) => SHA256_RE.test(s))
        .map(async (sha) => {
          const a = await readBytes(l.snapshotPath("active", sha));
          const b = await readBytes(l.snapshotPath("archive", sha));
          return a || b ? sha : null;
        }),
    );
    const left = snapshotsLeft.filter((s): s is string => s !== null);
    if (!present && left.length === 0) return;
    // Recompute references before deleting anything: a re-evaluation may
    // have referenced one of these snapshots since the tombstone was written.
    // A survivor with unreadable lines might reference one of them, so while
    // any exists the snapshots stay (and a reader still sees them); only the
    // tombstoned segment itself goes.
    const refs = await this.referencesExcept(new Set([t.segment]), true);
    for (const sha of left) {
      if (refs.refs.has(sha) || refs.corrupt.length > 0) continue;
      await removeFile(l.snapshotPath("active", sha));
      await removeFile(l.snapshotPath("archive", sha));
    }
    if (present) await removeFile(l.segmentPath("archive", t.segment));
  }

  /** Snapshot references of every surviving segment (active and archive) except `excluded`. */
  private async referencesExcept(
    excluded: Set<string>,
    tolerateCorrupt: boolean,
  ): Promise<{ refs: Set<string>; corrupt: string[] }> {
    const l = this.layout;
    const manifest = await readManifest(l);
    const refs = new Set<string>();
    const corrupt: string[] = [];
    for (const store of ["active", "archive"] as const) {
      for (const [id] of (await list(l, store)).segments) {
        if (excluded.has(id) || manifest.tombstones.has(id)) continue;
        const text = (await readText(l.segmentPath(store, id))) ?? "";
        const parsed = parseSegment(id, text);
        if (parsed.corrupt > 0) corrupt.push(id);
        for (const r of parsed.refs) refs.add(r);
      }
    }
    if (corrupt.length > 0 && !tolerateCorrupt) {
      throw new JournalError(
        "unreadable-references",
        `segments ${corrupt.join(", ")} have unreadable lines that may reference snapshots; refusing to delete any`,
      );
    }
    return { refs, corrupt };
  }

  // ── Small helpers ─────────────────────────────────────────────────────────

  private iso(): string {
    return this.now().toISOString();
  }

  private async appendManifest(kind: string, body: unknown): Promise<void> {
    const file = this.layout.manifestPath();
    await appendLines(file, await tornPrefix(file, this.iso()), [encodeLine(kind, body).text]);
  }

  private async seal(seg: ActiveSegment, reason: SealEntry["reason"]): Promise<void> {
    const file = this.layout.segmentPath("active", seg.id);
    const bytes = (await readBytes(file)) ?? Buffer.alloc(0);
    const parsed = parseSegment(seg.id, bytes.toString("utf8"));
    const entry: SealEntry = {
      segment: seg.id,
      records: parsed.entries.length,
      bytes: bytes.length,
      sha256: sha256Hex(bytes),
      firstAt: parsed.firstAt,
      lastAt: parsed.lastAt,
      reason,
      at: this.iso(),
    };
    await this.appendManifest("seal", entry);
    seg.sealed = true;
    await this.fault("rotate:sealed");
  }

  private header(s: State): { id: string; seq: number; openedAt: string; text: string } {
    const seq = s.maxSeq + 1;
    const id = segmentId(seq);
    const openedAt = this.iso();
    return {
      id,
      seq,
      openedAt,
      text: encodeLine("segment-open", { segment: id, openedAt, format: 1 }).text,
    };
  }

  private async openSegment(
    s: State,
    header: { id: string; seq: number; openedAt: string; text: string },
  ): Promise<ActiveSegment> {
    const { id, seq } = header;
    const file = this.layout.segmentPath("active", id);
    await mkdir(path.dirname(file), { recursive: true });
    const fh = await open(file, "wx");
    try {
      await fh.write(header.text);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await syncDir(path.dirname(file));
    const seg: ActiveSegment = {
      id,
      seq,
      bytes: Buffer.byteLength(header.text),
      sealed: false,
      openedAt: header.openedAt,
      refs: new Set(),
      endsMidLine: false,
    };
    s.active.set(id, seg);
    s.maxSeq = seq;
    s.activeBytes += seg.bytes;
    await this.fault("rotate:opened");
    return seg;
  }

  private current(s: State): ActiveSegment | null {
    let best: ActiveSegment | null = null;
    for (const seg of s.active.values()) if (!best || seg.seq > best.seq) best = seg;
    return best && !best.sealed ? best : null;
  }

  private aged(seg: ActiveSegment): boolean {
    if (!seg.openedAt) return true;
    const opened = Date.parse(seg.openedAt);
    return !Number.isFinite(opened) || this.now().getTime() - opened >= this.limits.segmentMaxAgeMs;
  }

  /** Canonical bytes of a snapshot, refusing one whose digest or size does not match. */
  private snapshotBytes(snapshot: StoredSnapshot): Buffer {
    if (!SHA256_RE.test(snapshot.sha256))
      throw new JournalError("invalid", "snapshot digest is not sha256 hex");
    const buf = Buffer.from(canonicalJson(snapshot.content), "utf8");
    if (sha256Hex(buf) !== snapshot.sha256 || buf.length !== snapshot.bytes) {
      throw new JournalError("invalid", "snapshot content does not match its digest or size");
    }
    if (buf.length > this.limits.snapshotMaxBytes) {
      throw new JournalError(
        "snapshot-too-large",
        `snapshot is ${buf.length} bytes, over the ${this.limits.snapshotMaxBytes}-byte limit`,
      );
    }
    return buf;
  }

  /** Whether a verified copy exists in either store; a damaged active copy counts as absent. */
  private async snapshotPresent(
    s: State,
    sha: string,
  ): Promise<{ present: boolean; replaceActive: boolean }> {
    const l = this.layout;
    for (const store of ["active", "archive"] as const) {
      const has = store === "active" ? s.activeSnapshots.has(sha) : s.archiveSnapshots.has(sha);
      if (!has) continue;
      const bytes = await readBytes(l.snapshotPath(store, sha));
      if (bytes && sha256Hex(bytes) === sha) return { present: true, replaceActive: false };
    }
    return { present: false, replaceActive: s.activeSnapshots.has(sha) };
  }

  private async publishInto(s: State, sha: string, buf: Buffer, replace: boolean): Promise<void> {
    await publishFile(this.layout.snapshotPath("active", sha), buf, this.fault, "snapshot");
    if (!replace) {
      s.activeSnapshots.set(sha, buf.length);
      s.activeBytes += buf.length;
    }
  }

  private admit(s: State, delta: number): void {
    if (s.activeBytes + delta > this.limits.activeMaxBytes) {
      throw new JournalError(
        "active-storage-full",
        `active journal storage would reach ${s.activeBytes + delta} of ${this.limits.activeMaxBytes} bytes; archive sealed segments to free space`,
      );
    }
  }

  // ── Public operations ─────────────────────────────────────────────────────

  /**
   * Publish a snapshot before its provider call ("hash before send"). Admitted
   * against the active bound with room left for its record. Idempotent.
   */
  async publishSnapshot(snapshot: StoredSnapshot): Promise<"published" | "present"> {
    const buf = this.snapshotBytes(snapshot);
    return this.mutate(async (s) => {
      const { present, replaceActive } = await this.snapshotPresent(s, snapshot.sha256);
      if (present) return "present";
      this.admit(s, (replaceActive ? 0 : buf.length) + RECORD_RESERVE);
      await this.publishInto(s, snapshot.sha256, buf, replaceActive);
      return "published";
    });
  }

  /**
   * Append one assessment with its retained snapshot. The snapshot is
   * re-ensured under the lock before the record is written, so an
   * acknowledged record's input is always on disk first.
   */
  async append(assessment: DecisionAssessment, snapshot: StoredSnapshot): Promise<AppendResult> {
    if (!isAssessment(assessment))
      throw new JournalError("invalid", "not a well-formed assessment");
    if (
      assessment.snapshot.sha256 !== snapshot.sha256 ||
      assessment.snapshot.bytes !== snapshot.bytes
    ) {
      throw new JournalError("invalid", "the assessment names a different snapshot");
    }
    const snapBuf = this.snapshotBytes(snapshot);
    const line = encodeLine("assessment", assessment);
    const lineBytes = Buffer.byteLength(line.text);
    return this.mutate(async (s) => {
      const known = s.ids.get(assessment.id);
      if (known) {
        if (known.digest === line.digest) return { status: "duplicate", segment: known.segment };
        throw new JournalError(
          "conflict",
          `assessment ${assessment.id} is already recorded differently`,
        );
      }
      let seg = this.current(s);
      const header = this.header(s);
      const headerBytes = Buffer.byteLength(header.text);
      if (lineBytes > MAX_RECORD_BYTES || headerBytes + lineBytes > this.limits.segmentMaxBytes) {
        throw new JournalError(
          "record-too-large",
          `a ${lineBytes}-byte record cannot fit any segment`,
        );
      }
      const rotateFor: SealEntry["reason"] | null = !seg
        ? null
        : seg.bytes + lineBytes > this.limits.segmentMaxBytes
          ? "size"
          : this.aged(seg)
            ? "age"
            : null;
      const opening = !seg || rotateFor !== null;
      const snap = await this.snapshotPresent(s, snapshot.sha256);
      const snapDelta = snap.present || snap.replaceActive ? 0 : snapBuf.length;
      const prefix = opening
        ? ""
        : await tornPrefix(this.layout.segmentPath("active", seg!.id), this.iso());
      this.admit(
        s,
        snapDelta + (opening ? headerBytes : 0) + Buffer.byteLength(prefix) + lineBytes,
      );

      if (seg && rotateFor) await this.seal(seg, rotateFor);
      if (opening) seg = await this.openSegment(s, header);
      if (!snap.present) await this.publishInto(s, snapshot.sha256, snapBuf, snap.replaceActive);
      await this.fault("append:before-line");
      const file = this.layout.segmentPath("active", seg!.id);
      const written = await appendLines(file, prefix, [line.text]);
      seg!.bytes += written;
      seg!.endsMidLine = false;
      seg!.refs.add(snapshot.sha256);
      s.activeBytes += written;
      s.ids.set(assessment.id, { digest: line.digest, segment: seg!.id });
      await this.fault("append:after-line");
      return { status: "appended", segment: seg!.id };
    });
  }

  /**
   * Explicit archival: move sealed segments (all but the newest `keepSealed`)
   * into the archive, then every active snapshot no active segment still
   * references. Each move is a copy that verifies, then a manifest line, then
   * removal of the active copy. Nothing is deleted.
   *
   * The open segment is sealed first when it holds any record (`sealOpen`,
   * the default), or when it has aged. Without that, a quota filled by
   * snapshots of the open segment could not be freed at all: they are only
   * movable once no active segment references them.
   */
  async archive(opts: { keepSealed?: number; sealOpen?: boolean } = {}): Promise<ArchiveResult> {
    const keep = Math.max(0, opts.keepSealed ?? 0);
    const sealOpen = opts.sealOpen ?? true;
    return this.mutate(async (s) => {
      const l = this.layout;
      const result: ArchiveResult = { segments: [], snapshots: [], skipped: [] };
      const open = this.current(s);
      if (open && open.refs.size > 0 && sealOpen) await this.seal(open, "archive");
      else if (open && this.aged(open)) await this.seal(open, "age");
      const manifest = await readManifest(l);
      const sealed = [...s.active.values()].filter((g) => g.sealed).sort((a, b) => a.seq - b.seq);
      const candidates = keep > 0 ? sealed.slice(0, Math.max(0, sealed.length - keep)) : sealed;
      for (const seg of candidates) {
        const seal = manifest.seals.get(seg.id);
        const bytes = await readBytes(l.segmentPath("active", seg.id));
        if (!seal || !bytes || sha256Hex(bytes) !== seal.sha256) {
          result.skipped.push({ segment: seg.id, reason: "segment bytes differ from its seal" });
          continue;
        }
        await publishFile(l.segmentPath("archive", seg.id), bytes, this.fault, "archive-segment");
        const copy = await readBytes(l.segmentPath("archive", seg.id));
        if (!copy || sha256Hex(copy) !== seal.sha256) {
          result.skipped.push({ segment: seg.id, reason: "archive copy did not verify" });
          continue;
        }
        await this.fault("archive:copied");
        await this.appendManifest("archive", {
          segment: seg.id,
          sha256: seal.sha256,
          at: this.iso(),
        });
        await this.fault("archive:recorded");
        await removeFile(l.segmentPath("active", seg.id));
        s.active.delete(seg.id);
        s.archiveSegments.add(seg.id);
        s.activeBytes -= bytes.length;
        for (const [id, v] of s.ids) if (v.segment === seg.id) s.ids.delete(id);
        result.segments.push(seg.id);
      }
      const referenced = new Set<string>();
      for (const seg of s.active.values()) for (const r of seg.refs) referenced.add(r);
      const movable = [...s.activeSnapshots.keys()].filter((sha) => !referenced.has(sha)).sort();
      for (const sha of movable) {
        const bytes = await readBytes(l.snapshotPath("active", sha));
        if (!bytes || sha256Hex(bytes) !== sha) {
          result.skipped.push({
            segment: "-",
            reason: `snapshot ${sha} is damaged; left in place`,
          });
          continue;
        }
        await publishFile(l.snapshotPath("archive", sha), bytes, this.fault, "archive-snapshot");
        result.snapshots.push(sha);
      }
      if (result.snapshots.length > 0) {
        await this.fault("archive:snapshots-copied");
        await this.appendManifest("snapshots-archived", {
          snapshots: result.snapshots,
          at: this.iso(),
        });
        for (const sha of result.snapshots) {
          await removeFile(l.snapshotPath("active", sha));
          s.activeBytes -= s.activeSnapshots.get(sha) ?? 0;
          s.activeSnapshots.delete(sha);
          s.archiveSnapshots.add(sha);
        }
      }
      return result;
    });
  }

  /**
   * Explicit, operator-initiated deletion of one archived segment. The
   * tombstone is written first; only snapshots no surviving segment
   * references are removed. Refuses active segments, and refuses while any
   * surviving segment has unreadable lines.
   */
  async deleteArchivedSegment(req: {
    segment: string;
    operator: string;
    reason: string;
  }): Promise<DeleteResult> {
    if (segmentSeq(req.segment) === null)
      throw new JournalError("unknown-segment", "invalid segment id");
    if (!req.operator.trim() || !req.reason.trim()) {
      throw new JournalError("invalid", "deletion needs an operator and a reason");
    }
    return this.mutate(async (s) => {
      const l = this.layout;
      if (s.active.has(req.segment)) {
        throw new JournalError("not-archived", `${req.segment} is active; archive it first`);
      }
      const manifest = await readManifest(l);
      if (manifest.tombstones.has(req.segment)) {
        throw new JournalError("unknown-segment", `${req.segment} is already deleted`);
      }
      const bytes = await readBytes(l.segmentPath("archive", req.segment));
      if (!bytes || !manifest.archived.has(req.segment)) {
        throw new JournalError("not-archived", `${req.segment} is not an archived segment`);
      }
      const parsed = parseSegment(req.segment, bytes.toString("utf8"));
      const { refs } = await this.referencesExcept(new Set([req.segment]), false);
      const deleted = [...parsed.refs].filter((sha) => !refs.has(sha)).sort();
      const retained = [...parsed.refs].filter((sha) => refs.has(sha)).sort();
      const tomb: Tombstone = {
        segment: req.segment,
        sha256: sha256Hex(bytes),
        records: parsed.entries.length,
        firstAt: parsed.firstAt,
        lastAt: parsed.lastAt,
        deletedSnapshots: deleted,
        retainedSnapshots: retained,
        operator: req.operator,
        reason: req.reason,
        at: this.iso(),
      };
      await this.appendManifest("tombstone", tomb);
      await this.fault("delete:tombstoned");
      for (const sha of deleted) {
        await removeFile(l.snapshotPath("active", sha));
        await removeFile(l.snapshotPath("archive", sha));
        if (s.activeSnapshots.has(sha)) {
          s.activeBytes -= s.activeSnapshots.get(sha)!;
          s.activeSnapshots.delete(sha);
        }
        s.archiveSnapshots.delete(sha);
      }
      await this.fault("delete:snapshots-removed");
      await removeFile(l.segmentPath("archive", req.segment));
      s.archiveSegments.delete(req.segment);
      return { segment: req.segment, deletedSnapshots: deleted, retainedSnapshots: retained };
    });
  }

  /** Current active usage and limits. */
  async usage(): Promise<Usage> {
    return this.mutate(async (s) => ({
      activeBytes: s.activeBytes,
      limits: { ...this.limits },
      manifestBytes: (await readManifest(this.layout)).bytes,
      activeSegments: s.active.size,
      activeSnapshots: s.activeSnapshots.size,
    }));
  }

  /**
   * Read the whole journal as it is on disk, without recovering anything:
   * a fresh reader's view. Entries are in (segment, line) order.
   */
  async read(): Promise<JournalView> {
    return locks.withLock(this.key(), () => readView(this.layout));
  }

  /** Find a retained snapshot in either store, verifying its bytes against its digest. */
  async loadSnapshot(sha256: string): Promise<SnapshotLookup> {
    return locks.withLock(this.key(), () => lookupSnapshot(this.layout, sha256));
  }
}

/** The largest assessment line accepted. The service caps every free-text field well below it. */
export const MAX_RECORD_BYTES = 16 * 1024;
/** Room kept for a record (and a segment header) when a snapshot is published before its call. */
const RECORD_RESERVE = MAX_RECORD_BYTES + 512;

function sumActive(s: State): number {
  let n = 0;
  for (const seg of s.active.values()) n += seg.bytes;
  for (const size of s.activeSnapshots.values()) n += size;
  return n;
}

export async function lookupSnapshot(l: Layout, sha256: string): Promise<SnapshotLookup> {
  if (!SHA256_RE.test(sha256)) return { status: "unavailable" };
  let damaged = false;
  for (const store of ["active", "archive"] as const) {
    const bytes = await readBytes(l.snapshotPath(store, sha256));
    if (!bytes) continue;
    if (sha256Hex(bytes) !== sha256) {
      damaged = true;
      continue;
    }
    return {
      status: "retained",
      store,
      snapshot: { sha256, bytes: bytes.length, content: JSON.parse(bytes.toString("utf8")) },
    };
  }
  return damaged
    ? { status: "corrupt", detail: "no copy matches its digest" }
    : { status: "unavailable" };
}

async function readView(l: Layout): Promise<JournalView> {
  const manifest = await readManifest(l);
  const act = await list(l, "active");
  const arc = await list(l, "archive");
  const view: JournalView = { segments: [], entries: [], gaps: [], notices: [...manifest.notices] };
  for (const f of [...act.unexpected, ...arc.unexpected]) {
    view.notices.push({ kind: "unexpected-file", detail: path.relative(l.root, f) });
  }
  const ids = new Set<string>([
    ...act.segments.keys(),
    ...arc.segments.keys(),
    ...manifest.seals.keys(),
    ...manifest.tombstones.keys(),
  ]);
  const maxSeq = Math.max(0, ...[...ids].map((id) => segmentSeq(id) ?? 0));
  const seen = new Map<string, JournalEntry>();
  for (let seq = 1; seq <= maxSeq; seq++) {
    const id = segmentId(seq);
    const tomb = manifest.tombstones.get(id);
    const inActive = act.segments.has(id);
    const inArchive = arc.segments.has(id);
    if (tomb) {
      view.gaps.push({
        segment: id,
        reason: "deleted",
        records: tomb.records,
        firstAt: tomb.firstAt,
        lastAt: tomb.lastAt,
      });
      if (inActive || inArchive) {
        view.notices.push({
          kind: "deletion-incomplete",
          segment: id,
          detail: "tombstoned, but its file remains",
        });
      }
      continue;
    }
    if (!inActive && !inArchive) {
      view.gaps.push({
        segment: id,
        reason: "missing",
        records: null,
        firstAt: null,
        lastAt: null,
      });
      continue;
    }
    const seal = manifest.seals.get(id);
    let store: Store = inArchive ? "archive" : "active";
    let bytes = await readBytes(l.segmentPath(store, id));
    if (inActive && inArchive) {
      const other = await readBytes(l.segmentPath("active", id));
      const archiveOk = !!bytes && !!seal && sha256Hex(bytes) === seal.sha256;
      if (!bytes || !other || !bytes.equals(other)) {
        view.notices.push({
          kind: "copy-mismatch",
          segment: id,
          detail: "active and archive copies differ",
        });
        if (!archiveOk) {
          store = "active";
          bytes = other;
        }
      }
    }
    const parsed = parseSegment(id, (bytes ?? Buffer.alloc(0)).toString("utf8"));
    view.notices.push(...parsed.notices);
    view.segments.push({ segment: id, store, sealed: !!seal, records: parsed.entries.length });
    for (const e of parsed.entries) {
      const prior = seen.get(e.assessment.id);
      if (prior) {
        view.notices.push({
          kind: prior.digest === e.digest ? "duplicate" : "conflict",
          segment: id,
          line: e.line,
          detail: `assessment ${e.assessment.id} also at ${prior.segment}:${prior.line}`,
        });
        if (prior.digest === e.digest) continue;
      } else {
        seen.set(e.assessment.id, e);
      }
      view.entries.push(e);
    }
  }
  return view;
}
