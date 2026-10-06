import { closeSync, openSync } from "node:fs";
import { spawnPipelineProcess } from "../pipelineProcess.js";
import type { PipelineSpawnFn } from "./types.js";
import { buildStepPlan } from "./prompts.js";

/** Thrown by start() when the pre-run guard finds a critical prerequisite still broken. */
export class PreflightError extends Error {
  constructor(public readonly reasons: string[]) {
    super(`setup preconditions not met: ${reasons.join("; ")}`);
    this.name = "PreflightError";
  }
}

/** Caps the number of concurrently spawned child processes. */
export class Semaphore {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async acquire(): Promise<void> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
  }
  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

/** Real spawn: the run's agent CLI, prompt on stdin, with the signal env
 *  injected. POSIX starts the agent directly and detached; Windows uses a
 *  hidden, detached two-stage host so the real agent PID can be confirmed over
 *  IPC before this handle resolves. Both keep fd-backed logs so the run survives
 *  an Argus restart. The handshake, rather than the host itself, preserves PID
 *  tracking across restarts.
 *
 *  With a prepared invocation the child gets exactly what the harness decided —
 *  argv and environment alike; `process.env` is not consulted here, because
 *  the environment policy has already been applied to it. The legacy branch
 *  (no preparation) is kept for callers that build a run by hand. */
export const defaultPipelineSpawn: PipelineSpawnFn = async (run, logPath, env, prepared) => {
  const fd = openSync(logPath, "a");
  const plan = prepared?.plan ?? buildStepPlan(run);
  try {
    return await spawnPipelineProcess(
      {
        bin: plan.bin,
        args: plan.args,
        stdin: plan.stdin,
        cwd: run.cwd,
        env: prepared ? prepared.env : { ...process.env, ...plan.env, ...env },
      },
      fd,
    );
  } finally {
    closeSync(fd);
  }
};
