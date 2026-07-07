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
//   * A run that stops while background tasks/subagents are still in flight is
//     also reported "failed": `claude -p` tears the process down at Stop, so
//     that deferred work never finishes. Without this guard such a run (e.g. one
//     that ended saying "I'll wait for the agents to finish") gets rubber-
//     stamped completed and the next phase inherits its empty output.
//
// Reads ARGUS_SIGNAL_URL / ARGUS_INSTANCE_ID / ARGUS_PHASE_ID / ARGUS_RUN_ID /
// ARGUS_SIGNAL_TOKEN from the environment the engine injected. No-ops when not
// running under a pipeline (env unset), so it is safe to register globally.
import { pathToFileURL } from "node:url";

/** A final message reporting a failed/blocked outcome via the sentinel line. */
const OUTCOME_RE = /ARGUS_OUTCOME:\s*(failed|blocked)/i;

/** Background-task statuses that mean the work is still in flight at Stop time.
 *  Anything not matching (done/completed/failed/cancelled/…) is treated as
 *  finished, so only genuinely abandoned work forces a failure. */
const PENDING_TASK_RE = /^(running|queued|pending|in[-_ ]?progress|active|working)$/i;

/**
 * True when the Stop payload still carries background tasks that never reached a
 * terminal status — i.e. the run stopped with deferred work in flight.
 */
export function hasPendingBackgroundWork(payload) {
  const tasks =
    payload && typeof payload === "object" && Array.isArray(payload.background_tasks)
      ? payload.background_tasks
      : [];
  return tasks.some(
    (t) =>
      t && typeof t === "object" && typeof t.status === "string" && PENDING_TASK_RE.test(t.status),
  );
}

/**
 * Resolve the signal type. An explicit CLI arg always wins; otherwise the
 * agent's final message (from the Stop payload) decides completed vs failed,
 * and a run that stops with background work still in flight is failed too.
 */
export function resolveType(argType, payload) {
  if (argType) return argType;
  const msg =
    payload && typeof payload === "object" && typeof payload.last_assistant_message === "string"
      ? payload.last_assistant_message
      : "";
  if (OUTCOME_RE.test(msg)) return "failed";
  if (hasPendingBackgroundWork(payload)) return "failed";
  return "completed";
}

function main() {
  const argType = process.argv[2];
  const url = process.env.ARGUS_SIGNAL_URL;
  if (!url) process.exit(0);

  let stdin = "";
  process.stdin.on("data", (c) => (stdin += c));
  process.stdin.on("end", async () => {
    let payload = stdin;
    try {
      payload = JSON.parse(stdin);
    } catch {
      /* keep raw text */
    }
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
    } catch {
      /* server unreachable — nothing to do */
    }
    process.exit(0);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
