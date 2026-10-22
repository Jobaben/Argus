/**
 * `argus skills` — the pure half: which skills Argus ships, how an installed
 * copy compares with the bundled one, argument parsing and rendering.
 * `skills.ts` reads and writes the trees.
 *
 * A skill is a folder, `skills/<name>/SKILL.md` plus whatever it links to,
 * under an agent CLI's home. Argus ships its skills in the repository
 * (`.claude/skills/<name>/`), so every build — checkout or pinned release —
 * carries the skills that describe *that* build. Installing writes the folder
 * into each agent home with a small manifest beside it; the manifest's digest
 * is what tells "older than this build" apart from "edited by hand", so an
 * update never silently throws away someone's edits.
 */

import { createHash } from "node:crypto";

/** The CLIs that read a `skills/<name>/SKILL.md` tree under their home. */
export const SKILL_RUNTIMES = ["claude", "codex"] as const;
export type SkillRuntime = (typeof SKILL_RUNTIMES)[number];
export type SkillTarget = SkillRuntime | "all" | "auto";

/** Every skill shipped under `.claude/skills/`, in the order they are listed. */
export const BUNDLED_SKILLS = ["argus-pipeline", "argus-tail"] as const;
export type BundledSkill = (typeof BUNDLED_SKILLS)[number];

/** Written into each installed skill folder; never part of the skill itself. */
export const MANIFEST_FILE = ".argus-skill.json";

/**
 * Replaced, at install time, with the absolute path of the build the skill
 * came from, so an installed skill can point its reader at that build's docs.
 */
export const ROOT_PLACEHOLDER = "{{argusRoot}}";

/** How a skill is invoked by name in each CLI. */
export const INVOKE: Record<SkillRuntime, (name: string) => string> = {
  claude: (name) => `/${name}`,
  codex: (name) => `$${name}`,
};

export function parseSkillTarget(raw: string | undefined): SkillTarget | null {
  if (raw === undefined || raw === "") return "auto";
  const v = raw.trim().toLowerCase();
  if (v === "all" || v === "auto") return v;
  return (SKILL_RUNTIMES as readonly string[]).includes(v) ? (v as SkillRuntime) : null;
}

export function isBundledSkill(name: string): name is BundledSkill {
  return (BUNDLED_SKILLS as readonly string[]).includes(name);
}

// ── Trees and digests ────────────────────────────────────────────────────────

/** A skill folder as relative POSIX path → bytes. */
export type SkillTree = Map<string, Buffer>;

/** The bundled tree as it lands on disk: the build's path in place of the placeholder. */
export function renderTree(tree: SkillTree, argusRoot: string): SkillTree {
  const root = argusRoot.replace(/\\/g, "/");
  const out: SkillTree = new Map();
  for (const [rel, bytes] of tree) {
    const text = bytes.toString("utf8");
    out.set(
      rel,
      text.includes(ROOT_PLACEHOLDER)
        ? Buffer.from(text.replaceAll(ROOT_PLACEHOLDER, root))
        : bytes,
    );
  }
  return out;
}

/** One digest for a whole tree: order-independent, the manifest left out. */
export function digestTree(tree: SkillTree): string {
  const hash = createHash("sha256");
  for (const rel of [...tree.keys()].filter((k) => k !== MANIFEST_FILE).sort()) {
    hash.update(rel);
    hash.update("\0");
    hash.update(tree.get(rel)!);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export interface SkillManifest {
  skill: string;
  /** Digest of the tree as it was written, so a later edit shows. */
  digest: string;
  argusVersion: string;
  argusRoot: string;
  installedAt: string;
}

export function parseManifest(raw: string | undefined): SkillManifest | null {
  if (raw === undefined) return null;
  try {
    const m = JSON.parse(raw) as Partial<SkillManifest>;
    return typeof m.digest === "string" && typeof m.skill === "string"
      ? (m as SkillManifest)
      : null;
  } catch {
    return null;
  }
}

/**
 * - `missing`   — nothing installed there.
 * - `current`   — byte for byte what this build would install.
 * - `outdated`  — what an earlier Argus installed, untouched since.
 * - `modified`  — installed by Argus, then edited.
 * - `unmanaged` — installed some other way (by hand, or by an Argus that
 *                 wrote no manifest) and different from this build's.
 */
export type SkillState = "missing" | "current" | "outdated" | "modified" | "unmanaged";

export function classify(
  bundledDigest: string,
  installed: { digest: string; manifest: SkillManifest | null } | null,
): SkillState {
  if (!installed) return "missing";
  if (installed.digest === bundledDigest) return "current";
  if (!installed.manifest) return "unmanaged";
  return installed.manifest.digest === installed.digest ? "outdated" : "modified";
}

/** Whether replacing the installed copy would lose something only it has. */
export function needsBackup(state: SkillState): boolean {
  return state === "modified" || state === "unmanaged";
}

const STATE_TEXT: Record<SkillState, string> = {
  missing: "not installed",
  current: "up to date",
  outdated: "older than this build",
  modified: "older than this build, and edited since it was installed",
  unmanaged: "different from this build (not installed by `argus skills`)",
};

export function describeState(state: SkillState): string {
  return STATE_TEXT[state];
}

// ── Arguments ────────────────────────────────────────────────────────────────

export const SKILLS_HELP = `argus skills — install or update the agent skills Argus ships

Usage: argus skills [status] [--json]
       argus skills install [<skill>...] [--for claude|codex|all] [--json]

Skills: ${BUNDLED_SKILLS.join(", ")}
  argus-pipeline  author, repair and run Argus pipelines correctly
  argus-tail      watch what Argus is doing and relay it

status (the default) says, for every skill and agent home, whether the
installed copy is missing, up to date, older than this build, or edited.

install writes every skill named (all of them when none is) into each agent
home: a missing skill is installed, an older one is replaced, an up-to-date
one is left alone. A copy that was edited, or installed some other way, is
saved under the Claude home's argus/skill-backups/ before it is replaced.

  --for <target>   claude, codex or all. Default: every CLI found on PATH,
                   plus every home that already has one of the skills
                   (Claude Code when that is none).
  --json           one JSON object per skill and home instead of text
  --help           show this help

Homes: $ARGUS_CLAUDE_HOME/skills (~/.claude/skills) and
$ARGUS_CODEX_HOME or $CODEX_HOME/skills (~/.codex/skills).

Exit status: 0 done, 1 a skill could not be written, 2 bad arguments.`;

export interface SkillsOptions {
  command: "status" | "install";
  skills: BundledSkill[];
  target: SkillTarget;
  json: boolean;
}

export type ParsedSkillsArgs =
  { kind: "run"; options: SkillsOptions } | { kind: "help" } | { kind: "error"; message: string };

export function parseSkillsArgs(argv: string[]): ParsedSkillsArgs {
  let command: SkillsOptions["command"] | null = null;
  const names: string[] = [];
  let target: SkillTarget = "auto";
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (flag === "--help" || flag === "-h") return { kind: "help" };
    if (flag === "--json") {
      json = true;
      continue;
    }
    if (flag === "--for") {
      const raw = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++i];
      const t = raw === undefined || raw.startsWith("--") ? null : parseSkillTarget(raw);
      if (t === null || t === "auto") {
        return {
          kind: "error",
          message: `--for takes ${SKILL_RUNTIMES.join(", ")} or all, got "${raw ?? ""}"`,
        };
      }
      target = t;
      continue;
    }
    if (arg.startsWith("-")) {
      return { kind: "error", message: `unknown option "${arg}" (try --help)` };
    }
    if (command === null) {
      if (arg !== "status" && arg !== "install" && arg !== "update") {
        return {
          kind: "error",
          message: `unknown command "${arg}" — expected status or install (try --help)`,
        };
      }
      // `update` reads naturally for a skill that is already there; it is install.
      command = arg === "status" ? "status" : "install";
      continue;
    }
    if (command === "status") {
      return { kind: "error", message: `status takes no skill names, got "${arg}"` };
    }
    names.push(arg);
  }
  const unknown = names.filter((n) => !isBundledSkill(n));
  if (unknown.length > 0) {
    return {
      kind: "error",
      message: `no bundled skill named ${unknown.map((n) => `"${n}"`).join(", ")} — Argus ships ${BUNDLED_SKILLS.join(", ")}`,
    };
  }
  const skills = names.length > 0 ? [...new Set(names as BundledSkill[])] : [...BUNDLED_SKILLS];
  return { kind: "run", options: { command: command ?? "status", skills, target, json } };
}
