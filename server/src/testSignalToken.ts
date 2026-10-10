/**
 * Test-only source of per-run signal tokens: deterministic, so a test can sign
 * a signal for exactly the run it means without reaching into the spawn's
 * environment. Pass as the engine's `newSignalToken`. The digest Argus stores
 * still binds each token to its instance, phase, attempt and run, so a test
 * that presents one run's token for another still gets the 403 it should.
 */
export const testRunToken = (binding: { runId: string } | string): string =>
  `run-token:${typeof binding === "string" ? binding : binding.runId}`;
