import { readdir } from "node:fs/promises";
import path from "node:path";
import { paths } from "../claudeHome.js";
import { readDaemon } from "./daemon.js";
import { readJson, readJsonl } from "./readJson.js";
import type { Agent, JobState, TimelineEntry } from "./types.js";

async function listJobShorts(): Promise<string[]> {
  try {
    const entries = await readdir(paths.jobs(), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

function deriveName(state: JobState, short: string): string {
  if (state.name && state.name.trim()) return state.name.trim();
  if (state.cwd) {
    // Last path segment of cwd, tolerant of both / and \ separators.
    const seg = state.cwd.split(/[\\/]/).filter(Boolean).pop();
    if (seg) return seg;
  }
  return short;
}

function toAgent(short: string, state: JobState, live: boolean, pid: number | null): Agent {
  return {
    short,
    sessionId: state.sessionId ?? null,
    name: deriveName(state, short),
    status: state.state ?? "unknown",
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
      const state = await readJson<JobState>(
        path.join(paths.jobs(), short, "state.json"),
        {},
      );
      const worker = daemon.workers[short];
      return toAgent(short, state, Boolean(worker), worker?.pid ?? null);
    }),
  );
  return agents.sort((a, b) => {
    if (a.live !== b.live) return a.live ? -1 : 1;
    return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
  });
}

/** Reads the progress timeline for a single job. */
export async function readTimeline(short: string): Promise<TimelineEntry[]> {
  return readJsonl<TimelineEntry>(path.join(paths.jobs(), short, "timeline.jsonl"));
}
