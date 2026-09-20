import { readdir } from "node:fs/promises";
import path from "node:path";
import { paths } from "../claudeHome.js";
import { readDaemon } from "./daemon.js";
import { readJson, readJsonl } from "./readJson.js";
import type { Agent, AgentStatus, JobState, TimelineEntry } from "./types.js";

/** The statuses Argus promises to serve, per the wire contract. */
const KNOWN_STATUSES = new Set<AgentStatus>([
  "working",
  "done",
  "failed",
  "idle",
  "queued",
  "stopped",
  "unknown",
]);

/**
 * Claude Code owns the `state` string on disk, so a newer CLI can write a value
 * this build has never heard of. Passing it through would break the contract's
 * promise and fall through every exhaustive switch in the client, so anything
 * unrecognised is normalized to `"unknown"` — which the UI already renders as
 * an idle tile.
 */
export function normalizeAgentStatus(raw: unknown): AgentStatus {
  return typeof raw === "string" && KNOWN_STATUSES.has(raw as AgentStatus)
    ? (raw as AgentStatus)
    : "unknown";
}

async function listJobShorts(): Promise<string[]> {
  try {
    const entries = await readdir(paths.jobs(), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * The `nameSource` values that mark a name Claude Code derived from the job's
 * own prompt rather than one a human chose. Confirmed against the job-state
 * schema in CLI 2.1.273, which declares
 * `nameSource: enum(["user", "auto", "collision"])`: `"auto"` is written by the
 * labeller that summarises the prompt, `"user"` is a `--name` value, and
 * `"collision"` is that same human name with a disambiguating suffix.
 */
const DERIVED_NAME_SOURCES = new Set(["auto"]);

/**
 * Picks the label for a job tile. A prompt-derived name reads as a sentence
 * rather than a title, so the working directory's last segment beats it — but
 * only when `nameSource` positively identifies it as derived. An absent or
 * unrecognised value keeps the older behaviour of trusting the name, because
 * Claude Code owns this field and every job written before it existed would
 * otherwise lose the name its owner set with `--name`.
 */
export function deriveName(state: JobState, short: string): string {
  const name = state.name?.trim() ?? "";
  if (name && !DERIVED_NAME_SOURCES.has(state.nameSource ?? "")) return name;
  if (state.cwd) {
    // Last path segment of cwd, tolerant of both / and \ separators.
    const seg = state.cwd.split(/[\\/]/).filter(Boolean).pop();
    if (seg) return seg;
  }
  // A derived label still beats the hex short id when there is no cwd.
  return name || short;
}

function toAgent(short: string, state: JobState, live: boolean, pid: number | null): Agent {
  return {
    short,
    sessionId: state.sessionId ?? null,
    name: deriveName(state, short),
    status: normalizeAgentStatus(state.state),
    tempo: state.tempo ?? null,
    detail: state.detail ?? null,
    result: state.output?.result ?? null,
    template: state.template ?? null,
    cwd: state.cwd ?? null,
    cliVersion: state.cliVersion ?? null,
    inFlight: state.inFlight
      ? {
          tasks: state.inFlight.tasks ?? 0,
          queued: state.inFlight.queued ?? 0,
          kinds: state.inFlight.kinds ?? [],
        }
      : null,
    createdAt: state.createdAt ?? null,
    updatedAt: state.updatedAt ?? null,
    firstTerminalAt: state.firstTerminalAt ?? null,
    live,
    pid,
  };
}

/** Reads every background job, merged with daemon liveness, newest first. */
export async function readAgents(): Promise<Agent[]> {
  const [shorts, daemon] = await Promise.all([listJobShorts(), readDaemon()]);
  const agents = await Promise.all(
    shorts.map(async (short) => {
      const state = await readJson<JobState>(path.join(paths.jobs(), short, "state.json"), {});
      const worker = daemon.workers[short];
      return toAgent(short, state, Boolean(worker), worker?.pid ?? null);
    }),
  );
  return agents.sort((a, b) => {
    if (a.live !== b.live) return a.live ? -1 : 1;
    return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
  });
}

// Job "short" ids are a single safe path segment — no slashes or dots that
// could escape the jobs dir via ../ traversal in the :short route param.
const SHORT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Reads the progress timeline for a single job. Entry states go through the
 *  same normalization as the job's own status, so the contract holds for every
 *  status Argus serves — not just the one on the tile. */
export async function readTimeline(short: string): Promise<TimelineEntry[]> {
  if (!SHORT_RE.test(short)) return [];
  const entries = await readJsonl<TimelineEntry>(path.join(paths.jobs(), short, "timeline.jsonl"));
  return entries.map((e) =>
    e.state === undefined ? e : { ...e, state: normalizeAgentStatus(e.state) },
  );
}
