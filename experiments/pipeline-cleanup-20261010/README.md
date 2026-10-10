# Experiment pipeline cleanup

On 2026-10-10, the user authorized archiving the 20 reviewed experiment pipeline definitions: Workshop Studio, the H2 shadow feeder, 16 controlled closeout cases, and two ledger closeout analysis jobs.

The cleanup changed only `C:/Users/ushab/.claude/argus/pipelines.json`, using Argus's existing atomic writer. The resulting definition store is an empty JSON array. No source code, engine configuration, collection settings, instances, runs, journals, or decision evidence was changed.

- `pipelines-before-cleanup.json`: exact original store, with all definitions and their original enabled states.
- `preserved-files-before.json`: SHA-256 manifest of all 1,281 other Argus files; the cleanup verified the same paths and hashes after the operation.
- `receipt.json`: archived IDs, store hashes, and verification results.
- `cleanup.mjs`: the one-time operation, including exact-ID checks, active-instance checks, backup verification, and preservation checks.

The local API on port 7777 refused connections. Persisted cleanup is verified; live application reload is unverified.

To restore, stop Argus and replace its pipeline store with the backup. This restores the original enabled states as well. If new definitions have since been created, reconcile them with the backup before restoring.
