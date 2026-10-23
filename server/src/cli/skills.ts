/**
 * `argus skills` — the I/O half. Reads the skills bundled with this build,
 * compares them with what each agent home holds, and installs or updates
 * them. See `skillsCore.ts` for the states and the rules.
 *
 * Claude Code and Codex discover skills the same way — a
 * `skills/<name>/SKILL.md` tree under the CLI's home, with `name` and
 * `description` frontmatter — so each skill is written once, in the dialect
 * both accept, and installed under whichever homes apply. The homes come from
 * the runtime registry (`ARGUS_CLAUDE_HOME`, `ARGUS_CODEX_HOME` / `CODEX_HOME`
 * honoured), so pointing Argus at a relocated CLI points the install there too.
 *
 * An update replaces the whole folder, so a file an older skill had and this
 * one dropped does not linger and mislead. It is written to a scratch folder
 * outside `skills/` first and swapped in, and a copy with edits of its own is
 * saved first. The scratch folder is removed once the swap is done.
 */

import { cp, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentSkillsResponse } from "@argus/contracts";
import { RUNTIMES } from "../runtimes/index.js";
import { probeCommand } from "../setup/prereqs.js";
import { VERSION } from "../version.js";
import {
  BUNDLED_SKILLS,
  INVOKE,
  MANIFEST_FILE,
  SKILL_RUNTIMES,
  SKILLS_HELP,
  classify,
  describeState,
  digestTree,
  needsBackup,
  parseManifest,
  parseSkillsArgs,
  renderTree,
  type BundledSkill,
  type SkillManifest,
  type SkillRuntime,
  type SkillState,
  type SkillTarget,
  type SkillTree,
} from "./skillsCore.js";

export interface SkillsIo {
  out: (line: string) => void;
  err: (line: string) => void;
  /** Is this CLI on PATH? Drives the default target; tests inject it. */
  probe?: (runtime: SkillRuntime) => boolean;
  now?: () => Date;
  /** The build whose skills are installed; tests point it elsewhere. */
  root?: string;
  /** Prefix of every line, so `argus tail --install-skill` reads as itself. */
  label?: string;
}

/** The build this module was loaded from, from either `src/cli` or `dist/cli`. */
export function argusRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export function bundledSkillDir(name: BundledSkill, root = argusRoot()): string {
  return path.join(root, ".claude", "skills", name);
}

/** Where a skill's folder lands for one runtime; `home` overrides the registry's answer. */
export function installedSkillDir(name: string, runtime: SkillRuntime, home?: string): string {
  return path.join(home ?? RUNTIMES[runtime].home(), "skills", name);
}

/** Copies with edits of their own go here, outside every `skills/` tree a CLI scans. */
export function skillBackupRoot(): string {
  return path.join(RUNTIMES.claude.home(), "argus", "skill-backups");
}

/** Every file under `dir`, keyed by POSIX path relative to it; null when `dir` is absent. */
async function readTree(dir: string): Promise<SkillTree | null> {
  const tree: SkillTree = new Map();
  async function walk(rel: string): Promise<void> {
    const entries = await readdir(path.join(dir, rel), { withFileTypes: true });
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(child);
      else if (e.isFile()) tree.set(child, await readFile(path.join(dir, child)));
    }
  }
  try {
    await walk("");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  return tree;
}

/** What this build would install for one skill. */
async function bundledTree(name: BundledSkill, root: string): Promise<SkillTree> {
  const tree = await readTree(bundledSkillDir(name, root));
  if (!tree || !tree.has("SKILL.md")) {
    throw new Error(
      `the bundled ${name} skill is missing at ${bundledSkillDir(name, root)} — reinstall Argus from git`,
    );
  }
  return renderTree(tree, root);
}

export interface SkillStatus {
  skill: BundledSkill;
  runtime: SkillRuntime;
  /** The installed folder (whether or not it exists). */
  dir: string;
  state: SkillState;
  /** The Argus version that installed it, when a manifest says. */
  installedVersion: string | null;
  /** Whether a manifest sits beside it, i.e. `argus skills` wrote it. */
  managed: boolean;
}

async function statusOf(
  name: BundledSkill,
  runtime: SkillRuntime,
  bundledDigest: string,
): Promise<SkillStatus> {
  const dir = installedSkillDir(name, runtime);
  const tree = await readTree(dir);
  const installed =
    tree && tree.size > 0
      ? {
          digest: digestTree(tree),
          manifest: parseManifest(tree.get(MANIFEST_FILE)?.toString("utf8")),
        }
      : null;
  return {
    skill: name,
    runtime,
    dir,
    state: classify(bundledDigest, installed),
    installedVersion: installed?.manifest?.argusVersion ?? null,
    managed: Boolean(installed?.manifest),
  };
}

/** Every named skill in every skill-reading home, compared with this build. */
export async function skillStatuses(
  names: readonly BundledSkill[] = BUNDLED_SKILLS,
  root = argusRoot(),
): Promise<SkillStatus[]> {
  const out: SkillStatus[] = [];
  for (const name of names) {
    const digest = digestTree(await bundledTree(name, root));
    for (const runtime of SKILL_RUNTIMES) out.push(await statusOf(name, runtime, digest));
  }
  return out;
}

function defaultProbe(runtime: SkillRuntime): boolean {
  const rt = RUNTIMES[runtime];
  return probeCommand(rt.bin(), rt.versionArgs).ok;
}

/**
 * Which homes a target names. `auto` is every CLI on PATH plus every home that
 * already holds one of the skills (an update reaches it even when its CLI is
 * not on this PATH), and Claude Code when that is none.
 */
export function resolveSkillTargets(
  target: SkillTarget,
  probe: (runtime: SkillRuntime) => boolean,
  alreadyThere: (runtime: SkillRuntime) => boolean = () => false,
): SkillRuntime[] {
  if (target === "all") return [...SKILL_RUNTIMES];
  if (target !== "auto") return [target];
  const found = SKILL_RUNTIMES.filter((rt) => probe(rt) || alreadyThere(rt));
  return found.length > 0 ? found : ["claude"];
}

export type InstallAction = "installed" | "updated" | "unchanged" | "failed";

export interface InstallResult {
  skill: BundledSkill;
  runtime: SkillRuntime;
  dir: string;
  action: InstallAction;
  /** The state found before installing. */
  was: SkillState;
  /** Where the replaced copy was saved, when it had edits of its own. */
  backup?: string;
  error?: string;
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[:.]/g, "-");
}

function writeManifest(dir: string, manifest: SkillManifest): Promise<void> {
  return writeFile(path.join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
}

const LOCKED = new Set(["EPERM", "EACCES", "EBUSY"]);

/** About five seconds in all: long enough for a CLI or a virus scanner to let go. */
export const LOCK_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1200, 2000];

/**
 * Runs `op` again while Windows reports a file in the folder open elsewhere —
 * a CLI loading a skill it just noticed, a virus scanner reading new files.
 */
export async function retryWhileLocked<T>(
  op: () => Promise<T>,
  delays: readonly number[] = LOCK_RETRY_DELAYS_MS,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await op();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= delays.length || !code || !LOCKED.has(code)) throw e;
      await sleep(delays[attempt]);
    }
  }
}

function removeTree(dir: string): Promise<void> {
  return rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/**
 * Scratch space for one home's installs: outside its `skills/` tree, which the
 * CLIs watch and load skills from, but on the same volume, so a swap is a rename.
 */
function stagingRoot(skillsDir: string): string {
  return path.join(path.dirname(skillsDir), "argus", "skill-staging");
}

/** Writes `tree` (plus its manifest) to `dir`, replacing whatever was there. */
async function writeSkill(
  name: BundledSkill,
  dir: string,
  tree: SkillTree,
  manifest: SkillManifest,
  hadOne: boolean,
): Promise<void> {
  const parent = path.dirname(dir);
  const scratch = stagingRoot(parent);
  const fresh = path.join(scratch, name);
  const old = path.join(scratch, `${name}.old`);
  await mkdir(parent, { recursive: true });
  // Older builds staged beside the skill, where Claude Code loaded it as one.
  await removeTree(path.join(parent, `.${name}.argus-staging`));
  await removeTree(fresh);
  await removeTree(old);
  for (const [rel, bytes] of tree) {
    const file = path.join(fresh, ...rel.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
  await writeManifest(fresh, manifest);

  // The old copy is moved aside rather than deleted, so a failed swap can put it back.
  let oldIsSpare = hadOne;
  try {
    if (hadOne) await retryWhileLocked(() => rename(dir, old));
    try {
      await retryWhileLocked(() => rename(fresh, dir));
    } catch (e) {
      if (hadOne) {
        oldIsSpare = false;
        await retryWhileLocked(() => rename(old, dir)).catch(() => {
          throw new Error(
            `${e instanceof Error ? e.message : String(e)} — the previous copy is at ${old}`,
          );
        });
      }
      throw e;
    }
  } finally {
    await removeTree(fresh).catch(() => {});
    if (oldIsSpare) await removeTree(old).catch(() => {});
    for (const empty of [scratch, path.dirname(scratch)]) await rmdir(empty).catch(() => {});
  }
}

/** Installs or updates each named skill in each target home. Never throws. */
export async function installSkills(
  names: readonly BundledSkill[],
  target: SkillTarget,
  io: SkillsIo,
): Promise<InstallResult[]> {
  const root = io.root ?? argusRoot();
  const now = (io.now ?? (() => new Date()))();
  const trees = new Map<BundledSkill, SkillTree>();
  for (const name of names) trees.set(name, await bundledTree(name, root));
  const before = new Map<string, SkillStatus>();
  for (const name of names) {
    const digest = digestTree(trees.get(name)!);
    for (const runtime of SKILL_RUNTIMES) {
      before.set(`${name}:${runtime}`, await statusOf(name, runtime, digest));
    }
  }
  const targets = resolveSkillTargets(target, io.probe ?? defaultProbe, (rt) =>
    names.some((n) => before.get(`${n}:${rt}`)!.state !== "missing"),
  );

  const results: InstallResult[] = [];
  for (const runtime of targets) {
    for (const name of names) {
      const { dir, state, managed } = before.get(`${name}:${runtime}`)!;
      const tree = trees.get(name)!;
      const manifest: SkillManifest = {
        skill: name,
        digest: digestTree(tree),
        argusVersion: VERSION,
        argusRoot: root,
        installedAt: now.toISOString(),
      };
      if (state === "current") {
        // Identical, but copied by hand: adopt it, so a later update knows it
        // holds nothing of its own. Best effort — the skill itself is fine.
        if (!managed) await writeManifest(dir, manifest).catch(() => {});
        results.push({ skill: name, runtime, dir, action: "unchanged", was: state });
        continue;
      }
      const result: InstallResult = {
        skill: name,
        runtime,
        dir,
        action: state === "missing" ? "installed" : "updated",
        was: state,
      };
      try {
        if (needsBackup(state)) {
          const backup = path.join(skillBackupRoot(), runtime, `${name}-${stamp(now)}`);
          await mkdir(path.dirname(backup), { recursive: true });
          await cp(dir, backup, { recursive: true });
          result.backup = backup;
        }
        await writeSkill(name, dir, tree, manifest, state !== "missing");
      } catch (e) {
        result.action = "failed";
        result.error = e instanceof Error ? e.message : String(e);
      }
      results.push(result);
    }
  }
  return results;
}

/**
 * For the dashboard: every bundled skill in each home an install would write
 * to — CLIs on PATH, plus homes that already hold one — so "up to date" is
 * something one press of Install can make true, never a home it would skip.
 */
export async function agentSkills(
  probe: (runtime: SkillRuntime) => boolean,
  root = argusRoot(),
): Promise<AgentSkillsResponse> {
  const all = await skillStatuses(BUNDLED_SKILLS, root);
  const targets = resolveSkillTargets("auto", probe, (rt) =>
    all.some((s) => s.runtime === rt && s.state !== "missing"),
  );
  const skills = all.filter((s) => targets.includes(s.runtime));
  return { skills, upToDate: skills.every((s) => s.state === "current") };
}

// ── Rendering ────────────────────────────────────────────────────────────────

function where(name: string, runtime: SkillRuntime, dir: string): string {
  return `the ${name} skill for ${RUNTIMES[runtime].label} at ${path.join(dir, "SKILL.md")}`;
}

export function installLine(r: InstallResult): string {
  switch (r.action) {
    case "installed":
      return `installed ${where(r.skill, r.runtime, r.dir)}`;
    case "unchanged":
      return `${where(r.skill, r.runtime, r.dir)} is already up to date`;
    case "updated":
      return r.backup
        ? `updated ${where(r.skill, r.runtime, r.dir)} — the copy it replaced was ${describeState(r.was)}, and is saved at ${r.backup}`
        : `updated ${where(r.skill, r.runtime, r.dir)} (it was ${describeState(r.was)})`;
    case "failed":
      return `could not write ${where(r.skill, r.runtime, r.dir)}: ${r.error ?? "unknown error"}`;
  }
}

/** Prints the outcome of an install the way both `argus skills` and `argus tail` do. */
export function reportInstall(
  results: readonly InstallResult[],
  target: SkillTarget,
  io: SkillsIo,
): number {
  const label = io.label ?? "argus skills";
  for (const r of results) {
    (r.action === "failed" ? io.err : io.out)(`[${label}] ${installLine(r)}`);
  }
  if (results.some((r) => r.action === "failed")) return 1;
  const runtimes = [...new Set(results.map((r) => r.runtime))];
  const skills = [...new Set(results.map((r) => r.skill))];
  for (const skill of skills) {
    const how = runtimes.map((rt) => `${INVOKE[rt](skill)} in ${RUNTIMES[rt].label}`).join(", ");
    io.out(`[${label}] invoke ${skill} by name with ${how}; a new session picks it up`);
  }
  if (target === "auto" && runtimes.length < SKILL_RUNTIMES.length) {
    const skipped = SKILL_RUNTIMES.filter((rt) => !runtimes.includes(rt));
    io.out(
      `[${label}] skipped ${skipped.map((rt) => RUNTIMES[rt].label).join(", ")} (CLI not found on PATH) — add --for all to install regardless`,
    );
  }
  return 0;
}

function statusLine(s: SkillStatus): string {
  const version = s.installedVersion ? ` (installed by Argus ${s.installedVersion})` : "";
  return `${s.skill} · ${RUNTIMES[s.runtime].label}: ${describeState(s.state)}${s.state === "missing" ? "" : version} — ${s.dir}`;
}

/** The line a server prints at startup when an installed skill has fallen behind it. */
export function staleSkillsNotice(statuses: readonly SkillStatus[]): string | null {
  const stale = statuses.filter((s) => s.state !== "missing" && s.state !== "current");
  if (stale.length === 0) return null;
  const which = stale.map((s) => `${s.skill} (${RUNTIMES[s.runtime].label})`).join(", ");
  return `installed agent skills do not match this build: ${which} — run \`argus skills install\` to update them`;
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function runSkills(argv: string[], io: SkillsIo): Promise<number> {
  const parsed = parseSkillsArgs(argv);
  if (parsed.kind === "help") {
    io.out(SKILLS_HELP);
    return 0;
  }
  if (parsed.kind === "error") {
    io.err(`[argus skills] ${parsed.message}`);
    return 2;
  }
  const { command, skills, target, json } = parsed.options;
  try {
    if (command === "status") {
      const statuses = await skillStatuses(skills, io.root ?? argusRoot());
      for (const s of statuses) io.out(json ? JSON.stringify(s) : statusLine(s));
      if (!json && statuses.some((s) => s.state !== "current")) {
        io.out("`argus skills install` installs the missing ones and updates the rest");
      }
      return 0;
    }
    const results = await installSkills(skills, target, io);
    if (json) {
      for (const r of results) (r.action === "failed" ? io.err : io.out)(JSON.stringify(r));
      return results.some((r) => r.action === "failed") ? 1 : 0;
    }
    return reportInstall(results, target, io);
  } catch (e) {
    io.err(`[argus skills] ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

export async function main(argv: string[]): Promise<number> {
  return runSkills(argv, {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  });
}

const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(`[argus skills] ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
