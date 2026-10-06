# Argus — Data Model Reference

Empirically observed shapes of the files Argus reads — `~/.claude` for Claude
Code, `~/.codex` for Codex, `~/.qwen` for Qwen Code and the XDG data dir for
OpenCode. Verified against a live home directory on 2026-06-16, and against
OpenCode 1.18 / Qwen Code 0.21 on 2026-08-15. Treat every field as optional and
read defensively — CLI versions vary and files are written incrementally.

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

## `~/.qwen/settings.json` — Qwen Code configuration

JSON, and the hook schema is **Claude Code's**, key for key:

```jsonc
{
  "hooks": {
    "Stop": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "node \"…/argus-signal.mjs\"" }] },
    ],
  },
}
```

The payload that hook receives is Claude Code's too — `last_assistant_message`,
`background_tasks`, `session_id`, `transcript_path` — which is why one
`argus-signal.mjs` serves both and needs no branch for this runtime. Argus reads
the file to check its own registration and rewrites it only to add that one
group, leaving every other key (and any hook the operator registered) intact; a
present-but-unparseable file is refused rather than replaced.

## `~/.qwen/projects/<encoded-cwd>/chats/<session-id>.jsonl` — Qwen Code transcripts

Filed by project the way Claude Code's are, one directory deeper, and with the
**same** encoding of the working directory into a path segment — so a Qwen
session resolves from `(project, sessionId)` exactly as a Claude one does, and a
Claude and a Qwen session from the same directory share a project segment
without shadowing each other (both ids are UUIDs).

```jsonc
{ "uuid": "…", "parentUuid": null, "sessionId": "…", "timestamp": "…", "type": "user",        "cwd": "/srv/app", "message": { "role": "user",  "parts": [{ "text": "…" }] } }
{ "uuid": "…", "parentUuid": "…",  "sessionId": "…", "timestamp": "…", "type": "system",      "cwd": "/srv/app", "subtype": "ui_telemetry", "systemPayload": { "uiEvent": { "model": "qwen3-27b", … } } }
{ "uuid": "…", "parentUuid": "…",  "sessionId": "…", "timestamp": "…", "type": "assistant",   "cwd": "/srv/app", "message": { "role": "model", "parts": [{ "functionCall": { "name": "run_shell_command", "args": { … } } }] } }
{ "uuid": "…", "parentUuid": "…",  "sessionId": "…", "timestamp": "…", "type": "tool_result", "cwd": "/srv/app", "message": { "role": "user",  "parts": [{ "functionResponse": { "name": "…", "response": { "output": "…" } } }] } }
{ "uuid": "…", "parentUuid": "…",  "sessionId": "…", "timestamp": "…", "type": "assistant",   "cwd": "/srv/app", "message": { "role": "model", "parts": [{ "text": "…" }] } }
```

The line shape is Gemini CLI's rather than Claude Code's — `message.parts[]`
instead of `message.content[]`, `functionCall` / `functionResponse` instead of
`tool_use` / `tool_result` blocks, `role: "model"` for the assistant, and
`type: "system"` lines that are telemetry rather than conversation.
`server/src/sources/qwenSessions.ts` translates these into the Claude line shape
so one set of readers serves all three sources. The telemetry lines are kept
rather than dropped: they are the only place the model name is recorded, and
every line carries the run's `cwd`. A `tool_result` line comes through flagged
`isMeta`, so a shell transcript can never become the session's title.

Note the asymmetry with the live stream: `qwen -o stream-json` emits Claude
Code's envelope verbatim, which is why the runtime's activity derivation needs
no translation at all. Only the file on disk is in Gemini's dialect.

## `~/.local/share/opencode/opencode.db` — OpenCode sessions

SQLite (plus `-wal` / `-shm`), not JSONL: a private schema Argus does not read,
which is what `transcripts: false` on that runtime reports. Its configuration
lives elsewhere again, in `~/.config/opencode/opencode.json`, where the provider
list defines the `<provider>/<model>` ids the model picker accepts.

## `history.jsonl` — global prompt history

Large append-only JSONL of prompts across all projects/sessions. ~900 KB live.
Newest entries are last. Parse line-by-line; cap the feed.

## `tasks/<uuid>/`

Sparse. Observed: `.highwatermark` (a small integer, e.g. `17`), `.lock`
(presence = locked). Mostly metadata for the in-session task queue.

## `stats-cache.json`

Usage aggregates cache (~18 KB live). Shape varies by CLI version — read
defensively and surface whatever headline numbers exist.

## `argus/transitions/<instanceId>.jsonl` — Argus's own transition log

Unlike everything above, this file is written by Argus, not read from an agent's
state. It is one per pipeline instance, under `~/.claude/argus/`: one
checksummed JSON line per instance save (`schema`, contiguous 1-based `seq`,
`instanceId`, `at`, `source`, optional `phaseId`/`attempt`/`runId`, `events`,
either a full `baseline` projection or `changes`, a diagnostic `effects`
summary, optional `unattributed`, `stateSha256`). It is **not authoritative**: it
is evidence for replay and integrity diagnosis about how the saved instance got
where it is (recovery derives effects from the saved instance and run records,
never from this file), replays to a
projection of the instance (large values by digest), is capped at 4 MiB and is
never pruned to make room. It is deleted only when its instance is pruned. See
ARCHITECTURE §5 and HARNESS §18.

## `argus/verdicts.json` — Verdict records

Also Argus's own. A JSON array of judgments, newest first, capped at **400 in
total** (output and trajectory together; a pruned judgment is simply absent).
A run may be judged more than once; each judgment is appended and the newest
of each kind is the run's current one. Shapes are in `contracts/src/verdict.ts`.

```jsonc
{
  "id": "V-…", // VT-… for a trajectory verdict; optional on old records
  "kind": "trajectory", // absent = "output" (every record written before trajectories)
  "runId": "…",
  "scheduleId": "…",
  "scheduleName": "…",
  "phaseId": null,
  "status": "ready", // ready | failed | skipped
  "at": "…",
  "score": 7.5,
  "criteria": [],
  "summary": null,
  "regression": false,
  "minScore": 6,
  "costUsd": null,
  "tokens": null,
  "durationMs": null,
  "error": null,
  "provenance": {
    "runtime": "claude",
    "requestedModel": "haiku",
    "reportedModel": null,
    "promptVersion": 1,
  },
  "rubricDigest": "…", // output: sha256 of goal + criteria; trajectory: trajectoryRubricDigest
  "trajectory": {
    // `trajectory` verdicts only
    "signals": {
      "version": 1,
      "transcript": "present", // present | missing
      "events": 212,
      "truncated": false,
      "signals": [{ "kind": "path", "count": 1, "observed": true, "examples": ["…"] }],
      // kind: repetition | errors | edit-revert | path | destructive-command
    },
    "held": ["path"], // observed signals the rubric's check holds on
    "judged": true, // a judge was asked
  },
}
```

- **`Verdict.kind`** is `output` or `trajectory`. Absent means `output`, so an
  older record reads unchanged and a trajectory verdict is never anyone's
  "verdict for this run" unless they ask for that kind.
- **`Verdict.trajectory`** is present only on `trajectory` verdicts. A
  `missing` transcript has no signals computed (`signals: []`) and the verdict
  is `skipped`. A check-only rubric produces a `ready` verdict with
  `score: null`. A zero `count` means "not observed", not "did not happen".
- **`Rubric.trajectory`** (on a schedule or a pipeline phase, beside `goal`,
  `criteria` and `minScore`) is optional: `{ criteria?, minScore?, check?: {
holdOn: <signal kinds> } }`. It must declare criteria, a check or both.
  Absent, nothing trajectory-related runs and the output `rubricDigest` is
  unchanged. `check.holdOn` is an automation hold only: it withholds an
  automated approval and is not a verification check (the `trajectory` PhaseCheck
  below is).
- **`signals.truncated`** is `true` when the Recorder kept only the last 2,000
  events. A truncated recording is incomplete input: an automated approval treats
  it as insufficient data and never as a clean trajectory.
- **`AutoApprove.trajectory`** (on a gated phase, beside `verdict`) is an
  optional 0–10 bar for the trajectory score, accepted only when the rubric
  declares trajectory criteria. Absent, the `verdict` bar applies to it too.

See HARNESS §19 for what the signals mean and what they cannot see.

## `argus/gate-decisions.jsonl` — gate decisions

One append-only JSON line per approve, revise or abort decision (`GateDecision`,
`contracts/src/gates.ts`), written and fsynced before the transition it
describes and never pruned. An automated approval carries `verdicts[]`, the
output judgments it rested on. **`GateDecision.trajectoryVerdicts[]`** is the
matching trajectory basis, present only when the approved phase's rubric
declares a trajectory: one entry per relevant run with `runId`, `stepName`,
`verdictId`, `at`, `score` and `bar` (both `null` for a check-only rubric),
`held` (always empty), `signalsVersion`, the provenance fields and the
trajectory `rubricDigest`. Entries are built from the stored judgments, not
from the request.

## Phase verification checks — `CheckResult`

A phase's `checks` (`PhaseCheck`) run once its steps have reported, and the
report is kept on the instance as `PhaseProgress.verification`
(`{ status, startedAt, endedAt?, checks[] }`; a best-of-N candidate step carries
its own). Each entry of `checks[]` is a `CheckResult`:

```jsonc
{
  "kind": "trajectory", // command | artifact | file | changed-files | trajectory
  "label": "trajectory: destructive-command, errors",
  "status": "not-evaluated", // passed | failed | not-evaluated
  "detail": "not evaluated — insufficient input: run-123: no readable transcript",
  "durationMs": 14,
}
```

`not-evaluated` is produced only by a `trajectory` check: it could not be
evaluated from the input it had and was not configured with `requireTranscript`.
It neither passed nor failed. The report's `status` is `failed` if and only if
some check `failed`, so a `not-evaluated` check does not fail the report and is
never counted as passed; the knowledge layer does not accept it as evidence for a
cited check.

The `trajectory` check is declared as
`{ "kind": "trajectory", "label"?, "thresholds": { "<signal>": <max count> }, "requireTranscript"?: boolean }`:
`thresholds` names at least one of the five signal kinds, each a whole number
0–10,000; the check reads each relevant run's transcript when it runs and
compares the signal `count`, so nothing about it is stored beyond the
`CheckResult`. See HARNESS §19 for its outcomes.

## H1 configuration — qualification definition

The Decision Plane H1 ledger records a `config` line (format
`argus.h1-collection-config`) naming the
definitions a capture is taken under. Its `qualification` field is a definition
reference `{ id: "auto-approval-qualification", version, digest }`. A config
written now names **version 2**, which is version 1 plus the trajectory
requirement; configs and captures written earlier name version 1 and keep it. A
capture is always read under the version it recorded. v2 was amended in place
before it was released (it now requires signals from a complete, untruncated
recording), so its digest changed; a record naming the earlier, never-released
digest matches no registered definition and is not re-read. Both digests are
listed in HARNESS §19.

## Not on disk

`cron` / scheduled routines, and `todos` (no `todos/` dir present). Cron is
session-scoped via `CronList` only — see ARCHITECTURE §6.

## Runtimes available in the build sandbox

Linux sandbox ships **only Python 3.12** by default. Node must be installed
manually — and `apt` yields Node 18 (too old for Vite 8) while NodeSource's
script trips on a debconf kernel prompt. Install the **official tarball** to
`/usr/local` instead. (The user's real machine is Windows; this Linux box is the
build/dev environment, and its `~/.claude` is a valid live dataset.)
