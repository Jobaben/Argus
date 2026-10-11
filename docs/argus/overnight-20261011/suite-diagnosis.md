# Server suite diagnosis — 2026-10-11

The first full `validation/server-tests.log` run completed with exit code 1: 3,195 tests, 2,091 passed, 1,066 failed, three cancelled, 35 skipped, zero todo; 157,732.5637 ms. No pristine equivalence is claimed. No production code, stores, services, or tests were changed for this diagnosis.

## Observed failure groups

**Atomic file replacement failures.** Numerous otherwise valid app mutations return 500 after approximately 1.34 seconds. Retained route errors explicitly show `EPERM: operation not permitted, rename` when replacing fixture JSON files under the sandbox temporary directory. Affected paths include users, peers, verdicts, incidents and pipeline/schedule state. The existing Windows retry delays in `server/src/sources/atomicWrite.ts` sum to 1,270 ms, consistent with the observed latency. This establishes persistent rename refusal during this run, not a parser regression or proof of its exact OS cause. Sandbox policy, file sharing/antivirus interference, and fixture filesystem behavior remain alternative causes.

**SQLite FTS5 unavailable.** Vault tests log `no such module: fts5`. `server/src/vault/db.ts` uses `node:sqlite` and creates FTS5/FTS5-vocabulary virtual tables. The observed runtime cannot supply that module to these tests. Do not infer that the vault implementation or overnight reader changes caused the missing SQLite capability.

**Further groups remain unclassified.** Git worktree setup failures, hook fetch failures, process-tree descendant assertions and other mismatched assertions also appear. Classify each from its complete error output rather than assigning every failure to the two groups above.

## Retained baseline comparison

`docs/argus/decision-ledger-development/validation/baseline-test-comparison.json` records an earlier pristine server run with 2,760 tests, 2,695 passing, 41 failing, one cancelled and 23 skipped. `execution-provenance-validation.json` records a later changed run with matching historical failing/cancelled names. These are historical evidence, not a fresh baseline for this checkout and sandbox.

The currently observed five app Vault failures share names with that retained baseline. The widespread app mutation/authentication EPERM failures do not appear in the retained pristine failure list. Thus the current run cannot be described as having only the documented 41 baseline failures. The final distinct display-name inventory has 28 matches to retained historical pristine names and 1,035 names absent from that list. This is a historical name comparison only; exact cause or pristine equivalence requires a fresh baseline where necessary.

The October 9 Decision Ledger forensic review primarily verifies retained assessment bytes and advisory evidence; it does not establish current server-suite or filesystem readiness.

## Follow-up environment evidence

The retained `validation/environment-sandbox.log` establishes Node v22.14.0 at `C:/Program Files/nodejs/node.exe`. Replacing an existing disposable file in sandbox temp fails with EPERM; the same disposable operation under the writable checkout succeeds. SQLite reports `ENABLE_FTS5` compile option 0 and creating the FTS5 table fails with `ERR_SQLITE_ERROR: no such module: fts5`.

The isolated schedule-creation test fails 500-versus-201 with default sandbox temp (`validation/schedule-sandbox.log`), then passes 1/1 using disposable checkout TEMP/TMP (`validation/schedule-checkout-temp.log`). Root supplied these follow-up logs and this review read their results. The source and runtime did not change between the isolated test variants. This demonstrates fixture-location sensitivity for that test; it does not prove all 1,066 failures have the same cause.

These findings justified the single bounded full-suite rerun with disposable checkout TEMP/TMP reported below, to remove the demonstrated fixture replacement obstacle and classify the remaining failures. Preserve the first run, keep the same runtime/source revision, isolate fixture directories, restore TEMP/TMP afterward, and report the rerun independently. Missing FTS5 remains expected to require a compatible runtime or a separately scoped task; no runtime installation or source fix is authorized by this diagnosis.

## Minimal next heartbeat diagnosis

1. The suite is finished and its summary is recorded above. Extract each failing test's complete error and stack; separate app fixture rename errors, SQLite capability errors, symlink/process/git errors and unmatched assertion failures. Do not rerun the full suite before explaining its current failures.
2. Probe SQLite directly with the same Node executable used by the suite, in memory only:

   ```powershell
   node -e 'const {DatabaseSync}=require("node:sqlite"); const db=new DatabaseSync(":memory:"); console.log(process.version,process.execPath); console.log(db.prepare("SELECT sqlite_compileoption_used(''ENABLE_FTS5'') AS enabled").get()); db.exec("CREATE VIRTUAL TABLE probe USING fts5(body)"); db.close();'
   ```

   Retain failure output. A successful alternate runtime probe alone does not verify the application.

3. Inspect only the failing app-test group in isolation before repeating broad tests:

   ```powershell
   npx tsx --import ./src/testHome.ts --test --test-name-pattern='POST /api/schedules creates a schedule' src/app.test.ts
   ```

   Run from `server`, with a bounded process timeout supplied by the caller. First confirm the suite's Node path, and separately check whether replacing an existing disposable file succeeds in its actual sandbox temp directory. Compare the same operation in a disposable directory under the writable checkout. These probes may write only their own disposable files; do not touch canonical Argus state or broaden production write permissions.

4. If fixture replacement still fails, repeat that one test outside the sandbox through the normal approved escalation path and preserve both logs. Alternatively redirect `TEMP`/`TMP` to an explicitly verified disposable directory under the writable checkout for a single test; restore both environment variables afterward. A difference establishes environment sensitivity, not pristine source equivalence.
5. For an unmatched failure that might concern the edits, create a disposable detached checkout or source copy of the recorded HEAD without modifying root source or committing. Run the narrow failing group there using the same runtime and fixture policy. Keep a manifest of revision, file hashes, command, environment policy, exit code and logs. Avoid root-file swapping. Compare changed and pristine errors exactly before claiming a regression or unchanged baseline.

The bounded reader suites, typecheck, lint and build remain separate evidence from global suite status. Global validation finished and is failing.

## Final failure inventory and reader relevance

The final failure-detail section has 1,067 displayed entries and 1,063 distinct display names. Display names are not unique test identities: repeated names occur in different files, and parent/file failures and cancellations differ from the runner summary accounting. Do not substitute these inventory counts for the runner summary.

A conservative text classification of the displayed entries found 879 with an explicit EPERM rename error, 15 Vault-related, nine spawn/worktree-related, eight timeout/cancellation-related, and 156 assertion/other entries. These are diagnostic buckets, not proven independent root causes. App HTTP status assertions often follow earlier logged rename errors and therefore are not automatically new defects. Worktree tests report fixture repositories unavailable; hook tests report fetch delivery failure; process-tree tests report surviving descendants. Unmatched assertions remain unresolved pending the narrow environment probes.

No failure-detail entry names the changed history/session modules or their test files. All 11 new history tests and both new session-shape tests have explicit passing lines in this full log. Existing session readers/transcript tests also have no failed entries in the final detail inventory. The suite provides no identified reader regression; this does not establish that every unrelated failure is environmental or unchanged.

Exact failure names and stacks remain in `validation/server-tests.log`, beginning at its “failing tests” section (line 3801). The raw log is the authoritative inventory; this report avoids duplicating over a thousand names.

## Final isolated Git-ancestry check

The failing “a directory that is not a repository yields no identity” test passed 1/1 when TEMP/TMP used a writable directory outside any Git repository. The parent directory was verified with `git rev-parse --show-toplevel` returning “not a git repository”; no source or runtime changed. Output is retained in `validation/nongit-isolated-temp.log`. The environment was restored and the disposable root removed. This confirms location sensitivity for this representative failure, not equivalence of all remaining Git/knowledge failures. No third broad rerun was performed.

## Single relocated-temp full run

`validation/server-checkout-temp.log` completed with exit code 1: 3,212 tests, 3,084 passed, 89 failed, two cancelled, 37 skipped, zero todo; 141,351.8503 ms. Its final detail section contains 91 distinct displayed names, 21 also present in the historical pristine list. These counts are not pristine equivalence. The two runs exercised different counts because cancellations and runtime-dependent skips changed; do not calculate a fixed-test pass-rate improvement from their totals.

The pervasive JSON-replacement failure group disappeared, consistent with the isolated temp-root probe. Remaining displayed groups by file are:

| Group                                                 | Displayed entries | Evidence and interpretation                                                                                                                                              |
| ----------------------------------------------------- | ----------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Vault app tests, Vault unit tests and watcher         |                20 | Missing FTS5 remains; several Vault cleanups also fail EBUSY unlink on open SQLite/WAL files.                                                                            |
| Knowledge discovery, realization, verification, scope |                48 | Git/evidence identity and file-existence assertions remain. Parent repository discovery is a material new fixture confound; do not call these proven source regressions. |
| CLI tail, hooks and result transport                  |                13 | Child fetch/socket connection failures, timeout waiting and delivery assertions. Sandbox networking is plausible; isolate one child connectivity probe.                  |
| Workspace and pipeline harness                        |                 5 | Parent repository discovery and root ref-lock errors; one deadline reconciliation assertion also remains.                                                                |
| Process tree and command verification                 |                 4 | Descendant survival/pipe closure assertions and a command timeout exceeding its expected duration remain; cause unresolved.                                              |
| App parent timeout                                    |                 1 | The app file exceeds the per-file 120-second test timeout; treat separately from individual assertions.                                                                  |

### Relocated temp introduced a git ancestry confound

The disposable fixture root is now inside `C:/GIT/Argus`, itself a git checkout. A fixture directory with no repository can therefore discover the parent Argus repository. The retained workspace refusal test explicitly attempts a root repository worktree branch and fails to lock `refs/heads/argus/i1/shared`, instead of producing the expected “not a git work tree” error. Knowledge evidence tests report fixture paths missing from the run's repository and mismatched repository identities. This is concrete evidence that at least some tests now observe unintended git ancestry; it does not explain every remaining assertion.

Next diagnosis should use a verified writable disposable directory **outside every git checkout** for a narrow workspace/knowledge group, preserving source/runtime and keeping canonical stores isolated. Verify resolved ancestry before use; the separate visualization writable root may qualify if it has no repository ancestor. Do not swap root sources, change git permissions, create commits, or repeat the full suite merely to change another variable.

All 11 added history tests and both session-shape tests remain explicitly passing in the relocated full log. Neither run's final failure-detail inventory identifies a session/history reader failure. Production source remained untouched during this diagnosis. Root should retain both logs and avoid claiming globally passing or unchanged baseline.
