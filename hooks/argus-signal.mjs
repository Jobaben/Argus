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
//     reported "deferred": the process is NOT torn down — Claude keeps it alive
//     and fires Stop again once the deferred work finishes, and that later Stop
//     drives the real outcome. Emitting no signal now avoids terminalizing a run
//     that is still working (the premature-fail bug). If the process instead
//     dies with work unfinished, the engine's healing pass fails the phase on
//     process exit, so abandoned work is never rubber-stamped completed.
//
// Reads ARGUS_SIGNAL_URL / ARGUS_INSTANCE_ID / ARGUS_PHASE_ID / ARGUS_RUN_ID /
// ARGUS_SIGNAL_TOKEN from the environment the engine injected. No-ops when not
// running under a pipeline (env unset), so it is safe to register globally.
import { pathToFileURL } from "node:url";

/** A final message reporting a failed/blocked outcome via the sentinel line,
 *  capturing any trailing reason text on that same line. */
const OUTCOME_RE = /ARGUS_OUTCOME:\s*(failed|blocked)\b[^\S\r\n]*(.*)/i;

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

/** Labels for background tasks still in flight, as "type: status" (or just the
 *  status when no type is present). Used to explain a background-work failure. */
function pendingTaskLabels(payload) {
  const tasks =
    payload && typeof payload === "object" && Array.isArray(payload.background_tasks)
      ? payload.background_tasks
      : [];
  return tasks
    .filter(
      (t) =>
        t &&
        typeof t === "object" &&
        typeof t.status === "string" &&
        PENDING_TASK_RE.test(t.status),
    )
    .map((t) => (typeof t.type === "string" ? `${t.type}: ${t.status}` : t.status));
}

/**
 * Compose a human-readable failure reason from a Stop payload. Only meaningful
 * for a `failed` outcome. Precedence: the ARGUS_OUTCOME sentinel's trailing
 * text, else a pending-background-work summary, else the last message's tail,
 * else a generic fallback. Always returns a non-empty string.
 */
export function buildReason(payload) {
  const msg =
    payload && typeof payload === "object" && typeof payload.last_assistant_message === "string"
      ? payload.last_assistant_message
      : "";
  const m = OUTCOME_RE.exec(msg);
  if (m) {
    const kind = m[1].toLowerCase();
    const rest = (m[2] ?? "").replace(/^[\s:–—-]+/, "").trim();
    return rest ? `${kind}: ${rest}` : kind;
  }
  const pending = pendingTaskLabels(payload);
  if (pending.length) {
    return `stopped with ${pending.length} background task(s) still in flight (${pending.join(", ")})`;
  }
  const tail = msg.trim().split("\n").pop()?.trim();
  return tail ? tail.slice(0, 300) : "run stopped without reporting an outcome";
}

/**
 * Resolve the signal type. An explicit CLI arg always wins; otherwise the
 * agent's final message (from the Stop payload) decides completed vs failed.
 * A run that stops with background work still in flight resolves "deferred" —
 * no signal is sent, so the later terminal Stop (or the engine's healing pass
 * on process exit) decides the real outcome. An explicit failure sentinel still
 * wins over deferral, so an agent that concludes it failed reports that at once.
 */
export function resolveType(argType, payload) {
  if (argType) return argType;
  const msg =
    payload && typeof payload === "object" && typeof payload.last_assistant_message === "string"
      ? payload.last_assistant_message
      : "";
  if (OUTCOME_RE.test(msg)) return "failed";
  if (hasPendingBackgroundWork(payload)) return "deferred";
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
    // "deferred": the run stopped with background work still in flight. Send no
    // signal — the process stays alive and a later Stop (or the engine's healing
    // pass on process exit) drives the real outcome. Terminalizing here would
    // fail a run that is still working.
    if (type === "deferred") process.exit(0);
    if (type === "failed") {
      const reason = buildReason(payload);
      payload =
        payload && typeof payload === "object" && !Array.isArray(payload)
          ? { ...payload, reason }
          : { reason, raw: payload };
    }
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
