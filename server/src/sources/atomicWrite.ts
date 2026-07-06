import { mkdir, rename, writeFile } from "node:fs/promises";
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
  await rename(tmp, file);
}

/** Atomically write a value as pretty-printed JSON. */
export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await atomicWriteFile(file, JSON.stringify(value, null, 2));
}
