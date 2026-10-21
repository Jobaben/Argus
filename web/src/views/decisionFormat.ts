import type { H2Measured, H2Proportion } from "@argus/contracts";

/**
 * How the two decision experiments say a number. One module for both, so a
 * proportion, a rate or a missing model reads the same way in the H1 report
 * as in the H2 report beside it.
 */

/** 0.625 → "62.5%". */
export function pct(v: number, digits = 1): string {
  return `${(v * 100).toFixed(digits)}%`;
}

/** A configured rate: no padding zeros, so 0.05 reads "5%" rather than "5.0%". */
export function rate(v: number): string {
  return `${+(v * 100).toFixed(2)}%`;
}

/** "62.5% (5/8, 95% CI 30.6–86.3%)", or "— (n = 0)" when there is nothing to divide. */
export function formatProportion(p: H2Proportion): string {
  if (p.value === null) return "— (n = 0)";
  const ci = p.ci95
    ? `, 95% CI ${(p.ci95[0] * 100).toFixed(1)}–${(p.ci95[1] * 100).toFixed(1)}%`
    : "";
  return `${pct(p.value)} (${p.k}/${p.n}${ci})`;
}

export function formatMeasured<T>(m: H2Measured<T>, show: (v: T) => string): string {
  return m.status === "measured" ? show(m.value) : `unmeasured — ${m.reason}`;
}

export const formatNullable = (v: number | null, show: (n: number) => string): string =>
  v === null ? "—" : show(v);

/** A configured wait between calls: 90 000 ms → "1.5 min". */
export const formatInterval = (ms: number): string => `${+(ms / 60_000).toFixed(2)} min`;

/** A reliability bucket too small to score, with the floor it is under. */
export const unmeasuredBucket = (n: number, min: number): string =>
  `unmeasured (n = ${n} < ${min})`;

/** What an unset model means: the agent CLI's own default, not a gap. */
export const RUNNER_DEFAULT = "runner default";
