import { paths } from "../claudeHome.js";
import { readJson } from "./readJson.js";
import type { DaemonWorker } from "./types.js";

interface RosterFile {
  supervisorPid?: number;
  updatedAt?: number;
  workers?: Record<string, DaemonWorker>;
}

interface StatusFile {
  supervisorPid?: number;
  writtenAt?: number;
  workers?: Record<string, unknown>;
}

export interface DaemonSnapshot {
  supervisorPid: number | null;
  updatedAt: number | null;
  workers: Record<string, DaemonWorker>;
}

/** Reads the daemon roster — the set of workers currently alive. */
export async function readDaemon(): Promise<DaemonSnapshot> {
  const roster = await readJson<RosterFile>(paths.daemonRoster(), {});
  const status = await readJson<StatusFile>(paths.daemonStatus(), {});
  return {
    supervisorPid: roster.supervisorPid ?? status.supervisorPid ?? null,
    updatedAt: roster.updatedAt ?? status.writtenAt ?? null,
    workers: roster.workers ?? {},
  };
}
