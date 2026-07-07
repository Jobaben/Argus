# Argus — Data Model Reference

Empirically observed shapes of the `~/.claude` files Argus reads. Verified
against a live home directory on 2026-06-16. Treat every field as optional and
read defensively — Claude Code versions vary and files are written incrementally.

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
