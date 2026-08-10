import { EventEmitter, once } from "node:events";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn as nodeSpawn } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnPipelineProcess } from "./pipelineProcess.js";

class FakeHost extends EventEmitter {
  pid = 91;
  connected = true;
  sent: unknown[] = [];
  writes: string[] = [];
  ended = false;
  unrefCalled = false;
  stdin = {
    on: () => this.stdin,
    write: (value: string) => this.writes.push(value),
    end: () => {
      this.ended = true;
    },
  };
  send(message: unknown, callback?: (error: Error | null) => void) {
    this.sent.push(message);
    callback?.(null);
    queueMicrotask(() => this.disconnect());
    return true;
  }
  disconnect() {
    this.connected = false;
    this.emit("disconnect");
  }
  unref() {
    this.unrefCalled = true;
  }
}

async function waitForFile(file: string, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!existsSync(file)) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("Windows launches a hidden host and returns the real agent PID from IPC", async () => {
  const host = new FakeHost();
  const calls: { command: string; args: string[]; options: Record<string, unknown> }[] = [];
  const spawn = ((command: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options });
    queueMicrotask(() => host.emit("message", { type: "spawned", pid: 4242 }));
    return host;
  }) as unknown as typeof nodeSpawn;

  const handle = await spawnPipelineProcess(
    { bin: "codex.exe", args: ["exec"], stdin: "prompt", cwd: "C:\\work", env: {} },
    17,
    "win32",
    spawn,
  );

  assert.equal(calls[0].command, process.execPath);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(calls[0].options.stdio, ["pipe", 17, 17, "ipc"]);
  assert.equal(handle.pid, 4242);
  assert.deepEqual(host.sent, [{ type: "ack" }]);
  assert.equal(calls[0].args.includes("prompt"), false);
  assert.deepEqual(host.writes, ["prompt"]);
  assert.equal(host.ended, true);
  assert.equal(host.unrefCalled, true);

  host.emit("close", 0);
  assert.deepEqual(await handle.done, { code: 0 });
});

test("Windows rejects an invalid PID handshake", async () => {
  const host = new FakeHost();
  const spawn = (() => {
    queueMicrotask(() => host.emit("message", { type: "spawned", pid: 0 }));
    return host;
  }) as unknown as typeof nodeSpawn;
  await assert.rejects(
    spawnPipelineProcess(
      { bin: "codex.exe", args: [], stdin: "", cwd: "C:\\work", env: {} },
      17,
      "win32",
      spawn,
    ),
    /invalid agent pid/i,
  );
});

test("Windows surfaces an agent spawn error from the host", async () => {
  const host = new FakeHost();
  const spawn = (() => {
    queueMicrotask(() => host.emit("message", { type: "error", error: "ENOENT codex.exe" }));
    return host;
  }) as unknown as typeof nodeSpawn;
  await assert.rejects(
    spawnPipelineProcess(
      { bin: "codex.exe", args: [], stdin: "", cwd: "C:\\work", env: {} },
      17,
      "win32",
      spawn,
    ),
    /ENOENT codex\.exe/,
  );
});

test("Windows rejects a host exit before the PID handshake", async () => {
  const host = new FakeHost();
  const spawn = (() => {
    queueMicrotask(() => host.emit("close", 1));
    return host;
  }) as unknown as typeof nodeSpawn;
  await assert.rejects(
    spawnPipelineProcess(
      { bin: "codex.exe", args: [], stdin: "", cwd: "C:\\work", env: {} },
      17,
      "win32",
      spawn,
    ),
    /before reporting an agent pid/i,
  );
});

test("Windows rejects a host disconnect before acknowledgement", async () => {
  const host = new FakeHost();
  host.send = (message, callback) => {
    host.sent.push(message);
    queueMicrotask(() => host.disconnect());
    queueMicrotask(() => callback?.(null));
    return true;
  };
  const spawn = (() => {
    queueMicrotask(() => host.emit("message", { type: "spawned", pid: 4242 }));
    return host;
  }) as unknown as typeof nodeSpawn;
  await assert.rejects(
    spawnPipelineProcess(
      { bin: "codex.exe", args: [], stdin: "", cwd: "C:\\work", env: {} },
      17,
      "win32",
      spawn,
    ),
    /before acknowledgement/i,
  );
});

test("Windows rejects an acknowledgement callback error before writing stdin", async () => {
  const host = new FakeHost();
  host.send = (message, callback) => {
    host.sent.push(message);
    callback?.(new Error("IPC acknowledgement failed"));
    queueMicrotask(() => host.disconnect());
    return true;
  };
  const spawn = (() => {
    queueMicrotask(() => host.emit("message", { type: "spawned", pid: 4242 }));
    return host;
  }) as unknown as typeof nodeSpawn;
  await assert.rejects(
    spawnPipelineProcess(
      { bin: "codex.exe", args: [], stdin: "prompt", cwd: "C:\\work", env: {} },
      17,
      "win32",
      spawn,
    ),
    /IPC acknowledgement failed/,
  );
  assert.deepEqual(host.writes, []);
  assert.equal(host.ended, false);
  assert.equal(host.unrefCalled, false);
});

test("Windows rejects a synchronous acknowledgement send error", async () => {
  const host = new FakeHost();
  host.send = () => {
    throw new Error("IPC send exploded");
  };
  const spawn = (() => {
    queueMicrotask(() => host.emit("message", { type: "spawned", pid: 4242 }));
    return host;
  }) as unknown as typeof nodeSpawn;
  await assert.rejects(
    spawnPipelineProcess(
      { bin: "codex.exe", args: [], stdin: "prompt", cwd: "C:\\work", env: {} },
      17,
      "win32",
      spawn,
    ),
    /IPC send exploded/,
  );
  assert.deepEqual(host.writes, []);
  assert.equal(host.ended, false);
  assert.equal(host.unrefCalled, false);
});

test("non-Windows launches the agent directly and detached", async () => {
  const child = new FakeHost();
  child.pid = 5150;
  const calls: { command: string; args: string[]; options: Record<string, unknown> }[] = [];
  const spawn = ((command: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options });
    return child;
  }) as unknown as typeof nodeSpawn;
  const handle = await spawnPipelineProcess(
    { bin: "claude", args: ["-p"], stdin: "go", cwd: "/work", env: {} },
    18,
    "linux",
    spawn,
  );
  assert.equal(calls[0].command, "claude");
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.windowsHide, false);
  assert.deepEqual(calls[0].options.stdio, ["pipe", 18, 18]);
  assert.equal(handle.pid, 5150);
});

test("Windows host keeps overlapping PowerShell descendants in one hidden console", { skip: process.platform !== "win32" }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), "argus-pipeline-console-"));
  const logPath = path.join(home, "console-probe.log");
  const moduleUrl = pathToFileURL(path.join(import.meta.dirname, "pipelineProcess.ts")).href;
  const probeAgentSource = String.raw`
    const { spawn } = require("node:child_process");
    const path = require("node:path");
    const shell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const command = [
      "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices;",
      "public static class ConsoleProbe {",
      "[DllImport(\"kernel32.dll\")] public static extern IntPtr GetConsoleWindow();",
      "[DllImport(\"user32.dll\")] public static extern bool IsWindowVisible(IntPtr hWnd); }';",
      "$console = [ConsoleProbe]::GetConsoleWindow(); @{ handle = $console.ToInt64(); visible = [ConsoleProbe]::IsWindowVisible($console) } | ConvertTo-Json -Compress;",
      "Start-Sleep -Milliseconds 400",
    ].join(" ");
    function probe() {
      return new Promise((resolve, reject) => {
        const child = spawn(shell, ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", command]);
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.once("error", reject);
        child.once("close", (code) => {
          if (code !== 0) reject(new Error(stderr || "PowerShell console probe failed"));
          else resolve(JSON.parse(stdout.trim().split(/\\r?\\n/)[0]));
        });
      });
    }
    Promise.all([probe(), probe()])
      .then((handles) => console.log(JSON.stringify(handles)))
      .catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  const consoleParentSource = `
    import { closeSync, openSync } from "node:fs";
    import { spawnPipelineProcess } from ${JSON.stringify(moduleUrl)};
    const fd = openSync(${JSON.stringify(logPath)}, "a");
    const handle = await spawnPipelineProcess({
      bin: process.execPath,
      args: ["-e", ${JSON.stringify(probeAgentSource)}],
      stdin: "",
      cwd: ${JSON.stringify(home)},
      env: process.env,
    }, fd, "win32");
    const keepAlive = setInterval(() => {}, 1000);
    await handle.done;
    clearInterval(keepAlive);
    closeSync(fd);
  `;
  const parent = nodeSpawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", consoleParentSource],
    { cwd: path.join(import.meta.dirname, ".."), detached: true, windowsHide: true, stdio: "ignore" },
  );

  try {
    await once(parent, "close");
    const probes = JSON.parse(readFileSync(logPath, "utf8").trim().split(/\r?\n/).at(-1)!);
    assert.equal(probes[0].handle > 0, true);
    assert.equal(probes[0].handle, probes[1].handle);
    assert.equal(probes[0].visible, false);
    assert.equal(probes[1].visible, false);
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("Windows host keeps the real agent alive after its parent exits", { skip: process.platform !== "win32" }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), "argus-pipeline-restart-"));
  const logPath = path.join(home, "restart.log");
  const doneMarker = path.join(home, "done");
  const pidMarker = path.join(home, "pid");
  let agentPid: number | null = null;
  const moduleUrl = pathToFileURL(path.join(import.meta.dirname, "pipelineProcess.ts")).href;
  const agentSource = `
    const { writeFileSync } = require("node:fs");
    setTimeout(() => writeFileSync(${JSON.stringify(doneMarker)}, "done"), 750);
  `;
  const parentSource = `
    import { closeSync, openSync, writeFileSync } from "node:fs";
    import { spawnPipelineProcess } from ${JSON.stringify(moduleUrl)};
    const fd = openSync(${JSON.stringify(logPath)}, "a");
    const handle = await spawnPipelineProcess({
      bin: process.execPath,
      args: ["-e", ${JSON.stringify(agentSource)}],
      stdin: "",
      cwd: ${JSON.stringify(home)},
      env: process.env,
    }, fd, "win32");
    closeSync(fd);
    writeFileSync(${JSON.stringify(pidMarker)}, String(handle.pid));
    process.exit(0);
  `;
  const parent = nodeSpawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", parentSource],
    { cwd: path.join(import.meta.dirname, ".."), detached: true, windowsHide: true, stdio: "ignore" },
  );

  try {
    await once(parent, "close");
    await waitForFile(doneMarker);
    agentPid = Number(readFileSync(pidMarker, "utf8"));
  } finally {
    if (agentPid === null && existsSync(pidMarker)) {
      agentPid = Number(readFileSync(pidMarker, "utf8"));
    }
    if (agentPid && Number.isInteger(agentPid) && agentPid > 0) {
      try {
        process.kill(agentPid, 0);
        process.kill(agentPid);
      } catch {
        // The delayed agent has normally exited before cleanup.
      }
    }
    rmSync(home, { recursive: true, force: true });
  }
});
