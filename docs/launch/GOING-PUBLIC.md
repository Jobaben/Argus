# Going public — owner runbook

Everything below is prepared to one keystroke short of public. Each step is
an explicit owner action; nothing here has been executed externally.

## 1. History: squash to a fresh public root (required)

A full-history scan (every commit, all branches) found **no credentials,
tokens, or private URLs**, but the pre-scrub history is not publishable
as-is:

- **Commit author metadata** on most commits carries a real name and a work
  email address (plus a second personal email identity).
- Docs, tests, and 26 dashboard screenshots in earlier commits contain a
  real machine username, employer name, employer project names, and personal
  file paths. HEAD is scrubbed; history still contains them.

Rewriting 58 commits' authors _and_ file contents is strictly worse than the
alternative the goal allows: **squash to a fresh public root**. The
CHANGELOG.md preserves the release narrative, so no story is lost.

```bash
# from the final, reviewed tip of main:
git checkout main
git checkout --orphan public-root
git commit -m "Argus v0.4.0 — initial public release"
git branch -M public-root main          # replace main locally
git push --force origin main            # ⚠ owner keystroke: rewrites origin/main
```

Before the push, set the identity you want on the public root:
`git config user.name Jobaben && git config user.email <public email or
noreply address>`. Enable GitHub's "Keep my email addresses private" and use
the `…@users.noreply.github.com` address if you don't want any real email in
the history.

After the force-push, delete all other remote branches (they retain the old
history) and any tags pointing into it.

## 2. Internal-docs decision log

| Artifact                                                                           | Decision                         | Reason                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/SCORECARD.md`                                                                | **Removed**                      | Internal audit rubric written for the improvement campaign; self-referential, no value to users.                                                                                                            |
| `docs/superpowers/` (plans + specs)                                                | **Removed**                      | Internal planning artifacts; one spec carried the owner's real name.                                                                                                                                        |
| `design/`                                                                          | **Removed**                      | Mirror of a private claude.ai/design project and its sync workflow; meaningless outside the owner's account.                                                                                                |
| `docs/screenshots/`                                                                | **Removed** (re-capture pending) | All 26 screenshots were captured from a real workspace and showed real usernames, employer project names, and paths. Re-capture from demo data at 1440×900 before/after launch — the user guide notes this. |
| `CHANGELOG.md`                                                                     | **Kept** (scrubbed)              | Genuine release narrative, useful to users; personal references replaced.                                                                                                                                   |
| `docs/ROADMAP.md`                                                                  | **Kept** (updated)               | Now ends with the two candidate follow-ups the pinned roadmap issue puts to a vote.                                                                                                                         |
| `docs/API.md`, `ARCHITECTURE.md`, `DATA-MODEL.md`, `USER-GUIDE.md`, `RELEASING.md` | **Kept** (scrubbed)              | Real documentation; example paths/usernames neutralized.                                                                                                                                                    |

## 3. Repo settings (owner keystrokes)

1. **Flip visibility** to public (Settings → General → Danger Zone) — only
   after step 1's force-push.
2. **Enable private vulnerability reporting** (Settings → Security) —
   SECURITY.md points at it.
3. **Pin the roadmap issue** — already created as
   [#20](https://github.com/Jobaben/Argus/issues/20) (body in
   [`ROADMAP-ISSUE.md`](ROADMAP-ISSUE.md)); Issues → ⋯ → Pin. README and
   the announcement both reference it.
4. Add the repo description + topics: `claude-code`, `agents`, `agent-ops`,
   `dashboard`, `scheduler`, `llm-ops`.

## 4. npm (optional, deferred)

`npx argus` from the npm registry is **not** part of this release: the root
package is a workspace monorepo whose server deps live in `server/package.json`,
so a naïve publish would not run. The documented install is the verified
clone + `node bin/argus.mjs --open` path (18s to a healthy dashboard on a
warm cache; the npm-install step dominates on cold cache). If npm
distribution is wanted later, it needs a packaging pass (bundle server +
web dist, hoist runtime deps) — candidate for a follow-up issue. The `argus`
name on npm may also be taken; check before deciding (`@jobaben/argus` as
fallback). Root `package.json` keeps `"private": true` until then, which
also makes an accidental publish impossible.

## 5. Launch posts (owner keystrokes)

- Announcement: [`ANNOUNCEMENT.md`](ANNOUNCEMENT.md)
- Show HN title + first comment: [`SHOW-HN.md`](SHOW-HN.md)
- Demo recording: [`DEMO-SCRIPT.md`](DEMO-SCRIPT.md) (90s, step-by-step)

## 6. Known residuals (accepted, documented)

- `npm audit`: 5 high findings remain, all one dev-only chain
  (`brace-expansion` via `@vitest/coverage-v8`); the fix is a breaking
  vitest major bump. Runtime dependencies are clean after the non-breaking
  `npm audit fix` already applied.
- Install verified on **Linux** (this environment). macOS verification needs
  an owner run: clean clone → `node bin/argus.mjs --open` → dashboard.
  The entry point already branches for darwin (`open` vs `xdg-open`), and
  the server keys off `os.homedir()` only.
- First-run against an **empty or missing** `~/.claude` was verified in a
  real browser: the server boots, self-creates its data dirs, and every tab
  renders a teaching empty state (verified on Command Center, Issues,
  Budget) — never a blank or broken screen.
