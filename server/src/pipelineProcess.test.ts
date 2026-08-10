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
  destroyed = false;
  disconnectCalls = 0;
  killCalled = false;
  unrefCalled = false;
  stdin = {
    on: () => this.stdin,
    write: (value: string) => this.writes.push(value),
    end: () => {
      this.ended = true;
    },
    destroy: () => {
      this.destroyed = true;
    },
  };
  send(message: unknown, callback?: (error: Error | null) => void) {
    this.sent.push(message);
    callback?.(null);
    queueMicrotask(() => this.disconnect());
    return true;
  }
  disconnect() {
    this.disconnectCalls += 1;
    this.connected = false;
    this.emit("disconnect");
  }
  kill() {
    this.killCalled = true;
    return true;
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

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (isAlive(pid)) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for pid ${pid} to exit`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function assertRejectedHostCleaned(host: FakeHost): void {
  assert.equal(host.destroyed, true);
  assert.equal(host.connected, false);
  assert.equal(host.disconnectCalls > 0, true);
  assert.equal(host.killCalled, true);
  assert.equal(host.unrefCalled, false);
}

async function captureNumericSignals(run: () => Promise<void>): Promise<number[]> {
  const originalKill = process.kill;
  const signals: number[] = [];
  process.kill = ((pid: number) => {
    signals.push(pid);
    return true;
  }) as typeof process.kill;
  try {
    await run();
  } finally {
    process.kill = originalKill;
  }
  return signals;
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
  assertRejectedHostCleaned(host);
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

test("Windows accepts host disconnect before the successful send callback", async () => {
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
  const handle = await spawnPipelineProcess(
    { bin: "codex.exe", args: [], stdin: "prompt", cwd: "C:\\work", env: {} },
    17,
    "win32",
    spawn,
  );
  assert.equal(handle.pid, 4242);
  assert.deepEqual(host.writes, ["prompt"]);
  assert.equal(host.ended, true);
  assert.equal(host.unrefCalled, true);
  assert.equal(host.killCalled, false);
});

test("Windows ignores a late send callback error after authoritative disconnect", async () => {
  const host = new FakeHost();
  host.send = (message, callback) => {
    host.sent.push(message);
    queueMicrotask(() => host.disconnect());
    queueMicrotask(() => callback?.(new Error("late IPC error")));
    return true;
  };
  const spawn = (() => {
    queueMicrotask(() => host.emit("message", { type: "spawned", pid: 4242 }));
    return host;
  }) as unknown as typeof nodeSpawn;
  const handle = await spawnPipelineProcess(
    { bin: "codex.exe", args: [], stdin: "prompt", cwd: "C:\\work", env: {} },
    17,
    "win32",
    spawn,
  );
  assert.equal(handle.pid, 4242);
  assert.deepEqual(host.writes, ["prompt"]);
  assert.equal(host.ended, true);
  assert.equal(host.killCalled, false);
});

test("Windows rejects a disconnect before a valid PID and acknowledgement attempt", async () => {
  const host = new FakeHost();
  const spawn = (() => {
    queueMicrotask(() => host.disconnect());
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
  assertRejectedHostCleaned(host);
});

test("Windows rejects an unavailable IPC channel and cleans the host", async () => {
  const host = new FakeHost();
  host.send = undefined as unknown as FakeHost["send"];
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
    /no IPC channel/i,
  );
  assertRejectedHostCleaned(host);
});

test("Windows does not signal a numeric PID when owned host kill returns false", async () => {
  const host = new FakeHost();
  let killCalls = 0;
  host.kill = () => {
    killCalls += 1;
    return false;
  };
  const spawn = (() => {
    queueMicrotask(() => host.emit("message", { type: "spawned", pid: 0 }));
    return host;
  }) as unknown as typeof nodeSpawn;
  const signals = await captureNumericSignals(async () => {
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
  assert.equal(killCalls, 1);
  assert.deepEqual(signals, []);
});

test("Windows does not signal a numeric PID when owned host kill throws", async () => {
  const host = new FakeHost();
  let killCalls = 0;
  host.kill = () => {
    killCalls += 1;
    throw new Error("owned kill failed");
  };
  const spawn = (() => {
    queueMicrotask(() => host.emit("message", { type: "spawned", pid: 0 }));
    return host;
  }) as unknown as typeof nodeSpawn;
  const signals = await captureNumericSignals(async () => {
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
  assert.equal(killCalls, 1);
  assert.deepEqual(signals, []);
});

test("Windows does not kill or signal an already-closed host", async () => {
  const host = new FakeHost();
  let killCalls = 0;
  host.kill = () => {
    killCalls += 1;
    return true;
  };
  const spawn = (() => {
    queueMicrotask(() => {
      host.connected = false;
      host.emit("close", 1);
    });
    return host;
  }) as unknown as typeof nodeSpawn;
  const signals = await captureNumericSignals(async () => {
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
  assert.equal(host.destroyed, true);
  assert.equal(host.disconnectCalls, 0);
  assert.equal(killCalls, 0);
  assert.deepEqual(signals, []);
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
  assertRejectedHostCleaned(host);
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
  assertRejectedHostCleaned(host);
});

test(
  "Windows rejected handshake leaves neither the real host nor agent alive",
  { skip: process.platform !== "win32" },
  async () => {
    const home = mkdtempSync(path.join(tmpdir(), "argus-pipeline-rejected-"));
    const logPath = path.join(home, "rejected.log");
    const fd = openSync(logPath, "a");
    let hostPid: number | null = null;
    let agentPid: number | null = null;
    let hostClosed = false;
    let hostProcess: ReturnType<typeof nodeSpawn> | null = null;
    const agentSource = "setInterval(() => {}, 1000);";
    const rejectingSpawn = ((command: string, args: string[], options: Parameters<typeof nodeSpawn>[2]) => {
      const host = nodeSpawn(command, args, options);
      hostProcess = host;
      hostPid = host.pid ?? null;
      host.once("close", () => {
        hostClosed = true;
      });
      host.on("message", (message: unknown) => {
        if (message && typeof message === "object" && (message as { type?: unknown }).type === "spawned") {
          agentPid = (message as { pid?: number }).pid ?? null;
        }
      });
      host.send = ((_message: unknown, callback?: (error: Error | null) => void) => {
        queueMicrotask(() => callback?.(new Error("forced acknowledgement rejection")));
        return true;
      }) as typeof host.send;
      return host;
    }) as unknown as typeof nodeSpawn;

    try {
      await assert.rejects(
        spawnPipelineProcess(
          { bin: process.execPath, args: ["-e", agentSource], stdin: "", cwd: home, env: process.env },
          fd,
          "win32",
          rejectingSpawn,
        ),
        /forced acknowledgement rejection/,
      );
      assert.equal(hostPid !== null && hostPid > 0, true);
      assert.equal(agentPid !== null && agentPid > 0, true);
      await Promise.all([waitForExit(hostPid!), waitForExit(agentPid!)]);
    } finally {
      closeSync(fd);
      const ownedHost = hostProcess as ReturnType<typeof nodeSpawn> | null;
      if (ownedHost && !hostClosed) {
        try {
          ownedHost.kill();
        } catch {
          // The owned host process may exit between the close check and cleanup.
        }
      }
      await Promise.all(
        ([hostPid, agentPid] as Array<number | null>)
          .filter((pid): pid is number => pid !== null)
          .map((pid) => waitForExit(pid).catch(() => {})),
      );
      const closeStarted = Date.now();
      while (!hostClosed && Date.now() - closeStarted <= 5000) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
);

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
