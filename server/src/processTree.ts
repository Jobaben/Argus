/**
 * Ending a process *tree*, not just a pid — the one place the platform
 * difference lives.
 *
 * An agent CLI or a check's shell spawns children, and those children inherit
 * the parent's stdout/stderr. Killing only the process Argus spawned leaves
 * them running and still holding the pipes, so the `close` event every owner
 * waits on never fires: the owner hangs, and the open pipe handles keep the
 * host process alive.
 *
 * - **POSIX.** A child spawned with `detached: true` leads its own process
 *   group (pid == pgid), so signalling `-pid` reaches every descendant that
 *   stayed in the group. That is only true of a detached spawn: a child that
 *   shares Argus's group must be signalled by its own pid, never `-pid`.
 * - **Windows.** There are no signals or process groups. `taskkill /T /F`
 *   walks the tree by parent pid and terminates it forcefully — there is no
 *   graceful SIGTERM-then-SIGKILL ladder, whatever signal was asked for. The
 *   walk starts at a live root: once the root has exited its children can no
 *   longer be found from it, so the tree is taken down *before* anything
 *   kills the root alone.
 *
 * Termination being *requested* is never reported as the process having
 * stopped. {@link childTreeStopper} escalates, and if the pipes are still held
 * after the ladder it releases Argus's end of them and says so, so the owner
 * settles with an honest "did not exit" instead of hanging.
 */

import { execFile, type ChildProcess } from "node:child_process";

/** Grace between a tree's terminate request and its escalation. */
export const DEFAULT_TREE_KILL_GRACE_MS = 5000;
/** Upper bound on one `taskkill` invocation. */
const TASKKILL_TIMEOUT_MS = 10_000;

/** The platform seam, injectable so the tests never signal a real pid they did not spawn. */
export interface ProcessTreeDeps {
  platform?: NodeJS.Platform;
  /** Deliver a POSIX signal; `process.kill` by default. Throws if undeliverable. */
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  /** Run `taskkill /PID <pid> /T /F`; resolves true iff it succeeded. */
  taskkill?: (pid: number) => Promise<boolean>;
}

/** `taskkill /PID <pid> /T /F`: forceful termination of `pid` and its descendants. */
export function taskkillTree(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      execFile(
        "taskkill",
        ["/PID", String(pid), "/T", "/F"],
        { windowsHide: true, timeout: TASKKILL_TIMEOUT_MS },
        (err) => resolve(!err),
      );
    } catch {
      resolve(false);
    }
  });
}

export interface SignalTreeOptions extends ProcessTreeDeps {
  /**
   * POSIX only: the root was spawned `detached`, so it leads a process group
   * that holds its descendants. False signals the pid alone. Default true —
   * every Argus spawn that is signalled as a tree is detached on POSIX.
   */
  grouped?: boolean;
}

/**
 * Signal `pid` and its descendants. On Windows `signal` is ignored: the tree
 * is terminated forcefully. Resolves true if the request was delivered — which
 * is not the same as the tree having exited.
 */
export async function signalProcessTree(
  pid: number,
  signal: NodeJS.Signals = "SIGTERM",
  opts: SignalTreeOptions = {},
): Promise<boolean> {
  const platform = opts.platform ?? process.platform;
  if (platform === "win32") return (opts.taskkill ?? taskkillTree)(pid);
  const send = opts.signal ?? ((p: number, s: NodeJS.Signals) => void process.kill(p, s));
  if (opts.grouped ?? true) {
    try {
      send(-pid, signal);
      return true;
    } catch {
      // No such group (the root was not a group leader, or it is gone):
      // fall through to the pid itself.
    }
  }
  try {
    send(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** True while Node has seen neither an exit code nor a terminating signal. */
function stillRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

/**
 * Let go of Argus's end of a child's pipes and stop the child handle keeping
 * the event loop alive. Used only once termination has been tried and the
 * pipes are still held — by the child itself or a descendant out of reach.
 */
export function releaseChildPipes(child: ChildProcess): void {
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    try {
      stream?.destroy();
    } catch {
      /* already closed */
    }
  }
  try {
    child.unref();
  } catch {
    /* not a real handle */
  }
}

export interface ChildTreeStopperOptions extends ProcessTreeDeps {
  /** The child was spawned `detached` on POSIX (see {@link SignalTreeOptions.grouped}). */
  grouped: boolean;
  /** Wait between the terminate request and the escalation, and again before giving up. */
  graceMs?: number;
  /**
   * The tree still held its pipes `2 × graceMs` after {@link ChildTreeStopper.stop}:
   * the pipes have been released and the child unref'd. The owner settles here
   * with a "did not exit" outcome — `close` will not come.
   */
  onAbandon: () => void;
}

export interface ChildTreeStopper {
  /** Begin terminating the child's tree. Idempotent. */
  stop(): void;
  /** Whether {@link stop} has been called. */
  readonly stopping: boolean;
  /** Cancel any pending escalation; call once the child has closed or the owner has settled. */
  dispose(): void;
}

/**
 * The termination ladder for a child Argus spawned and owns.
 *
 * `stop()` asks the tree to end (POSIX: SIGTERM to the group; Windows:
 * `taskkill /T /F`, falling back to the root alone if that fails). After
 * `graceMs`, if the owner has not disposed it: POSIX sends SIGKILL to the
 * group — sent regardless of the leader, because a descendant that outlived
 * an exited leader is exactly the process this exists to reach — and Windows
 * repeats the tree kill. On Windows nothing is ever sent once the root has
 * exited; on POSIX nothing ever goes to the bare pid. After a further
 * `graceMs` the pipes are released and `onAbandon` runs, once — which means
 * the tree was *not* confirmed to have exited, and owners must say so.
 *
 * Timers stay referenced: the ladder is bounded (`2 × graceMs`) and cleared on
 * `dispose()`, and an unreferenced abandon timer could let a host exit with
 * the owner's promise still pending.
 */
export function childTreeStopper(
  child: ChildProcess,
  opts: ChildTreeStopperOptions,
): ChildTreeStopper {
  const platform = opts.platform ?? process.platform;
  const graceMs = opts.graceMs ?? DEFAULT_TREE_KILL_GRACE_MS;
  const timers: ReturnType<typeof setTimeout>[] = [];
  let stopping = false;
  let disposed = false;

  function killRootAlone(signal: NodeJS.Signals): void {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }

  async function terminate(signal: NodeJS.Signals): Promise<void> {
    const pid = child.pid;
    if (pid == null) return;
    let delivered = false;
    if (platform === "win32") {
      // Only while the root is running: its pid is then still its own (Node
      // holds the process handle), and `taskkill /T` can only walk the tree
      // from a live root anyway. Once it has exited, the pid may be reused.
      if (!stillRunning(child)) return;
      try {
        delivered = await (opts.taskkill ?? taskkillTree)(pid);
      } catch {
        delivered = false;
      }
    } else if (opts.grouped) {
      // The group only — never the bare pid as a fallback: once the root has
      // exited and been reaped its pid can belong to anyone. A group with a
      // live member cannot have its id reused.
      try {
        (opts.signal ?? ((p: number, s: NodeJS.Signals) => void process.kill(p, s)))(-pid, signal);
        delivered = true;
      } catch {
        delivered = false;
      }
    }
    // The root by itself, through its handle (which knows whether it has
    // exited), when the tree request failed or there is no group to signal.
    if (!delivered && !disposed && stillRunning(child)) killRootAlone(signal);
  }

  return {
    get stopping() {
      return stopping;
    },
    stop() {
      if (stopping || disposed) return;
      stopping = true;
      void terminate("SIGTERM");
      timers.push(
        setTimeout(() => {
          if (disposed) return;
          // Windows repeats the tree kill only while the root is still
          // running (see terminate); POSIX signals the group regardless.
          void terminate("SIGKILL");
          timers.push(
            setTimeout(() => {
              if (disposed) return;
              disposed = true;
              releaseChildPipes(child);
              opts.onAbandon();
            }, graceMs),
          );
        }, graceMs),
      );
    },
    dispose() {
      disposed = true;
      for (const t of timers) clearTimeout(t);
    },
  };
}
