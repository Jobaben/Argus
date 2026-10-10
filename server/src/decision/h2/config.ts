/**
 * H2 collection settings (RFC §P.1, §P.3, §P.4).
 *
 * Collection is off unless an operator turns on **both** switches:
 * `ARGUS_DECISIONS=on` (the plane's background work) and
 * `ARGUS_DECISIONS_H2_COLLECT=on` (this experiment). `ARGUS_ANALYSIS=off`
 * wins over both, because every provider call is an analysis pass.
 *
 * A setting that does not parse disables collection and is named in the
 * reasons. Nothing falls back to a guess: an operator who typed a rate of
 * `5` meant something, and it was not 0.5.
 */

export interface H2Limits {
  /** Provider invocations (made, or possibly made) per rolling 24 hours. */
  maxCallsPer24h: number;
  minCallIntervalMs: number;
  /** Recorded H2 cost per rolling 24 hours. Known only after a call. */
  maxUsdPer24h: number;
  /** Tries per item, counting only attempts that made no provider call. */
  maxTriesPerItem: number;
  retryAfterMs: number;
}

export interface H2Settings {
  runtime: "claude" | "codex";
  reasoningEffort: "low" | "medium" | "high" | "xhigh" | null;
  seed: string;
  residualRate: number;
  probeRate: number;
  /** Explicit model for the selected CLI adapter; null = the runner's default. */
  model: string | null;
  window: { minAgeMs: number; maxAgeMs: number };
  limits: H2Limits;
}

export type H2Enablement =
  | { enabled: true; settings: H2Settings }
  | { enabled: false; reasons: string[]; settings: H2Settings | null };

const MINUTE = 60_000;

export const H2_DEFAULTS: Readonly<H2Settings> = Object.freeze({
  runtime: "claude",
  reasoningEffort: null,
  seed: "argus-h2",
  residualRate: 0.5,
  probeRate: 0.1,
  model: null,
  window: Object.freeze({ minAgeMs: 10 * MINUTE, maxAgeMs: 24 * 60 * MINUTE }),
  limits: Object.freeze({
    maxCallsPer24h: 20,
    minCallIntervalMs: 15 * MINUTE,
    maxUsdPer24h: 1,
    maxTriesPerItem: 3,
    retryAfterMs: 30 * MINUTE,
  }),
}) as H2Settings;

type Env = Readonly<Record<string, string | undefined>>;

const on = (v: string | undefined) => (v ?? "").trim().toLowerCase() === "on";

/** Parse the H2 settings. Unset values take the defaults; a bad value is an error, not a default. */
export function readH2Settings(env: Env): { settings: H2Settings; errors: string[] } {
  const errors: string[] = [];
  const text = (name: string) => {
    const v = env[name]?.trim();
    return v ? v : undefined;
  };
  const rate = (name: string, dflt: number) => {
    const v = text(name);
    if (v === undefined) return dflt;
    const n = Number(v);
    if (!/^\d*\.?\d+$/.test(v) || !Number.isFinite(n) || n < 0 || n > 1) {
      errors.push(`${name}="${v}" is not a rate between 0 and 1`);
      return dflt;
    }
    return n;
  };
  const int = (name: string, dflt: number, min: number, max: number) => {
    const v = text(name);
    if (v === undefined) return dflt;
    const n = Number(v);
    if (!/^\d+$/.test(v) || !Number.isSafeInteger(n) || n < min || n > max) {
      errors.push(`${name}="${v}" is not a whole number from ${min} to ${max}`);
      return dflt;
    }
    return n;
  };
  const usd = (name: string, dflt: number) => {
    const v = text(name);
    if (v === undefined) return dflt;
    const n = Number(v);
    if (!/^\d*\.?\d+$/.test(v) || !Number.isFinite(n) || n < 0 || n > 1000) {
      errors.push(`${name}="${v}" is not a dollar amount from 0 to 1000`);
      return dflt;
    }
    return n;
  };
  const seed = text("ARGUS_DECISIONS_H2_SEED") ?? H2_DEFAULTS.seed;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(seed)) {
    errors.push(`ARGUS_DECISIONS_H2_SEED="${seed}" must be 1-64 letters, digits, ".", "_" or "-"`);
  }
  const model = text("ARGUS_DECISIONS_H2_MODEL") ?? null;
  if (model !== null && !/^[A-Za-z0-9._:@/[\]-]{1,100}$/.test(model)) {
    errors.push(`ARGUS_DECISIONS_H2_MODEL="${model}" is not a model alias or id`);
  }
  const rawRuntime = text("ARGUS_DECISIONS_H2_RUNTIME") ?? "claude";
  const runtime = rawRuntime === "codex" ? "codex" : "claude";
  if (rawRuntime !== "claude" && rawRuntime !== "codex")
    errors.push("ARGUS_DECISIONS_H2_RUNTIME must be claude or codex");
  if (runtime === "codex" && (!model || /^(haiku|sonnet|opus|claude)(-|$)/.test(model)))
    errors.push("ARGUS_DECISIONS_H2_MODEL must explicitly name a Codex model for codex runtime");
  if (runtime === "claude" && model?.startsWith("gpt-"))
    errors.push("ARGUS_DECISIONS_H2_MODEL names a Codex model for claude runtime");
  const effort = text("ARGUS_DECISIONS_H2_REASONING_EFFORT") ?? null;
  const reasoningEffort = effort as H2Settings["reasoningEffort"];
  if (
    effort !== null &&
    (runtime !== "codex" || !["low", "medium", "high", "xhigh"].includes(effort))
  )
    errors.push(
      "ARGUS_DECISIONS_H2_REASONING_EFFORT requires codex and low, medium, high or xhigh",
    );
  const d = H2_DEFAULTS;
  const settings: H2Settings = {
    runtime,
    reasoningEffort,
    seed,
    residualRate: rate("ARGUS_DECISIONS_H2_RESIDUAL_RATE", d.residualRate),
    probeRate: rate("ARGUS_DECISIONS_H2_PROBE_RATE", d.probeRate),
    model,
    window: { ...d.window },
    limits: {
      ...d.limits,
      maxCallsPer24h: int("ARGUS_DECISIONS_H2_MAX_CALLS_PER_DAY", d.limits.maxCallsPer24h, 0, 96),
      minCallIntervalMs:
        int(
          "ARGUS_DECISIONS_H2_MIN_INTERVAL_MINUTES",
          d.limits.minCallIntervalMs / MINUTE,
          1,
          1440,
        ) * MINUTE,
      maxUsdPer24h: usd("ARGUS_DECISIONS_H2_MAX_USD_PER_DAY", d.limits.maxUsdPer24h),
    },
  };
  return { settings, errors };
}

/** Whether collection may run, and why not. Reads only the environment it is handed. */
export function h2Enablement(env: Env): H2Enablement {
  const reasons: string[] = [];
  if (!on(env.ARGUS_DECISIONS)) reasons.push("ARGUS_DECISIONS is not on");
  if (!on(env.ARGUS_DECISIONS_H2_COLLECT)) reasons.push("ARGUS_DECISIONS_H2_COLLECT is not on");
  if ((env.ARGUS_ANALYSIS ?? "").trim().toLowerCase() === "off") {
    reasons.push("analysis passes are disabled (ARGUS_ANALYSIS=off)");
  }
  const { settings, errors } = readH2Settings(env);
  reasons.push(...errors);
  if (reasons.length > 0)
    return { enabled: false, reasons, settings: errors.length ? null : settings };
  return { enabled: true, settings };
}
