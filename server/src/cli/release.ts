/**
 * `argus release` — the I/O half. See `releaseCore.ts` for what a release is.
 * Every effect comes through `ReleaseIo`, so the test drives it with a fake
 * build step and one real `git archive`.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  isRelease,
  POINTER_FILE,
  readPointer,
  RELEASE_MANIFEST,
  releasesRoot,
} from "../../../bin/lib/buildTarget.mjs";
import { atomicWriteJson } from "../sources/atomicWrite.js";
import {
  parseReleaseArgs,
  RELEASE_HELP,
  releaseId,
  renderList,
  rollbackWarning,
  SMOKE_PATHS,
  type ReleaseManifest,
  type ReleasePointer,
} from "./releaseCore.js";

export interface ProcResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface ReleaseIo {
  /** The checkout releases are cut from. */
  checkout: string;
  /** Where releases live (`releasesRoot()`). */
  root: string;
  git: (args: string[], cwd: string) => Promise<ProcResult>;
  /** `git archive <sha> | tar -x` into `dest`, which exists and is empty. */
  extract: (sha: string, dest: string) => Promise<void>;
  /** `npm ci && npm run build` in `dir`; resolves to the first failing status, or 0. */
  build: (dir: string) => Promise<number>;
  /** Imports a module, for the smoke check. */
  importModule: (file: string) => Promise<Record<string, unknown>>;
  now: () => Date;
  out: (line: string) => void;
  err: (line: string) => void;
}

class ReleaseError extends Error {}

async function readManifest(dir: string): Promise<ReleaseManifest | null> {
  try {
    return JSON.parse(await readFile(path.join(dir, RELEASE_MANIFEST), "utf8")) as ReleaseManifest;
  } catch {
    return null;
  }
}

async function pin(io: ReleaseIo, manifest: ReleaseManifest): Promise<void> {
  const current = readPointer(io.root);
  if (current?.id === manifest.id) {
    io.out(`[argus release] ${manifest.id} is already pinned`);
    return;
  }
  const from = current ? await readManifest(path.join(io.root, current.id)) : null;
  const warning = rollbackWarning(from, manifest);
  if (warning) io.err(`[argus release] WARNING: ${warning}`);
  const pointer: ReleasePointer = {
    id: manifest.id,
    pinnedAt: io.now().toISOString(),
    previous: current?.id ?? null,
  };
  await atomicWriteJson(path.join(io.root, POINTER_FILE), pointer);
  io.out(`[argus release] pinned ${manifest.id} — restart argus to run it`);
}

async function smoke(io: ReleaseIo, dir: string, version: string): Promise<void> {
  const missing = SMOKE_PATHS.filter((p) => !existsSync(path.join(dir, p)));
  if (missing.length > 0) throw new ReleaseError(`the build is missing ${missing.join(", ")}`);
  const mod = await io.importModule(path.join(dir, "server", "dist", "version.js"));
  if (mod.VERSION !== version)
    throw new ReleaseError(
      `server/dist/version.js reports ${String(mod.VERSION)}, expected ${version}`,
    );
}

async function cut(io: ReleaseIo, ref: string): Promise<void> {
  const rev = await io.git(["rev-parse", "--verify", `${ref}^{commit}`], io.checkout);
  const sha = rev.stdout.trim();
  if (rev.status !== 0 || !/^[0-9a-f]{40}$/.test(sha))
    throw new ReleaseError(`cannot resolve "${ref}" to a commit`);
  const status = await io.git(["status", "--porcelain"], io.checkout);
  if (status.stdout.trim().length > 0)
    io.err(
      "[argus release] WARNING: the checkout has uncommitted changes; the release contains only the commit",
    );
  const pkg = await io.git(["show", `${sha}:package.json`], io.checkout);
  const version =
    pkg.status === 0 ? (JSON.parse(pkg.stdout) as { version?: unknown }).version : null;
  if (typeof version !== "string") throw new ReleaseError(`${ref} has no package.json version`);

  const id = releaseId(version, sha);
  const dir = path.join(io.root, id);
  if (isRelease(dir)) {
    io.out(`[argus release] ${id} is already built`);
    const manifest = await readManifest(dir);
    if (!manifest) throw new ReleaseError(`${dir}/${RELEASE_MANIFEST} is unreadable`);
    await pin(io, manifest);
    return;
  }
  // A folder without a manifest is an earlier attempt that never finished. It
  // was never pinned, so no run can reference it.
  if (existsSync(dir)) {
    io.out(`[argus release] removing an unfinished build of ${id}`);
    await rm(dir, { recursive: true, force: true });
  }
  await mkdir(dir, { recursive: true });
  io.out(`[argus release] extracting ${sha.slice(0, 7)} (${ref}) into ${dir}`);
  await io.extract(sha, dir);
  io.out("[argus release] installing and building — this takes a few minutes");
  const built = await io.build(dir);
  if (built !== 0)
    throw new ReleaseError(`the build failed (exit ${built}); ${dir} is left for inspection`);
  await smoke(io, dir, version);
  const manifest: ReleaseManifest = { id, version, sha, ref, builtAt: io.now().toISOString() };
  await atomicWriteJson(path.join(dir, RELEASE_MANIFEST), manifest);
  io.out(`[argus release] built ${id}`);
  await pin(io, manifest);
}

async function list(io: ReleaseIo): Promise<void> {
  const entries = await readdir(io.root, { withFileTypes: true }).catch(() => []);
  const manifests = (
    await Promise.all(
      entries.filter((e) => e.isDirectory()).map((e) => readManifest(path.join(io.root, e.name))),
    )
  ).filter((m): m is ReleaseManifest => m !== null);
  for (const line of renderList(manifests, readPointer(io.root)?.id ?? null)) io.out(line);
}

async function use(io: ReleaseIo, id: string): Promise<void> {
  const manifest = await readManifest(path.join(io.root, id));
  if (!manifest) throw new ReleaseError(`no finished release "${id}" (see --list)`);
  await pin(io, manifest);
}

/** Runs the command; resolves to the exit status. */
export async function runRelease(argv: string[], io: ReleaseIo): Promise<number> {
  const cmd = parseReleaseArgs(argv);
  if (cmd.kind === "help") {
    io.out(RELEASE_HELP);
    return 0;
  }
  if (cmd.kind === "error") {
    io.err(`[argus release] ${cmd.message}`);
    return 2;
  }
  try {
    await mkdir(io.root, { recursive: true });
    if (cmd.kind === "list") await list(io);
    else if (cmd.kind === "use") await use(io, cmd.id);
    else await cut(io, cmd.ref);
    return 0;
  } catch (e) {
    io.err(`[argus release] ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

function proc(cmd: string, args: string[], cwd: string, inherit = false): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    // Node refuses to spawn .cmd files without a shell (CVE-2024-27980 → EINVAL).
    const child = spawn(cmd, args, {
      cwd,
      stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32" && cmd.endsWith(".cmd"),
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

/** Streams `git archive` straight into `tar -x`; nothing touches the checkout. */
export function gitArchiveExtract(checkout: string) {
  return (sha: string, dest: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const git = spawn("git", ["archive", "--format=tar", sha], {
        cwd: checkout,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      // Windows' own bsdtar, not a Git-for-Windows GNU tar earlier on PATH,
      // which reads the `C:` in the destination as a remote host.
      const tarBin =
        process.platform === "win32"
          ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
          : "tar";
      const tar = spawn(tarBin, ["-x", "-f", "-", "-C", dest], {
        stdio: ["pipe", "ignore", "pipe"],
        windowsHide: true,
      });
      let errText = "";
      git.stderr.on("data", (d: Buffer) => (errText += d.toString()));
      tar.stderr.on("data", (d: Buffer) => (errText += d.toString()));
      git.stdout.pipe(tar.stdin);
      let gitCode: number | null = null;
      git.on("error", reject);
      tar.on("error", reject);
      git.on("close", (code) => (gitCode = code));
      tar.on("close", (code) => {
        if (gitCode === 0 && code === 0) resolve();
        else
          reject(
            new ReleaseError(`git archive | tar failed (${gitCode}/${code}): ${errText.trim()}`),
          );
      });
    });
}

export async function main(argv: string[]): Promise<number> {
  const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  return runRelease(argv, {
    checkout,
    root: releasesRoot(),
    git: (args, cwd) => proc("git", args, cwd),
    extract: gitArchiveExtract(checkout),
    build: async (dir) => {
      for (const args of [["ci"], ["run", "build"]]) {
        const res = await proc(npm, args, dir, true);
        if (res.status !== 0) return res.status ?? 1;
      }
      return 0;
    },
    importModule: (file) => import(pathToFileURL(file).href) as Promise<Record<string, unknown>>,
    now: () => new Date(),
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
      console.error(`[argus release] ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
