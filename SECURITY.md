# Security Policy

Argus is a privileged local control plane: it can spawn `claude -p` agents
with the credentials of the user running it. Security reports are taken
seriously and handled with priority.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately via
[GitHub private vulnerability reporting](https://github.com/Jobaben/Argus/security/advisories/new)
("Report a vulnerability" on the repository's Security tab).

You can expect an acknowledgement within **72 hours** and a status update
within **7 days**. Please include reproduction steps and the Argus version
(`argus --version` or `GET /api/health`).

## Scope

Reports of most interest, roughly in order:

1. Anything that lets a **remote origin** (web page, LAN peer, DNS rebinding)
   reach the API or WebSocket without the bearer token — the loopback bind,
   Host allowlist, Origin/CSRF checks, and token enforcement exist precisely
   to prevent this.
2. Anything that turns Argus's **read** path over `~/.claude` into a write,
   or escapes it (path traversal in project/session/agent identifiers).
3. **Command/argument injection** into the spawned `claude -p` processes
   beyond what the model/argument allowlist intends.
4. Auth bypasses in the account/session system (registration approval,
   role checks, brute-force lockout).

## Supported versions

Only the latest release receives security fixes. Argus is pre-1.0; there are
no maintenance branches.
