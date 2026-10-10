import { mkdir, open, readdir, readFile, rename, rm, lstat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { SHA256_RE } from "./canonical.js";

/**
 * Low-level, path-safe file primitives for the Decision Journal (RFC §O.3).
 *
 * Every path is rebuilt from a validated id — `seg-` plus eight digits for a
 * segment, 64 lowercase hex characters for a snapshot — and never joined from
 * a string read out of a file, so a manifest or record cannot steer a write
 * or a delete outside the journal root.
 */

// The line envelope, its torn-write fence and the plain readers live in
// durable/envelope.ts, shared with the pipeline transition log; re-exported
// here so the journal's callers and tests are unchanged.
import {
  appendLines,
  encodeLine,
  parseLines,
  readText,
  TORN_FENCE,
  TORN_MARKER,
  tornPrefix,
  type ParsedFile,
  type ParsedLine,
} from "../durable/envelope.js";
export {
  appendLines,
  encodeLine,
  parseLines,
  readText,
  TORN_FENCE,
  TORN_MARKER,
  tornPrefix,
  type ParsedFile,
  type ParsedLine,
};

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

// The byte-level durability primitives (`writeAll`, `syncDir` and their
// types) live in durable/io.ts so the instance writer can share them;
// re-exported here so the journal's callers and tests are unchanged.
export {
  defaultWrite,
  ShortWriteError,
  syncDir,
  writeAll,
  type FaultHook,
  type WriteFn,
} from "../durable/io.js";
import { defaultWrite, syncDir, writeAll, type FaultHook, type WriteFn } from "../durable/io.js";

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
  write: WriteFn = defaultWrite,
): Promise<void> {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const fh = await open(tmp, "wx");
  try {
    await writeAll(fh, data, write);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fault(`${label}:temp-written`);
  await rename(tmp, file);
  await syncDir(dir);
  await fault(`${label}:renamed`);
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
