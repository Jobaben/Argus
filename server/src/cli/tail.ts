/**
 * `argus tail` — the I/O half. Reads the same API the dashboard reads, opens
 * the same WebSocket, and prints lines built by `tailCore.ts`.
 *
 * Shape of a run:
 *
 *   1. `GET /api/health` — is there an Argus, and will it talk to us?
 *   2. One read of runs, overview, agents and the situation strip, plus the
 *      retained activity of each running step → the snapshot.
 *   3. Follow `/ws` until the window closes (or nothing is running, with
 *      `--until-idle`): payload frames print directly, change pings trigger
 *      conditional re-reads that the tracker diffs into lines.
 *   4. One closing line saying why it stopped and what is still running.
 *
 * The window matters more here than in a browser: the reader is often an
 * agent running this from a Bash tool with a timeout, so the command must
 * return on its own, say so, and be cheap to run again.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket as NodeWebSocket } from "ws";
import type {
  ActivityEvent,
  Agent,
  HealthResponse,
  OverviewEntry,
  Run,
  Situation,
} from "@argus/contracts";
import { RUNTIMES } from "../runtimes/index.js";
import { probeCommand } from "../setup/prereqs.js";
import {
  buildSnapshot,
  endLine,
  formatMs,
  parseFrame,
  parseTailArgs,
  refreshFor,
  render,
  SKILL_RUNTIMES,
  TAIL_HELP,
  Tracker,
  type SkillRuntime,
  type SkillTarget,
  type TailLine,
  type TailOptions,
} from "./tailCore.js";

/** Everything the runner touches outside its own process, injectable for tests. */
export interface TailIo {
  fetch: typeof fetch;
  WebSocket: typeof NodeWebSocket;
  out: (line: string) => void;
  err: (line: string) => void;
  now: () => Date;
  /** Aborting it ends the tail as an interruption (Ctrl-C). */
  signal?: AbortSignal;
  /** Coalescing delay for change pings; tests shrink it. */
  refreshDebounceMs?: number;
  /** Safety re-read cadence while following, in case a ping is missed. */
  fallbackRefreshMs?: number;
  /** Is this CLI on PATH? Drives `--install-skill` with no target; tests inject it. */
  probe?: (runtime: SkillRuntime) => boolean;
}

/** How many running steps get their retained activity fetched for the snapshot. */
const ACTIVITY_FETCH_CAP = 10;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 5_000;

type Fetched<T> =
  | { status: "ok"; body: T }
  | { status: "unchanged" }
  | { status: "error"; code: number | null; message: string };

/** A small API client: bearer token, conditional GETs, never throws. */
function createClient(options: TailOptions, io: TailIo) {
  const etags = new Map<string, string>();
  const headers = (extra: Record<string, string> = {}) => ({
    accept: "application/json",
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    ...extra,
  });
  async function get<T>(apiPath: string, conditional = true): Promise<Fetched<T>> {
    const tag = conditional ? etags.get(apiPath) : undefined;
    try {
      const res = await io.fetch(`${options.url}${apiPath}`, {
        headers: headers(tag ? { "if-none-match": tag } : {}),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 304) return { status: "unchanged" };
      if (!res.ok) return { status: "error", code: res.status, message: `HTTP ${res.status}` };
      const etag = res.headers.get("etag");
      if (etag) etags.set(apiPath, etag);
      return { status: "ok", body: (await res.json()) as T };
    } catch (e) {
      return { status: "error", code: null, message: e instanceof Error ? e.message : String(e) };
    }
  }
  return { get };
}

function unreachable(options: TailOptions, health: Fetched<unknown>): string {
  if (health.status === "error" && health.code === 401) {
    return `Argus at ${options.url} wants a token — set ARGUS_TOKEN (or pass --token) to the value the server was started with`;
  }
  if (health.status === "error" && health.code === 403) {
    return `Argus at ${options.url} refused the request (403) — its Host allowlist does not cover this URL; try the address it was started on, or ARGUS_ALLOWED_HOSTS on the server`;
  }
  if (health.status === "error" && health.code !== null) {
    return `Argus at ${options.url} answered ${health.message} to /api/health — is that the right port?`;
  }
  const why = health.status === "error" ? health.message : "no response";
  return `no Argus answering at ${options.url} (${why}) — start one with \`argus\`, or point --url at the one you mean`;
}

/** Runs the whole thing; resolves to the exit status. */
export async function runTail(options: TailOptions, io: TailIo): Promise<number> {
  if (options.installSkill) return installSkill(options.installSkill, io);

  const api = createClient(options, io);
  const print = (line: TailLine) => io.out(render(line, options.json));
  const startedAt = io.now();

  const health = await api.get<HealthResponse>("/api/health", false);
  if (health.status !== "ok") {
    io.err(`[argus tail] ${unreachable(options, health)}`);
    return 1;
  }

  // First reads. Every one is best-effort: the snapshot degrades to what
  // answered rather than failing because one derived view is slow.
  const [runsRes, overviewRes, agentsRes, situationRes] = await Promise.all([
    api.get<{ runs: Run[] }>("/api/runs?limit=100"),
    api.get<{ overview: OverviewEntry[] }>("/api/overview"),
    api.get<{ agents: Agent[] }>("/api/agents"),
    api.get<Situation>("/api/insight"),
  ]);
  const runs = runsRes.status === "ok" ? runsRes.body.runs : [];
  const overview = overviewRes.status === "ok" ? overviewRes.body.overview : [];
  const agents = agentsRes.status === "ok" ? agentsRes.body.agents : [];
  const situation = situationRes.status === "ok" ? situationRes.body : null;

  const tracker = new Tracker(io.now);
  tracker.applyOverview(overview);
  tracker.applyRuns(runs);
  tracker.applyAgents(agents);

  let events = 0;
  if (options.snapshot) {
    const activity = new Map<string, ActivityEvent[]>();
    const running = runs.filter((r) => r.status === "running").slice(0, ACTIVITY_FETCH_CAP);
    await Promise.all(
      running.map(async (r) => {
        const got = await api.get<{ events: ActivityEvent[] }>(`/api/runs/${r.id}/activity`, false);
        if (got.status === "ok" && got.body.events.length > 0) activity.set(r.id, got.body.events);
      }),
    );
    for (const line of buildSnapshot({
      now: io.now(),
      url: options.url,
      version: health.body.version ?? null,
      runs,
      overview,
      agents,
      situation,
      activity,
      sinceMs: options.sinceMs,
      context: options.context,
    })) {
      print(line);
    }
  }

  const finish = (reason: "window" | "idle" | "interrupted" | "snapshot") => {
    print(
      endLine({
        now: io.now(),
        reason,
        elapsedMs: io.now().getTime() - startedAt.getTime(),
        events,
        running: tracker.runningCount(),
        json: options.json,
      }),
    );
    return 0;
  };

  if (options.forMs === 0) return finish("snapshot");
  if (options.untilIdle && tracker.isIdle()) return finish("idle");
  if (io.signal?.aborted) return finish("interrupted");

  // ── Follow ─────────────────────────────────────────────────────────────
  return new Promise<number>((resolve) => {
    let done = false;
    let socket: NodeWebSocket | null = null;
    let reconnectTimer: NodeJS.Timeout | null = null;
    let reconnectAttempt = 0;
    let refreshTimer: NodeJS.Timeout | null = null;
    let refreshing = false;
    const pending = { runs: false, overview: false, agents: false };
    const debounce = io.refreshDebounceMs ?? 250;

    const windowTimer =
      options.forMs === null ? null : setTimeout(() => end("window"), options.forMs);
    const fallbackTimer = setInterval(
      () => request({ runs: true, overview: true, agents: true }),
      io.fallbackRefreshMs ?? 20_000,
    );
    const onAbort = () => end("interrupted");
    io.signal?.addEventListener("abort", onAbort, { once: true });

    function end(reason: "window" | "idle" | "interrupted") {
      if (done) return;
      done = true;
      if (windowTimer) clearTimeout(windowTimer);
      clearInterval(fallbackTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (refreshTimer) clearTimeout(refreshTimer);
      io.signal?.removeEventListener("abort", onAbort);
      if (socket) {
        const s = socket;
        socket = null;
        s.removeAllListeners();
        s.on("error", () => {});
        try {
          s.terminate();
        } catch {
          /* already gone */
        }
      }
      resolve(finish(reason));
    }

    function emit(lines: TailLine[]) {
      if (done) return;
      for (const line of lines) {
        print(line);
        events++;
      }
    }

    function request(what: { runs: boolean; overview: boolean; agents: boolean }) {
      if (done) return;
      pending.runs ||= what.runs;
      pending.overview ||= what.overview;
      pending.agents ||= what.agents;
      if (!pending.runs && !pending.overview && !pending.agents) return;
      if (refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void refresh();
      }, debounce);
    }

    async function refresh(): Promise<void> {
      if (done) return;
      if (refreshing) {
        // Re-arm: the pings that arrived mid-read are still pending.
        request({ runs: false, overview: false, agents: false });
        return;
      }
      refreshing = true;
      const want = { ...pending };
      pending.runs = pending.overview = pending.agents = false;
      try {
        const [ov, rs, ag] = await Promise.all([
          want.overview ? api.get<{ overview: OverviewEntry[] }>("/api/overview") : null,
          want.runs ? api.get<{ runs: Run[] }>("/api/runs?limit=100") : null,
          want.agents ? api.get<{ agents: Agent[] }>("/api/agents") : null,
        ]);
        if (done) return;
        const lines: TailLine[] = [];
        // Overview first so a step run reported below already has its board
        // label; then sorted by instant so cause reads before effect.
        if (ov?.status === "ok") lines.push(...tracker.applyOverview(ov.body.overview));
        if (rs?.status === "ok") lines.push(...tracker.applyRuns(rs.body.runs));
        if (ag?.status === "ok") lines.push(...tracker.applyAgents(ag.body.agents));
        lines.sort((a, b) => a.at.localeCompare(b.at));
        emit(lines);
        if (options.untilIdle && tracker.isIdle()) end("idle");
      } finally {
        refreshing = false;
        if (!done && (pending.runs || pending.overview || pending.agents)) {
          request({ runs: false, overview: false, agents: false });
        }
      }
    }

    function connect() {
      if (done) return;
      const wsUrl = options.url.replace(/^http/, "ws") + "/ws";
      let ws: NodeWebSocket;
      try {
        ws = new io.WebSocket(wsUrl, {
          headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
        });
      } catch {
        scheduleReconnect();
        return;
      }
      socket = ws;
      ws.on("open", () => {
        if (reconnectAttempt > 0) {
          // Something may have moved while we were away: read everything.
          request({ runs: true, overview: true, agents: true });
        }
        reconnectAttempt = 0;
      });
      ws.on("message", (data) => {
        const frame = parseFrame(String(data));
        if (!frame) return;
        if (frame.type.endsWith(":changed")) {
          request(refreshFor(frame.type));
          return;
        }
        emit(tracker.applyFrame(frame));
      });
      ws.on("error", () => {
        /* close follows */
      });
      ws.on("close", () => {
        if (socket === ws) socket = null;
        scheduleReconnect();
      });
    }

    function scheduleReconnect() {
      if (done || reconnectTimer) return;
      reconnectAttempt++;
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (reconnectAttempt - 1));
      if (reconnectAttempt === 1 || reconnectAttempt % 5 === 0) {
        print({
          at: io.now().toISOString(),
          kind: "tail.reconnect",
          text: `live feed dropped — reconnecting (attempt ${reconnectAttempt})`,
          attempt: reconnectAttempt,
        });
      }
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    }

    if (!options.json) {
      print({
        at: io.now().toISOString(),
        kind: "tail.start",
        text:
          options.forMs === null
            ? "following live (Ctrl-C to stop)"
            : `following live for ${formatMs(options.forMs)}${options.untilIdle ? ", or until idle" : ""}`,
      });
    } else {
      print({
        at: io.now().toISOString(),
        kind: "tail.start",
        text: "following",
        forMs: options.forMs,
        untilIdle: options.untilIdle,
      });
    }
    connect();
  });
}

// ── Skill install ────────────────────────────────────────────────────────────

/**
 * One skill file, every agent CLI that can read it.
 *
 * Claude Code and Codex both discover skills the same way — a
 * `skills/<name>/SKILL.md` tree under the CLI's home, with `name` and
 * `description` frontmatter, picked implicitly when a request matches the
 * description or explicitly by name (`/argus-tail` in Claude Code, `$argus-tail`
 * in Codex). So the skill is written once, in the runtime-neutral dialect both
 * accept, and installed under whichever homes apply. The homes come from the
 * runtime registry (`ARGUS_CLAUDE_HOME`, `ARGUS_CODEX_HOME` / `CODEX_HOME`
 * honoured), so pointing Argus at a relocated CLI points the install there too.
 */
const SKILL_NAME = "argus-tail";

/** The skill file shipped in the repo, resolved from either `src/cli` or `dist/cli`. */
export function bundledSkillPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..", ".claude", "skills", SKILL_NAME, "SKILL.md");
}

/** Where the skill lands for one runtime; `home` overrides the registry's answer. */
export function installedSkillPath(runtime: SkillRuntime = "claude", home?: string): string {
  return path.join(home ?? RUNTIMES[runtime].home(), "skills", SKILL_NAME, "SKILL.md");
}

const INVOKE: Record<SkillRuntime, string> = { claude: `/${SKILL_NAME}`, codex: `$${SKILL_NAME}` };

/** Which runtimes a target names; `auto` asks PATH and falls back to Claude Code. */
export function resolveSkillTargets(
  target: SkillTarget,
  probe: (runtime: SkillRuntime) => boolean,
): SkillRuntime[] {
  if (target === "all") return [...SKILL_RUNTIMES];
  if (target !== "auto") return [target];
  const found = SKILL_RUNTIMES.filter((rt) => probe(rt));
  return found.length > 0 ? found : ["claude"];
}

function defaultProbe(runtime: SkillRuntime): boolean {
  const rt = RUNTIMES[runtime];
  return probeCommand(rt.bin(), rt.versionArgs).ok;
}

async function installSkill(target: SkillTarget, io: TailIo): Promise<number> {
  const from = bundledSkillPath();
  let body: string;
  try {
    body = await readFile(from, "utf8");
  } catch {
    io.err(`[argus tail] the bundled skill is missing at ${from} — reinstall Argus from git`);
    return 1;
  }
  const targets = resolveSkillTargets(target, io.probe ?? defaultProbe);
  let failed = false;
  for (const runtime of targets) {
    const to = installedSkillPath(runtime);
    try {
      await mkdir(path.dirname(to), { recursive: true });
      await writeFile(to, body, "utf8");
    } catch (e) {
      io.err(`[argus tail] could not write ${to}: ${e instanceof Error ? e.message : String(e)}`);
      failed = true;
      continue;
    }
    io.out(
      `[argus tail] installed the ${SKILL_NAME} skill for ${RUNTIMES[runtime].label} at ${to}`,
    );
  }
  if (failed) return 1;
  const how = targets.map((rt) => `${INVOKE[rt]} in ${RUNTIMES[rt].label}`).join(", ");
  io.out(
    `[argus tail] a session on this machine can now be asked "what is Argus doing?" — or invoke the skill by name: ${how}`,
  );
  if (target === "auto" && targets.length < SKILL_RUNTIMES.length) {
    const skipped = SKILL_RUNTIMES.filter((rt) => !targets.includes(rt));
    io.out(
      `[argus tail] skipped ${skipped.map((rt) => RUNTIMES[rt].label).join(", ")} (CLI not found on PATH) — \`argus tail --install-skill=all\` installs regardless`,
    );
  }
  return 0;
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function main(argv: string[]): Promise<number> {
  const parsed = parseTailArgs(argv, process.env, Boolean(process.stdout.isTTY));
  if (parsed.kind === "help") {
    console.log(TAIL_HELP);
    return 0;
  }
  if (parsed.kind === "error") {
    console.error(`[argus tail] ${parsed.message}`);
    return 2;
  }
  const controller = new AbortController();
  // `on`, not `once`: a Ctrl-C in a terminal reaches this process directly
  // *and* forwarded by the `argus` launcher, and the second copy must not fall
  // through to the default handler and kill us before the closing line prints.
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    return await runTail(parsed.options, {
      fetch: globalThis.fetch,
      WebSocket: NodeWebSocket,
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
      now: () => new Date(),
      signal: controller.signal,
    });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(`[argus tail] ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
