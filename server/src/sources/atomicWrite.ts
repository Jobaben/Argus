import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

/**
 * Write a file atomically: write to a unique temp sibling, then rename over the
 * target (rename is atomic within a filesystem, so a reader never observes a
 * half-written file).
 *
 * The temp name mixes pid AND random bytes: keying only on pid collides when
 * two concurrent writers in the same process target the same file (e.g. a step
 * run and a heal pass both writing one instance), and the losing writer's
 * rename could move a half-written temp over the target.
 */
export async function atomicWriteFile(file: string, data: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, data, "utf8");
  try {
    await renameOver(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

/** Atomically write a value as pretty-printed JSON. */
export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await atomicWriteFile(file, JSON.stringify(value, null, 2));
}

/** Waits between attempts when Windows refuses the rename; ~1.5s in total. */
export const RENAME_RETRY_DELAYS_MS: readonly number[] = [10, 20, 40, 80, 160, 320, 640];

/** The codes Windows answers a rename with while another handle has the target open. */
const TRANSIENT_ON_WINDOWS = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * `rename(tmp, file)`, retried briefly on Windows when the target is open
 * elsewhere. Replacing a file another process (or this one — a request
 * reading the same record) holds open without delete sharing fails there
 * with EPERM/EACCES/EBUSY until that handle closes; a reader's handle is
 * short-lived, so a few bounded retries land the write instead of losing it.
 * POSIX replaces the name regardless of open handles, so any error there is
 * real and is thrown at once.
 */
export async function renameOver(
  tmp: string,
  file: string,
  deps: {
    rename?: (from: string, to: string) => Promise<void>;
    platform?: NodeJS.Platform;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<void> {
  const doRename = deps.rename ?? rename;
  const platform = deps.platform ?? process.platform;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      await doRename(tmp, file);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      const retryable = platform === "win32" && TRANSIENT_ON_WINDOWS.has(code);
      if (!retryable || attempt >= RENAME_RETRY_DELAYS_MS.length) throw e;
      await sleep(RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}
