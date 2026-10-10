import { open, type FileHandle } from "node:fs/promises";

/**
 * Byte-level durability primitives shared by every writer that promises its
 * bytes reached the disk: the Decision Journal's segments, the transition
 * log, and durable instance publication.
 *
 * What they guarantee, and what they do not. `writeAll` writes every byte or
 * throws; `FileHandle.sync` asks the OS to flush the file's data to stable
 * storage; `syncDir` asks the same of a directory, so a rename or create in it
 * is ordered after the data. On Linux and macOS both are real `fsync` calls.
 * On Windows a directory cannot be opened for `fsync`, so `syncDir` is a
 * no-op there and directory-entry durability rests on NTFS's own metadata
 * journalling, which Argus has not measured. None of this is a claim about
 * power loss on hardware that lies about its write cache.
 */

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
 * One positional-less write: the seam through which every journal byte
 * reaches a file. `FileHandle.write` may write fewer bytes than asked (a
 * short write) and reports how many; the default passes straight through.
 */
export type WriteFn = (
  fh: FileHandle,
  data: Buffer,
  offset: number,
  length: number,
) => Promise<{ bytesWritten: number }>;

export const defaultWrite: WriteFn = (fh, data, offset, length) =>
  fh.write(data, offset, length, null);

export class ShortWriteError extends Error {
  constructor(
    readonly written: number,
    readonly intended: number,
  ) {
    super(`write made no progress after ${written} of ${intended} bytes`);
    this.name = "ShortWriteError";
  }
}

/**
 * Write every byte of `data`, looping over short writes. It never returns
 * until all intended bytes are written. Zero progress (or an impossible
 * count) throws `ShortWriteError`, and a write error propagates as-is, with
 * whatever prefix already reached the file left for torn-write recovery.
 */
export async function writeAll(
  fh: FileHandle,
  data: Buffer,
  write: WriteFn = defaultWrite,
): Promise<void> {
  let done = 0;
  while (done < data.length) {
    const { bytesWritten } = await write(fh, data, done, data.length - done);
    if (
      !Number.isSafeInteger(bytesWritten) ||
      bytesWritten <= 0 ||
      bytesWritten > data.length - done
    ) {
      throw new ShortWriteError(done, data.length);
    }
    done += bytesWritten;
  }
}
