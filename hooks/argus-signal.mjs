#!/usr/bin/env node
// Reference Claude Code hook: emit a pipeline signal to Argus from inside a
// `claude -p` run started by the pipeline engine.
//
// Signal type resolution:
//   * If a type is passed as the first CLI arg ("needs-input" | "failed" |
//     "completed") it is used verbatim. The Gate PreToolUse hook uses this to
//     force "needs-input" at a gate.
//   * Otherwise (the Stop hook, registered with no arg) the type is derived
//     from the agent's own final message: a line matching
//     `ARGUS_OUTCOME: failed` or `ARGUS_OUTCOME: blocked` emits "failed";
//     anything else emits "completed". This lets a run that stops cleanly but
//     concluded it failed/was blocked report that, instead of being rubber-
//     stamped as a success.
//
// Reads ARGUS_SIGNAL_URL / ARGUS_INSTANCE_ID / ARGUS_PHASE_ID / ARGUS_RUN_ID /
// ARGUS_SIGNAL_TOKEN from the environment the engine injected. No-ops when not
// running under a pipeline (env unset), so it is safe to register globally.
import { pathToFileURL } from "node:url";

/** A final message reporting a failed/blocked outcome via the sentinel line. */
const OUTCOME_RE = /ARGUS_OUTCOME:\s*(failed|blocked)/i;

/**
 * Resolve the signal type. An explicit CLI arg always wins; otherwise the
 * agent's final message (from the Stop payload) decides completed vs failed.
 */
export function resolveType(argType, payload) {
  if (argType) return argType;
  const msg =
    payload && typeof payload === "object" && typeof payload.last_assistant_message === "string"
      ? payload.last_assistant_message
      : "";
  return OUTCOME_RE.test(msg) ? "failed" : "completed";
}

function main() {
  const argType = process.argv[2];
  const url = process.env.ARGUS_SIGNAL_URL;
  if (!url) process.exit(0);

  let stdin = "";
  process.stdin.on("data", (c) => (stdin += c));
  process.stdin.on("end", async () => {
    let payload = stdin;
    try { payload = JSON.parse(stdin); } catch { /* keep raw text */ }
    const type = resolveType(argType, payload);
    try {
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          instanceId: process.env.ARGUS_INSTANCE_ID,
          phaseId: process.env.ARGUS_PHASE_ID,
          runId: process.env.ARGUS_RUN_ID,
          type,
          token: process.env.ARGUS_SIGNAL_TOKEN,
          payload,
        }),
      });
    } catch { /* server unreachable — nothing to do */ }
    process.exit(0);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
