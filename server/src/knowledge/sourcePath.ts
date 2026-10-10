/**
 * Repository-path containment for source evidence — the one place that decides
 * whether a path an agent named really is a file inside the tree Argus said it
 * could look at.
 *
 * Phase 5 checked containment **lexically**: the declared path is
 * repository-relative, has no `..` segment, and `path.resolve(root, …)` stays
 * under `root`. That is necessary and not sufficient. A repository may contain
 * a symlink of its own:
 *
 *   src/Booking/secrets.cs → /etc/shadow
 *
 * Every lexical rule above is satisfied — the declared path is
 * `src/Booking/secrets.cs`, which is inside the scope — and the file `stat`s
 * happily, so a rule could be recorded with durable evidence pointing at a
 * file outside the repository entirely. Nothing in Argus copies that file's
 * contents anywhere, so this is a containment bug rather than a disclosure
 * one, but the record would be a lie: "this rule is grounded in
 * `src/Booking/secrets.cs` at commit abc123" when the bytes are not in the
 * repository and not at that commit at all.
 *
 * So containment is decided on the **resolved real path**: `realpath` of the
 * candidate must stay inside `realpath` of the root. `realpath` resolves every
 * intermediate symlink too, which is what makes `scope/link/inner.cs` — where
 * `link` points outside — fail as well.
 *
 * Platform honesty. Where `realpath` cannot be taken (the file does not exist,
 * a permission error, a filesystem that does not support it), the lexical
 * verdict stands and the caller is told the path is *missing* rather than
 * unsafe: Argus refuses what it can disprove and reports what it merely cannot
 * confirm, which is the same discipline `gitHead` verification follows. The
 * root is resolved with `realpath` when it can be and used as given when it
 * cannot, so a repository that is itself reached through a symlink (a macOS
 * `/tmp` → `/private/tmp` worktree, a `~/src` shortcut) does not make every
 * path inside it look like an escape.
 */

import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { validArtifactPath } from "./kernel.js";

/**
 * Why a candidate path is not usable as repository source evidence.
 *
 * - `unsafe` — it is not a containable repository-relative path, or it
 *   resolves (through a symlink or otherwise) outside the repository root.
 * - `missing` — nothing is there.
 * - `not-a-file` — something is there, inside the root, but it is not a file
 *   (a directory, a device). Kept distinct from `missing` because the two read
 *   very differently to somebody diagnosing a refused rule.
 */
export type SourcePathRejection = "unsafe" | "missing" | "not-a-file";

export type SourcePathVerdict =
  | { ok: true; /** The resolved real path of the file. */ resolved: string }
  | { ok: false; reason: SourcePathRejection };

/** `realpath`, or the path as given when it cannot be taken. */
async function realOrSelf(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

/**
 * Is `relPath` a file inside `root`, both lexically and after every symlink on
 * the way has been resolved?
 *
 * Used for every repository source-code evidence record Argus validates
 * deterministically: discovery evidence (Phase 5) and verification evidence
 * (Phase 6) alike.
 */
export async function resolveRepositoryFile(
  root: string,
  relPath: string,
): Promise<SourcePathVerdict> {
  if (!validArtifactPath(relPath)) return { ok: false, reason: "unsafe" };
  const lexicalRoot = path.resolve(root);
  const lexical = path.resolve(lexicalRoot, ...relPath.split("/"));
  if (!inside(lexicalRoot, lexical)) return { ok: false, reason: "unsafe" };

  // The real root first: a worktree reached through a symlink is still the
  // root, and every path inside it must be judged against where it really is.
  const realRoot = await realOrSelf(lexicalRoot);
  let resolved: string;
  try {
    resolved = await realpath(lexical);
  } catch {
    // No real path to take — the commonest cause by far is that the file is
    // simply not there. The lexical verdict already held, so this is missing,
    // not unsafe.
    return { ok: false, reason: "missing" };
  }
  if (!inside(realRoot, resolved)) return { ok: false, reason: "unsafe" };
  try {
    const st = await stat(resolved);
    if (!st.isFile()) return { ok: false, reason: "not-a-file" };
  } catch {
    return { ok: false, reason: "missing" };
  }
  return { ok: true, resolved };
}
