# Validation evidence inventory

The JSON files retain exact suite results and scope/proof limitations. Raw .log files remain in this worktree for diagnosis and are ignored; they are not application source or automatic staging candidates. The final review inventory binds current source bytes separately from earlier per-slice hashes. Test counts from overlapping suites must not be summed.

The .ts/.mts reproduction scripts here are historical development evidence. They use injected mocks, temporary fixture stores and captured absolute paths to this specific worktree. Some original probes intentionally document pre-fix behavior or an earlier interface. They are not portable regression suites, production tools or instructions to run against live stores. Preserve original repro bytes/logs so the first failure and subsequent diagnosis remain auditable. Maintained regression cases live under server/src/decision and server/src/sources with testHome preload.

Use the documented server test commands only with the testHome preload and isolated temporary ARGUS_CLAUDE_HOME. No script here authorizes provider inference, production restart, store migration or account changes. Source hashes and exact counts establish the tested fixture version, not live readiness, authenticated human labels or enforcing safety.

Final staging includes only owned source/tests and additive documentation/evidence. Do not force-add ignored logs/dependencies or import another checkout's index. The original user checkout remains untouched.
