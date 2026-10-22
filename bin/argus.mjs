#!/usr/bin/env node
/**
 * `argus` — single-command entry point.
 *
 * Runs the pinned release (`argus release`, under ~/.claude-argus-releases)
 * when one is pinned, else the dev checkout, building the checkout on first
 * run, then starts the single-port server (UI + API together,
 * loopback:7777 by default). Everything the server honours (ARGUS_PORT,
 * ARGUS_HOST, ARGUS_TOKEN, …) passes straight through; `--port` is a
 * convenience override.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BuildTargetError, resolveBuildRoot } from "./lib/buildTarget.mjs";

/** The checkout this launcher lives in; `argus release` always builds from it. */
const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const HELP = `argus — the all-seeing monitor for your Claude Code agents

Usage: argus [options]
       argus tail [tail options]
       argus approve <instanceId> [--phase <id>]
       argus revise <instanceId> --note "<text>" [--phase <id>]
       argus pipeline list | show | runtimes | validate | create | update | start
       argus skills [status] | install [<skill>...] [--for claude|codex|all]
       argus release [--ref <ref>] | --list | --use <id>

Commands:
  (none)         serve the dashboard and API on one port
  tail           stream what Argus is doing as text — a snapshot of what is
                 running, waiting for approval or just finished, then the live
                 feed for a bounded window. For a terminal you cannot see, or
                 an agent relaying it. \`argus tail --help\` for its options.
  approve        open a gate a pipeline is waiting at, from a terminal that
                 cannot reach the Command Center. Needs an Argus account
                 (ARGUS_USER / ARGUS_PASSWORD, or the prompt).
  revise         send a paused phase back to its agent with a note; the phase
                 runs again. Same credentials. \`argus revise --help\`.
  pipeline       author pipelines from a terminal: list and show definitions,
                 check one without saving it, save, replace and start them.
                 \`argus pipeline --help\`.
  skills         install or update the agent skills Argus ships
                 (argus-pipeline, argus-tail) in the Claude Code and Codex
                 homes, so agents author pipelines the way this build
                 expects. \`argus skills --help\`.
  release        build a commit into its own folder and pin it, so pipelines
                 keep running while you work in the checkout.
                 \`argus release --help\`.

Every command runs the pinned release when there is one, else the checkout
(with a warning).

Options:
  --open         open the dashboard in your browser once the server is up
  --agent <id>   default runtime: claude, codex, opencode or qwen
                 (default: $ARGUS_AGENT or claude)
  --port <n>     port to serve on (default: $ARGUS_PORT or 7777)
  --rebuild      rebuild the checkout's UI and server even if a build
                 exists (the checkout only; a release is never rebuilt)
  --dev          run the checkout even when a release is pinned
  --version      print the Argus version
  --help         show this help

Environment: ARGUS_PORT, ARGUS_HOST, ARGUS_TOKEN, ARGUS_CLAUDE_HOME,
ARGUS_CODEX_HOME, ARGUS_OPENCODE_HOME, ARGUS_QWEN_HOME, ARGUS_AGENT
(claude|codex|opencode|qwen) and every other server variable are honoured as
usual (see the README's Configuration table).`;

// The runtime ids the server registry knows. Duplicated here rather than
// imported because this launcher runs before anything is built — but a value
// that slips through is only ever ARGUS_AGENT, which the server itself
// re-validates and falls back to Claude Code for.
const AGENTS = ["claude", "codex", "opencode", "qwen"];

function fail(msg) {
  console.error(`[argus] ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { open: false, rebuild: false, port: null, agent: null };
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
    } else if (arg === "--agent" || arg.startsWith("--agent=")) {
      const agent = (arg.includes("=") ? arg.slice("--agent=".length) : argv[++i])?.toLowerCase();
      if (!AGENTS.includes(agent))
        fail(`--agent needs one of ${AGENTS.join(", ")}, got \"${agent ?? ""}\"`);
      opts.agent = agent;
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

// `--dev` applies to every command, so it is taken out before anything parses
// or forwards the arguments: tail's and gate's parsers reject unknown flags.
const dev = process.argv.slice(2).includes("--dev");
const argv = process.argv.slice(2).filter((a) => a !== "--dev");

let resolved = null;
/** The tree to run, resolved once; notices go to stderr so stdout stays clean. */
function target() {
  if (resolved) return resolved;
  try {
    resolved = resolveBuildRoot({ checkout, dev });
  } catch (e) {
    if (e instanceof BuildTargetError) fail(e.message);
    throw e;
  }
  if (resolved.kind === "dev") console.error(`[argus] WARNING: ${resolved.warning}`);
  else console.error(`[argus] release ${resolved.id}`);
  return resolved;
}

function version() {
  return JSON.parse(readFileSync(path.join(target().root, "package.json"), "utf8")).version;
}

function run(args, label) {
  console.log(`[argus] ${label}…`);
  // Node refuses to spawn .cmd files without a shell (CVE-2024-27980 → EINVAL).
  const res = spawnSync(npm, args, {
    cwd: checkout,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (res.status !== 0) fail(`${label} failed (exit ${res.status ?? "?"})`);
}

/**
 * Build check: make sure UI + compiled server exist before starting. Only the
 * checkout is ever installed or built here; a release was built once, by
 * `argus release`, and is never touched again.
 */
function ensureBuilt(t, rebuild, extra = []) {
  if (t.kind === "release") {
    if (rebuild)
      fail(
        "--rebuild rebuilds the checkout, and a pinned release is never rebuilt: cut a new one with `argus release`, or add --dev",
      );
    return;
  }
  const missing = [
    path.join("web", "dist", "index.html"),
    path.join("server", "dist", "index.js"),
    ...extra,
  ].some((p) => !existsSync(path.join(checkout, p)));
  if (!missing && !rebuild) return;
  if (!existsSync(path.join(checkout, "node_modules"))) run(["ci"], "installing dependencies");
  run(
    ["run", "build"],
    missing ? "no build found — building UI and server" : "rebuilding UI and server",
  );
}

/** Runs one of the compiled CLIs in `t`, mirroring its exit and signals. */
function delegate(t, script, args) {
  const child = spawn(
    process.execPath,
    [path.join(t.root, "server", "dist", "cli", script), ...args],
    { cwd: t.root, env: process.env, stdio: "inherit" },
  );
  child.on("exit", (code, signal) => process.exit(signal ? 130 : (code ?? 1)));
  // Ctrl-C reaches the child through the shared terminal; forward it when it
  // arrives here first so the child prints its closing line either way.
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
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

/**
 * `argus tail` — the terminal frontend. It is a client of a *running* Argus
 * (same port, same token), so it needs the compiled server tree but starts no
 * server of its own. Everything after `tail` belongs to it.
 */
if (argv[0] === "tail") {
  const t = target();
  ensureBuilt(t, false);
  delegate(t, "tail.js", argv.slice(1));
} else if (argv[0] === "approve" || argv[0] === "revise") {
  // The terminal's Approve / Revise: same server, same token, plus an admin
  // login for the one call. The verb travels as the first argument.
  const t = target();
  ensureBuilt(t, false);
  delegate(t, "gate.js", argv);
} else if (argv[0] === "pipeline" || argv[0] === "skills") {
  // `pipeline` is another client of the running server; `skills` installs the
  // skills of the tree it runs from, so a pinned release installs its own.
  const t = target();
  ensureBuilt(t, false);
  delegate(t, `${argv[0]}.js`, argv.slice(1));
} else if (argv[0] === "release") {
  // Always the checkout's: it is what builds and pins the releases.
  const t = { kind: "dev", root: checkout };
  ensureBuilt(t, false, [path.join("server", "dist", "cli", "release.js")]);
  delegate(t, "release.js", argv.slice(1));
} else {
  serve();
}

function serve() {
  const opts = parseArgs(argv);
  const t = target();
  ensureBuilt(t, opts.rebuild);

  const env = { ...process.env };
  if (opts.port !== null) env.ARGUS_PORT = String(opts.port);
  if (opts.agent !== null) env.ARGUS_AGENT = opts.agent;
  const port = opts.port ?? (Number(process.env.ARGUS_PORT || "") || 7777);

  const child = spawn(process.execPath, [path.join(t.root, "server", "dist", "index.js")], {
    cwd: t.root,
    env,
    stdio: "inherit",
  });
  child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));

  if (opts.open) void openWhenUp(`http://127.0.0.1:${port}`);
}
