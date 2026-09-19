/**
 * Isolated working trees for a phase's steps.
 *
 * Every phase of a pipeline has historically run in the same checkout: the
 * `cwd` its author declared. That is fine for a pipeline that reads, and wrong
 * for one that writes — two branches of a fan-out edit the same files, and a
 * failed attempt leaves its half-done edits for the next one to trip over. A
 * phase (or a whole pipeline) that declares a {@link WorkspacePolicy} instead
 * gets a git worktree of its own: a real directory, on a branch of the
 * repository at `cwd`, created before the phase's first step launches.
 *
 * The deliverable is the **branch**. The directory is disposable — removed when
 * the instance settles unless `keep` says otherwise — so anything the agent
 * left uncommitted in it is gone with it. Nothing here decides *when* any of
 * this happens: like the rest of `harness/`, this module only does what the
 * engine asks, and every git call goes through `child_process` (no new
 * dependency, and the same discipline `verification.ts` already uses).
 */

import { spawn as nodeSpawn } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { paths } from "../claudeHome.js";
import { safeSegment } from "./invocation.js";
import type {
  PhaseDef,
  PipelineDefinition,
  PipelineInstance,
  WorkspacePolicy,
  WorkspaceRecord,
} from "../sources/pipelineTypes.js";

/** A worktree Argus could not create or remove, with git's own words kept. */
export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

/** Wall-clock limit for one git invocation. A worktree add is local work. */
const GIT_TIMEOUT_MS = 60_000;

function runGit(
  args: string[],
  cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = nodeSpawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      resolve({ code: null, stdout: "", stderr: e instanceof Error ? e.message : String(e) });
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, GIT_TIMEOUT_MS);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr || err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** git's complaint, trimmed to one readable line, so a `configuration` failure
 *  says what git said rather than only that git said no. */
function gitReason(stderr: string, stdout: string): string {
  const text = (stderr.trim() || stdout.trim()).replace(/\s+/g, " ").trim();
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

// ── Names and paths ──────────────────────────────────────────────────────────

/**
 * One component of a branch name, derived from an identifier.
 *
 * {@link safeSegment} already reduces it to `[A-Za-z0-9._-]`, which is all a
 * path join needs; a git ref has two rules beyond that — a component may not
 * start with `.` nor end with `.lock` — and breaking either makes
 * `git worktree add` fail with a message about ref format rather than about
 * the pipeline. Enforced here so the branch is always nameable.
 */
export function refSegment(id: string): string {
  let s = safeSegment(id).replace(/^\.+/, "");
  s = s.replace(/\.lock$/i, "_lock");
  return s === "" ? "_" : s;
}

/** The directory holding every worktree of one instance. */
export function instanceWorktreesDir(root: string, instanceId: string): string {
  return path.join(root, safeSegment(instanceId));
}

/**
 * The directory name of one worktree: the single tree an `instance`-scoped
 * pipeline shares, or one per phase attempt.
 */
export function worktreeDirName(
  scope: WorkspacePolicy["scope"],
  phaseId: string,
  attempt: number,
): string {
  if (scope === "instance") return "shared";
  return `${safeSegment(phaseId)}-attempt${Math.max(0, Math.trunc(attempt))}`;
}

/** The branch a worktree's work lands on. Named for what it is: this instance's
 *  shared branch, or this phase attempt's own. */
export function worktreeBranch(
  scope: WorkspacePolicy["scope"],
  instanceId: string,
  phaseId: string,
  attempt: number,
): string {
  const inst = refSegment(instanceId);
  if (scope === "instance") return `argus/${inst}/shared`;
  return `argus/${inst}/${refSegment(phaseId)}/${Math.max(0, Math.trunc(attempt))}`;
}

export interface WorkspaceTarget {
  path: string;
  branch: string;
}

/**
 * Where one phase attempt's worktree goes and what its branch is called —
 * pure, so the engine, the cleanup pass and the tests all agree on the answer
 * without touching a repository.
 */
export function workspaceTarget(input: {
  root: string;
  instanceId: string;
  phaseId: string;
  attempt: number;
  policy: WorkspacePolicy;
}): WorkspaceTarget {
  const { root, instanceId, phaseId, attempt, policy } = input;
  const dir = worktreeDirName(policy.scope, phaseId, attempt);
  return {
    path: path.join(instanceWorktreesDir(root, instanceId), dir),
    branch: worktreeBranch(policy.scope, instanceId, phaseId, attempt),
  };
}

/**
 * A worktree path must stay under the worktrees root — the same containment
 * rule the artifact reader and the `artifact` check apply to their own roots.
 * Everything here runs `git worktree remove --force` and deletes directories;
 * a path that escaped the root would do that somewhere Argus does not own.
 */
export function assertInsideWorktreesRoot(root: string, target: string): void {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(target);
  const back = path.relative(resolvedRoot, resolved);
  if (back === "" || back.startsWith("..") || path.isAbsolute(back)) {
    throw new WorkspaceError(`workspace path escapes the worktrees directory: ${target}`);
  }
}

// ── Git operations ───────────────────────────────────────────────────────────

export interface CreateWorktreeInput {
  /** The repository the worktree is cut from: the phase's own `cwd`. */
  repoCwd: string;
  path: string;
  branch: string;
  /** Ref to cut from. Default `HEAD` of the repository at `repoCwd`. */
  base?: string;
  /** The root every worktree must stay under. Defaults to Argus's own. */
  root?: string;
}

/** Is `dir` the top level of a git worktree? Used to tell "a tree Argus already
 *  made" from "a directory in the way". */
async function worktreeHead(dir: string): Promise<{ top: string; branch: string } | null> {
  const top = await runGit(["rev-parse", "--show-toplevel"], dir);
  if (top.code !== 0) return null;
  const branch = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], dir);
  return { top: top.stdout.trim(), branch: branch.code === 0 ? branch.stdout.trim() : "" };
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create (or re-attach) the worktree for one phase attempt.
 *
 * Idempotent on purpose, because Argus restarts: a directory that is already
 * this branch's worktree is reused as it stands, and a branch that exists
 * without a directory (its tree removed, the work kept) is checked out again
 * rather than being recreated from the base — the first attempt's commits are
 * the point of keeping the branch.
 *
 * Every failure is a {@link WorkspaceError} carrying git's own stderr: the
 * engine turns it into a `configuration` failure, and a pipeline author reading
 * "fatal: invalid reference: nope" can fix their `base` without guessing.
 */
export async function createWorktree(input: CreateWorktreeInput): Promise<WorkspaceRecord> {
  const root = input.root ?? paths.worktreesDir();
  assertInsideWorktreesRoot(root, input.path);

  const top = await runGit(["rev-parse", "--show-toplevel"], input.repoCwd);
  if (top.code !== 0) {
    throw new WorkspaceError(
      `workspace: "${input.repoCwd}" is not inside a git work tree${
        gitReason(top.stderr, top.stdout) ? ` (${gitReason(top.stderr, top.stdout)})` : ""
      }`,
    );
  }

  const base = input.base?.trim() || "HEAD";
  const resolved = await runGit(
    ["rev-parse", "--verify", "--quiet", `${base}^{commit}`],
    top.stdout.trim(),
  );
  const baseHead = resolved.stdout.trim();
  if (resolved.code !== 0 || !baseHead) {
    throw new WorkspaceError(
      `workspace: cannot resolve base "${base}" in ${top.stdout.trim()}${
        gitReason(resolved.stderr, "") ? ` (${gitReason(resolved.stderr, "")})` : ""
      }`,
    );
  }

  const record: WorkspaceRecord = { path: input.path, branch: input.branch, base, baseHead };

  if (await exists(input.path)) {
    const head = await worktreeHead(input.path);
    if (head && path.resolve(head.top) === path.resolve(input.path)) return record;
    throw new WorkspaceError(
      `workspace: ${input.path} already exists and is not a git worktree Argus can reuse`,
    );
  }

  await mkdir(path.dirname(input.path), { recursive: true });
  const hasBranch = await runGit(
    ["rev-parse", "--verify", "--quiet", `refs/heads/${input.branch}`],
    top.stdout.trim(),
  );
  const args =
    hasBranch.code === 0
      ? ["worktree", "add", input.path, input.branch]
      : ["worktree", "add", "-b", input.branch, input.path, baseHead];
  const added = await runGit(args, top.stdout.trim());
  if (added.code !== 0) {
    throw new WorkspaceError(
      `workspace: git worktree add failed for ${input.path}: ${
        gitReason(added.stderr, added.stdout) || `git exited ${added.code}`
      }`,
    );
  }
  return record;
}

export interface RemoveWorktreeInput {
  repoCwd: string;
  path: string;
  root?: string;
}

/**
 * Remove one worktree directory, keeping its branch.
 *
 * Idempotent: a path that is already gone still runs `git worktree prune`, so
 * the repository's administrative records do not accumulate stale entries
 * after a directory was deleted by hand (or by a `rm -rf` of a temp dir).
 * `--force` because the whole point is that uncommitted work in a disposable
 * tree is disposable — what the phase meant to keep, it committed to the
 * branch, which this never touches.
 */
export async function removeWorktree(input: RemoveWorktreeInput): Promise<void> {
  const root = input.root ?? paths.worktreesDir();
  assertInsideWorktreesRoot(root, input.path);

  if (await exists(input.path)) {
    const removed = await runGit(["worktree", "remove", "--force", input.path], input.repoCwd);
    if (removed.code !== 0) {
      // git can refuse (a worktree from another repository, a locked one); the
      // directory is Argus's own, so it goes anyway and `prune` tidies the
      // registration below.
      await rm(input.path, { recursive: true, force: true });
    }
  }
  await runGit(["worktree", "prune"], input.repoCwd);
  if (await exists(input.path)) {
    throw new WorkspaceError(`workspace: could not remove the worktree at ${input.path}`);
  }
}

// ── Cleanup planning ─────────────────────────────────────────────────────────

/** The policy in force for one phase: its own, else the pipeline's. */
export function workspacePolicyFor(
  def: Pick<PipelineDefinition, "workspace">,
  phaseDef: Pick<PhaseDef, "workspace"> | undefined,
): WorkspacePolicy | undefined {
  return phaseDef?.workspace ?? def.workspace;
}

export interface WorkspaceRemoval {
  /** The repository to run `git worktree remove` in. */
  repoCwd: string;
  path: string;
  branch: string;
}

/**
 * Every worktree of an instance that should not outlive it.
 *
 * Pure, and deliberately keyed by path: an `instance`-scoped tree is recorded
 * on the instance *and* on every phase that used it, and one phase declaring
 * `keep` keeps the shared directory for all of them — the more conservative
 * reading, because a directory kept by mistake costs disk, and one removed by
 * mistake costs whatever was never committed.
 */
export function plannedRemovals(
  def: Pick<PipelineDefinition, "workspace" | "phases">,
  inst: Pick<PipelineInstance, "phases" | "workspace">,
): WorkspaceRemoval[] {
  const phaseDefById = new Map(def.phases.map((p) => [p.id, p]));
  const removals = new Map<string, WorkspaceRemoval>();
  const kept = new Set<string>();

  const consider = (record: WorkspaceRecord, phaseId: string | null) => {
    const phaseDef = phaseId === null ? undefined : phaseDefById.get(phaseId);
    const policy = workspacePolicyFor(def, phaseDef);
    // A repository to act in: the phase's own cwd, else any phase that shares
    // this tree, else the first phase the definition has. Without one there is
    // nothing to ask git in, so the tree is left alone.
    const repoCwd =
      phaseDef?.cwd ??
      def.phases.find((p) => p.workspace?.scope === "instance")?.cwd ??
      def.phases[0]?.cwd;
    if (!repoCwd) return;
    if (policy?.keep === true) {
      kept.add(record.path);
      return;
    }
    removals.set(record.path, { repoCwd, path: record.path, branch: record.branch });
  };

  for (const phase of inst.phases) {
    if (phase.workspace) consider(phase.workspace, phase.id);
  }
  if (inst.workspace) {
    // The shared tree: kept when any phase that opted in asked to keep it.
    const sharedKeep = [def.workspace, ...def.phases.map((p) => p.workspace)].some(
      (w) => w?.scope === "instance" && w.keep === true,
    );
    if (sharedKeep) kept.add(inst.workspace.path);
    else consider(inst.workspace, null);
  }

  return [...removals.values()].filter((r) => !kept.has(r.path));
}
