/**
 * Per-run signal tokens (Hardening Item 3).
 *
 * Every run used to be handed its instance's one `signalToken`, so any run of
 * an instance could complete, fail or pause any other step of it — a sibling,
 * a later attempt's run, a phase it had nothing to do with. Now each run that
 * can signal at all gets its own random token, and Argus keeps only a digest
 * of it bound to exactly one instance, phase, attempt and run.
 *
 * What this is not: a boundary between an agent and its own hook. The two
 * share an OS user and an environment, so an agent can always read the token
 * its own hook would use. The binding limits what that token can reach — its
 * own run, nothing else — and the digest means no persisted record holds a
 * usable credential.
 *
 * Pure apart from `crypto`: randomness is drawn only in {@link mintSignalToken},
 * and the engine lets a test supply its own source instead.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { SignalAuthRecord } from "../sources/pipelineTypes.js";

export const SIGNAL_TOKEN_SCHEME = "run-token-v1" as const;

export interface SignalBinding {
  instanceId: string;
  phaseId: string;
  attempt: number;
  runId: string;
}

/** 256 bits, URL-safe — the default source of a run's token. */
export function mintSignalToken(): string {
  return randomBytes(32).toString("base64url");
}

/** The digest stored for a token: SHA-256 over the token *and* everything it
 *  is bound to, so the same token presented for another run never matches. */
export function signalTokenDigest(binding: SignalBinding, token: string): string {
  return createHash("sha256")
    .update(
      [
        `argus-signal/${SIGNAL_TOKEN_SCHEME}`,
        binding.instanceId,
        binding.phaseId,
        String(binding.attempt),
        binding.runId,
        token,
      ].join("\n"),
    )
    .digest("hex");
}

/** The record kept for a run Argus handed a token. */
export function signalAuthFor(binding: SignalBinding, token: string): SignalAuthRecord {
  return {
    scheme: SIGNAL_TOKEN_SCHEME,
    sha256: signalTokenDigest(binding, token),
    phaseId: binding.phaseId,
    attempt: binding.attempt,
  };
}

/** Constant-time equality over two strings of possibly different length. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Does `token` authenticate a signal for this run, under its record?
 *
 * The binding is taken from the record (phase, attempt) plus the instance and
 * run the signal names, so a token minted for one run, phase or attempt
 * cannot authenticate another. `none` accepts nothing.
 */
export function verifySignalToken(
  auth: SignalAuthRecord,
  instanceId: string,
  runId: string,
  token: unknown,
): boolean {
  if (auth.scheme !== SIGNAL_TOKEN_SCHEME) return false;
  if (typeof token !== "string" || token.length === 0) return false;
  const expected = signalTokenDigest(
    { instanceId, phaseId: auth.phaseId, attempt: auth.attempt, runId },
    token,
  );
  return safeEqual(expected, auth.sha256);
}
