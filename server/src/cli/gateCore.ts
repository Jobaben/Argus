/**
 * The pure half of `argus approve` / `argus revise` — the terminal's way to
 * decide on a gate that `argus tail` reported.
 *
 * The dashboard's review drawer is where a human *looks* at what a paused
 * phase produced. These two verbs exist for the window that has no browser:
 * an SSH session, or an agent relaying the tail into a chat and being told
 * "approve it". They call the same admin-gated routes the drawer does, with an
 * admin session obtained for the one call and never kept.
 *
 * Nothing here touches the network or the terminal: argument parsing, the
 * request each verb makes, where credentials come from, and how an outcome
 * reads — all testable as plain functions. `gate.ts` does the I/O.
 */

import { defaultUrl } from "./tailCore.js";

export type GateVerb = "approve" | "revise";

export interface GateOptions {
  verb: GateVerb;
  instanceId: string;
  /** Which paused phase, when a fan-out has more than one waiting. */
  phaseId: string | null;
  /** The revision handed to the agent. Required for `revise`. */
  note: string | null;
  url: string;
  /** Shared `ARGUS_TOKEN`, the network gate; not the admin session. */
  token: string | null;
  json: boolean;
}

export type ParsedGateArgs =
  | { kind: "help"; verb: GateVerb }
  | { kind: "error"; message: string }
  | { kind: "ok"; options: GateOptions };

export const GATE_HELP: Record<GateVerb, string> = {
  approve: `argus approve — open a gate a pipeline is waiting at

Usage: argus approve <instanceId> [options]

Continues the pipeline past the paused phase with what the agent produced,
exactly as the Approve button in the Command Center's review drawer does.
Look first: \`argus tail\` prints the review link beside every waiting gate.

Options:
  --phase <phaseId>   which paused phase, when more than one is waiting
  --json              one JSON object describing the outcome
  --url <base>        Argus base URL (default http://127.0.0.1:$ARGUS_PORT or 7777)
  --token <token>     shared bearer token (default $ARGUS_TOKEN)
  --help              show this help

Credentials: approving needs an Argus account. Set ARGUS_USER and
ARGUS_PASSWORD, or answer the prompt on a terminal. The session lasts for
this one call and is never written to disk.

Exit status: 0 approved, 1 refused or unreachable, 2 bad arguments.`,
  revise: `argus revise — send a paused phase back to its agent with a note

Usage: argus revise <instanceId> --note "<what to change>" [options]

Discards this attempt's output and runs the phase again with your note
appended to its prompt, exactly as Revise in the Command Center does.

Options:
  --note <text>       the revision the agent should make (required)
  --phase <phaseId>   which paused phase, when more than one is waiting
  --json              one JSON object describing the outcome
  --url <base>        Argus base URL (default http://127.0.0.1:$ARGUS_PORT or 7777)
  --token <token>     shared bearer token (default $ARGUS_TOKEN)
  --help              show this help

Credentials: revising needs an Argus account. Set ARGUS_USER and
ARGUS_PASSWORD, or answer the prompt on a terminal. The session lasts for
this one call and is never written to disk.

Exit status: 0 sent back, 1 refused or unreachable, 2 bad arguments.`,
};

export function isGateVerb(word: string | undefined): word is GateVerb {
  return word === "approve" || word === "revise";
}

export function parseGateArgs(
  verb: GateVerb,
  argv: string[],
  env: NodeJS.ProcessEnv,
): ParsedGateArgs {
  const options: GateOptions = {
    verb,
    instanceId: "",
    phaseId: null,
    note: null,
    url: defaultUrl(env),
    token: env.ARGUS_TOKEN?.trim() || null,
    json: false,
  };
  const value = (i: number, flag: string): string | { error: string } => {
    const arg = argv[i];
    if (arg.includes("=")) return arg.slice(arg.indexOf("=") + 1);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) return { error: `${flag} needs a value` };
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      if (options.instanceId) {
        return { kind: "error", message: `unexpected argument "${arg}" (one instance id only)` };
      }
      options.instanceId = arg;
      continue;
    }
    const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    const takesValue = ["--note", "--phase", "--url", "--token"].includes(flag);
    let v = "";
    if (takesValue) {
      const got = value(i, flag);
      if (typeof got !== "string") return { kind: "error", message: got.error };
      v = got;
      if (!arg.includes("=")) i++;
    }
    switch (flag) {
      case "--help":
      case "-h":
        return { kind: "help", verb };
      case "--json":
        options.json = true;
        break;
      case "--note":
        if (verb !== "revise") return { kind: "error", message: "--note belongs to revise" };
        options.note = v;
        break;
      case "--phase":
        options.phaseId = v;
        break;
      case "--url":
        options.url = v.replace(/\/+$/, "");
        break;
      case "--token":
        options.token = v || null;
        break;
      default:
        return { kind: "error", message: `unknown option "${arg}" (try --help)` };
    }
  }
  if (!options.instanceId) {
    return { kind: "error", message: `${verb} needs an instance id — argus tail prints it` };
  }
  if (verb === "revise" && !options.note?.trim()) {
    return {
      kind: "error",
      message: 'revise needs --note "<what to change>" — the agent runs the phase again with it',
    };
  }
  return { kind: "ok", options };
}

/** The one admin-gated POST each verb makes. */
export function gateRequest(options: GateOptions): { path: string; body: Record<string, unknown> } {
  const target = options.phaseId ? { phaseId: options.phaseId } : {};
  if (options.verb === "approve") {
    return { path: `/api/instances/${options.instanceId}/approve`, body: { ...target } };
  }
  return {
    path: `/api/instances/${options.instanceId}/revise`,
    body: { note: options.note ?? "", ...target },
  };
}

export interface Credentials {
  username: string;
  password: string;
}

/** Both variables set and non-blank, else null: the prompt (or an error) takes over. */
export function credentialsFromEnv(env: NodeJS.ProcessEnv): Credentials | null {
  const username = env.ARGUS_USER?.trim();
  const password = env.ARGUS_PASSWORD;
  if (!username || !password) return null;
  return { username, password };
}

export const NO_CREDENTIALS =
  "this needs an Argus account and no terminal is attached to ask — set ARGUS_USER and ARGUS_PASSWORD";

/** The session cookie's value out of a `set-cookie` header, or null. */
export function sessionFromSetCookie(header: string | null, cookieName: string): string | null {
  if (!header) return null;
  for (const cookie of header.split(/,(?=\s*[^;,\s]+=)/)) {
    const first = cookie.split(";")[0]?.trim() ?? "";
    const eq = first.indexOf("=");
    if (eq === -1) continue;
    if (first.slice(0, eq).trim() !== cookieName) continue;
    const raw = first.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw) || null;
    } catch {
      return raw || null;
    }
  }
  return null;
}

export interface GateOutcome {
  ok: boolean;
  verb: GateVerb;
  instanceId: string;
  phaseId: string | null;
  /** HTTP status of the decisive response, null when nothing answered. */
  status: number | null;
  error?: string;
}

/** One line for a human, or one JSON object, saying what happened. */
export function renderOutcome(outcome: GateOutcome, json: boolean): string {
  if (json) return JSON.stringify(outcome);
  const where = outcome.phaseId ? ` at "${outcome.phaseId}"` : "";
  if (outcome.ok) {
    return outcome.verb === "approve"
      ? `✓ approved ${outcome.instanceId}${where} — the pipeline continues`
      : `↺ sent ${outcome.instanceId}${where} back to its agent — the phase runs again with your note`;
  }
  return `✗ could not ${outcome.verb} ${outcome.instanceId}${where}: ${outcome.error ?? `HTTP ${outcome.status ?? "?"}`}`;
}

/** Why a login or gate call was refused, from its status and body, for a human. */
export function explainRefusal(
  step: "login" | "gate",
  status: number,
  body: { error?: string; code?: string } | null,
  url: string,
): string {
  if (step === "login") {
    if (status === 401 && body?.code === "auth_setup_required") {
      return `Argus at ${url} has no account yet — create one in the dashboard first`;
    }
    if (status === 401 && body?.error) {
      return `login refused: ${body.error}`;
    }
    if (status === 401)
      return `Argus at ${url} refused the shared token — set ARGUS_TOKEN (or pass --token)`;
    if (status === 403 && body?.code === "pending_approval") {
      return "login refused: your account is awaiting root approval";
    }
    if (status === 403) {
      return `Argus at ${url} refused the request (403) — its Host allowlist does not cover this URL`;
    }
    if (status === 429) return "login refused: too many failed attempts — try again shortly";
    return body?.error ? `login failed: ${body.error}` : `login failed: HTTP ${status}`;
  }
  if (status === 404) return body?.error ?? "no such instance";
  if (status === 409) return body?.error ?? "the instance is not waiting at a gate";
  if (status === 401) return "the session was not accepted";
  return body?.error ?? `HTTP ${status}`;
}
