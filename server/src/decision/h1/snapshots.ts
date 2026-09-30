import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { StoredSnapshot } from "@argus/contracts";
import { KeyedMutex } from "../../mutex.js";
import { canonicalDigest, parseCanonical, SHA256_RE, sha256Hex } from "../canonical.js";
import { defaultWrite, publishFile, readBytes, type FaultHook, type WriteFn } from "../storage.js";

/**
 * The H1 snapshot store (RFC §Q.9): the captured `gate-review` snapshots,
 * retained apart from every source they were built from, so replay and the
 * baselines survive pruning of instances, runs, transcripts, verdicts and
 * the gate log.
 *
 * A snapshot file is the canonical JSON of its content, and its name is the
 * sha256 of exactly those bytes. Publication is atomic and durable (temp
 * file, `fsync`, rename, directory `fsync`) and happens before the capture
 * line that names it. Admission is bounded by the total size of the store;
 * nothing is deleted, rotated or archived automatically.
 */

export const DEFAULT_MAX_SNAPSHOT_STORE_BYTES = 64 * 1024 * 1024;

export type StoredLookup =
  | { status: "retained"; snapshot: StoredSnapshot }
  | { status: "missing" }
  | { status: "corrupt"; detail: string };

export class SnapshotStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotStoreError";
  }
}

const locks = new KeyedMutex();

export class H1SnapshotStore {
  readonly root: string;
  readonly maxBytes: number;
  private readonly write: WriteFn;
  private readonly fault: FaultHook;

  constructor(opts: { root: string; maxBytes?: number; write?: WriteFn; fault?: FaultHook }) {
    this.root = path.join(path.resolve(opts.root), "snapshots");
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_SNAPSHOT_STORE_BYTES;
    this.write = opts.write ?? defaultWrite;
    this.fault = opts.fault ?? (() => {});
  }

  private file(sha256: string): string {
    if (!SHA256_RE.test(sha256)) throw new SnapshotStoreError(`"${sha256}" is not a sha256`);
    return path.join(this.root, sha256.slice(0, 2), `${sha256}.json`);
  }

  /** Bytes held now, summed over files whose name is a snapshot id. Reads only. */
  async usage(): Promise<number> {
    let total = 0;
    let shards: string[];
    try {
      shards = await readdir(this.root);
    } catch {
      return 0;
    }
    for (const shard of shards) {
      if (!/^[0-9a-f]{2}$/.test(shard)) continue;
      let names: string[];
      try {
        names = await readdir(path.join(this.root, shard));
      } catch {
        continue;
      }
      for (const n of names) {
        if (!/^[0-9a-f]{64}\.json$/.test(n)) continue;
        try {
          total += (await stat(path.join(this.root, shard, n))).size;
        } catch {
          /* vanished */
        }
      }
    }
    return total;
  }

  /**
   * Publish a snapshot, verified against its own digest. `present` when an
   * identical copy is already there. Refused, with nothing written, when it
   * would take the store past its cap.
   */
  async publish(snapshot: StoredSnapshot): Promise<"published" | "present"> {
    const sealed = canonicalDigest(snapshot.content);
    if (sealed.sha256 !== snapshot.sha256 || sealed.bytes !== snapshot.bytes) {
      throw new SnapshotStoreError("the snapshot does not match its digest");
    }
    return locks.withLock(this.root, async () => {
      const file = this.file(snapshot.sha256);
      const existing = await readBytes(file);
      if (existing && sha256Hex(existing) === snapshot.sha256) return "present";
      const used = await this.usage();
      if (used + sealed.bytes > this.maxBytes) {
        throw new SnapshotStoreError(
          `the H1 snapshot store would pass ${this.maxBytes} bytes; nothing was written`,
        );
      }
      await publishFile(
        file,
        Buffer.from(sealed.text, "utf8"),
        this.fault,
        "h1-snapshot",
        this.write,
      );
      return "published";
    });
  }

  /** Read a snapshot back and verify it. Never writes. */
  async load(sha256: string): Promise<StoredLookup> {
    let file: string;
    try {
      file = this.file(sha256);
    } catch (e) {
      return { status: "corrupt", detail: (e as Error).message };
    }
    const bytes = await readBytes(file);
    if (!bytes) return { status: "missing" };
    if (sha256Hex(bytes) !== sha256)
      return { status: "corrupt", detail: "the file does not match its sha256" };
    try {
      const content = parseCanonical(bytes.toString("utf8")) as StoredSnapshot["content"];
      return { status: "retained", snapshot: { sha256, bytes: bytes.length, content } };
    } catch (e) {
      return { status: "corrupt", detail: `not canonical JSON: ${(e as Error).message}` };
    }
  }
}
