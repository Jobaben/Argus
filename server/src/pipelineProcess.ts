import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

export interface PipelineProcessPlan {
  bin: string;
  args: string[];
  stdin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface PipelineProcessHandle {
  pid: number | null;
  done: Promise<{ code: number | null }>;
}

const WINDOWS_HOST_SOURCE = String.raw`
const { spawn } = require("node:child_process");
const [bin, ...args] = process.argv.slice(1);
let acknowledged = false;
let terminal = null;
const child = spawn(bin, args, {
  cwd: process.cwd(),
  env: process.env,
  shell: false,
  detached: false,
  windowsHide: true,
  stdio: "inherit",
});

function finish() {
  if (!acknowledged || terminal === null) return;
  if (terminal.signal) process.kill(process.pid, terminal.signal);
  else process.exit(terminal.code == null ? 1 : terminal.code);
}

process.on("message", (message) => {
  if (!message || message.type !== "ack") return;
  acknowledged = true;
  if (process.connected) process.disconnect();
  finish();
});

process.on("disconnect", () => {
  if (!acknowledged) child.kill();
});

child.once("spawn", () => {
  if (process.send) process.send({ type: "spawned", pid: child.pid });
});

child.once("error", (error) => {
  const message = String(error && error.message ? error.message : error).slice(0, 1024);
  if (process.send) {
    process.send({ type: "error", error: message }, () => process.exit(1));
  } else {
    process.exit(1);
  }
});

child.once("close", (code, signal) => {
  terminal = { code, signal };
  finish();
});
`;

export async function spawnPipelineProcess(
  plan: PipelineProcessPlan,
  logFd: number,
  platform: NodeJS.Platform = process.platform,
  spawnImpl: typeof nodeSpawn = nodeSpawn,
): Promise<PipelineProcessHandle> {
  return platform === "win32"
    ? spawnWindowsHost(plan, logFd, spawnImpl)
    : spawnDirect(plan, logFd, spawnImpl);
}

function spawnDirect(
  plan: PipelineProcessPlan,
  logFd: number,
  spawnImpl: typeof nodeSpawn,
): PipelineProcessHandle {
  const child = spawnImpl(plan.bin, plan.args, {
    cwd: plan.cwd,
    env: plan.env,
    shell: false,
    detached: true,
    windowsHide: false,
    stdio: ["pipe", logFd, logFd],
  });
  child.stdin?.on("error", () => {});
  child.stdin?.write(plan.stdin);
  child.stdin?.end();
  child.unref();

  return { pid: child.pid ?? null, done: completionOf(child) };
}

function spawnWindowsHost(
  plan: PipelineProcessPlan,
  logFd: number,
  spawnImpl: typeof nodeSpawn,
): Promise<PipelineProcessHandle> {
  const host = spawnImpl(process.execPath, ["--input-type=commonjs", "-e", WINDOWS_HOST_SOURCE, plan.bin, ...plan.args], {
    cwd: plan.cwd,
    env: plan.env,
    shell: false,
    detached: true,
    windowsHide: true,
    stdio: ["pipe", logFd, logFd, "ipc"],
  });
  const done = completionOf(host);

  return new Promise((resolve, reject) => {
    let settled = false;
    let reportedPid = false;
    let acknowledged = false;
    let hostDisconnected = false;
    let agentPid: number | null = null;
    const rejectHandshake = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    host.once("error", (error) => rejectHandshake(error));
    const resolveAcknowledged = () => {
      if (settled || !acknowledged || !hostDisconnected || agentPid === null) return;
      settled = true;
      resolve({ pid: agentPid, done });
    };
    host.once("disconnect", () => {
      if (!reportedPid) {
        rejectHandshake(new Error("Windows pipeline host disconnected before reporting an agent pid"));
        return;
      }
      if (!acknowledged) {
        rejectHandshake(new Error("Windows pipeline host disconnected before acknowledgement"));
        return;
      }
      hostDisconnected = true;
      resolveAcknowledged();
    });
    host.once("close", () => {
      if (!reportedPid) {
        rejectHandshake(new Error("Windows pipeline host exited before reporting an agent pid"));
      }
    });
    host.on("message", (message: unknown) => {
      if (settled || !message || typeof message !== "object") return;
      const protocol = message as { type?: unknown; pid?: unknown; error?: unknown };
      if (protocol.type === "error" && typeof protocol.error === "string") {
        rejectHandshake(new Error(protocol.error));
        return;
      }
      if (protocol.type !== "spawned") return;
      if (!Number.isInteger(protocol.pid) || (protocol.pid as number) <= 0) {
        rejectHandshake(new Error("Windows pipeline host reported an invalid agent pid"));
        return;
      }

      reportedPid = true;
      agentPid = protocol.pid as number;
      if (!host.send) {
        rejectHandshake(new Error("Windows pipeline host has no IPC channel"));
        return;
      }
      try {
        host.send({ type: "ack" }, (error) => {
          if (error) {
            rejectHandshake(error);
            return;
          }
          if (settled) return;
          host.stdin?.on("error", () => {});
          host.stdin?.write(plan.stdin);
          host.stdin?.end();
          host.unref();
          acknowledged = true;
          resolveAcknowledged();
        });
      } catch (error) {
        rejectHandshake(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

function completionOf(child: ChildProcess): Promise<{ code: number | null }> {
  return new Promise((resolve) => {
    child.once("error", () => resolve({ code: null }));
    child.once("close", (code) => resolve({ code }));
  });
}
