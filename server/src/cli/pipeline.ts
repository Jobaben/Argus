/**
 * `argus pipeline` — the I/O half. See `pipelineCore.ts` for what each verb
 * means. Reads go straight to the open routes; a verb that validates, saves
 * or starts logs in for the one call (as `argus approve` does), makes it, and
 * logs out. Every effect comes through `PipelineIo`, so the test drives it
 * against a stand-in server with no terminal attached.
 */

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { PipelineDefinition, PipelineInstance } from "@argus/contracts";
import { SESSION_COOKIE } from "../auth.js";
import { obtainCredentials, readJson, terminalPrompt, type GateIo } from "./gate.js";
import { NO_CREDENTIALS, explainRefusal, sessionFromSetCookie } from "./gateCore.js";
import {
  PIPELINE_HELP,
  explainPipelineRefusal,
  findPipeline,
  listLine,
  needsSession,
  parseDefinition,
  parsePipelineArgs,
  runtimeLine,
  shareable,
  writeRequest,
  type PipelineCliOptions,
  type RuntimeRow,
} from "./pipelineCore.js";

export interface PipelineIo extends Pick<
  GateIo,
  "fetch" | "out" | "err" | "isTTY" | "prompt" | "env"
> {
  /** The definition file's text; `-` is stdin. */
  readFile: (file: string) => Promise<string>;
}

type Body = { error?: string; code?: string; reasons?: string[] } | null;

/** Runs the verb; resolves to the exit status. */
export async function runPipeline(options: PipelineCliOptions, io: PipelineIo): Promise<number> {
  const { command } = options;
  const headers = (extra: Record<string, string> = {}) => ({
    accept: "application/json",
    "content-type": "application/json",
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    ...extra,
  });
  const fail = (message: string): number => {
    io.err(options.json ? JSON.stringify({ ok: false, error: message }) : `✗ ${message}`);
    return 1;
  };
  const unreachable = (e: unknown) =>
    fail(
      `no Argus answering at ${options.url} (${e instanceof Error ? e.message : String(e)}) — start one with \`argus\`, or point --url at the one you mean`,
    );

  async function get<T>(
    path: string,
  ): Promise<{ ok: true; body: T } | { ok: false; code: number }> {
    let res: Response;
    try {
      res = await io.fetch(`${options.url}${path}`, {
        headers: headers(),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      unreachable(e);
      return { ok: false, code: 1 };
    }
    if (!res.ok) {
      const why =
        res.status === 401
          ? `Argus at ${options.url} wants a token — set ARGUS_TOKEN (or pass --token)`
          : explainPipelineRefusal(command.verb, res.status, await readJson(res));
      return { ok: false, code: fail(why) };
    }
    return { ok: true, body: (await res.json()) as T };
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  if (command.verb === "list" || command.verb === "show") {
    const got = await get<{ pipelines: PipelineDefinition[] }>("/api/pipelines");
    if (!got.ok) return got.code;
    const defs = got.body.pipelines;
    if (command.verb === "list") {
      if (options.json) {
        for (const d of defs) io.out(JSON.stringify(shareable(d)));
      } else if (defs.length === 0) {
        io.out("no pipelines yet — `argus pipeline create <file>` saves one");
      } else {
        for (const d of defs) io.out(listLine(d));
      }
      return 0;
    }
    const found = findPipeline(defs, command.ref);
    if (!found.ok) return fail(found.error);
    io.out(JSON.stringify(shareable(found.def), null, 2));
    return 0;
  }

  if (command.verb === "runtimes") {
    const got = await get<{ runtimes: RuntimeRow[] }>("/api/runtimes");
    if (!got.ok) return got.code;
    for (const rt of got.body.runtimes) io.out(options.json ? JSON.stringify(rt) : runtimeLine(rt));
    return 0;
  }

  // ── Writes: read the file first, so a typo costs no login ─────────────────

  let definition: unknown = undefined;
  if (command.verb !== "start") {
    let text: string;
    try {
      text = await io.readFile(command.file);
    } catch (e) {
      return fail(`cannot read ${command.file}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const parsed = parseDefinition(text, command.file);
    if (!parsed.ok) return fail(parsed.error);
    definition = parsed.value;
  }

  if (!needsSession(command)) return fail(`unexpected command ${command.verb}`);
  const credentials = await obtainCredentials(io);
  if (!credentials) return fail(NO_CREDENTIALS);
  let login: Response;
  try {
    login = await io.fetch(`${options.url}/api/auth/login`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(credentials),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    return unreachable(e);
  }
  if (!login.ok) {
    return fail(explainRefusal("login", login.status, await readJson(login), options.url));
  }
  const session = sessionFromSetCookie(login.headers.get("set-cookie"), SESSION_COOKIE);
  if (!session) return fail("login answered without a session cookie");
  const withSession = () => headers({ "x-argus-session": session });

  try {
    const { method, path } = writeRequest(command);
    let res: Response;
    try {
      res = await io.fetch(`${options.url}${path}`, {
        method,
        headers: withSession(),
        body: JSON.stringify(definition ?? {}),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      return unreachable(e);
    }
    if (!res.ok) {
      return fail(explainPipelineRefusal(command.verb, res.status, (await readJson(res)) as Body));
    }
    const body = (await res.json()) as unknown;
    if (options.json) {
      const out =
        command.verb === "create" || command.verb === "update"
          ? shareable(body as PipelineDefinition)
          : body;
      io.out(JSON.stringify(out));
      return 0;
    }
    switch (command.verb) {
      case "validate": {
        const p = (body as { pipeline: { name: string; phases: unknown[] } }).pipeline;
        io.out(
          `✓ valid — "${p.name}", ${p.phases.length} phase${p.phases.length === 1 ? "" : "s"}; nothing was saved`,
        );
        break;
      }
      case "create": {
        const d = body as PipelineDefinition;
        io.out(`✓ created ${d.id} — ${listLine(d).slice(d.id.length + 2)}`);
        if (d.trigger?.kind === "webhook") {
          io.out(
            `  its webhook is POST ${options.url}/api/hooks/pipelines/${d.id}, with the token on its card in the dashboard`,
          );
        }
        break;
      }
      case "update": {
        const d = body as PipelineDefinition;
        io.out(`✓ saved ${d.id} — the next instance runs this definition`);
        break;
      }
      case "start": {
        const inst = body as PipelineInstance;
        io.out(
          `✓ started instance ${inst.id} of "${inst.pipelineName}" — follow it with \`argus tail\``,
        );
        break;
      }
    }
    return 0;
  } finally {
    // Best effort: the session is in the server's memory only.
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

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function main(argv: string[]): Promise<number> {
  const parsed = parsePipelineArgs(argv, process.env);
  if (parsed.kind === "help") {
    console.log(PIPELINE_HELP);
    return 0;
  }
  if (parsed.kind === "error") {
    console.error(`[argus pipeline] ${parsed.message}`);
    return 2;
  }
  const fromStdin = "file" in parsed.options.command && parsed.options.command.file === "-";
  return runPipeline(parsed.options, {
    fetch: globalThis.fetch,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    // stdin carrying the definition cannot also answer a prompt.
    isTTY: !fromStdin && Boolean(process.stdin.isTTY && process.stdout.isTTY),
    prompt: terminalPrompt,
    env: process.env,
    readFile: (file) => (file === "-" ? readStdin() : readFile(file, "utf8")),
  });
}

const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(`[argus pipeline] ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
