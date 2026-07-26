/**
 * Agent-domain types.
 *
 * The wire shapes (`Agent`, `AgentStatus`, `TimelineEntry`, `DaemonWorker`)
 * live in `@argus/contracts` so the web imports the same declarations; they are
 * re-exported here because every source module already reaches for them via
 * this path. What stays local is the *on-disk* shape — `JobState` is Claude
 * Code's file format, which Argus reads but never serves.
 */

import type { AgentStatus } from "@argus/contracts";

export type { Agent, AgentStatus, DaemonWorker, TimelineEntry } from "@argus/contracts";

/** A background job's persisted state (`jobs/<short>/state.json`). */
export interface JobState {
  state?: AgentStatus;
  detail?: string;
  tempo?: string;
  name?: string;
  nameSource?: string;
  inFlight?: { tasks?: number; queued?: number; kinds?: string[] };
  output?: { result?: string };
  template?: string;
  sessionId?: string;
  daemonShort?: string;
  cliVersion?: string;
  cwd?: string;
  createdAt?: string;
  updatedAt?: string;
  firstTerminalAt?: string;
  backend?: string;
}
