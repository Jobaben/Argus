#!/usr/bin/env node
/**
 * `argus` — single-command entry point.
 *
 * Ensures a production build exists (building it on first run), then starts
 * the single-port server (UI + API together, loopback:7777 by default).
 * Everything the server honours (ARGUS_PORT, ARGUS_HOST, ARGUS_TOKEN, …)
 * passes straight through; `--port` is a convenience override.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const HELP = `argus — the all-seeing monitor for your Claude Code agents

Usage: argus [options]

Options:
  --open         open the dashboard in your browser once the server is up
  --port <n>     port to serve on (default: $ARGUS_PORT or 7777)
  --rebuild      rebuild the UI and server even if a build already exists
  --version      print the Argus version
  --help         show this help

Environment: ARGUS_PORT, ARGUS_HOST, ARGUS_TOKEN, ARGUS_CLAUDE_HOME and every
other server variable are honoured as usual (see docs/API.md).`;

function fail(msg) {
  console.error(`[argus] ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { open: false, rebuild: false, port: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(HELP);
      process.exit(0);
    } else if (arg === "--version" || arg === "-v") {
      console.log(version());
      process.exit(0);
    } else if (arg === "--open") {
      opts.open = true;
    } else if (arg === "--rebuild") {
      opts.rebuild = true;
    } else if (arg === "--port" || arg.startsWith("--port=")) {
      const raw = arg.includes("=") ? arg.slice("--port=".length) : argv[++i];
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 65535)
        fail(`--port needs an integer 1-65535, got "${raw ?? ""}"`);
      opts.port = n;
    } else {
      fail(`unknown option "${arg}" (try --help)`);
    }
  }
  return opts;
}

function version() {
  return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
}

function run(args, label) {
  console.log(`[argus] ${label}…`);
  const res = spawnSync(npm, args, { cwd: root, stdio: "inherit", shell: false });
  if (res.status !== 0) fail(`${label} failed (exit ${res.status ?? "?"})`);
}

/** Build check: make sure UI + compiled server exist before starting. */
function ensureBuilt(rebuild) {
  const missing =
    !existsSync(path.join(root, "web", "dist", "index.html")) ||
    !existsSync(path.join(root, "server", "dist", "index.js"));
  if (!missing && !rebuild) return;
  if (!existsSync(path.join(root, "node_modules"))) run(["ci"], "installing dependencies");
  run(
    ["run", "build"],
    missing ? "no build found — building UI and server" : "rebuilding UI and server",
  );
}

function opener(url) {
  if (process.platform === "darwin") return ["open", [url]];
  if (process.platform === "win32") return ["cmd", ["/c", "start", "", url]];
  return ["xdg-open", [url]];
}

async function openWhenUp(url) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) {
        const [cmd, args] = opener(url);
        spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {
          console.log(`[argus] couldn't open a browser — dashboard is at ${url}`);
        });
        return;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`[argus] server didn't answer within 20s — open ${url} manually once it's up`);
}

const major = Number(process.versions.node.split(".")[0]);
if (major < 22) fail(`Node >= 22 required (you have ${process.versions.node})`);

const opts = parseArgs(process.argv.slice(2));
ensureBuilt(opts.rebuild);

const env = { ...process.env };
if (opts.port !== null) env.ARGUS_PORT = String(opts.port);
const port = opts.port ?? (Number(process.env.ARGUS_PORT || "") || 7777);

const child = spawn(process.execPath, [path.join(root, "server", "dist", "index.js")], {
  cwd: root,
  env,
  stdio: "inherit",
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));

if (opts.open) void openWhenUp(`http://127.0.0.1:${port}`);
