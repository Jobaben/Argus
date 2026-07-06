# Changelog

All notable changes to Argus are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow SemVer.

## [0.2.0]

### Security

- Server binds to loopback (`127.0.0.1`) by default; `ARGUS_HOST` to override.
- Host-header allowlist (defeats DNS-rebinding) and Origin checks on all
  mutating requests (defeats drive-by CSRF), applied to REST and the WebSocket
  upgrade.
- Optional `ARGUS_TOKEN` bearer-token gate for non-loopback deployments.
- `--model` values validated against an identifier allowlist (argv/shell
  injection); path-traversal guard on the agent-timeline route.

### Fixed

- Lost-update races on pipeline instances and JSON stores eliminated with a
  keyed mutex serializing every read-modify-write.
- Semaphore self-deadlock on the signal path broken by detaching step spawns.
- Scheduler tick reentrancy guard prevents double-fires; `stop()` drains the
  in-flight tick.
- Atomic writes use unique temp names (no same-file collision).
- Run-completion handlers can no longer crash the daemon (unhandled rejection);
  process-level `unhandledRejection`/`uncaughtException` handlers added.
- Robust CLI result parsing (256 KB tail, envelope recovery) — large results no
  longer silently dropped.
- Schedules no longer fire immediately when created within their trigger window.

### Added

- Single-port packaging: `npm run build && npm start` serves UI + API together.
- Compiled server build (`server/dist`) and a multi-stage `Dockerfile`.
- `POST /api/runs/:id/cancel` to kill a running scheduled run.
- Per-run cost (`total_cost_usd`) and token capture.
- `/api/health` reports the version.
- CI workflow (typecheck, lint, test, build); server ESLint; Prettier and
  EditorConfig; `.nvmrc`.
- Quality rubric in `docs/SCORECARD.md`.

## [0.1.0]

- Initial live-agents dashboard: background jobs + daemon liveness, live
  WebSocket refresh, plus the Scheduler and Pipelines verticals.
