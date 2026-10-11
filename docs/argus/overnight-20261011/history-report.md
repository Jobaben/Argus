# History source fixture hardening

The activity reader now skips malformed records independently so one corrupt line cannot hide valid recent prompts. It validates JSON object shape and string fields before normalization, rejects numeric timestamps outside JavaScript's date range, and scopes its short-lived cache to the resolved history path as well as the requested limit.

Changed files: `server/src/sources/history.ts` and new `server/src/sources/history.test.ts`. The 256 KiB bounded tail, partial-first-line handling, newest-first file ordering, 1.5 second cache TTL, missing-file result, and limit slicing remain intact. Absent/non-numeric timestamps retain the existing empty timestamp behavior; absent/null project values remain empty.

## Evidence

- Before implementation, `npx tsx --import ./src/testHome.ts --test src/sources/history.test.ts` produced six expected failures: null records, nonstring display, nonstring project, out-of-range timestamp, infinite timestamp, and cross-home cache reuse. Five compatibility checks passed.
- After implementation, the same command passed all 11 tests.
- `npm run typecheck` in `server` passed.
- `npx eslint src/sources/history.ts src/sources/history.test.ts` in `server` passed.

Fixtures use fresh temporary directories, restore the environment override, clear test cache state, and remove their files. No real agent homes, provider calls, service state, or live deployment were used. Repository-wide validation is coordinated by the parent overnight task; this report records the focused checks only.

The edits are ready for review; no commit, push, or merge was performed. The parent task owns staging.
