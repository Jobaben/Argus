/**
 * `argus approve` / `argus revise` — the I/O half. See `gateCore.ts` for what
 * each verb means; this file logs in, makes the one call, logs out, and prints
 * the outcome. Every effect comes through `GateIo`, so the test drives it
 * against a stand-in server with no terminal attached.
 */

import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { SESSION_COOKIE } from "../auth.js";
import {
  GATE_HELP,
  NO_CREDENTIALS,
  credentialsFromEnv,
  explainRefusal,
  gateRequest,
  isGateVerb,
  parseGateArgs,
  renderOutcome,
  sessionFromSetCookie,
  type Credentials,
  type GateOptions,
  type GateOutcome,
} from "./gateCore.js";

export interface GateIo {
  fetch: typeof fetch;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Whether a human can be asked for credentials. */
  isTTY: boolean;
  /** Ask on the terminal; `hidden` for a password. Only called when `isTTY`. */
  prompt: (question: string, hidden: boolean) => Promise<string>;
  env: NodeJS.ProcessEnv;
}

async function readJson(res: Response): Promise<{ error?: string; code?: string } | null> {
  try {
    return (await res.json()) as { error?: string; code?: string };
  } catch {
    return null;
  }
}

async function obtainCredentials(io: GateIo): Promise<Credentials | null> {
  const fromEnv = credentialsFromEnv(io.env);
  if (fromEnv) return fromEnv;
  if (!io.isTTY) return null;
  const username = (await io.prompt("Argus username: ", false)).trim();
  if (!username) return null;
  const password = await io.prompt("Argus password: ", true);
  if (!password) return null;
  return { username, password };
}

/** Runs the verb; resolves to the exit status. */
export async function runGate(options: GateOptions, io: GateIo): Promise<number> {
  const base = (extra: Record<string, string> = {}) => ({
    accept: "application/json",
    "content-type": "application/json",
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    ...extra,
  });
  const fail = (status: number | null, error: string): number => {
    const outcome: GateOutcome = {
      ok: false,
      verb: options.verb,
      instanceId: options.instanceId,
      phaseId: options.phaseId,
      status,
      error,
    };
    io.err(renderOutcome(outcome, options.json));
    return 1;
  };

  const credentials = await obtainCredentials(io);
  if (!credentials) return fail(null, NO_CREDENTIALS);

  let login: Response;
  try {
    login = await io.fetch(`${options.url}/api/auth/login`, {
      method: "POST",
      headers: base(),
      body: JSON.stringify(credentials),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    return fail(
      null,
      `no Argus answering at ${options.url} (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  if (!login.ok) {
    return fail(
      login.status,
      explainRefusal("login", login.status, await readJson(login), options.url),
    );
  }
  const session = sessionFromSetCookie(login.headers.get("set-cookie"), SESSION_COOKIE);
  if (!session) return fail(login.status, "login answered without a session cookie");

  const withSession = () => base({ "x-argus-session": session });
  try {
    const { path, body } = gateRequest(options);
    const res = await io.fetch(`${options.url}${path}`, {
      method: "POST",
      headers: withSession(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return fail(res.status, explainRefusal("gate", res.status, await readJson(res), options.url));
    }
    const outcome: GateOutcome = {
      ok: true,
      verb: options.verb,
      instanceId: options.instanceId,
      phaseId: options.phaseId,
      status: res.status,
    };
    io.out(renderOutcome(outcome, options.json));
    return 0;
  } finally {
    // Best effort: the session is in the server's memory only, and letting it
    // lapse would be harmless — but a one-call session should end with the call.
    try {
      await io.fetch(`${options.url}/api/auth/logout`, {
        method: "POST",
        headers: withSession(),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      /* nothing to do */
    }
  }
}

/** Ask on the terminal, echoing the answer or not. */
function terminalPrompt(question: string, hidden: boolean): Promise<string> {
  const muted = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  const rl = createInterface({
    input: process.stdin,
    output: hidden ? muted : process.stdout,
    terminal: true,
  });
  if (hidden) process.stdout.write(question);
  return new Promise((resolve) => {
    rl.question(hidden ? "" : question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer);
    });
  });
}

export async function main(argv: string[]): Promise<number> {
  const [verb, ...rest] = argv;
  if (!isGateVerb(verb)) {
    console.error(`[argus] expected approve or revise, got "${verb ?? ""}"`);
    return 2;
  }
  const parsed = parseGateArgs(verb, rest, process.env);
  if (parsed.kind === "help") {
    console.log(GATE_HELP[parsed.verb]);
    return 0;
  }
  if (parsed.kind === "error") {
    console.error(`[argus ${verb}] ${parsed.message}`);
    return 2;
  }
  return runGate(parsed.options, {
    fetch: globalThis.fetch,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    prompt: terminalPrompt,
    env: process.env,
  });
}

const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(`[argus] ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
