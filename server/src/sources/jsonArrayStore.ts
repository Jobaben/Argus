import { readFile } from "node:fs/promises";
import { atomicWriteJson } from "./atomicWrite.js";
import { KeyedMutex } from "../mutex.js";

/**
 * A single-file JSON-array store with the crash-safe read/write discipline the
 * schedule and pipeline stores both need:
 *
 *  - reads tolerate a missing file (empty list) but distinguish a *corrupt*
 *    file (parse failure) so writes refuse to clobber it,
 *  - writes go through the atomic tmp+rename writer,
 *  - a keyed mutex serializes the read-modify-write cycle so concurrent
 *    creates/updates from HTTP handlers and the scheduler tick can't lose each
 *    other's changes.
 *
 * Extracted so schedules.ts and pipelines.ts share one audited implementation
 * instead of two byte-for-byte copies.
 */
export interface JsonArrayStore<T> {
  /** Parse the file. `ok:false` means present-but-corrupt (do not overwrite). */
  readRaw(): Promise<{ ok: boolean; list: T[] }>;
  /** The current list (empty on missing/corrupt). */
  read(): Promise<T[]>;
  /** Overwrite the list atomically; throws if the on-disk file is corrupt. */
  write(list: T[]): Promise<void>;
  /** Run a read-modify-write critical section under the store lock. */
  withLock<R>(fn: () => Promise<R>): Promise<R>;
}

export function createJsonArrayStore<T>(opts: { file: () => string; label: string }): JsonArrayStore<T> {
  const lock = new KeyedMutex();

  async function readRaw(): Promise<{ ok: boolean; list: T[] }> {
    let text: string;
    try {
      text = await readFile(opts.file(), "utf8");
    } catch {
      return { ok: true, list: [] }; // missing = empty, safe to write
    }
    try {
      const parsed = JSON.parse(text);
      return { ok: true, list: Array.isArray(parsed) ? (parsed as T[]) : [] };
    } catch {
      return { ok: false, list: [] }; // present but corrupt = do not overwrite
    }
  }

  async function read(): Promise<T[]> {
    return (await readRaw()).list;
  }

  async function write(list: T[]): Promise<void> {
    const current = await readRaw();
    if (!current.ok) {
      throw new Error(`${opts.label} could not be parsed; refusing to overwrite it`);
    }
    await atomicWriteJson(opts.file(), list);
  }

  function withLock<R>(fn: () => Promise<R>): Promise<R> {
    return lock.withLock(opts.label, fn);
  }

  return { readRaw, read, write, withLock };
}
