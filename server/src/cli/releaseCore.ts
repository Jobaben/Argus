/**
 * `argus release` — the pure half: argument parsing, naming, the smoke list
 * and the rendering. `release.ts` performs the effects.
 *
 * A release is one commit extracted with `git archive` into its own folder
 * under the releases root, installed and built there once, and pinned by
 * `current.json`. The launcher then runs it instead of the checkout, so work
 * in the checkout no longer moves running pipelines.
 */

import { isReleaseId } from "../../../bin/lib/buildTarget.mjs";

export const RELEASE_HELP = `argus release — build a commit into its own folder and pin it

Usage: argus release [--ref <ref>]   build <ref> (default HEAD) and pin it
       argus release --list          list the built releases; * marks the pinned one
       argus release --use <id>      pin an already built release (roll back or forward)

A release is extracted from the commit with \`git archive\`, so uncommitted
changes are never in it. It is installed and built in place under
~/.claude-argus-releases/<version>-<sha7>/ and never moved or deleted:
runs it launched keep their hook path inside it. Restart \`argus\` to run a
newly pinned release; \`argus --dev\` runs the checkout instead.`;

export type ReleaseCommand =
  | { kind: "help" }
  | { kind: "error"; message: string }
  | { kind: "cut"; ref: string }
  | { kind: "list" }
  | { kind: "use"; id: string };

export function parseReleaseArgs(argv: string[]): ReleaseCommand {
  let ref: string | null = null;
  let mode: "cut" | "list" | "use" = "cut";
  let id = "";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    const value = (): string | null => {
      if (arg.includes("=")) return arg.slice(arg.indexOf("=") + 1);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) return null;
      i++;
      return next;
    };
    switch (flag) {
      case "--help":
      case "-h":
        return { kind: "help" };
      case "--list":
        mode = "list";
        break;
      case "--ref": {
        const v = value();
        if (!v) return { kind: "error", message: "--ref needs a value" };
        ref = v;
        break;
      }
      case "--use": {
        const v = value();
        if (!v) return { kind: "error", message: "--use needs a release id (see --list)" };
        mode = "use";
        id = v;
        break;
      }
      default:
        return { kind: "error", message: `unknown argument "${arg}" (try --help)` };
    }
  }
  if (mode !== "cut" && ref !== null)
    return { kind: "error", message: "--ref only applies when building a release" };
  if (mode === "list") return { kind: "list" };
  if (mode === "use") {
    if (!isReleaseId(id)) return { kind: "error", message: `"${id}" is not a release id` };
    return { kind: "use", id };
  }
  return { kind: "cut", ref: ref ?? "HEAD" };
}

/** `<version>-<sha7>`: readable, and unique per commit. */
export function releaseId(version: string, sha: string): string {
  return `${version}-${sha.slice(0, 7)}`;
}

/** What `release.json` records; written last, so it marks a finished build. */
export interface ReleaseManifest {
  id: string;
  version: string;
  sha: string;
  ref: string;
  builtAt: string;
}

export interface ReleasePointer {
  id: string;
  pinnedAt: string;
  /** The release pinned before this one, for a one-step rollback. */
  previous: string | null;
}

/**
 * What a finished build must contain. Every path is checked for existence;
 * `version.js` is also imported. `index.js` is never imported: that would start
 * a server and take the state lock.
 */
export const SMOKE_PATHS: readonly string[] = [
  "server/dist/index.js",
  "server/dist/version.js",
  "server/dist/cli/tail.js",
  "server/dist/cli/gate.js",
  "web/dist/index.html",
  "hooks/argus-signal.mjs",
  ".claude/skills",
];

/** Numeric `x.y.z` comparison; anything unparseable compares equal. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => /^(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1).map(Number) ?? null;
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/** The rollback note: an older build can read a newer store as empty. */
export function rollbackWarning(from: ReleaseManifest | null, to: ReleaseManifest): string | null {
  if (!from || compareVersions(to.version, from.version) >= 0) return null;
  return (
    `${to.id} is older than ${from.id}: an older build may read data a newer one wrote as empty ` +
    `(the Knowledge Ledger does). Nothing is deleted, and pinning ${from.id} again shows it. See docs/RELEASING.md.`
  );
}

export function renderList(releases: ReleaseManifest[], pinned: string | null): string[] {
  if (releases.length === 0) return ["no releases built yet — `argus release` builds one"];
  return [...releases]
    .sort((a, b) => a.builtAt.localeCompare(b.builtAt))
    .map((r) => `${r.id === pinned ? "*" : " "} ${r.id}  ${r.ref}  built ${r.builtAt}`);
}
