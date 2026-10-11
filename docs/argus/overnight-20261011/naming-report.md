# Job naming evidence — 2026-10-11

The roadmap item “deriveName should consult nameSource to avoid raw-prompt titles” is not implementation-ready from the locally available evidence. No naming code was changed.

## Evidence inspected

- `server/src/sources/jobs.ts`: `deriveName` currently returns a nonblank trimmed `state.name`, then the final segment of `state.cwd`, then the job short ID. It does not consult `nameSource`.
- `server/src/sources/types.ts`: `JobState.nameSource` is an optional string; the type declares no category vocabulary or relationship to `name`.
- `docs/DATA-MODEL.md`: the illustrative `nameSource` field is described as sometimes containing a raw prompt. That documentation is not sufficient to establish whether current CLI versions store a provenance category, source text, or both.
- The local `~/.claude/jobs` directory contains one job directory and zero `state.json` records. Consequently there are zero observable `nameSource` categories and no samples establishing explicit names versus raw prompt names.
- The installed Claude package exposes wrapper/install JavaScript and a native `bin/claude.exe`; readable CLI implementation source defining `nameSource` was unavailable. Wrapper code does not establish naming semantics.

Only category counts and structural facts were inspected or reported. No raw job prompts, names, or credentials were emitted.

## Decision

Defer a narrow `jobs.ts` naming change until a sanitized job-state sample or authoritative CLI source establishes the field's semantics. Guessing a category such as `prompt` or treating equality between `name` and `nameSource` as proof of prompt origin could suppress an explicitly supplied name or expose source text as a title.

Once semantics are established, scope the change to the existing naming decision and fixture tests: preserve explicitly supplied names, use a bounded non-prompt fallback for demonstrated prompt-derived names, and keep missing or unfamiliar provenance backward-compatible unless evidence supports another rule. Do not add API fields or rewrite stored state.

## Follow-up evidence needed

Collect category counts and whether a name was explicitly supplied or derived from raw prompt input from a disposable controlled CLI job or sanitized existing state. Review a corresponding CLI version's implementation if available. This report does not claim the current naming behavior is defective on this installation.
