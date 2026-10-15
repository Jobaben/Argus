import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildInfo } from "@argus/contracts";

/** The tree this server runs from: `<root>/server/{src,dist}/buildInfo.*`. */
export const BUILD_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Written last by `argus release`, so its presence marks a finished release. */
export const RELEASE_MANIFEST = "release.json";

function gitHead(root: string): string | null {
  try {
    const res = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    const sha = res.status === 0 ? res.stdout.trim() : "";
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Identifies the build at `root`: a release when `argus release` left its
 * manifest there, else the dev checkout. Derived from the directory rather
 * than an env var the launcher sets, so `npm run dev` and a bare
 * `node server/dist/index.js` report themselves correctly too.
 */
export function readBuildInfo(root: string = BUILD_ROOT, head = gitHead): BuildInfo {
  try {
    const m = JSON.parse(readFileSync(path.join(root, RELEASE_MANIFEST), "utf8")) as {
      id?: unknown;
      sha?: unknown;
    };
    if (typeof m.id === "string" && typeof m.sha === "string")
      return { kind: "release", sha: m.sha, dir: root, id: m.id };
  } catch {
    /* no manifest: a dev checkout */
  }
  return { kind: "dev", sha: head(root), dir: root };
}

/** Short form for logs and the lock file: the release id, or `dev@<sha7>`. */
export function buildLabel(info: BuildInfo): string {
  return info.kind === "release" && info.id ? info.id : `dev@${info.sha?.slice(0, 7) ?? "unknown"}`;
}
