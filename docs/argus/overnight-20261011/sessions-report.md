# Transcript shape hardening

The historical roadmap's transcript parser hardening backlog supplied this bounded slice. JSON syntax validity does not establish that a line or content block has the shape a display reader expects.

## Changes

- Added a shared canonical display-line normalizer in `server/src/sources/sessions.ts`, used by full reads and incremental live-tail ingestion after runtime translation.
- Non-object lines and content blocks are discarded. Known title, timestamp, directory, role, model, text, thinking and tool-name fields are accepted only as strings. Message containers with invalid shapes remain empty display messages with stable indices.
- Valid neighboring content, authored-title precedence, tool counting, tool-result errors and incremental append indices remain available.
- Raw `readSessionLines` output remains unchanged for Recorder consumers. No interface, storage, provider or production-state change was introduced.

## Verification

The new fixture regression first failed with `Cannot read properties of null (reading 'timestamp')` in `summarize`, demonstrating the failure rather than assuming it.

After the patch, this command passed **40 tests**:

```powershell
node_modules/.bin/tsx.cmd --import ./server/src/testHome.ts --test server/src/sources/sessionShapes.test.ts server/src/sources/sessionTail.test.ts server/src/sources/sessionLines.test.ts server/src/sources/sessionMarkdown.test.ts server/src/sources/codexSessionRead.test.ts server/src/sources/qwenSessionRead.test.ts
```

Also passed:

```powershell
npm run typecheck --workspace @argus/server
node_modules/.bin/eslint.cmd server/src/sources/sessions.ts server/src/sources/sessionShapes.test.ts
```

The focused checks establish offline parser behavior, not a running service or a passing global suite. Tests use temporary fixture homes; no production transcripts were opened. Changes remain uncommitted for IDE review.

Independent review found no production findings. Its test-hygiene follow-up adds per-test teardown that restores `ARGUS_CLAUDE_HOME` and removes only the validated temporary fixture directory. The two shape regression tests passed again after that change.
