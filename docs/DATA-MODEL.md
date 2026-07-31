# Argus — Data Model Reference

Empirically observed shapes of the files Argus reads — `~/.claude` for Claude
Code, `~/.codex` for Codex. Verified against a live home directory on
2026-06-16. Treat every field as optional and read defensively — CLI versions
vary and files are written incrementally.

## `jobs/<short>/state.json` — background job state

```jsonc
{
  "state": "working", // working | done | failed | idle  (others possible)
  "detail": "root cause found …",
  "tempo": "active", // active | idle
  "inFlight": { "tasks": 0, "queued": 0, "kinds": [] },
  "output": { "result": "…final result text…" },
  "children": null,
  "template": "bg", // launch template
  "respawnFlags": ["--effort", "high", "--permission-mode", "auto"],
  "bgIsolation": "none",
  "sessionId": "96e07482-f8ff-416b-89a3-64d185cc3bd7",
  "resumeSessionId": "…",
  "daemonShort": "96e07482", // == the dir name <short>
  "cliVersion": "2.1.165",
  "cwd": "C:\\GIT\\Spectacle", // ⚠ may be a foreign-OS path — display only
  "createdAt": "2026-06-05T06:47:44.453Z",
  "updatedAt": "2026-06-08T12:17:04.825Z",
  "firstTerminalAt": "2026-06-05T07:00:37.163Z",
  "backend": "daemon",
  "name": "…",
  "nameSource": "…", // sometimes a raw prompt — prefer nameSource heuristics
  "linkScanOffset": 368630,
  "linkScanPath": "C:\\Users\\…", // ⚠ foreign-OS path
}
```

Observed live: `working/active`, `failed/idle`, `done/idle`. The `<short>` dir
name equals `daemonShort` and is the stable join key.

## `jobs/<short>/timeline.jsonl` — progress trail

One JSON object per line:

```jsonc
{ "at": "2026-06-05T07:00:37.163Z", "state": "done", "detail": "…", "text": "…long narration…" }
```

Keys observed: `at`, `state`, `detail`, `text`. Append-only.

## `daemon/roster.json` — live workers

```jsonc
{
  "proto": 1,
  "supervisorPid": 43460,
  "updatedAt": 1781249595862, // epoch ms
  "workers": {
    "59b12afc": {
      "pid": 49616,
      "sessionId": "59b12afc-…",
      "rendezvousSock": "\\\\.\\pipe\\cc-daemon-…", // Windows named pipe
      "ptySock": "\\\\.\\pipe\\…",
      "cliVersion": "2.1.175",
      "startedAt": 1781249592832,
      "attempt": 1,
      "cwd": "C:\\GIT\\Replicas\\MotoritOnline",
      "dispatch": {
        "short": "59b12afc",
        "source": "slash",
        "launch": { "mode": "resume", "fork": true },
      },
    },
  },
}
```

A job is **live** iff its `<short>` is a key in `workers`. `daemon.status.json`
is a lighter `{ supervisorPid, writtenAt, workers }` snapshot.

## `projects/<encoded>/<sessionId>.jsonl` — transcripts

Dir name = encoded absolute project path. Decoding rules observed:

- `-home-mtrushbad-GIT` → `/home/mtrushbad/GIT`
- `C--GIT-Spectacle` → `C:\GIT\Spectacle`
- `C--Users-mtrushbad-OneDrive---Motorit-AB-…` → drive + `---` ≈ space/separator runs

Each line has a `type`. Observed distribution in one session:

```
message, user, attachment, assistant, tool_use, tool_result,
permission-mode, mode, last-prompt, hook_non_blocking_error, direct,
text, file-history-snapshot, ai-title, thinking, system,
skill_listing, hook_success, hook_additional_context, deferred_tools_delta
```

Useful for summaries: `ai-title` (human title), `last-prompt`/`user` (first
prompt), `tool_use` count, message count, first/last timestamps where present.

## `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl` — Codex transcripts

Filed by **date**, not by project, and named for the thread id — which is why a
Codex session is resolved by id rather than by composing a path from
`(project, sessionId)` the way a Claude transcript is. Archived threads move to
`~/.codex/archived_sessions/` with the same shape.

Each line wraps one item with a UTC timestamp:

```jsonc
{ "timestamp": "…", "type": "session_meta",   "payload": { "id": "…", "cwd": "/srv/app", "cli_version": "…" } }
{ "timestamp": "…", "type": "turn_context",   "payload": { "model": "gpt-5.3-codex", "cwd": "/srv/app" } }
{ "timestamp": "…", "type": "response_item",  "payload": { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "…" }] } }
{ "timestamp": "…", "type": "response_item",  "payload": { "type": "function_call", "name": "shell", "arguments": "{…}" } }
{ "timestamp": "…", "type": "response_item",  "payload": { "type": "function_call_output", "output": "…" } }
{ "timestamp": "…", "type": "response_item",  "payload": { "type": "reasoning", "summary": [{ "type": "summary_text", "text": "…" }] } }
{ "timestamp": "…", "type": "event_msg",      "payload": { "type": "token_count", "info": { "total_token_usage": { … } } } }
```

`server/src/sources/codexSessions.ts` translates these into the Claude line
shape so one set of readers serves both. It reads **`response_item` only**: a
rollout carries the same content again as `event_msg` UI events, and reading
both would show every message twice. `session_meta` / `turn_context` are kept
for the working directory and the model; roles other than user/assistant come
through flagged `isMeta`, which is the signal the title deriver already uses to
skip injected instructions.

## `~/.codex/config.toml` — Codex configuration

TOML. Argus reads it to check whether its stop hook is registered, and
**appends** a `[[hooks.stop]]` block when it isn't — never a rewrite, so
comments and ordering survive. See ARCHITECTURE §1.

## `history.jsonl` — global prompt history

Large append-only JSONL of prompts across all projects/sessions. ~900 KB live.
Newest entries are last. Parse line-by-line; cap the feed.

## `tasks/<uuid>/`

Sparse. Observed: `.highwatermark` (a small integer, e.g. `17`), `.lock`
(presence = locked). Mostly metadata for the in-session task queue.

## `stats-cache.json`

Usage aggregates cache (~18 KB live). Shape varies by CLI version — read
defensively and surface whatever headline numbers exist.

## Not on disk

`cron` / scheduled routines, and `todos` (no `todos/` dir present). Cron is
session-scoped via `CronList` only — see ARCHITECTURE §6.

## Runtimes available in the build sandbox

Linux sandbox ships **only Python 3.12** by default. Node must be installed
manually — and `apt` yields Node 18 (too old for Vite 8) while NodeSource's
script trips on a debconf kernel prompt. Install the **official tarball** to
`/usr/local` instead. (The user's real machine is Windows; this Linux box is the
build/dev environment, and its `~/.claude` is a valid live dataset.)
