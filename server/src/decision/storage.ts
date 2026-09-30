import { mkdir, open, readdir, readFile, rename, rm, lstat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { canonicalJson, sha256Hex, SHA256_RE } from "./canonical.js";

/**
 * Low-level, path-safe file primitives for the Decision Journal (RFC §O.3).
 *
 * Every path is rebuilt from a validated id — `seg-` plus eight digits for a
 * segment, 64 lowercase hex characters for a snapshot — and never joined from
 * a string read out of a file, so a manifest or record cannot steer a write
 * or a delete outside the journal root.
 */

export const SEGMENT_RE = /^seg-(\d{8})$/;
export const SEGMENT_FILE_RE = /^seg-(\d{8})\.jsonl$/;
const SNAPSHOT_FILE_RE = /^([0-9a-f]{64})\.json$/;
const FANOUT_RE = /^[0-9a-f]{2}$/;

export function segmentId(seq: number): string {
  if (!Number.isSafeInteger(seq) || seq < 1 || seq > 99_999_999) {
    throw new Error(`segment sequence ${seq} is out of range`);
  }
  return `seg-${String(seq).padStart(8, "0")}`;
}

export function segmentSeq(id: string): number | null {
  const m = SEGMENT_RE.exec(id);
  return m ? Number(m[1]) : null;
}

export type Store = "active" | "archive";

export interface Layout {
  root: string;
  segmentsDir(store: Store): string;
  segmentPath(store: Store, id: string): string;
  snapshotsDir(store: Store): string;
  snapshotPath(store: Store, sha256: string): string;
  manifestPath(): string;
}

export function layout(root: string): Layout {
  const abs = path.resolve(root);
  const segmentsDir = (store: Store) =>
    store === "active" ? path.join(abs, "active") : path.join(abs, "archive", "segments");
  const snapshotsDir = (store: Store) =>
    store === "active" ? path.join(abs, "snapshots") : path.join(abs, "archive", "snapshots");
  return {
    root: abs,
    segmentsDir,
    segmentPath(store, id) {
      if (!SEGMENT_RE.test(id)) throw new Error(`invalid segment id "${id}"`);
      return path.join(segmentsDir(store), `${id}.jsonl`);
    },
    snapshotsDir,
    snapshotPath(store, sha256) {
      if (!SHA256_RE.test(sha256)) throw new Error(`invalid snapshot digest "${sha256}"`);
      return path.join(snapshotsDir(store), sha256.slice(0, 2), `${sha256}.json`);
    },
    manifestPath: () => path.join(abs, "manifest.jsonl"),
  };
}

// ── Line envelope ───────────────────────────────────────────────────────────

/** One record: `canonical({body, kind, sha256})`, sha256 over `canonical({body, kind})`. */
export function encodeLine(kind: string, body: unknown): { text: string; digest: string } {
  const digest = sha256Hex(canonicalJson({ body, kind }));
  return { text: `${canonicalJson({ body, kind, sha256: digest })}\n`, digest };
}

export type ParsedLine =
  | { ok: true; line: number; kind: string; body: unknown; digest: string }
  | { ok: false; line: number; problem: "unparseable" | "digest-mismatch" | "malformed" };

export interface ParsedFile {
  lines: ParsedLine[];
  /** Bytes after the last newline: an unacknowledged, torn write. */
  tornTail: number;
  /** Line numbers (1-based) of bad lines recovered by a following torn marker. */
  recoveredTorn: Set<number>;
  endsWithNewline: boolean;
}

export const TORN_MARKER = "torn-marker";

/**
 * Parse a JSONL file of envelopes. A run of bad lines immediately followed by
 * a torn marker is a recovered torn write; any other bad line is corruption.
 */
export function parseLines(text: string): ParsedFile {
  const parts = text.split("\n");
  const endsWithNewline = text.length === 0 || text.endsWith("\n");
  const tail = parts.pop() ?? "";
  const lines: ParsedLine[] = parts.map((raw, i) => {
    const line = i + 1;
    let v: unknown;
    try {
      v = JSON.parse(raw);
    } catch {
      return { ok: false, line, problem: "unparseable" };
    }
    if (!v || typeof v !== "object" || Array.isArray(v))
      return { ok: false, line, problem: "malformed" };
    const env = v as Record<string, unknown>;
    if (typeof env.kind !== "string" || typeof env.sha256 !== "string" || !("body" in env)) {
      return { ok: false, line, problem: "malformed" };
    }
    let digest: string;
    try {
      digest = sha256Hex(canonicalJson({ body: env.body, kind: env.kind }));
    } catch {
      return { ok: false, line, problem: "malformed" };
    }
    if (digest !== env.sha256) return { ok: false, line, problem: "digest-mismatch" };
    return { ok: true, line, kind: env.kind, body: env.body, digest };
  });
  const recoveredTorn = new Set<number>();
  let run: number[] = [];
  for (const l of lines) {
    if (!l.ok) {
      // A digest mismatch parsed as JSON: that is damage, not a torn write.
      if (l.problem === "digest-mismatch") run = [];
      else run.push(l.line);
      continue;
    }
    if (l.kind === TORN_MARKER) for (const n of run) recoveredTorn.add(n);
    run = [];
  }
  return {
    lines,
    tornTail: Buffer.byteLength(tail, "utf8"),
    recoveredTorn,
    endsWithNewline,
  };
}

// ── Durable writes ──────────────────────────────────────────────────────────

/** fsync a directory so a rename or create in it is ordered; best effort where unsupported. */
export async function syncDir(dir: string): Promise<void> {
  let fh;
  try {
    fh = await open(dir, "r");
  } catch {
    return;
  }
  try {
    await fh.sync();
  } catch {
    /* some platforms refuse fsync on a directory */
  } finally {
    await fh.close();
  }
}

export type FaultHook = (point: string) => void | Promise<void>;

/**
 * Publish bytes at `file` atomically and durably: temp sibling, fsync,
 * rename, fsync the directory. `fault` runs between the steps so tests can
 * interrupt each one.
 */
export async function publishFile(
  file: string,
  data: Buffer,
  fault: FaultHook,
  label: string,
): Promise<void> {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const fh = await open(tmp, "wx");
  try {
    await fh.write(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fault(`${label}:temp-written`);
  await rename(tmp, file);
  await syncDir(dir);
  await fault(`${label}:renamed`);
}

/**
 * The prefix an append must write first when `file` ends in a torn write:
 * a newline, so the next record starts on a fresh line, and a torn marker,
 * so readers can tell that fragment from interior damage. Empty when the
 * file ends cleanly (or does not exist).
 */
export async function tornPrefix(file: string, markerAt: string): Promise<string> {
  let fh;
  try {
    fh = await open(file, "r");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  }
  try {
    const { size } = await fh.stat();
    if (size === 0) return "";
    const window = Math.min(size, 1 << 20);
    const buf = Buffer.alloc(window);
    await fh.read(buf, 0, window, size - window);
    if (buf[window - 1] === 0x0a) return "";
    const nl = buf.lastIndexOf(0x0a);
    // Bytes of the fragment back to the previous newline (a floor past 1 MiB).
    const fragmentBytes = nl === -1 ? window : window - nl - 1;
    return `\n${encodeLine(TORN_MARKER, { fragmentBytes, at: markerAt }).text}`;
  } finally {
    await fh.close();
  }
}

/** Append `prefix` and lines in one write, then fsync. Returns bytes written. */
export async function appendLines(file: string, prefix: string, lines: string[]): Promise<number> {
  await mkdir(path.dirname(file), { recursive: true });
  const fh = await open(file, "a");
  try {
    const data = Buffer.from(prefix + lines.join(""), "utf8");
    await fh.write(data);
    await fh.sync();
    return data.length;
  } finally {
    await fh.close();
  }
}

// ── Listing ─────────────────────────────────────────────────────────────────

export interface Listing {
  /** Segment id → size, per store. */
  segments: Map<string, number>;
  /** Snapshot sha256 → size. */
  snapshots: Map<string, number>;
  /** Leftover temp files (never-published writes). */
  temps: string[];
  /** Entries that match no pattern, or are symlinks: ignored and reported. */
  unexpected: string[];
}

async function entries(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

async function regularSize(file: string): Promise<number | null> {
  const st = await lstat(file);
  return st.isFile() && !st.isSymbolicLink() ? st.size : null;
}

export async function list(l: Layout, store: Store): Promise<Listing> {
  const out: Listing = { segments: new Map(), snapshots: new Map(), temps: [], unexpected: [] };
  const segDir = l.segmentsDir(store);
  for (const name of await entries(segDir)) {
    const full = path.join(segDir, name);
    if (name.endsWith(".tmp")) {
      out.temps.push(full);
      continue;
    }
    const m = SEGMENT_FILE_RE.exec(name);
    const size = m ? await regularSize(full) : null;
    if (!m || size === null) out.unexpected.push(full);
    else out.segments.set(`seg-${m[1]}`, size);
  }
  const snapDir = l.snapshotsDir(store);
  for (const fan of await entries(snapDir)) {
    const fanDir = path.join(snapDir, fan);
    const st = await lstat(fanDir);
    if (!FANOUT_RE.test(fan) || !st.isDirectory() || st.isSymbolicLink()) {
      out.unexpected.push(fanDir);
      continue;
    }
    for (const name of await entries(fanDir)) {
      const full = path.join(fanDir, name);
      if (name.endsWith(".tmp")) {
        out.temps.push(full);
        continue;
      }
      const m = SNAPSHOT_FILE_RE.exec(name);
      const size = m && m[1].startsWith(fan) ? await regularSize(full) : null;
      if (!m || size === null) out.unexpected.push(full);
      else out.snapshots.set(m[1], size);
    }
  }
  return out;
}

export async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function readBytes(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function removeFile(file: string): Promise<void> {
  await rm(file, { force: true });
  await syncDir(path.dirname(file));
}
