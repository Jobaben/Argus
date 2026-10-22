/**
 * `argus pipeline` — the pure half: arguments, the request each verb makes,
 * and how answers read. `pipeline.ts` does the I/O.
 *
 * The pipeline form is the human's way to author a definition. This is the
 * agent's: a definition lives in a JSON file the agent writes, is checked by
 * the server's own validator without being saved (`validate`), and is then
 * saved, replaced or started with the same admin-gated routes the form uses.
 * The skill that teaches an agent to author pipelines (`argus-pipeline`) is
 * written against these verbs, so they stay few and literal.
 */

import type { AgentRuntimeId, PipelineDefinition } from "@argus/contracts";
import { defaultUrl } from "./tailCore.js";

export type PipelineVerb =
  "list" | "show" | "runtimes" | "validate" | "create" | "update" | "start";

export type PipelineCommand =
  | { verb: "list" }
  | { verb: "runtimes" }
  | { verb: "show"; ref: string }
  | { verb: "validate"; file: string; as: string | null }
  | { verb: "create"; file: string }
  | { verb: "update"; id: string; file: string; patch: boolean; force: boolean }
  | { verb: "start"; id: string };

export interface PipelineCliOptions {
  command: PipelineCommand;
  url: string;
  /** Shared `ARGUS_TOKEN`, the network gate; not the admin session. */
  token: string | null;
  json: boolean;
}

export type ParsedPipelineArgs =
  | { kind: "help" }
  | { kind: "error"; message: string }
  | { kind: "ok"; options: PipelineCliOptions };

export const PIPELINE_HELP = `argus pipeline — author, check and start pipelines from a terminal

Usage: argus pipeline list [--json]
       argus pipeline show <id|name>
       argus pipeline runtimes [--json]
       argus pipeline validate <file|-> [--as <id>]
       argus pipeline create <file|->
       argus pipeline update <id> <file|-> [--patch] [--force]
       argus pipeline start <id>

Commands:
  list       every definition: id, name, trigger, state, phase count
  show       one definition as JSON — save it, edit it, send it back with update
  runtimes   which agent CLIs this Argus can run, with their models and efforts
  validate   every check a save makes, without saving; prints the reason when
             the definition would be refused. --as <id> checks it as a
             replacement of that pipeline.
  create     save a new definition; prints its id
  update     replace a definition with the file (--patch: merge the file's
             fields into it). Refused while instances run under it, since
             they keep the definition they started with; --force saves it
             for the next start anyway.
  start      start an instance now. It runs the pipeline's agents, which
             spend money; watch it with \`argus tail\`.

<file> is a JSON pipeline definition; - reads it from stdin.

Options:
  --json           one JSON object instead of text
  --url <base>     Argus base URL (default http://127.0.0.1:$ARGUS_PORT or 7777)
  --token <token>  shared bearer token (default $ARGUS_TOKEN)
  --help           show this help

Credentials: validate, create, update and start need an Argus account. Set
ARGUS_USER and ARGUS_PASSWORD, or answer the prompt on a terminal. The
session lasts for this one call and is never written to disk.

Exit status: 0 done, 1 refused, invalid or unreachable, 2 bad arguments.`;

const VERBS: readonly PipelineVerb[] = [
  "list",
  "show",
  "runtimes",
  "validate",
  "create",
  "update",
  "start",
];

/** What each verb takes positionally, for the error that says so. */
const USAGE: Record<PipelineVerb, string> = {
  list: "list",
  runtimes: "runtimes",
  show: "show <id|name>",
  validate: "validate <file|->",
  create: "create <file|->",
  update: "update <id> <file|->",
  start: "start <id>",
};
const ARITY: Record<PipelineVerb, number> = {
  list: 0,
  runtimes: 0,
  show: 1,
  validate: 1,
  create: 1,
  update: 2,
  start: 1,
};

export function parsePipelineArgs(argv: string[], env: NodeJS.ProcessEnv): ParsedPipelineArgs {
  let url = defaultUrl(env);
  let token = env.ARGUS_TOKEN?.trim() || null;
  let json = false;
  let as: string | null = null;
  let patch = false;
  let force = false;
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // `-` alone is the stdin file, not a flag.
    if (!arg.startsWith("-") || arg === "-") {
      words.push(arg);
      continue;
    }
    const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    const value = (): string | null => {
      if (arg.includes("=")) return arg.slice(arg.indexOf("=") + 1);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) return null;
      i++;
      return next;
    };
    switch (flag) {
      case "--help":
      case "-h":
        return { kind: "help" };
      case "--json":
        json = true;
        break;
      case "--patch":
        patch = true;
        break;
      case "--force":
        force = true;
        break;
      case "--as":
      case "--url":
      case "--token": {
        const v = value();
        if (v === null) return { kind: "error", message: `${flag} needs a value` };
        if (flag === "--as") as = v;
        else if (flag === "--url") url = v.replace(/\/+$/, "");
        else token = v || null;
        break;
      }
      default:
        return { kind: "error", message: `unknown option "${arg}" (try --help)` };
    }
  }
  const [verb, ...rest] = words;
  if (verb === undefined) return { kind: "help" };
  if (!(VERBS as readonly string[]).includes(verb)) {
    return {
      kind: "error",
      message: `unknown command "${verb}" — expected one of ${VERBS.join(", ")} (try --help)`,
    };
  }
  const v = verb as PipelineVerb;
  if (rest.length !== ARITY[v]) {
    return { kind: "error", message: `usage: argus pipeline ${USAGE[v]}` };
  }
  if (as !== null && v !== "validate")
    return { kind: "error", message: "--as belongs to validate" };
  if ((patch || force) && v !== "update") {
    return { kind: "error", message: `${patch ? "--patch" : "--force"} belongs to update` };
  }
  let command: PipelineCommand;
  switch (v) {
    case "list":
    case "runtimes":
      command = { verb: v };
      break;
    case "show":
      command = { verb: v, ref: rest[0] };
      break;
    case "validate":
      command = { verb: v, file: rest[0], as };
      break;
    case "create":
      command = { verb: v, file: rest[0] };
      break;
    case "update":
      command = { verb: v, id: rest[0], file: rest[1], patch, force };
      break;
    case "start":
      command = { verb: v, id: rest[0] };
      break;
  }
  return { kind: "ok", options: { command, url, token, json } };
}

/** Whether the verb changes or executes something, and so needs an admin session. */
export function needsSession(command: PipelineCommand): boolean {
  return (
    command.verb === "validate" ||
    command.verb === "create" ||
    command.verb === "update" ||
    command.verb === "start"
  );
}

/** The one call a session-needing verb makes, given the definition it read. */
export function writeRequest(
  command: Exclude<PipelineCommand, { verb: "list" | "runtimes" | "show" }>,
): { method: "POST" | "PUT" | "PATCH"; path: string } {
  switch (command.verb) {
    case "validate":
      return {
        method: "POST",
        path: `/api/pipelines/validate${command.as ? `?id=${encodeURIComponent(command.as)}` : ""}`,
      };
    case "create":
      return { method: "POST", path: "/api/pipelines" };
    case "update":
      return {
        method: command.patch ? "PATCH" : "PUT",
        path: `/api/pipelines/${encodeURIComponent(command.id)}${command.force ? "?force=1" : ""}`,
      };
    case "start":
      return { method: "POST", path: `/api/pipelines/${encodeURIComponent(command.id)}/start` };
  }
}

/** JSON text → a value, or a message saying where it broke. */
export function parseDefinition(
  text: string,
  file: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    const where = file === "-" ? "stdin" : file;
    return {
      ok: false,
      error: `${where} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * The stored definition as `show` prints it: everything `update` takes back,
 * without the webhook credential, which is no part of authoring and should
 * not travel through files and transcripts.
 */
export function shareable(def: PipelineDefinition): Omit<PipelineDefinition, "hookToken"> {
  const { hookToken: _hookToken, ...rest } = def;
  return rest;
}

/** `id` exactly, else a unique case-insensitive name. */
export function findPipeline(
  defs: readonly PipelineDefinition[],
  ref: string,
): { ok: true; def: PipelineDefinition } | { ok: false; error: string } {
  const byId = defs.find((d) => d.id === ref);
  if (byId) return { ok: true, def: byId };
  const named = defs.filter((d) => d.name.trim().toLowerCase() === ref.trim().toLowerCase());
  if (named.length === 1) return { ok: true, def: named[0] };
  if (named.length > 1) {
    return {
      ok: false,
      error: `${named.length} pipelines are named "${ref}" — name one by id: ${named.map((d) => d.id).join(", ")}`,
    };
  }
  return { ok: false, error: `no pipeline with id or name "${ref}" — \`argus pipeline list\`` };
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function triggerText(def: Pick<PipelineDefinition, "trigger">): string {
  const t = def.trigger;
  if (!t) return "manual";
  const day = (d: number) => WEEKDAYS[d] ?? String(d);
  switch (t.kind) {
    case "interval":
      return `every ${t.everyMinutes}m`;
    case "daily":
      return `daily ${t.time}`;
    case "weekly":
      return `${t.weekday === undefined ? "weekly" : day(t.weekday)} ${t.time}`;
    case "windowed": {
      const days = t.weekdays?.length ? ` ${t.weekdays.map(day).join(",")}` : "";
      return `every ${t.everyMinutes}m ${t.startTime}–${t.endTime}${days}`;
    }
    case "webhook":
      return "webhook";
    case "after":
      return `after ${t.pipelineId} (${t.on ?? "succeeded"})`;
  }
}

export function listLine(def: PipelineDefinition): string {
  const phases = `${def.phases.length} phase${def.phases.length === 1 ? "" : "s"}`;
  const state = def.enabled ? "enabled" : "paused";
  return `${def.id}  ${def.name} · ${triggerText(def)} · ${state} · ${phases}`;
}

/** The slice of `GET /api/runtimes` the `runtimes` verb prints. */
export interface RuntimeRow {
  id: AgentRuntimeId;
  label: string;
  available: boolean;
  isDefault: boolean;
  detail?: string;
  models: string[];
  reasoningEfforts: string[];
}

export function runtimeLine(rt: RuntimeRow): string {
  const state = rt.available ? "available" : `not available${rt.detail ? ` (${rt.detail})` : ""}`;
  const models = rt.models.length > 0 ? rt.models.join(", ") : "the CLI's own";
  const efforts = rt.reasoningEfforts.length > 0 ? rt.reasoningEfforts.join(", ") : "none";
  return `${rt.id}${rt.isDefault ? " (default)" : ""} · ${rt.label} · ${state} · models: ${models} · reasoning efforts: ${efforts}`;
}

/** Why a pipeline call was refused, from its status and body, for a reader. */
export function explainPipelineRefusal(
  verb: PipelineVerb,
  status: number,
  body: { error?: string; code?: string; reasons?: string[] } | null,
): string {
  const error = body?.error;
  if (status === 400)
    return error ? `the server refused it: ${error}` : "the server refused it (400)";
  if (status === 404) return error === "not found" || !error ? "no such pipeline" : error;
  if (status === 409 && body?.code === "instances-running") {
    // The server's own advice names the query parameter; this CLI's is a flag.
    return `${(error ?? "instances are running").replace(/Repeat with \?force=1 to save it anyway\.?/, "").trim()} Add --force to save it anyway.`;
  }
  if (status === 409) return error ?? "conflict";
  if (status === 412 && verb === "start") {
    const reasons = body?.reasons?.length ? `: ${body.reasons.join("; ")}` : "";
    return `${error ?? "preflight failed"}${reasons}`;
  }
  if (status === 401) return "the session was not accepted";
  return error ?? `HTTP ${status}`;
}
