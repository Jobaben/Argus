/**
 * Which tree the `argus` launcher runs: the pinned release `current.json`
 * points at, or the dev checkout.
 *
 * Plain ESM with no dependencies, because the launcher needs it before
 * anything is built; `argus release` (server/src/cli) imports the same module
 * through `buildTarget.d.mts`, so the path and pointer rules live only here.
 */
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Written last by `argus release`; a directory without it is not a release. */
export const RELEASE_MANIFEST = "release.json";
export const POINTER_FILE = "current.json";

export class BuildTargetError extends Error {}

/**
 * `~/.claude-argus-releases` by default: a sibling of the Claude home, as the
 * work root (`~/.claude-argus`) is, and resolved from the same overrides
 * (`ARGUS_CLAUDE_HOME`, then `CLAUDE_CONFIG_DIR`) so a test or alternate home
 * carries its own releases. Deliberately not under the work root: that holds
 * agent outputs people wipe, and running agents' hooks live in a release.
 */
export function releasesRoot(env = process.env, homedir = os.homedir()) {
  const override = env.ARGUS_CLAUDE_HOME ?? env.CLAUDE_CONFIG_DIR;
  const home =
    override && override.trim().length > 0 ? path.resolve(override) : path.join(homedir, ".claude");
  return path.join(path.dirname(home), `${path.basename(home)}-argus-releases`);
}

/** A release id is a plain folder name, never a path. */
export function isReleaseId(id) {
  return typeof id === "string" && /^[\w.+-]+$/.test(id) && id !== "." && id !== "..";
}

/** The release `current.json` names, or null when none is pinned. */
export function readPointer(root) {
  const file = path.join(root, POINTER_FILE);
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    throw new BuildTargetError(`cannot read ${file}: ${e?.message ?? e}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BuildTargetError(`${file} is not valid JSON`);
  }
  if (!isReleaseId(parsed?.id)) throw new BuildTargetError(`${file} names no release id`);
  return { id: parsed.id };
}

/** A finished release: its directory exists and holds the manifest. */
export function isRelease(dir) {
  return existsSync(path.join(dir, RELEASE_MANIFEST));
}

/**
 * The tree to run. No pointer means the dev checkout (with a warning); a
 * pointer to a missing or unfinished release is an error, never a silent
 * fall back to the checkout, which is exactly what pinning exists to stop.
 */
export function resolveBuildRoot({ checkout, dev = false, env = process.env, homedir }) {
  if (dev) {
    return {
      kind: "dev",
      root: checkout,
      warning: "--dev: running the checkout, not the pinned release",
    };
  }
  const root = releasesRoot(env, homedir);
  const pointer = readPointer(root);
  if (pointer === null) {
    return {
      kind: "dev",
      root: checkout,
      warning:
        "no release is pinned: running the dev checkout, so rebuilding or switching branches moves running pipelines. Pin one with `argus release`.",
    };
  }
  const dir = path.join(root, pointer.id);
  if (!isRelease(dir)) {
    throw new BuildTargetError(
      `the pinned release ${pointer.id} is missing or unfinished (${dir} has no ${RELEASE_MANIFEST}).\n` +
        `    Pin another with \`argus release --use <id>\` (see \`argus release --list\`), or run the checkout with --dev.`,
    );
  }
  return { kind: "release", root: dir, id: pointer.id };
}
