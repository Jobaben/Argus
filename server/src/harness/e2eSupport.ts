/**
 * Scaffolding for the harness end-to-end suite.
 *
 * One `startHarness()` call stands up everything a real pipeline step needs and
 * nothing it doesn't: a throwaway Claude home, a throwaway working directory,
 * an engine wired to the *real* `defaultPipelineSpawn`, and the *real* Hono app
 * listening on loopback so the agent's Stop hook can POST its completion signal
 * over HTTP to the actual `/api/instances/:id/signal` route.
 *
 * The child process it spawns is `fakeAgent.mjs` (via `ARGUS_CLAUDE_BIN`), so
 * the only thing faked in the whole path is the agent's own thinking.
 */

import { mkdirSync, mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "../app.js";
import { createEngine, defaultPipelineSpawn } from "../pipelineEngine.js";
import { paths } from "../claudeHome.js";
import { phaseArtifactDir } from "./invocation.js";
import { readInstance } from "../sources/instances.js";
import { createPipeline, validatePipelineInput } from "../sources/pipelines.js";
import type { Engine, EngineDeps } from "../pipelineEngine.js";
import type { ArgusConfig } from "../config.js";
import type { PipelineDefinition, PipelineInstance } from "../sources/pipelineTypes.js";

/** The executable "agent" the engine really spawns. */
export const FAKE_AGENT = fileURLToPath(new URL("./fakeAgent.mjs", import.meta.url));

/** An Argus admin token the suite sets so it can prove the harness strips it. */
export const ADMIN_TOKEN = "super-secret-admin-token";

/** A test-only variable, to prove `env.inherit: "minimal"` keeps it out. */
export const LEAK_VAR = "E2E_SECRET_LEAK";

/** Every poll in this suite gives up well inside a test runner's patience. */
const POLL_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 20;

export function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export function hasGit(): boolean {
  try {
    return spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/** A repository with one commit, so `changed-files` has a baseline to diff. */
export function initGitRepo(dir: string): void {
  const git = (...args: string[]) => {
    const res = spawnSync("git", args, { cwd: dir, stdio: "ignore" });
    if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${dir}`);
  };
  git("init", "-q");
  git("config", "user.email", "harness@example.test");
  git("config", "user.name", "Argus Harness");
  git("commit", "--allow-empty", "-q", "-m", "root");
}

export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  label = "condition",
  timeoutMs = POLL_TIMEOUT_MS,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await condition()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

/** Poll the persisted instance until `predicate` holds, then return it. */
export async function waitForInstance(
  instanceId: string,
  predicate: (inst: PipelineInstance) => boolean,
  label: string,
  timeoutMs = POLL_TIMEOUT_MS,
): Promise<PipelineInstance> {
  let latest: PipelineInstance | null = null;
  await waitFor(
    async () => {
      latest = await readInstance(instanceId);
      return latest !== null && predicate(latest);
    },
    label,
    timeoutMs,
  );
  return latest as unknown as PipelineInstance;
}

export function phaseOf(inst: PipelineInstance, phaseId: string) {
  const phase = inst.phases.find((p) => p.id === phaseId);
  if (!phase) throw new Error(`no phase ${phaseId} on instance ${inst.id}`);
  return phase;
}

/** Where a phase attempt's agents were told to leave their file artifacts. */
export function artifactDirFor(instanceId: string, phaseId: string): string {
  return phaseArtifactDir(paths.artifactsDir(), instanceId, phaseId);
}

export interface Seen {
  argv: string[];
  envNames: string[];
  cwd: string;
  hasArgusToken: boolean;
  prompt: string;
}

/** The record the fake agent wrote about its own invocation. */
export async function readSeen(instanceId: string, phaseId: string): Promise<Seen> {
  const file = path.join(artifactDirFor(instanceId, phaseId), "seen.json");
  return JSON.parse(await readFile(file, "utf8")) as Seen;
}

/** The value following `flag` in an argv, or null. */
export function argAfter(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

export interface Harness {
  home: string;
  cwd: string;
  engine: Engine;
  baseUrl: string;
  /**
   * Save a pipeline definition, returning it. Phases are plain objects rather
   * than `PhaseDef`s so a test can write the literal a client would POST (the
   * real `validatePipelineInput` is what turns it into a definition), with the
   * harness's own working directory filled in.
   */
  seed(
    phases: Record<string, unknown>[],
    over?: Record<string, unknown>,
  ): Promise<PipelineDefinition>;
  close(): Promise<void>;
}

/**
 * Stand up a self-contained Argus: fresh home, fresh working directory, real
 * spawn, real HTTP signal endpoint, real clock.
 */
export async function startHarness(opts: { git?: boolean } = {}): Promise<Harness> {
  const home = tempDir("argus-e2e-home-");
  process.env.ARGUS_CLAUDE_HOME = home;
  // The same data directories the server creates at boot (setup/prereqs
  // `ensureDataDirs`); without the runs directory the fd-backed log cannot be
  // opened and every spawn fails before it starts.
  mkdirSync(paths.runsDir(), { recursive: true });
  mkdirSync(paths.instancesDir(), { recursive: true });

  const cwd = tempDir("argus-e2e-cwd-");
  if (opts.git) initGitRepo(cwd);

  process.env.ARGUS_CLAUDE_BIN = FAKE_AGENT;
  process.env.ARGUS_TOKEN = ADMIN_TOKEN;
  process.env[LEAK_VAR] = "1";

  // `signalUrlBase` is read at launch time, so the placeholder is replaced with
  // the real port once the listener is up — before any step can be spawned.
  const deps: EngineDeps = {
    now: () => new Date(),
    newId: randomUUID,
    spawn: defaultPipelineSpawn,
    signalUrlBase: "http://127.0.0.1:0",
    maxConcurrent: 4,
    tickMs: 30_000,
    killGraceMs: 200,
  };
  const engine = createEngine(deps);

  const config: ArgusConfig = {
    port: 0,
    host: "127.0.0.1",
    // Deliberately null: the signal route authenticates with the per-instance
    // token the engine injected, which is the credential the hook actually has.
    token: null,
    allowedHosts: [],
    allowedOrigins: [],
    maxConcurrentRuns: 4,
    schedulerTickMs: 30_000,
    webhookUrl: null,
  };
  const app = createApp({
    config,
    engine,
    broadcast: () => {},
    serveWeb: false,
    remoteAddr: () => "127.0.0.1",
  });
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  deps.signalUrlBase = baseUrl;

  let pipelineCount = 0;
  return {
    home,
    cwd,
    engine,
    baseUrl,
    async seed(phases, over = {}) {
      return createPipeline(
        validatePipelineInput({
          name: "e2e",
          trigger: null,
          phases: phases.map((p) => ({ cwd, gated: false, ...p })),
          ...over,
        }),
        new Date(),
        `p${++pipelineCount}`,
      );
    },
    async close() {
      await engine.drain().catch(() => {});
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
