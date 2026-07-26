import type { Stats } from "../useStats";

/**
 * Which halves of the usage headline actually have data.
 *
 * The two halves come from different places. Session counts are derived from the
 * transcript files Argus reads directly; token, cost and model counts come from
 * Claude Code's own usage telemetry, which may not have been written yet, may be
 * a shape this version does not parse, or may simply not exist for a fresh
 * install. When only the first half is present the page used to render six
 * confident zeros beside two real numbers — indistinguishable from "you have
 * genuinely used zero tokens across 184 sessions", which is not a thing that
 * happens.
 *
 * A zero inside a group that has data is left alone: among real numbers, a real
 * zero means something.
 */
export function hasTokenData(headline: Stats["headline"]): boolean {
  return (
    headline.totalTokens > 0 ||
    headline.totalOutputTokens > 0 ||
    headline.totalCacheReadTokens > 0 ||
    headline.totalCostUSD > 0 ||
    headline.modelsUsed > 0
  );
}

/** True when even the transcript-derived counts are empty. */
export function hasSessionData(headline: Stats["headline"]): boolean {
  return headline.totalSessions > 0 || headline.totalMessages > 0 || headline.totalToolCalls > 0;
}
