# Releasing Argus

## Cadence

Release when a feature lands, not when the backlog feels heavy. The working
rule:

- **Every merged feature (or small batch of related features) gets a minor
  release within a day or two of landing on `main`.** Don't let `[Unreleased]`
  accumulate more than one feature-sized entry.
- **Fixes-only?** Cut a patch release whenever a fix is worth having on a
  tagged version — same day is fine.
- SemVer from 1.0.0 on: **minor** (`x.Y.0`) for features, **patch**
  (`x.y.Z`) for fixes/hardening. Breaking changes to the API or on-disk
  formats bump **major** (`X.0.0`) and get a callout in the changelog.

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

6. Pin it on the machine that runs your pipelines, from the checkout:

   ```sh
   node bin/argus.mjs release --ref vX.Y.Z
   ```

   This builds the tagged commit into its own folder,
   `~/.claude-argus-releases/X.Y.Z-<sha7>/`, and points `current.json` at it.
   Restart `argus` to run it; `GET /api/health` then reports
   `build.kind: "release"` with that id. The folder name and the tag name the
   same commit, but they are independent: a release can be cut from any ref,
   and a tag does not build anything.

## Rolling back

`argus release --list` shows the built releases; `argus release --use <id>`
pins an earlier one, and a restart runs it. Releases are never deleted,
because runs they launched point at their hooks.

Rolling back can **hide** data. An older build can read a store a newer one
wrote as if it were empty: the Knowledge Ledger, for one, shows no claims and
refuses to write a ledger version it does not know. Nothing is deleted, and
pinning the newer release again shows it. `--use` warns when the target is
older than the pinned release.

Rolling back can also **drop** a field the older build does not know. A build
from before approval conditions ignores a phase's `approveWhen`, so its gates
wait for a person, and saving the pipeline from that build removes the field.
