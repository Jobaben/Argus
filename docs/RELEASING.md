# Releasing Argus

## Cadence

Release when a feature lands, not when the backlog feels heavy. The working
rule:

- **Every merged feature (or small batch of related features) gets a minor
  release within a day or two of landing on `main`.** Don't let `[Unreleased]`
  accumulate more than one feature-sized entry.
- **Fixes-only?** Cut a patch release whenever a fix is worth having on a
  tagged version — same day is fine.
- Pre-1.0 SemVer: **minor** (`0.x.0`) for features, **patch** (`0.x.y`) for
  fixes/hardening. Breaking changes to the API or on-disk formats also bump
  minor while we're pre-1.0, and get a callout in the changelog.

## Checklist

1. `main` is green: `npm run check` (typecheck + lint + server & web tests).
2. Roll the changelog: retitle `## [Unreleased]` content to
   `## [X.Y.Z] - YYYY-MM-DD` and leave a fresh empty `## [Unreleased]` above it.
3. Bump every package in lockstep:

   ```sh
   npm version X.Y.Z --no-git-tag-version --workspaces --include-workspace-root
   ```

   `/api/health` reads its version from `server/package.json` at boot, so no
   code change is needed.

4. Commit: `chore(release): vX.Y.Z`.
5. Tag and push:

   ```sh
   git tag -a vX.Y.Z -m "Argus X.Y.Z"
   git push origin main --follow-tags
   ```
